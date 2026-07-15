'use strict';

const { randomUUID } = require('node:crypto');

const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const DRIFT_RECONCILE_MS = 5 * 60 * 1000;

class ThreatIpBlockingError extends Error {
    constructor(message, { code, httpStatus } = {}) {
        super(message);
        this.name = 'ThreatIpBlockingError';
        this.code = code || 'threat_ip_blocking_error';
        this.httpStatus = httpStatus || 500;
    }
}

function createThreatIpBlockingService({
    repository,
    client,
    logger = null,
    now = () => Date.now()
} = {}) {
    const requiredRepositoryMethods = [
        'requestThreatIpBlock',
        'requestThreatIpBlockRemoval',
        'expireThreatIpBlocks',
        'listThreatIpBlocks',
        'listThreatIpBlockAudit',
        'markThreatIpBlocksSynced',
        'markThreatIpBlockSyncFailure'
    ];
    for (const method of requiredRepositoryMethods) {
        if (typeof repository?.[method] !== 'function') throw new TypeError(`repository.${method} is required`);
    }
    if (typeof client?.configuration !== 'function' || typeof client?.replace !== 'function') {
        throw new TypeError('client configuration and replace functions are required');
    }

    let operationTail = Promise.resolve();
    let lastReconcileAt = null;
    let lastSuccessAt = null;
    let lastSuccessAtMs = null;
    let lastConfigurationKey = null;
    let lastError = null;
    let lastChanged = false;

    function configurationStatus() {
        const configuration = client.configuration();
        return {
            configured: configuration.configured,
            missing: configuration.missing,
            ipv4Only: true,
            listName: configuration.listName || null
        };
    }

    function snapshot() {
        const blocks = repository.listThreatIpBlocks();
        return {
            configuration: configurationStatus(),
            reconcile: {
                status: lastError ? 'degraded' : (lastSuccessAt ? 'healthy' : 'pending'),
                lastReconcileAt,
                lastSuccessAt,
                lastChanged,
                lastError
            },
            blocks,
            audit: repository.listThreatIpBlockAudit(100)
        };
    }

    async function performReconcile({ force = false } = {}) {
        const timestamp = now();
        repository.expireThreatIpBlocks(timestamp);
        const configuration = client.configuration();
        lastReconcileAt = new Date(timestamp).toISOString();
        if (!configuration.configured) {
            lastError = { code: 'not_configured', retryable: false };
            return { applied: false, skipped: true, reason: 'not_configured', snapshot: snapshot() };
        }
        const rows = repository.listThreatIpBlocks();
        const retryAt = rows.reduce((latest, row) => Math.max(latest, Number(row.nextRetryTs) || 0), 0);
        if (!force && retryAt > timestamp) {
            return { applied: false, skipped: true, reason: 'backoff', retryAt: new Date(retryAt).toISOString(), snapshot: snapshot() };
        }
        // The secret participates only in an in-memory equality key so credential
        // rotation triggers immediate reconciliation; it is never returned/logged.
        const configurationKey = [configuration.baseUrl, configuration.siteId, configuration.listId, configuration.listName, configuration.apiKey].join('|');
        const hasPendingState = rows.some(row => row.syncState !== 'applied' || row.desiredState !== 'active');
        if (!force && !hasPendingState && lastSuccessAtMs !== null
            && lastConfigurationKey === configurationKey
            && timestamp - lastSuccessAtMs < DRIFT_RECONCILE_MS) {
            return { applied: true, skipped: true, reason: 'stable', snapshot: snapshot() };
        }
        const desired = rows
            .filter(row => row.desiredState === 'active' && row.expiresTs > timestamp)
            .map(row => row.ip)
            .sort();
        try {
            const result = await client.replace(desired);
            repository.markThreatIpBlocksSynced(timestamp);
            lastSuccessAt = new Date(timestamp).toISOString();
            lastSuccessAtMs = timestamp;
            lastConfigurationKey = configurationKey;
            lastError = null;
            lastChanged = result.changed;
            return { applied: true, changed: result.changed, snapshot: snapshot() };
        } catch (error) {
            const attempt = Math.max(1, ...rows.map(row => Number(row.attemptCount) + 1 || 1));
            const delay = Math.min(BASE_RETRY_MS * (2 ** Math.min(attempt - 1, 16)), MAX_RETRY_MS);
            const retryAtMs = timestamp + delay;
            const code = String(error?.code || 'upstream_unavailable').slice(0, 80);
            repository.markThreatIpBlockSyncFailure(timestamp, code, retryAtMs);
            lastError = { code, retryable: error?.retryable === true, retryAt: new Date(retryAtMs).toISOString() };
            lastChanged = false;
            logger?.warning?.({
                module: 'security.threatBlock', function: 'reconcile', code: 'EXT-UNIFI-THREAT-BLOCK',
                message: 'UniFi threat block reconciliation failed', error,
                fields: { retry_at: lastError.retryAt, desired_count: desired.length, upstream_status: error?.status || null }
            });
            return { applied: false, skipped: false, reason: code, retryAt: lastError.retryAt, snapshot: snapshot() };
        }
    }

    function enqueue(operation) {
        const current = operationTail.then(operation, operation);
        operationTail = current.catch(() => undefined);
        return current;
    }

    function reconcile(options) {
        return enqueue(() => performReconcile(options));
    }

    function add({ ip, expiresInMinutes }) {
        const configuration = client.configuration();
        if (!configuration.configured) {
            return Promise.reject(new ThreatIpBlockingError('UniFi threat blocking is not configured', {
                code: 'threat_blocking_not_configured', httpStatus: 503
            }));
        }
        return enqueue(async () => {
            const timestamp = now();
            const requested = repository.requestThreatIpBlock({
                id: randomUUID(),
                ip,
                createdTs: timestamp,
                expiresTs: timestamp + expiresInMinutes * 60 * 1000
            });
            const reconciled = await performReconcile({ force: true });
            const block = repository.listThreatIpBlocks().find(row => row.ip === ip) || requested.block;
            return {
                ok: true,
                accepted: true,
                applied: reconciled.applied,
                duplicate: !requested.created,
                extended: requested.extended,
                block,
                reconcile: reconciled.snapshot.reconcile
            };
        });
    }

    function remove(id) {
        return enqueue(async () => {
            const timestamp = now();
            const requested = repository.requestThreatIpBlockRemoval(id, timestamp, 'manual');
            if (!requested) {
                throw new ThreatIpBlockingError('Threat IP block was not found', {
                    code: 'threat_block_not_found', httpStatus: 404
                });
            }
            const reconciled = await performReconcile({ force: true });
            return {
                ok: true,
                accepted: true,
                applied: reconciled.applied,
                id,
                reconcile: reconciled.snapshot.reconcile
            };
        });
    }

    return { add, configurationStatus, reconcile, remove, snapshot };
}

module.exports = {
    BASE_RETRY_MS,
    DRIFT_RECONCILE_MS,
    MAX_RETRY_MS,
    ThreatIpBlockingError,
    createThreatIpBlockingService
};

'use strict';

const { randomUUID } = require('node:crypto');
const {
    buildInactiveSchedule,
    expandCategories,
    normalizeDeviceId,
    publicCategoryDefinitions
} = require('../policies/adguard-service-policy');

const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const DRIFT_RECONCILE_MS = 5 * 60 * 1000;
const WRITABLE_CLIENT_FIELDS = Object.freeze([
    'name', 'ids', 'tags', 'use_global_settings', 'filtering_enabled',
    'parental_enabled', 'safebrowsing_enabled', 'safesearch_enabled', 'safe_search',
    'use_global_blocked_services', 'blocked_services', 'blocked_services_schedule',
    'upstreams', 'upstreams_cache_enabled', 'upstreams_cache_size',
    'ignore_querylog', 'ignore_statistics'
]);

class AdGuardServicePolicyError extends Error {
    constructor(message, { code = 'adguard_service_policy_error', httpStatus = 500, retryable = false } = {}) {
        super(message);
        this.name = 'AdGuardServicePolicyError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.retryable = retryable;
    }
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function exactSortedStrings(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(item => typeof item === 'string'))].sort();
}

function extractPersistentClients(payload) {
    const candidates = Array.isArray(payload?.clients)
        ? payload.clients
        : Array.isArray(payload?.clients?.persistent)
            ? payload.clients.persistent
            : Array.isArray(payload?.persistent)
                ? payload.persistent
                : null;
    if (!candidates || candidates.length > 5000) {
        throw new AdGuardServicePolicyError('AdGuard returned an invalid persistent client list', {
            code: 'invalid_client_catalog', retryable: true
        });
    }
    return candidates;
}

function extractServiceIds(payload) {
    const candidates = Array.isArray(payload) ? payload : Array.isArray(payload?.services) ? payload.services : null;
    if (!candidates || candidates.length > 5000) {
        throw new AdGuardServicePolicyError('AdGuard returned an invalid service catalog', {
            code: 'invalid_service_catalog', retryable: true
        });
    }
    const ids = new Set();
    for (const candidate of candidates) {
        const id = typeof candidate === 'string' ? candidate : candidate?.id;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_]{0,127}$/u.test(id)) {
            throw new AdGuardServicePolicyError('AdGuard service catalog contains an invalid identifier', {
                code: 'invalid_service_catalog', retryable: true
            });
        }
        ids.add(id);
    }
    return ids;
}

function findPersistentClient(clients, deviceId) {
    const target = normalizeDeviceId(deviceId);
    const matches = clients.filter(client => Array.isArray(client?.ids)
        && client.ids.some(id => {
            try { return normalizeDeviceId(id) === target; }
            catch { return false; }
        }));
    if (matches.length === 0) {
        throw new AdGuardServicePolicyError('No persistent AdGuard client owns this device identity', {
            code: 'client_not_found', httpStatus: 409, retryable: true
        });
    }
    if (matches.length > 1) {
        throw new AdGuardServicePolicyError('Multiple AdGuard clients own this device identity', {
            code: 'client_identity_ambiguous', httpStatus: 409, retryable: false
        });
    }
    return matches[0];
}

function normalizedClientIds(client) {
    const ids = new Set();
    for (const id of Array.isArray(client?.ids) ? client.ids : []) {
        try { ids.add(normalizeDeviceId(id)); } catch { }
    }
    return ids;
}

function writableClientData(client) {
    if (!client || typeof client.name !== 'string' || !client.name
        || !Array.isArray(client.ids) || client.ids.length === 0) {
        throw new AdGuardServicePolicyError('AdGuard returned an invalid persistent client', {
            code: 'invalid_client', retryable: true
        });
    }
    const data = {};
    for (const field of WRITABLE_CLIENT_FIELDS) {
        if (Object.hasOwn(client, field)) data[field] = cloneJson(client[field]);
    }
    data.name = client.name;
    data.ids = cloneJson(client.ids);
    return data;
}

function managedBaseline(client) {
    return {
        use_global_blocked_services: client.use_global_blocked_services !== false,
        blocked_services: exactSortedStrings(client.blocked_services),
        blocked_services_schedule: client.blocked_services_schedule && typeof client.blocked_services_schedule === 'object'
            && !Array.isArray(client.blocked_services_schedule)
            ? cloneJson(client.blocked_services_schedule)
            : {}
    };
}

function desiredManagedSettings(policy) {
    return {
        use_global_blocked_services: false,
        blocked_services: expandCategories(policy.categories),
        blocked_services_schedule: buildInactiveSchedule(policy)
    };
}

function sameManagedSettings(client, desired) {
    const current = managedBaseline(client);
    return current.use_global_blocked_services === desired.use_global_blocked_services
        && JSON.stringify(current.blocked_services) === JSON.stringify(exactSortedStrings(desired.blocked_services))
        && JSON.stringify(current.blocked_services_schedule) === JSON.stringify(desired.blocked_services_schedule);
}

function publicPolicy(row) {
    const { baseline: _baseline, ...policy } = row;
    return policy;
}

function createAdGuardServicePolicyService({
    repository,
    client,
    logger = null,
    now = () => Date.now()
} = {}) {
    const requiredRepositoryMethods = [
        'upsertAdguardServicePolicy',
        'requestAdguardServicePolicyRemoval',
        'listAdguardServicePolicies',
        'listAdguardServicePolicyAudit',
        'setAdguardServicePolicyBaseline',
        'markAdguardServicePolicySynced',
        'markAdguardServicePolicyFailure'
    ];
    for (const method of requiredRepositoryMethods) {
        if (typeof repository?.[method] !== 'function') throw new TypeError(`repository.${method} is required`);
    }
    for (const method of ['configuration', 'listClients', 'listServices', 'updateClient']) {
        if (typeof client?.[method] !== 'function') throw new TypeError(`client.${method} is required`);
    }

    let operationTail = Promise.resolve();
    let lastReconcileAt = null;
    let lastSuccessAt = null;
    let lastDriftAtMs = null;
    let lastError = null;
    let lastChanged = false;

    function configurationStatus() {
        const status = client.configuration();
        return {
            configured: status.configured === true,
            transport: status.transport || null,
            tlsVerified: status.tlsVerified === true
        };
    }

    function snapshot() {
        return {
            configuration: configurationStatus(),
            definitions: publicCategoryDefinitions(),
            ownership: 'SmartHub owns blocked service fields while a policy is active and restores their captured baseline on removal.',
            reconcile: {
                status: lastError ? 'degraded' : (lastSuccessAt ? 'healthy' : 'pending'),
                lastReconcileAt,
                lastSuccessAt,
                lastChanged,
                lastError
            },
            policies: repository.listAdguardServicePolicies().map(publicPolicy),
            audit: repository.listAdguardServicePolicyAudit(100)
        };
    }

    function recordFailure(row, error, timestamp) {
        const attempt = Math.max(1, Number(row.attemptCount || 0) + 1);
        const delay = Math.min(BASE_RETRY_MS * (2 ** Math.min(attempt - 1, 16)), MAX_RETRY_MS);
        const retryAt = timestamp + delay;
        const code = String(error?.code || 'upstream_unavailable').slice(0, 80);
        repository.markAdguardServicePolicyFailure(row.id, timestamp, code, retryAt);
        logger?.warning?.({
            module: 'integration.adguardPolicy', function: 'reconcile', code: 'EXT-ADGUARD-POLICY',
            message: 'AdGuard service policy reconciliation failed', error,
            fields: { policy_id: row.id, retry_at: new Date(retryAt).toISOString(), error_code: code }
        });
        return { id: row.id, applied: false, code, retryAt: new Date(retryAt).toISOString() };
    }

    async function performReconcile({ force = false, policyId = null } = {}) {
        const timestamp = now();
        lastReconcileAt = new Date(timestamp).toISOString();
        const configuration = client.configuration();
        if (!configuration.configured) {
            lastError = { code: 'not_configured', retryable: false };
            lastChanged = false;
            return { applied: false, skipped: true, reason: 'not_configured', snapshot: snapshot() };
        }
        const allRows = repository.listAdguardServicePolicies();
        let rows = allRows;
        if (policyId) rows = rows.filter(row => row.id === policyId);
        const driftDue = lastDriftAtMs === null || timestamp - lastDriftAtMs >= DRIFT_RECONCILE_MS;
        if (!force) {
            rows = rows.filter(row => row.syncState === 'applied'
                ? driftDue
                : (row.nextRetryTs == null || row.nextRetryTs <= timestamp));
        }
        if (rows.length === 0) {
            const failures = allRows.filter(row => row.syncState === 'error');
            lastError = failures.length ? {
                code: failures[0].lastError || 'upstream_unavailable',
                failedPolicies: failures.length,
                retryable: true
            } : null;
            lastChanged = false;
            return {
                applied: failures.length === 0,
                skipped: true,
                reason: failures.length ? 'backoff' : 'stable',
                snapshot: snapshot()
            };
        }

        let clientsPromise;
        let servicesPromise;
        const clients = () => (clientsPromise ||= Promise.resolve(client.listClients()).then(extractPersistentClients));
        const services = () => (servicesPromise ||= Promise.resolve(client.listServices()).then(extractServiceIds));
        const results = [];
        let anyChanged = false;
        const claimedClients = new Map();
        for (const original of rows) {
            let row = original;
            try {
                if (row.desiredState === 'removed' && row.baseline == null) {
                    repository.markAdguardServicePolicySynced(row.id, timestamp, false);
                    results.push({ id: row.id, applied: true, changed: false, removed: true });
                    continue;
                }
                const persistent = findPersistentClient(await clients(), row.deviceId);
                const persistentIds = normalizedClientIds(persistent);
                const policyOwners = allRows.filter(candidate => persistentIds.has(candidate.deviceId));
                if (policyOwners.length > 1 && policyOwners[0].id !== row.id) {
                    throw new AdGuardServicePolicyError('Multiple SmartHub policies resolve to the same AdGuard client', {
                        code: 'client_policy_conflict', httpStatus: 409, retryable: false
                    });
                }
                const clientKey = typeof persistent.uid === 'string' && persistent.uid ? `uid:${persistent.uid}` : `name:${persistent.name}`;
                const existingClaim = claimedClients.get(clientKey);
                if (existingClaim && existingClaim !== row.id) {
                    throw new AdGuardServicePolicyError('Multiple SmartHub policies resolve to the same AdGuard client', {
                        code: 'client_policy_conflict', httpStatus: 409, retryable: false
                    });
                }
                claimedClients.set(clientKey, row.id);
                let desired;
                if (row.desiredState === 'active') {
                    const desiredIds = expandCategories(row.categories);
                    const supported = await services();
                    const unsupported = desiredIds.filter(id => !supported.has(id));
                    if (unsupported.length) {
                        throw new AdGuardServicePolicyError('AdGuard does not support every selected service', {
                            code: 'unsupported_service_ids', httpStatus: 409, retryable: true
                        });
                    }
                    if (row.baseline == null) {
                        repository.setAdguardServicePolicyBaseline(row.id, managedBaseline(persistent), timestamp);
                        row = repository.listAdguardServicePolicies().find(candidate => candidate.id === row.id) || row;
                    }
                    desired = desiredManagedSettings(row);
                } else {
                    desired = row.baseline;
                }
                const changed = !sameManagedSettings(persistent, desired);
                if (changed) {
                    await client.updateClient(persistent.name, { ...writableClientData(persistent), ...cloneJson(desired) });
                    anyChanged = true;
                }
                repository.markAdguardServicePolicySynced(row.id, timestamp, changed);
                results.push({ id: row.id, applied: true, changed, removed: row.desiredState === 'removed' });
            } catch (error) {
                results.push(recordFailure(row, error, timestamp));
            }
        }
        if (policyId == null) lastDriftAtMs = timestamp;
        const selectedFailures = results.filter(result => !result.applied);
        const remainingFailures = repository.listAdguardServicePolicies().filter(row => row.syncState === 'error');
        if (selectedFailures.length === 0 && results.length > 0) {
            lastSuccessAt = new Date(timestamp).toISOString();
        }
        lastError = remainingFailures.length ? {
            code: remainingFailures[0].lastError || 'upstream_unavailable',
            failedPolicies: remainingFailures.length,
            retryable: true
        } : null;
        lastChanged = anyChanged;
        return { applied: selectedFailures.length === 0, changed: anyChanged, results, snapshot: snapshot() };
    }

    function enqueue(operation) {
        const current = operationTail.then(operation, operation);
        operationTail = current.catch(() => undefined);
        return current;
    }

    function reconcile(options) {
        return enqueue(() => performReconcile(options));
    }

    function upsert(policy) {
        const configuration = client.configuration();
        if (!configuration.configured) {
            return Promise.reject(new AdGuardServicePolicyError('AdGuard service policy is not configured', {
                code: 'adguard_not_configured', httpStatus: 503
            }));
        }
        return enqueue(async () => {
            const timestamp = now();
            const existingPolicies = repository.listAdguardServicePolicies();
            const otherPolicies = existingPolicies.filter(existing => existing.deviceId !== policy.deviceId);
            if (otherPolicies.length) {
                let persistentClients;
                try { persistentClients = extractPersistentClients(await client.listClients()); }
                catch (error) {
                    throw new AdGuardServicePolicyError('AdGuard client ownership could not be verified', {
                        code: 'client_catalog_unavailable', httpStatus: 503, retryable: true
                    });
                }
                const targetClient = findPersistentClient(persistentClients, policy.deviceId);
                const targetIds = normalizedClientIds(targetClient);
                if (otherPolicies.some(existing => targetIds.has(existing.deviceId))) {
                    throw new AdGuardServicePolicyError('An existing SmartHub policy already owns this AdGuard client', {
                        code: 'client_policy_conflict', httpStatus: 409
                    });
                }
            }
            const requested = repository.upsertAdguardServicePolicy({
                id: randomUUID(), ...policy, timestamp
            });
            const reconciled = await performReconcile({ force: true, policyId: requested.id });
            const current = repository.listAdguardServicePolicies().find(row => row.id === requested.id) || requested.policy;
            return {
                ok: true,
                accepted: true,
                applied: reconciled.applied,
                created: requested.created,
                changed: requested.changed,
                policy: current ? publicPolicy(current) : null,
                reconcile: reconciled.snapshot.reconcile
            };
        });
    }

    function remove(id) {
        return enqueue(async () => {
            const timestamp = now();
            const requested = repository.requestAdguardServicePolicyRemoval(id, timestamp);
            if (!requested) {
                throw new AdGuardServicePolicyError('AdGuard service policy was not found', {
                    code: 'policy_not_found', httpStatus: 404
                });
            }
            const reconciled = await performReconcile({ force: true, policyId: id });
            return {
                ok: true,
                accepted: true,
                applied: reconciled.applied,
                id,
                reconcile: reconciled.snapshot.reconcile
            };
        });
    }

    return { configurationStatus, reconcile, remove, snapshot, upsert };
}

module.exports = {
    AdGuardServicePolicyError,
    BASE_RETRY_MS,
    DRIFT_RECONCILE_MS,
    MAX_RETRY_MS,
    WRITABLE_CLIENT_FIELDS,
    createAdGuardServicePolicyService,
    desiredManagedSettings,
    extractPersistentClients,
    extractServiceIds,
    findPersistentClient,
    managedBaseline,
    normalizedClientIds,
    sameManagedSettings,
    writableClientData
};

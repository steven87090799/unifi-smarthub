'use strict';

const PUBLIC_STATUSES = new Set(['operational', 'degraded', 'critical', 'unknown']);

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unknownSnapshot() {
    return Object.freeze({
        status: 'unknown',
        total: 0,
        online: 0,
        offline: 0,
        snapshotAt: null
    });
}

function normalizeSnapshot(input) {
    if (!input || typeof input !== 'object' || !PUBLIC_STATUSES.has(input.status)) {
        throw new TypeError('Invalid public system health snapshot');
    }
    const total = Number(input.total);
    const online = Number(input.online);
    const offline = Number(input.offline);
    if (![total, online, offline].every(value => Number.isSafeInteger(value) && value >= 0)
        || online + offline !== total) {
        throw new TypeError('Public system health counts must be non-negative and internally consistent');
    }
    const timestamp = Date.parse(input.snapshotAt);
    if (!Number.isFinite(timestamp)) throw new TypeError('Public system health snapshotAt must be a valid timestamp');
    return Object.freeze({
        status: input.status,
        total,
        online,
        offline,
        snapshotAt: new Date(timestamp).toISOString()
    });
}

function createPublicSystemHealthService(options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const maxRequests = positiveInteger(options.maxRequests, 30);
    const windowMs = positiveInteger(options.windowMs, 60_000);
    const maxClients = positiveInteger(options.maxClients, 1000);
    const clients = new Map();
    let snapshot = null;

    function prune(current = now()) {
        for (const [key, state] of clients) {
            if (state.resetAt <= current) clients.delete(key);
        }
    }

    function removeOldestClient() {
        while (clients.size >= maxClients) clients.delete(clients.keys().next().value);
    }

    function clientKey(req) {
        return String(req.ip || req.socket?.remoteAddress || 'unknown');
    }

    function consume(req) {
        const current = now();
        prune(current);
        const key = clientKey(req);
        let state = clients.get(key);
        if (!state || state.resetAt <= current) {
            removeOldestClient();
            state = { count: 0, resetAt: current + windowMs };
        }
        state.count += 1;
        clients.delete(key);
        clients.set(key, state);
        return {
            allowed: state.count <= maxRequests,
            retryAfter: Math.max(Math.ceil((state.resetAt - current) / 1000), 1)
        };
    }

    function update(nodes, snapshotAt = now()) {
        if (!Array.isArray(nodes)) throw new TypeError('Public system health nodes must be an array');
        const included = nodes.filter(node => node && node.included !== false);
        const total = included.length;
        const online = included.filter(node => node.online === true).length;
        const offline = total - online;
        const criticalNodeOffline = included.some(node => node.online !== true && node.critical === true);
        const criticalThreshold = Math.max(2, Math.ceil(total * 0.34));
        const status = total === 0 ? 'unknown'
            : offline === 0 ? 'operational'
                : criticalNodeOffline || offline >= criticalThreshold ? 'critical' : 'degraded';
        snapshot = normalizeSnapshot({
            status,
            total,
            online,
            offline,
            snapshotAt: new Date(snapshotAt).toISOString()
        });
        return snapshot;
    }

    function replace(input) {
        snapshot = normalizeSnapshot(input);
        return snapshot;
    }

    function read() {
        return snapshot || unknownSnapshot();
    }

    function handle(req, res) {
        res.set('Cache-Control', 'private, max-age=0, no-store');
        res.set('Pragma', 'no-cache');
        const limit = consume(req);
        if (!limit.allowed) {
            res.set('Retry-After', String(limit.retryAfter));
            return res.status(429).json(unknownSnapshot());
        }
        return res.json(read());
    }

    function getState() {
        return { clients: clients.size, snapshot: read() };
    }

    return { getState, handle, prune, read, replace, update };
}

module.exports = {
    PUBLIC_STATUSES,
    createPublicSystemHealthService,
    normalizeSnapshot
};

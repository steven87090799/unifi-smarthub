'use strict';

const DOCKER_LOG_CACHE_PREFIX = 'nasMonitor.dockerLog.';
const DOCKER_LOG_CANONICAL_LINES = 1_000;
const DOCKER_LOG_MIN_REFRESH_MS = 30_000;

function normalizeRequestedLines(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 200;
    return Math.min(DOCKER_LOG_CANONICAL_LINES, Math.max(1, parsed));
}

function selectTailLines(payload, requestedLines) {
    const lines = normalizeRequestedLines(requestedLines);
    if (Array.isArray(payload)) return payload.slice(-lines);
    if (typeof payload === 'string') return payload.split(/\r?\n/).slice(-lines).join('\n');
    if (payload && typeof payload === 'object' && Array.isArray(payload.logs)) {
        return { ...payload, logs: payload.logs.slice(-lines) };
    }
    if (payload && typeof payload === 'object' && typeof payload.logs === 'string') {
        return { ...payload, logs: selectTailLines(payload.logs, lines) };
    }
    return payload;
}

function dockerLogNotificationsEnabled(settings) {
    return settings?.enabled === true && (
        settings?.triggerDockerCriticalLog === true
        || settings?.triggerDockerErrorLog === true
    );
}

function dockerLogCacheKey(id) {
    return `${DOCKER_LOG_CACHE_PREFIX}${String(id)}`;
}

function createDockerLogSnapshot({ cache, fetch, getMinIntervalMs = () => 30_000, maxContainers = 12 } = {}) {
    if (!cache || typeof cache.read !== 'function' || typeof cache.snapshot !== 'function') {
        throw new TypeError('cache must be a collector cache');
    }
    if (typeof fetch !== 'function') throw new TypeError('fetch must be a function');
    if (typeof getMinIntervalMs !== 'function') throw new TypeError('getMinIntervalMs must be a function');

    function freshnessMs() {
        return Math.max(DOCKER_LOG_MIN_REFRESH_MS, Number(getMinIntervalMs()) || DOCKER_LOG_MIN_REFRESH_MS);
    }

    function read(id, { lines = 200, allowStale = true, refresh = false } = {}) {
        return cache.read(dockerLogCacheKey(id), () => fetch(id, { lines: DOCKER_LOG_CANONICAL_LINES }), {
            freshnessMs: freshnessMs(), allowStale, refresh, scope: 'nas'
        }).then(payload => selectTailLines(payload, lines));
    }

    function idsFromInventory(inventory) {
        const containers = Array.isArray(inventory) ? inventory : (inventory?.containers || inventory?.data || []);
        return [...new Set(containers.filter(container => container?.id).map(container => String(container.id)))].slice(0, maxContainers);
    }

    async function readInventory(inventory, { enabled = true, lines = 120, allowStale = true } = {}) {
        if (!enabled) {
            clear();
            return [];
        }
        const ids = idsFromInventory(inventory);
        reconcile(ids);
        return Promise.all(ids.map(id => read(id, { lines, allowStale })));
    }

    function reconcile(containerIds) {
        const current = new Set((containerIds || []).map(id => String(id)));
        let removed = 0;
        for (const name of cache.names()) {
            if (!name.startsWith(DOCKER_LOG_CACHE_PREFIX)) continue;
            const id = name.slice(DOCKER_LOG_CACHE_PREFIX.length);
            if (!current.has(id)) removed += cache.invalidatePrefix(name);
        }
        return removed;
    }

    function clear() {
        return cache.invalidatePrefix(DOCKER_LOG_CACHE_PREFIX);
    }

    return Object.freeze({
        read,
        readInventory,
        reconcile,
        clear,
        key: dockerLogCacheKey,
        prefix: DOCKER_LOG_CACHE_PREFIX,
        freshnessMs
    });
}

module.exports = {
    DOCKER_LOG_CACHE_PREFIX,
    DOCKER_LOG_CANONICAL_LINES,
    DOCKER_LOG_MIN_REFRESH_MS,
    createDockerLogSnapshot,
    dockerLogCacheKey,
    dockerLogNotificationsEnabled,
    normalizeRequestedLines,
    selectTailLines
};

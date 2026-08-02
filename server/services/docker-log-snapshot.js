'use strict';

const DOCKER_LOG_CACHE_PREFIX = 'nasMonitor.dockerLog.';

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
        return Math.max(30_000, Number(getMinIntervalMs()) || 30_000);
    }

    function read(id, { lines = 120, allowStale = false, refresh = false } = {}) {
        return cache.read(dockerLogCacheKey(id), () => fetch(id, { lines }), {
            freshnessMs: freshnessMs(), allowStale, refresh, scope: 'nas'
        });
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
        return Promise.all(idsFromInventory(inventory).map(id => read(id, { lines, allowStale })));
    }

    function reconcile(containerIds) {
        const current = new Set((containerIds || []).map(id => String(id)));
        return cache.invalidateMatching(name => name.startsWith(DOCKER_LOG_CACHE_PREFIX)
            && !current.has(name.slice(DOCKER_LOG_CACHE_PREFIX.length)));
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

module.exports = { DOCKER_LOG_CACHE_PREFIX, createDockerLogSnapshot, dockerLogCacheKey };

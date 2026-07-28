'use strict';

// Shared collector cache: stale payloads remain displayable, while the
// snapshot exposes the latest upstream health separately for watchers.
function createDeviceCollectorCache({ cacheAgeMs = () => 1000, now = () => Date.now() } = {}) {
    const entries = new Map();

    async function read(name, collect, { refresh = false, allowStale = false } = {}) {
        const current = entries.get(name);
        const timestamp = now();
        if (current?.data !== undefined && !refresh
            && (allowStale || timestamp - (current.lastSuccessAt || 0) <= cacheAgeMs())) return current.data;
        if (current?.inflight) return current.inflight;

        const entry = current || {
            data: undefined, lastAttemptAt: null, lastSuccessAt: null,
            lastErrorAt: null, lastError: null, consecutiveFailures: 0, inflight: null
        };
        entry.lastAttemptAt = timestamp;
        const inflight = Promise.resolve().then(collect).then(data => {
            entry.data = data;
            entry.lastSuccessAt = now();
            entry.lastErrorAt = null;
            entry.lastError = null;
            entry.consecutiveFailures = 0;
            return data;
        }).catch(error => {
            entry.lastErrorAt = now();
            entry.lastError = error;
            entry.consecutiveFailures += 1;
            throw error;
        }).finally(() => {
            if (entry.inflight === inflight) entry.inflight = null;
        });
        entry.inflight = inflight;
        entries.set(name, entry);
        return inflight;
    }

    function snapshot(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        return {
            data: entry.data,
            lastAttemptAt: entry.lastAttemptAt,
            lastSuccessAt: entry.lastSuccessAt,
            lastErrorAt: entry.lastErrorAt,
            lastError: entry.lastError,
            consecutiveFailures: entry.consecutiveFailures,
            inflight: entry.inflight
        };
    }

    return { read, snapshot };
}

module.exports = { createDeviceCollectorCache };

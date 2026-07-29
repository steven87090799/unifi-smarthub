'use strict';

// A caller can explicitly signal that work was cancelled by a configuration
// generation change. This is neither a successful sample nor an upstream
// device failure, so it must not alter cache health.
const DISCARDED_COLLECTOR_RESULT = Symbol('DISCARDED_COLLECTOR_RESULT');

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
        const previousAttemptAt = entry.lastAttemptAt;
        entry.lastAttemptAt = timestamp;
        const inflight = Promise.resolve().then(collect).then(data => {
            if (data === DISCARDED_COLLECTOR_RESULT) {
                if (current) entry.lastAttemptAt = previousAttemptAt;
                else entries.delete(name);
                return current?.data;
            }
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

    function clear(name) {
        if (name === undefined) {
            entries.clear();
            return;
        }
        entries.delete(name);
    }

    return { read, snapshot, clear };
}

module.exports = { createDeviceCollectorCache, DISCARDED_COLLECTOR_RESULT };

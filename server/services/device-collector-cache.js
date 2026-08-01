'use strict';

/**
 * A small process-local cache for read-only device collectors.
 *
 * The cache deliberately keeps payload freshness and upstream health as two
 * different pieces of state.  A caller may choose to display the last
 * successful payload after a failed refresh, but that payload never makes the
 * collector healthy again.  `inflight` is also kept per key so API requests,
 * workers and notification scans share one upstream request.
 */
function createDeviceCollectorCache({ cacheAgeMs = () => 1_000, now = () => Date.now(), sampleId = null } = {}) {
    if (typeof cacheAgeMs !== 'function') throw new TypeError('cacheAgeMs must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    const entries = new Map();
    let sequence = 0;

    function newSampleId(name, timestamp) {
        if (typeof sampleId === 'function') return String(sampleId(name, timestamp, sequence += 1));
        sequence += 1;
        return `${name}:${timestamp}:${sequence}`;
    }

    function freshnessFor(name, entry, override) {
        const value = override === undefined ? cacheAgeMs(name, entry) : override;
        return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    }

    function entryFor(name) {
        let entry = entries.get(name);
        if (!entry) {
            entry = {
                data: undefined,
                lastAttemptAt: null,
                lastSuccessAt: null,
                lastErrorAt: null,
                lastError: null,
                consecutiveFailures: 0,
                inflight: null,
                sampleId: null,
                freshnessMs: null
            };
            entries.set(name, entry);
        }
        return entry;
    }

    function isFresh(name, entry, timestamp = now(), override) {
        if (!entry || entry.data === undefined || entry.lastSuccessAt == null) return false;
        const age = Math.max(0, timestamp - entry.lastSuccessAt);
        return age <= freshnessFor(name, entry, override);
    }

    function snapshot(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        const timestamp = now();
        // Re-evaluate the policy for diagnostics as activity can change from
        // active to idle without another upstream read.  A later read still
        // stores the effective value used for that request in the entry.
        const freshnessMs = freshnessFor(name, entry);
        const ageMs = entry.lastSuccessAt == null ? null : Math.max(0, timestamp - entry.lastSuccessAt);
        return {
            data: entry.data,
            lastAttemptAt: entry.lastAttemptAt,
            lastSuccessAt: entry.lastSuccessAt,
            lastErrorAt: entry.lastErrorAt,
            lastError: entry.lastError,
            consecutiveFailures: entry.consecutiveFailures,
            inflight: Boolean(entry.inflight),
            sampleId: entry.sampleId,
            freshnessMs,
            ageMs,
            fresh: isFresh(name, entry, timestamp, freshnessMs),
            stale: entry.data !== undefined && !isFresh(name, entry, timestamp, freshnessMs),
            healthy: entry.data !== undefined
                && entry.lastErrorAt == null
                && entry.consecutiveFailures === 0
                && isFresh(name, entry, timestamp, freshnessMs)
        };
    }

    function peek(name, { allowStale = true } = {}) {
        const current = entries.get(name);
        if (!current || current.data === undefined) return undefined;
        if (!allowStale && !isFresh(name, current)) return undefined;
        return current.data;
    }

    async function read(name, collect, {
        refresh = false,
        allowStale = false,
        freshnessMs
    } = {}) {
        if (typeof collect !== 'function') throw new TypeError('collect must be a function');
        const entry = entryFor(name);
        const timestamp = now();
        entry.freshnessMs = freshnessFor(name, entry, freshnessMs);

        // An existing request always wins, including for force refreshes.
        if (entry.inflight) return entry.inflight;
        if (!refresh && isFresh(name, entry, timestamp, entry.freshnessMs)) return entry.data;

        entry.lastAttemptAt = timestamp;
        const pending = Promise.resolve().then(collect).then(data => {
            if (data === undefined) throw new Error(`collector ${name} returned undefined`);
            const successAt = now();
            entry.data = data;
            entry.lastSuccessAt = successAt;
            entry.lastErrorAt = null;
            entry.lastError = null;
            entry.consecutiveFailures = 0;
            entry.sampleId = newSampleId(name, successAt);
            return data;
        }).catch(error => {
            entry.lastErrorAt = now();
            entry.lastError = error;
            entry.consecutiveFailures += 1;
            if (allowStale && entry.data !== undefined) return entry.data;
            throw error;
        }).finally(() => {
            if (entry.inflight === pending) entry.inflight = null;
        });
        entry.inflight = pending;
        return pending;
    }

    function invalidate(name) {
        if (name === undefined) entries.clear();
        else entries.delete(name);
    }

    return Object.freeze({
        read,
        peek,
        snapshot,
        invalidate,
        has: name => entries.has(name),
        names: () => [...entries.keys()]
    });
}

module.exports = { createDeviceCollectorCache };

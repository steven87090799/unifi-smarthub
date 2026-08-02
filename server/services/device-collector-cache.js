'use strict';

/**
 * A bounded process-local cache for read-only device collectors.
 *
 * Payload freshness and upstream health are deliberately separate.  The
 * upstream promise is shared, while each caller decides whether a rejection
 * may fall back to the retained payload.  This prevents an allowStale caller
 * from changing the contract seen by a strict caller.
 */
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_ENTRY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ESTIMATED_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 512;

function boundedText(value, max = MAX_ERROR_MESSAGE_LENGTH) {
    return String(value || '')
        .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
        .replace(/(token|password|passwd|secret|api[-_]?key|authorization|cookie)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
        .slice(0, max);
}

function safeError(error) {
    const source = error && typeof error === 'object' ? error : { message: error };
    const message = boundedText(source.message || source.code || 'upstream failure');
    const result = { name: boundedText(source.name || 'Error', 64), message };
    if (source.code !== undefined) result.code = boundedText(source.code, 64);
    if (source.status !== undefined && Number.isFinite(Number(source.status))) result.status = Number(source.status);
    return Object.freeze(result);
}

function defaultEstimateBytes(value) {
    if (value === undefined) return 0;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
    if (Buffer.isBuffer(value)) return value.byteLength;
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
    catch { return Number.MAX_SAFE_INTEGER; }
}

function createDeviceCollectorCache({
    cacheAgeMs = () => 1_000,
    now = () => Date.now(),
    sampleId = null,
    maxEntries = DEFAULT_MAX_ENTRIES,
    entryTtlMs = DEFAULT_ENTRY_TTL_MS,
    maxEstimatedBytes = DEFAULT_MAX_ESTIMATED_BYTES,
    estimateBytes = defaultEstimateBytes
} = {}) {
    if (typeof cacheAgeMs !== 'function') throw new TypeError('cacheAgeMs must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    if (!Number.isFinite(entryTtlMs) || entryTtlMs < 0) throw new TypeError('entryTtlMs must be a non-negative number');
    if (!Number.isFinite(maxEstimatedBytes) || maxEstimatedBytes < 1) throw new TypeError('maxEstimatedBytes must be positive');
    if (typeof estimateBytes !== 'function') throw new TypeError('estimateBytes must be a function');

    const entries = new Map();
    let sequence = 0;
    let estimatedBytes = 0;
    let evictionCount = 0;
    let expiredCount = 0;

    function newSampleId(name, timestamp) {
        if (typeof sampleId === 'function') return String(sampleId(name, timestamp, sequence += 1));
        sequence += 1;
        return `${name}:${timestamp}:${sequence}`;
    }

    function freshnessFor(name, entry, override) {
        if (override !== undefined) {
            return Number.isFinite(Number(override)) ? Math.max(0, Number(override)) : 0;
        }
        if (entry?.dynamicFreshness === false && entry.freshnessMs != null) return entry.freshnessMs;
        const value = cacheAgeMs(name, entry);
        return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    }

    function touch(entry, timestamp = now()) {
        entry.lastAccessAt = timestamp;
    }

    function entryFor(name) {
        let entry = entries.get(name);
        if (!entry) {
            const createdAt = now();
            entry = {
                data: undefined,
                estimatedBytes: 0,
                createdAt,
                lastAccessAt: createdAt,
                lastAttemptAt: null,
                lastSuccessAt: null,
                lastErrorAt: null,
                lastError: null,
                consecutiveFailures: 0,
                inflight: null,
                sampleId: null,
                freshnessMs: null,
                dynamicFreshness: true,
                scope: undefined,
                detached: false
            };
            entries.set(name, entry);
        }
        touch(entry);
        return entry;
    }

    function isFresh(name, entry, timestamp = now(), override) {
        if (!entry || entry.data === undefined || entry.lastSuccessAt == null) return false;
        const age = Math.max(0, timestamp - entry.lastSuccessAt);
        return age <= freshnessFor(name, entry, override);
    }

    function removeEntry(name, reason = null) {
        const entry = entries.get(name);
        if (!entry || entry.inflight) return false;
        entries.delete(name);
        estimatedBytes = Math.max(0, estimatedBytes - entry.estimatedBytes);
        if (reason === 'eviction') evictionCount += 1;
        if (reason === 'expired') expiredCount += 1;
        return true;
    }

    function purgeExpired(timestamp = now()) {
        if (entryTtlMs === Infinity) return;
        for (const [name, entry] of entries) {
            if (entry.inflight || entry.lastAccessAt == null) continue;
            if (timestamp - entry.lastAccessAt > entryTtlMs) removeEntry(name, 'expired');
        }
    }

    function evictToBounds(timestamp = now()) {
        purgeExpired(timestamp);
        while (entries.size > maxEntries || estimatedBytes > maxEstimatedBytes) {
            const candidate = [...entries.entries()]
                .filter(([, entry]) => !entry.inflight)
                .sort(([, left], [, right]) => (left.lastAccessAt || 0) - (right.lastAccessAt || 0))[0];
            if (!candidate) break;
            removeEntry(candidate[0], 'eviction');
        }
    }

    function buildSnapshot(name, entry) {
        if (!entry) return null;
        const timestamp = now();
        const freshnessMs = freshnessFor(name, entry);
        const ageMs = entry.lastSuccessAt == null ? null : Math.max(0, timestamp - entry.lastSuccessAt);
        const fresh = isFresh(name, entry, timestamp, freshnessMs);
        return {
            name,
            data: entry.data,
            hasData: entry.data !== undefined,
            lastAttemptAt: entry.lastAttemptAt,
            lastSuccessAt: entry.lastSuccessAt,
            lastErrorAt: entry.lastErrorAt,
            lastError: entry.lastError,
            consecutiveFailures: entry.consecutiveFailures,
            inflight: Boolean(entry.inflight),
            sampleId: entry.sampleId,
            createdAt: entry.createdAt,
            lastAccessAt: entry.lastAccessAt,
            freshnessMs,
            ageMs,
            estimatedBytes: entry.estimatedBytes,
            fresh,
            stale: entry.data !== undefined && !fresh,
            healthy: entry.data !== undefined
                && entry.lastErrorAt == null
                && entry.consecutiveFailures === 0
                && fresh
        };
    }

    function snapshot(name) {
        purgeExpired();
        const entry = entries.get(name);
        if (!entry) return null;
        touch(entry);
        return buildSnapshot(name, entry);
    }

    function peekSnapshot(name) {
        purgeExpired();
        return buildSnapshot(name, entries.get(name));
    }

    function peek(name, { allowStale = true } = {}) {
        purgeExpired();
        const current = entries.get(name);
        if (!current || current.data === undefined) return undefined;
        if (!allowStale && !isFresh(name, current)) return undefined;
        return current.data;
    }

    function storeSuccess(name, entry, data, successAt) {
        const bytes = Math.max(0, Number(estimateBytes(data)) || 0);
        estimatedBytes = Math.max(0, estimatedBytes - entry.estimatedBytes);
        entry.estimatedBytes = bytes <= maxEstimatedBytes ? bytes : 0;
        entry.data = bytes <= maxEstimatedBytes ? data : undefined;
        estimatedBytes += entry.estimatedBytes;
        entry.lastSuccessAt = successAt;
        entry.lastErrorAt = null;
        entry.lastError = null;
        entry.consecutiveFailures = 0;
        entry.sampleId = newSampleId(name, successAt);
        touch(entry, successAt);
        evictToBounds(successAt);
    }

    function startUpstream(name, entry, collect) {
        entry.lastAttemptAt = now();
        const upstreamPromise = Promise.resolve().then(collect).then(data => {
            if (data === undefined) throw new Error(`collector ${name} returned undefined`);
            if (entries.get(name) === entry && !entry.detached) storeSuccess(name, entry, data, now());
            return data;
        }).catch(error => {
            if (entries.get(name) === entry && !entry.detached) {
                entry.lastErrorAt = now();
                entry.lastError = safeError(error);
                entry.consecutiveFailures += 1;
                touch(entry);
            }
            throw error;
        }).finally(() => {
            if (entries.get(name) === entry) {
                if (entry.inflight === upstreamPromise) entry.inflight = null;
                evictToBounds();
            }
        });
        entry.inflight = upstreamPromise;
        return upstreamPromise;
    }

    async function read(name, collect, {
        refresh = false,
        allowStale = false,
        freshnessMs,
        scope,
        dynamicFreshness = freshnessMs === undefined
    } = {}) {
        if (typeof collect !== 'function') throw new TypeError('collect must be a function');
        purgeExpired();
        const entry = entryFor(name);
        if (scope !== undefined) entry.scope = scope;
        entry.dynamicFreshness = dynamicFreshness !== false;
        entry.freshnessMs = freshnessFor(name, entry, freshnessMs);
        const timestamp = now();
        const freshnessOverride = entry.dynamicFreshness ? undefined : freshnessMs;

        // The raw upstream promise is shared; stale policy is caller-local.
        const upstream = entry.inflight || (
            !refresh && isFresh(name, entry, timestamp, freshnessOverride)
                ? Promise.resolve(entry.data)
                : startUpstream(name, entry, collect)
        );
        try {
            return await upstream;
        } catch (error) {
            if (allowStale && entry.data !== undefined) return entry.data;
            throw error;
        }
    }

    function forceRemoveEntry(name) {
        const entry = entries.get(name);
        if (!entry) return false;
        entries.delete(name);
        estimatedBytes = Math.max(0, estimatedBytes - entry.estimatedBytes);
        entry.detached = true;
        return true;
    }

    function invalidate(name) {
        if (name === undefined) {
            let count = 0;
            for (const key of [...entries.keys()]) {
                if (forceRemoveEntry(key)) count += 1;
            }
            return count;
        }
        return forceRemoveEntry(name);
    }

    function invalidatePrefix(prefix) {
        const value = String(prefix);
        let count = 0;
        for (const name of [...entries.keys()]) {
            if (name.startsWith(value) && forceRemoveEntry(name)) count += 1;
        }
        return count;
    }

    function invalidateMatching(predicate) {
        if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
        purgeExpired();
        let count = 0;
        for (const [name, entry] of [...entries.entries()]) {
            if (predicate(name, buildSnapshot(name, entry)) && forceRemoveEntry(name)) count += 1;
        }
        return count;
    }

    function diagnostics() {
        purgeExpired();
        return {
            entryCount: entries.size,
            estimatedBytes,
            evictionCount,
            expiredCount,
            maxEntries,
            entryTtlMs,
            maxEstimatedBytes,
            inflightCount: [...entries.values()].filter(entry => Boolean(entry.inflight)).length
        };
    }

    return Object.freeze({
        read,
        peek,
        peekSnapshot,
        snapshot,
        invalidate,
        invalidatePrefix,
        invalidateMatching,
        diagnostics,
        has: name => { purgeExpired(); return entries.has(name); },
        names: () => { purgeExpired(); return [...entries.keys()]; },
        size: () => { purgeExpired(); return entries.size; }
    });
}

module.exports = {
    DEFAULT_ENTRY_TTL_MS,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_ESTIMATED_BYTES,
    createDeviceCollectorCache
};

'use strict';

const { formatWiimHost } = require('./wiim-config');

const CACHEABLE_COMMANDS = new Set([
    'getPlayerStatus', 'getMetaInfo', 'getStatusEx', 'getPresetInfo', 'getbtdiscoveryresult'
]);
const DEFAULT_FRESH_CACHE_MS = 2_000;
const DEFAULT_MAX_STALE_MS = 5 * 60 * 1_000;

function finiteTemperature(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function parseWiimTemperatures(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { cpu: null, board: null };
    return {
        cpu: finiteTemperature(data.temperature_cpu),
        board: finiteTemperature(data.temperature_tmp102)
    };
}

function resultShape({ data = null, source, fetchedAt = null, now, error = null }) {
    const ageMs = fetchedAt == null ? null : Math.max(0, now - fetchedAt);
    return {
        data,
        source,
        stale: source === 'stale_cache',
        fetchedAt,
        lastSuccessAt: fetchedAt,
        ageMs,
        error: error || undefined
    };
}

function createWiimClient({
    getIp,
    request,
    getAllowInsecureHttp = () => false,
    getAllowInsecureTls = () => false,
    now = () => Date.now(),
    freshCacheMs = DEFAULT_FRESH_CACHE_MS,
    maxStaleMs = DEFAULT_MAX_STALE_MS,
    onTransportError = () => {}
} = {}) {
    if (typeof getIp !== 'function') throw new TypeError('getIp is required');
    if (typeof request !== 'function') throw new TypeError('request is required');
    const cache = new Map();

    function reset() {
        cache.clear();
    }

    function peek(command) {
        const entry = cache.get(command);
        if (!entry) return null;
        const timestamp = now();
        const ageMs = Math.max(0, timestamp - entry.fetchedAt);
        if (ageMs > maxStaleMs) {
            cache.delete(command);
            return resultShape({ source: 'unreachable', now: timestamp });
        }
        const source = ageMs < freshCacheMs ? 'fresh_cache' : 'stale_cache';
        return resultShape({ data: entry.data, source, fetchedAt: entry.fetchedAt, now: timestamp });
    }

    async function get(command, { allowStale = true } = {}) {
        const ip = getIp();
        const timestamp = now();
        if (!ip) return resultShape({ source: 'not_configured', now: timestamp });
        const cacheable = CACHEABLE_COMMANDS.has(command);
        const cached = cacheable ? cache.get(command) : null;
        if (cached && timestamp - cached.fetchedAt < freshCacheMs) {
            return resultShape({ data: cached.data, source: 'fresh_cache', fetchedAt: cached.fetchedAt, now: timestamp });
        }

        let data = null;
        let lastError = null;
        try {
            data = await request({
                protocol: 'https:',
                host: formatWiimHost(ip),
                command,
                insecureTls: getAllowInsecureTls()
            });
        } catch (error) {
            lastError = error;
            onTransportError(error, { command, protocol: 'https:' });
            if (getAllowInsecureHttp()) {
                try {
                    data = await request({
                        protocol: 'http:',
                        host: formatWiimHost(ip),
                        command,
                        insecureTls: true
                    });
                } catch (httpError) {
                    lastError = httpError;
                    onTransportError(httpError, { command, protocol: 'http:' });
                }
            }
        }

        if (data !== null && data !== undefined) {
            const serialized = typeof data === 'string' ? data : JSON.stringify(data);
            const fetchedAt = now();
            if (cacheable) cache.set(command, { data: serialized, fetchedAt });
            return resultShape({ data: serialized, source: 'live', fetchedAt, now: fetchedAt });
        }

        const failedAt = now();
        const staleAge = cached ? Math.max(0, failedAt - cached.fetchedAt) : Infinity;
        if (allowStale && cached && staleAge <= maxStaleMs) {
            return resultShape({ data: cached.data, source: 'stale_cache', fetchedAt: cached.fetchedAt, now: failedAt, error: lastError?.code || lastError?.message });
        }
        if (cached && staleAge > maxStaleMs) cache.delete(command);
        return resultShape({ source: 'unreachable', now: failedAt, error: lastError?.code || lastError?.message });
    }

    return {
        get,
        peek,
        reset,
        cacheSize: () => cache.size,
        commands: CACHEABLE_COMMANDS
    };
}

module.exports = {
    CACHEABLE_COMMANDS,
    DEFAULT_FRESH_CACHE_MS,
    DEFAULT_MAX_STALE_MS,
    createWiimClient,
    parseWiimTemperatures
};

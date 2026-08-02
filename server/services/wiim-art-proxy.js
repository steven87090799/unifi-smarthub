'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const IMAGE_TYPE = /^image\/(?:avif|bmp|gif|jpeg|png|webp)$/iu;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_DNS_RECORDS = 32;

const IPV4_BLOCKED_RANGES = Object.freeze([
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
]);

// These ranges are not routable public artwork origins.  The transition and
// documentation prefixes are blocked as well so an encoded private endpoint
// cannot be smuggled through a seemingly public IPv6 address.
const IPV6_BLOCKED_RANGES = Object.freeze([
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
    ['2001:0::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
    ['2001:db8::', 32], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16]
]);

function stripBrackets(address) {
    return String(address || '').replace(/^\[|\]$/gu, '').toLowerCase();
}

function ipv4ToInteger(address) {
    const value = stripBrackets(address);
    if (net.isIP(value) !== 4) return null;
    const parts = value.split('.').map(Number);
    return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
        ? ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0
        : null;
}

function ipv6ToBigInt(address) {
    const value = stripBrackets(address);
    if (net.isIP(value) !== 6) return null;
    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const mapped = ipv4ToInteger(value.slice(lastColon + 1));
        if (lastColon < 0 || mapped === null) return null;
        const suffix = `${(mapped >>> 16).toString(16)}:${(mapped & 0xffff).toString(16)}`;
        return ipv6ToBigInt(`${value.slice(0, lastColon + 1)}${suffix}`);
    }
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
    const parts = [...left, ...Array(missing).fill('0'), ...right];
    if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
    return parts.reduce((result, part) => (result << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function parseIp(address) {
    const value = stripBrackets(address);
    const family = net.isIP(value);
    if (family === 4) {
        const numeric = ipv4ToInteger(value);
        return numeric === null ? null : { family, text: value, numeric };
    }
    if (family === 6) {
        const numeric = ipv6ToBigInt(value);
        return numeric === null ? null : { family, text: value, numeric };
    }
    return null;
}

function mappedIpv4Numeric(info) {
    if (!info || info.family !== 6) return null;
    const prefix = info.numeric >> 32n;
    if (prefix !== 0n && prefix !== 0xffffn) return null;
    return Number(info.numeric & 0xffffffffn) >>> 0;
}

function ipIdentity(address) {
    const info = typeof address === 'object' && address !== null ? address : parseIp(address);
    if (!info) return null;
    const mapped = mappedIpv4Numeric(info);
    return mapped === null ? `${info.family}:${info.numeric.toString(16)}` : `4:${mapped.toString(16)}`;
}

function canonicalAddress(address) {
    return ipIdentity(address);
}

function inIpv4Range(value, start, maskBits) {
    const base = ipv4ToInteger(start);
    if (value === null || base === null) return false;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (value & mask) === (base & mask);
}

function inIpv6Range(value, start, prefixBits) {
    const base = ipv6ToBigInt(start);
    if (value === null || base === null) return false;
    const shift = 128n - BigInt(prefixBits);
    return (value >> shift) === (base >> shift);
}

function isBlockedAddress(address) {
    const info = parseIp(address);
    if (!info) return true;
    const mapped = mappedIpv4Numeric(info);
    if (info.family === 4 || mapped !== null) {
        const value = info.family === 4 ? info.numeric : mapped;
        return IPV4_BLOCKED_RANGES.some(([start, bits]) => inIpv4Range(value, start, bits));
    }
    return IPV6_BLOCKED_RANGES.some(([start, bits]) => inIpv6Range(info.numeric, start, bits));
}

function configuredLiteralAllowed(hostname, address, allowedPrivateAddresses) {
    const host = parseIp(hostname);
    const resolved = parseIp(address);
    if (!host || !resolved) return false;
    const hostIdentity = ipIdentity(host);
    const resolvedIdentity = ipIdentity(resolved);
    const allowed = new Set((allowedPrivateAddresses || []).map(ipIdentity).filter(Boolean));
    return allowed.has(hostIdentity) && hostIdentity === resolvedIdentity;
}

function parseArtworkUrl(value) {
    let url;
    try { url = value instanceof URL ? new URL(value.toString()) : new URL(value); }
    catch { throw new Error('Artwork URL is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Artwork protocol is not allowed');
    if (url.username || url.password) throw new Error('Artwork URL credentials are not allowed');
    return url;
}

function normalizedRecord(record) {
    const info = parseIp(record?.address);
    if (!info) throw new Error('Artwork host resolution is invalid');
    return { address: info.text, family: info.family, identity: ipIdentity(info) };
}

async function resolvePublicArtworkUrl(value, {
    lookup = dns.lookup,
    allowedPrivateAddresses = [],
    maxDnsRecords = DEFAULT_MAX_DNS_RECORDS
} = {}) {
    const url = parseArtworkUrl(value);
    const hostname = stripBrackets(url.hostname);
    const literal = parseIp(hostname);
    const records = literal
        ? [{ address: literal.text, family: literal.family }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0 || records.length > maxDnsRecords) {
        throw new Error('Artwork host resolution is invalid');
    }
    const validatedRecords = records.map(normalizedRecord);
    const configuredLiteral = literal !== null
        && validatedRecords.length === 1
        && configuredLiteralAllowed(hostname, validatedRecords[0].address, allowedPrivateAddresses);
    const configuredPrivateLiteral = configuredLiteral && isBlockedAddress(validatedRecords[0].address);
    if (validatedRecords.some(record => isBlockedAddress(record.address)
        && !configuredLiteralAllowed(hostname, record.address, allowedPrivateAddresses))) {
        throw new Error('Artwork host resolves to a blocked address');
    }
    return {
        url,
        hostname,
        records: validatedRecords,
        address: validatedRecords[0].address,
        family: validatedRecords[0].family,
        configuredLiteral,
        configuredPrivateLiteral,
        allowInsecureTls: configuredLiteral
    };
}

function createPinnedLookup(validatedRecords) {
    const records = validatedRecords.map(normalizedRecord);
    return function pinnedLookup(_hostname, options, callback) {
        let lookupOptions = options;
        let done = callback;
        if (typeof lookupOptions === 'function') {
            done = lookupOptions;
            lookupOptions = {};
        }
        const requestedFamily = Number(lookupOptions?.family || 0);
        const candidates = requestedFamily === 4 || requestedFamily === 6
            ? records.filter(record => record.family === requestedFamily)
            : requestedFamily === 0 ? records : [];
        const complete = () => {
            if (!candidates.length) {
                const error = new Error(`Pinned artwork host has no IPv${requestedFamily} candidate`);
                error.code = 'EAI_FAMILY';
                done(error);
                return;
            }
            if (lookupOptions?.all === true) {
                done(null, candidates.map(({ address, family }) => ({ address, family })));
                return;
            }
            const [first] = candidates;
            done(null, first.address, first.family);
        };
        process.nextTick(complete);
    };
}

function pinnedAgent(target, { allowInsecureTls = false } = {}) {
    const lookup = createPinnedLookup(target.records);
    return target.url.protocol === 'https:'
        ? new https.Agent({ lookup, rejectUnauthorized: !allowInsecureTls })
        : new http.Agent({ lookup });
}

function abortError() {
    const error = new Error('Artwork request aborted');
    error.code = 'ARTWORK_ABORTED';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

async function readLimitedStream(stream, maxBytes, signal) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('Artwork response stream is invalid');
    const chunks = [];
    let total = 0;
    const onAbort = () => stream.destroy?.(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        throwIfAborted(signal);
        for await (const chunk of stream) {
            throwIfAborted(signal);
            const buffer = Buffer.from(chunk);
            total += buffer.length;
            if (total > maxBytes) {
                stream.destroy?.();
                throw new Error('Artwork exceeds the download limit');
            }
            chunks.push(buffer);
        }
    } catch (error) {
        stream.destroy?.();
        throw error;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
    return Buffer.concat(chunks, total);
}

function contentLengthValue(value) {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    if (!/^\d+$/u.test(text)) throw new Error('Artwork content length is invalid');
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) throw new Error('Artwork content length is invalid');
    return parsed;
}

async function fetchArtwork(value, {
    axiosInstance,
    lookup,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 6000,
    allowedPrivateAddresses = [],
    allowInsecureTls = false,
    allowInsecureHttp = false,
    signal
} = {}) {
    if (!axiosInstance || typeof axiosInstance.get !== 'function') throw new TypeError('axiosInstance is required');
    let current = parseArtworkUrl(value);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        throwIfAborted(signal);
        const target = await resolvePublicArtworkUrl(current, { lookup, allowedPrivateAddresses });
        if (current.protocol === 'http:' && (!allowInsecureHttp || !target.configuredPrivateLiteral)) {
            throw new Error('Artwork HTTP is only enabled for the configured WiiM address');
        }
        const agent = target.url.protocol === 'https:'
            ? pinnedAgent(target, { allowInsecureTls: allowInsecureTls && target.allowInsecureTls })
            : pinnedAgent(target);
        try {
            const response = await axiosInstance.get(target.url.toString(), {
                responseType: 'stream', maxRedirects: 0, timeout: timeoutMs,
                // A configured literal WiiM address is LAN egress and must
                // never inherit an ambient proxy. Public CDN requests use
                // the caller's policy-bound Internet Axios client.
                ...(target.configuredPrivateLiteral ? { proxy: false } : {}),
                signal, validateStatus: () => true,
                ...(target.url.protocol === 'https:' ? { httpsAgent: agent } : { httpAgent: agent }),
                headers: { 'User-Agent': 'wiim-temp/2.0' }
            });
            if (REDIRECT_STATUS.has(response.status)) {
                response.data?.destroy?.();
                const location = response.headers?.location;
                if (!location || redirect === maxRedirects) throw new Error('Artwork redirect limit exceeded');
                current = parseArtworkUrl(new URL(location, target.url));
                continue;
            }
            if (response.status < 200 || response.status >= 300) {
                response.data?.destroy?.();
                throw new Error('Artwork request failed');
            }
            const type = String(response.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
            if (!IMAGE_TYPE.test(type)) {
                response.data?.destroy?.();
                throw new Error('Artwork response is not an image');
            }
            const contentLength = contentLengthValue(response.headers?.['content-length']);
            if (contentLength !== null && contentLength > maxBytes) {
                response.data?.destroy?.();
                throw new Error('Artwork exceeds the download limit');
            }
            return { type, buffer: await readLimitedStream(response.data, maxBytes, signal) };
        } finally {
            agent.destroy?.();
        }
    }
    throw new Error('Artwork redirect limit exceeded');
}

function createArtworkCache({
    maxEntries = 20,
    maxItemBytes = DEFAULT_MAX_BYTES,
    maxBytes = 10 * 1024 * 1024,
    ttlMs = 5 * 60 * 1000,
    now = () => Date.now()
} = {}) {
    const entries = new Map();
    let totalBytes = 0;
    function remove(key) {
        const entry = entries.get(key);
        if (!entry) return;
        totalBytes -= entry.buffer.length;
        entries.delete(key);
    }
    function prune(timestamp = now()) {
        for (const [key, entry] of entries) if (timestamp - entry.ts >= ttlMs) remove(key);
        while (entries.size > maxEntries || totalBytes > maxBytes) remove(entries.keys().next().value);
    }
    return {
        get(key) {
            prune();
            const entry = entries.get(key);
            if (!entry) return null;
            entries.delete(key); entries.set(key, entry);
            return entry;
        },
        set(key, entry) {
            if (!entry?.buffer || entry.buffer.length > maxItemBytes) throw new Error('Artwork cache item exceeds the limit');
            remove(key);
            entries.set(key, { ...entry, ts: now() });
            totalBytes += entry.buffer.length;
            prune();
        },
        size: () => entries.size,
        totalBytes: () => totalBytes
    };
}

function createArtworkFetcher({
    fetch = fetchArtwork,
    cache = createArtworkCache(),
    maxConcurrent = 4,
    maxQueue = 16,
    deadlineMs = 7000
} = {}) {
    if (typeof fetch !== 'function') throw new TypeError('fetch is required');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be positive');
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new TypeError('maxQueue must be non-negative');
    const inFlight = new Map();
    const queue = [];
    let active = 0;

    function pump() {
        while (active < maxConcurrent && queue.length) {
            const item = queue.shift();
            active += 1;
            void (async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), deadlineMs);
                timer.unref?.();
                try {
                    const result = await fetch(item.value, { ...item.options, signal: controller.signal });
                    cache.set(item.key, result);
                    item.resolve(result);
                } catch (error) {
                    item.reject(error);
                } finally {
                    clearTimeout(timer);
                    active -= 1;
                    inFlight.delete(item.key);
                    pump();
                }
            })();
        }
    }

    function fetchCached(key, value, options = {}) {
        const hit = cache.get(key);
        if (hit) return Promise.resolve(hit);
        const existing = inFlight.get(key);
        if (existing) return existing;
        if (active >= maxConcurrent && queue.length >= maxQueue) {
            return Promise.reject(new Error('Artwork fetch concurrency limit exceeded'));
        }
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        inFlight.set(key, promise);
        queue.push({ key, value, options, resolve, reject });
        pump();
        return promise;
    }

    return {
        fetch: fetchCached,
        cache,
        active: () => active,
        queued: () => queue.length,
        inFlight: () => inFlight.size
    };
}

module.exports = {
    canonicalAddress,
    createArtworkCache,
    createArtworkFetcher,
    createPinnedLookup,
    fetchArtwork,
    ipIdentity,
    isBlockedAddress,
    parseArtworkUrl,
    parseIp,
    resolvePublicArtworkUrl
};

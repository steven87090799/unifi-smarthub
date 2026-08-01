'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const IMAGE_TYPE = /^image\/(?:avif|bmp|gif|jpeg|png|webp)$/iu;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function ipv4ToInteger(address) {
    const parts = String(address).split('.').map(Number);
    return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
        ? ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0
        : null;
}

function inIpv4Range(address, start, maskBits) {
    const value = ipv4ToInteger(address);
    const base = ipv4ToInteger(start);
    if (value === null || base === null) return false;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (value & mask) === (base & mask);
}

function ipv6ToBigInt(address) {
    const value = String(address || '').toLowerCase().replace(/^\[|\]$/gu, '');
    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const mapped = ipv4ToInteger(value.slice(lastColon + 1));
        if (mapped === null) return null;
        return ipv6ToBigInt(`${value.slice(0, lastColon + 1)}${(mapped >>> 16).toString(16)}:${(mapped & 0xffff).toString(16)}`);
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

function inIpv6Range(address, start, prefixBits) {
    const value = ipv6ToBigInt(address);
    const base = ipv6ToBigInt(start);
    if (value === null || base === null) return false;
    const shift = 128n - BigInt(prefixBits);
    return (value >> shift) === (base >> shift);
}

function ipv4MappedIpv6(address) {
    const value = String(address || '').toLowerCase().replace(/^\[|\]$/gu, '');
    if (!value.includes(':') || !value.includes('.')) return null;
    const lastColon = value.lastIndexOf(':');
    const mapped = ipv4ToInteger(value.slice(lastColon + 1));
    if (mapped === null) return null;
    const prefix = value.slice(0, lastColon).replace(/:+$/u, '');
    if (prefix !== '::ffff' && prefix !== '0:0:0:0:0:ffff') return null;
    return `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
}

function canonicalAddress(address) {
    return ipv4MappedIpv6(address) || String(address || '').toLowerCase().replace(/^\[|\]$/gu, '');
}

function isBlockedAddress(address) {
    const normalized = canonicalAddress(address);
    if (net.isIP(normalized) === 4) {
        return [
            ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
            ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
            ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
            ['224.0.0.0', 4], ['240.0.0.0', 4]
        ].some(([start, bits]) => inIpv4Range(normalized, start, bits));
    }
    if (net.isIP(normalized) !== 6) return true;
    return [
        ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
        ['2001:0::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32]
    ].some(([start, bits]) => inIpv6Range(normalized, start, bits));
}

function parseArtworkUrl(value) {
    let url;
    try { url = value instanceof URL ? new URL(value.toString()) : new URL(value); }
    catch { throw new Error('Artwork URL is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Artwork protocol is not allowed');
    if (url.username || url.password) throw new Error('Artwork URL credentials are not allowed');
    return url;
}

function configuredLiteralAllowed(hostname, address, allowedPrivateAddresses) {
    const allowed = new Set((allowedPrivateAddresses || []).map(canonicalAddress));
    const host = canonicalAddress(hostname);
    const resolved = canonicalAddress(address);
    return net.isIP(hostname) !== 0 && allowed.has(host) && host === resolved;
}

async function resolvePublicArtworkUrl(value, { lookup = dns.lookup, allowedPrivateAddresses = [] } = {}) {
    const url = parseArtworkUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    const records = net.isIP(hostname)
        ? [{ address: hostname, family: net.isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0 || records.length > 32) {
        throw new Error('Artwork host resolution is invalid');
    }
    if (records.some(record => !record || net.isIP(record.address) === 0)) {
        throw new Error('Artwork host resolution is invalid');
    }
    if (records.some(record => isBlockedAddress(record.address)
        && !configuredLiteralAllowed(hostname, record.address, allowedPrivateAddresses))) {
        throw new Error('Artwork host resolves to a blocked address');
    }
    const address = records[0].address;
    return {
        url,
        address,
        family: records[0].family || net.isIP(address),
        allowInsecureTls: configuredLiteralAllowed(hostname, address, allowedPrivateAddresses)
    };
}

function pinnedAgent(target, { allowInsecureTls = false } = {}) {
    const lookup = (_hostname, _options, callback) => callback(null, target.address, target.family);
    return target.url.protocol === 'https:'
        ? new https.Agent({ lookup, rejectUnauthorized: !allowInsecureTls })
        : new http.Agent({ lookup });
}

async function readLimitedStream(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of stream) {
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
    }
    return Buffer.concat(chunks, total);
}

async function fetchArtwork(value, {
    axiosInstance,
    lookup,
    maxRedirects = 3,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 6000,
    allowedPrivateAddresses = [],
    allowInsecureTls = false,
    allowInsecureHttp = false
} = {}) {
    if (!axiosInstance || typeof axiosInstance.get !== 'function') throw new TypeError('axiosInstance is required');
    let current = parseArtworkUrl(value);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        if (current.protocol === 'http:' && !allowInsecureHttp) throw new Error('Artwork HTTP is not enabled');
        const target = await resolvePublicArtworkUrl(current, { lookup, allowedPrivateAddresses });
        const response = await axiosInstance.get(target.url.toString(), {
            responseType: 'stream', maxRedirects: 0, timeout: timeoutMs, proxy: false,
            validateStatus: () => true,
            ...(target.url.protocol === 'https:'
                ? { httpsAgent: pinnedAgent(target, { allowInsecureTls: allowInsecureTls && target.allowInsecureTls }) }
                : { httpAgent: pinnedAgent(target) }),
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
        const contentLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > maxBytes)) {
            response.data?.destroy?.();
            throw new Error('Artwork exceeds the download limit');
        }
        return { type, buffer: await readLimitedStream(response.data, maxBytes) };
    }
    throw new Error('Artwork redirect limit exceeded');
}

function createArtworkCache({ maxEntries = 20, maxItemBytes = DEFAULT_MAX_BYTES, maxBytes = 10 * 1024 * 1024, ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
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

module.exports = {
    canonicalAddress,
    createArtworkCache,
    fetchArtwork,
    isBlockedAddress,
    parseArtworkUrl,
    resolvePublicArtworkUrl
};

'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const IMAGE_TYPE = /^image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|webp)$/i;

function ipv4ToInteger(address) {
    const parts = address.split('.').map(Number);
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

function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        return [
            ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
            ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
            ['198.18.0.0', 15], ['224.0.0.0', 4]
        ].some(([start, bits]) => inIpv4Range(address, start, bits));
    }
    if (family !== 6) return true;
    const normalized = address.toLowerCase().replace(/^::ffff:/, '');
    if (net.isIP(normalized) === 4) return isBlockedAddress(normalized);
    return normalized === '::' || normalized === '::1'
        || normalized.startsWith('fe8') || normalized.startsWith('fe9')
        || normalized.startsWith('fea') || normalized.startsWith('feb')
        || normalized.startsWith('fc') || normalized.startsWith('fd')
        || normalized.startsWith('ff');
}

function parseArtworkUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Artwork protocol is not allowed');
    if (url.username || url.password) throw new Error('Artwork URL credentials are not allowed');
    return url;
}

async function resolvePublicArtworkUrl(value, { lookup = dns.lookup } = {}) {
    const url = value instanceof URL ? value : parseArtworkUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const records = net.isIP(hostname)
        ? [{ address: hostname, family: net.isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0 || records.some(record => isBlockedAddress(record.address))) {
        throw new Error('Artwork host resolves to a blocked address');
    }
    return { url, address: records[0].address, family: records[0].family || net.isIP(records[0].address) };
}

function pinnedAgent(target) {
    const lookup = (_hostname, _options, callback) => callback(null, target.address, target.family);
    return target.url.protocol === 'https:'
        ? new https.Agent({ lookup })
        : new http.Agent({ lookup });
}

async function readLimitedStream(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of stream) {
            total += chunk.length;
            if (total > maxBytes) {
                stream.destroy?.();
                throw new Error('Artwork exceeds the download limit');
            }
            chunks.push(Buffer.from(chunk));
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
    maxBytes = 2 * 1024 * 1024,
    timeoutMs = 6000
} = {}) {
    if (!axiosInstance) throw new TypeError('axiosInstance is required');
    let current = parseArtworkUrl(value);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        const target = await resolvePublicArtworkUrl(current, { lookup });
        const response = await axiosInstance.get(target.url.toString(), {
            responseType: 'stream', maxRedirects: 0, timeout: timeoutMs,
            validateStatus: () => true,
            [target.url.protocol === 'https:' ? 'httpsAgent' : 'httpAgent']: pinnedAgent(target),
            headers: { 'User-Agent': 'wiim-temp/2.0' }
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            response.data?.destroy?.();
            const location = response.headers?.location;
            if (!location || redirect === maxRedirects) throw new Error('Artwork redirect limit exceeded');
            current = new URL(location, target.url);
            continue;
        }
        if (response.status < 200 || response.status >= 300) {
            response.data?.destroy?.();
            throw new Error(`Artwork request failed (${response.status})`);
        }
        const type = String(response.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (!IMAGE_TYPE.test(type)) {
            response.data?.destroy?.();
            throw new Error('Artwork response is not an image');
        }
        const contentLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            response.data?.destroy?.();
            throw new Error('Artwork exceeds the download limit');
        }
        return { type, buffer: await readLimitedStream(response.data, maxBytes) };
    }
    throw new Error('Artwork redirect limit exceeded');
}

function createArtworkCache({ maxEntries = 20, maxItemBytes = 2 * 1024 * 1024, maxBytes = 10 * 1024 * 1024, ttlMs = 5 * 60 * 1000 } = {}) {
    const entries = new Map();
    let totalBytes = 0;
    function remove(key) {
        const entry = entries.get(key);
        if (!entry) return;
        totalBytes -= entry.buffer.length;
        entries.delete(key);
    }
    function prune(now = Date.now()) {
        for (const [key, entry] of entries) if (now - entry.ts >= ttlMs) remove(key);
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
            entries.set(key, { ...entry, ts: Date.now() });
            totalBytes += entry.buffer.length;
            prune();
        },
        size: () => entries.size,
        totalBytes: () => totalBytes
    };
}

module.exports = { createArtworkCache, fetchArtwork, isBlockedAddress, parseArtworkUrl, resolvePublicArtworkUrl };

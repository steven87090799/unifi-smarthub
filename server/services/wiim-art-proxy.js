'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const MAX_ART_BYTES = 5 * 1024 * 1024;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const MAX_CACHE_ITEMS = 20;
const ALLOWED_TYPES = new Map([
    ['image/jpeg', 'jpeg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']
]);

function normalizeHost(value) {
    return String(value || '').trim().toLowerCase().replace(/\.$/u, '');
}

function ipv4Unsafe(address) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

function ipv6Unsafe(address) {
    const normalized = normalizeHost(address);
    if (normalized === '::' || normalized === '::1') return true;
    if (/^fe[89ab]/u.test(normalized) || /^f[cd]/u.test(normalized) || /^ff/u.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
    return !!mapped && ipv4Unsafe(mapped[1]);
}

function publicAddress(address) {
    const family = net.isIP(address);
    return family === 4 ? !ipv4Unsafe(address) : family === 6 ? !ipv6Unsafe(address) : false;
}

function sniffImage(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buffer.length >= 12 && buffer.subarray(0, 4).equals(Buffer.from('RIFF')) && buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'webp';
    if (buffer.length >= 6 && (buffer.subarray(0, 6).equals(Buffer.from('GIF87a')) || buffer.subarray(0, 6).equals(Buffer.from('GIF89a')))) return 'gif';
    return null;
}

function contentType(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function createWiimArtProxy({
    getKnownHost = () => '', getAllowedHosts = () => '', resolve = dns.promises.lookup,
    request = (url, options, callback) => (url.protocol === 'https:' ? https : http).request(url, options, callback),
    now = () => Date.now(), maxBytes = MAX_ART_BYTES, maxCacheBytes = MAX_CACHE_BYTES,
    maxCacheItems = MAX_CACHE_ITEMS, timeoutMs = 6000
} = {}) {
    const cache = new Map();
    const inflight = new Map();
    let cacheBytes = 0;

    function allowedHosts() {
        return new Set(String(getAllowedHosts() || '').split(',').map(normalizeHost).filter(Boolean));
    }

    async function resolveTarget(url) {
        const host = normalizeHost(url.hostname);
        const known = normalizeHost(getKnownHost());
        const localKnown = host && host === known;
        if (!localKnown && !allowedHosts().has(host)) throw new Error('art host is not allowlisted');
        const records = await resolve(host, { all: true, verbatim: true });
        if (!Array.isArray(records) || records.length === 0 || records.length > 16) throw new Error('art host has no bounded DNS result');
        const addresses = records.map(record => String(record.address || '')).filter(address => net.isIP(address));
        if (addresses.length !== records.length) throw new Error('art DNS result is invalid');
        if (!localKnown && addresses.some(address => !publicAddress(address))) throw new Error('art host resolves to a forbidden address');
        if (localKnown && net.isIP(known) && addresses.some(address => address !== known)) throw new Error('known WiiM host resolution changed');
        return { address: addresses[0], family: net.isIP(addresses[0]) };
    }

    function cacheKey(url, version) { return `${url.toString()}|${String(version || '').slice(0, 256)}`; }
    function secretBearing(url) { return /(?:^|[?&])(token|key|signature|auth|password|secret|access_token)=/iu.test(url.search); }
    function evict() {
        while (cache.size > maxCacheItems || cacheBytes > maxCacheBytes) {
            const key = cache.keys().next().value;
            const value = cache.get(key);
            cache.delete(key);
            cacheBytes -= value?.buffer.length || 0;
        }
    }
    function get(key) {
        const entry = cache.get(key);
        if (!entry || entry.expiresAt <= now()) {
            if (entry) { cache.delete(key); cacheBytes -= entry.buffer.length; }
            return null;
        }
        cache.delete(key); cache.set(key, entry);
        return entry;
    }
    function put(key, value) {
        if (value.buffer.length > maxBytes || value.buffer.length > maxCacheBytes) return;
        cache.set(key, { ...value, expiresAt: now() + 5 * 60 * 1000 });
        cacheBytes += value.buffer.length;
        evict();
    }

    async function download(url, signal) {
        const target = await resolveTarget(url);
        return new Promise((resolvePromise, rejectPromise) => {
            let settled = false;
            const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
            const abort = () => requestHandle.destroy(new Error('art download aborted'));
            const requestHandle = request(url, {
                method: 'GET', headers: { 'User-Agent': 'smarthub-art-proxy/3.0', Accept: 'image/jpeg,image/png,image/webp,image/gif' },
                timeout: timeoutMs, maxRedirects: 0,
                lookup: (_hostname, _options, callback) => callback(null, target.address, target.family)
            }, response => {
                const status = Number(response.statusCode || 0);
                if (status < 200 || status >= 300) { response.resume(); settle(rejectPromise, new Error('art upstream status rejected')); return; }
                const type = contentType(response.headers['content-type']);
                if (!ALLOWED_TYPES.has(type)) { response.resume(); settle(rejectPromise, new Error('art content type rejected')); return; }
                const length = Number(response.headers['content-length']);
                if (Number.isFinite(length) && (length < 1 || length > maxBytes)) { response.resume(); settle(rejectPromise, new Error('art content length rejected')); return; }
                const chunks = []; let bytes = 0;
                response.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > maxBytes) { response.destroy(new Error('art body exceeds limit')); return; }
                    chunks.push(chunk);
                });
                response.once('error', error => settle(rejectPromise, error));
                response.once('end', () => {
                    const buffer = Buffer.concat(chunks, bytes);
                    if (!buffer.length || sniffImage(buffer) !== ALLOWED_TYPES.get(type)) {
                        settle(rejectPromise, new Error('art magic bytes rejected')); return;
                    }
                    settle(resolvePromise, { buffer, type });
                });
            });
            requestHandle.once('timeout', () => requestHandle.destroy(new Error('art request timeout')));
            requestHandle.once('error', error => settle(rejectPromise, error));
            if (signal) {
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
            }
            requestHandle.end();
        });
    }

    async function fetch(urlValue, version, { signal } = {}) {
        const url = new URL(urlValue);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('art URL rejected');
        const key = cacheKey(url, version);
        const hit = get(key);
        if (hit) return hit;
        if (inflight.has(key)) return inflight.get(key);
        const promise = download(url, signal).then(value => {
            if (!secretBearing(url)) put(key, value);
            return value;
        }).finally(() => inflight.delete(key));
        inflight.set(key, promise);
        return promise;
    }
    return Object.freeze({ fetch, diagnostics: () => ({ cacheItems: cache.size, cacheBytes, inflight: inflight.size, maxBytes, maxCacheBytes, maxCacheItems }) });
}

module.exports = { ALLOWED_TYPES, MAX_ART_BYTES, MAX_CACHE_BYTES, MAX_CACHE_ITEMS, createWiimArtProxy, publicAddress, sniffImage };

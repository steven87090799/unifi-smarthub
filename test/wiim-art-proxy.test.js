'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const axios = require('axios');
const {
    createArtworkCache,
    createArtworkFetcher,
    createPinnedLookup,
    fetchArtwork,
    isBlockedAddress,
    resolvePublicArtworkUrl,
    parseIp,
    ipIdentity
} = require('../server/services/wiim-art-proxy');

const image = (body = 'image') => Readable.from([Buffer.from(body)]);

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function close(server) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('blocks private, mapped, special, documentation, and multicast addresses', async () => {
    for (const address of [
        '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
        '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
        '224.0.0.1', '::', '::1', '::192.168.0.1', '::ffff:192.168.0.1', 'fc00::1', 'fe80::1', 'ff02::1',
        '2001:db8::1', '2001:2::1', '::ffff:7f00:1', '64:ff9b::c000:0201', '2002:c000:0201::1'
    ]) assert.equal(isBlockedAddress(address), true, address);
    for (const address of ['8.8.8.8', '2001:4860:4860::8888']) assert.equal(isBlockedAddress(address), false, address);
    await assert.rejects(
        resolvePublicArtworkUrl('https://cdn.example.test/art.png', {
            lookup: async () => [{ address: '192.168.0.170', family: 4 }]
        }),
        /blocked/u
    );
});

test('IPv4-compatible and mapped IPv6 spellings share semantic identities', () => {
    assert.equal(ipIdentity('::192.0.2.1'), ipIdentity('192.0.2.1'));
    assert.equal(ipIdentity('::c000:201'), ipIdentity('192.0.2.1'));
    assert.equal(ipIdentity('::ffff:192.168.0.1'), ipIdentity('::ffff:c0a8:1'));
    assert.equal(ipIdentity('::ffff:192.168.0.1'), ipIdentity('192.168.0.1'));
});

test('allows only the configured literal WiiM address inside blocked ranges and pins DNS', async () => {
    const target = await resolvePublicArtworkUrl('https://192.168.0.170/art.png', {
        allowedPrivateAddresses: ['192.168.0.170']
    });
    assert.equal(target.address, '192.168.0.170');
    await assert.rejects(
        resolvePublicArtworkUrl('https://wiim.example.test/art.png', {
            allowedPrivateAddresses: ['192.168.0.170'],
            lookup: async () => [{ address: '192.168.0.170', family: 4 }]
        }),
        /blocked/u
    );
});

test('pinned HTTP agent completes a real local socket request at the validated address', async () => {
    let remoteAddress = null;
    const server = http.createServer((request, response) => {
        remoteAddress = request.socket.remoteAddress;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('local-image');
    });
    const port = await listen(server);
    try {
        const result = await fetchArtwork(`http://127.0.0.1:${port}/art.png`, {
            axiosInstance: axios,
            allowInsecureHttp: true,
            allowedPrivateAddresses: ['127.0.0.1']
        });
        assert.equal(result.type, 'image/png');
        assert.equal(result.buffer.toString(), 'local-image');
        assert.equal(remoteAddress, '127.0.0.1');
    } finally {
        await close(server);
    }
});

test('validates redirects, MIME, content length, actual bytes, and explicit HTTP opt-in', async () => {
    const requests = [];
    const axiosInstance = {
        get: async (url, options) => {
            requests.push({ url, options });
            if (requests.length === 1) return { status: 302, headers: { location: 'https://cdn.example.test/final.png' }, data: image() };
            return { status: 200, headers: { 'content-type': 'image/png', 'content-length': '5' }, data: image('hello') };
        }
    };
    const result = await fetchArtwork('https://cdn.example.test/start.png', {
        axiosInstance,
        lookup: async host => [{ address: host === 'cdn.example.test' ? '8.8.8.8' : '1.1.1.1', family: 4 }]
    });
    assert.equal(result.type, 'image/png');
    assert.equal(result.buffer.toString(), 'hello');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.maxRedirects, 0);
    assert.equal(Object.hasOwn(requests[0].options, 'proxy'), false, 'public artwork must use the Internet client policy');
    assert.equal(requests[0].options.httpsAgent.options.rejectUnauthorized, true);
    await assert.rejects(fetchArtwork('http://cdn.example.test/art.png', { axiosInstance, lookup: async () => [{ address: '8.8.8.8', family: 4 }] }), /HTTP/u);
    await assert.rejects(fetchArtwork('http://cdn.example.test/art.png', {
        axiosInstance: { get: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: image('<x>') }) },
        allowInsecureHttp: true,
        lookup: async () => [{ address: '8.8.8.8', family: 4 }]
    }), /HTTP/u);
    await assert.rejects(fetchArtwork('http://192.168.0.170/art.png', {
        axiosInstance: { get: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: image('<x>') }) },
        allowInsecureHttp: true,
        allowedPrivateAddresses: ['192.168.0.170'],
        lookup: async () => [{ address: '192.168.0.170', family: 4 }]
    }), /not an image/u);
    let redirectCount = 0;
    const localRedirect = await fetchArtwork('https://192.168.0.170/start.png', {
        axiosInstance: { get: async url => {
            redirectCount += 1;
            return redirectCount === 1
                ? { status: 302, headers: { location: 'http://192.168.0.170/final.png' }, data: image() }
                : { status: 200, headers: { 'content-type': 'image/png' }, data: image('local') };
        } },
        allowInsecureHttp: true,
        allowedPrivateAddresses: ['192.168.0.170'],
        lookup: async () => [{ address: '192.168.0.170', family: 4 }]
    });
    assert.equal(localRedirect.buffer.toString(), 'local');
});

test('configured private artwork requests retain the LAN no-proxy boundary', async () => {
    let requestOptions;
    await fetchArtwork('https://192.168.0.170/art.png', {
        axiosInstance: { get: async (_url, options) => {
            requestOptions = options;
            return { status: 200, headers: { 'content-type': 'image/png' }, data: image('local') };
        } },
        allowedPrivateAddresses: ['192.168.0.170'],
        lookup: async () => [{ address: '192.168.0.170', family: 4 }]
    });
    assert.equal(requestOptions.proxy, false);
});

test('rejects oversized content and keeps a deterministic bounded LRU cache', async () => {
    const axiosInstance = { get: async () => ({ status: 200, headers: { 'content-type': 'image/jpeg' }, data: image('123456') }) };
    await assert.rejects(fetchArtwork('https://cdn.example.test/art.jpg', {
        axiosInstance, maxBytes: 5, lookup: async () => [{ address: '8.8.8.8', family: 4 }]
    }), /download limit/u);
    let now = 0;
    const cache = createArtworkCache({ maxEntries: 2, maxItemBytes: 4, maxBytes: 6, ttlMs: 10, now: () => now });
    cache.set('a', { type: 'image/png', buffer: Buffer.from('aa') });
    cache.set('b', { type: 'image/png', buffer: Buffer.from('bb') });
    assert.equal(cache.get('a').buffer.toString(), 'aa');
    cache.set('c', { type: 'image/png', buffer: Buffer.from('cc') });
    assert.equal(cache.get('b'), null);
    assert.equal(cache.totalBytes(), 4);
    now = 11;
    assert.equal(cache.get('a'), null);
});

test('pinned lookup honors family/all options without resolving again', async () => {
    const lookup = createPinnedLookup([
        { address: '8.8.8.8', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 }
    ]);
    const scalar = await new Promise((resolve, reject) => lookup('cdn.example', { family: 6 }, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(scalar, { address: '2001:4860:4860::8888', family: 6 });
    const all = await new Promise((resolve, reject) => lookup('cdn.example', { all: true }, (error, records) => error ? reject(error) : resolve(records)));
    assert.deepEqual(all, [
        { address: '8.8.8.8', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 }
    ]);
    await assert.rejects(new Promise((resolve, reject) => lookup('cdn.example', { family: 5 }, (error, address) => error ? reject(error) : resolve(address))), error => error.code === 'EAI_FAMILY');
});

test('artwork fetcher deduplicates keys and bounds active work and queue', async () => {
    let active = 0;
    let peak = 0;
    const cache = createArtworkCache({ maxEntries: 8 });
    const fetcher = createArtworkFetcher({
        cache,
        maxConcurrent: 1,
        maxQueue: 1,
        deadlineMs: 1000,
        fetch: async value => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return { type: 'image/png', buffer: Buffer.from(value) };
        }
    });
    const first = fetcher.fetch('same', 'aa');
    assert.equal(first, fetcher.fetch('same', 'aa'));
    const queued = fetcher.fetch('queued', 'bb');
    await assert.rejects(fetcher.fetch('overflow', 'cc'), /concurrency limit/u);
    assert.equal((await first).buffer.toString(), 'aa');
    assert.equal((await queued).buffer.toString(), 'bb');
    assert.equal(peak, 1);
    assert.equal(fetcher.active(), 0);
    assert.equal(fetcher.queued(), 0);
    assert.equal(fetcher.inFlight(), 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
    createArtworkCache,
    fetchArtwork,
    isBlockedAddress,
    resolvePublicArtworkUrl
} = require('../server/services/wiim-art-proxy');

const image = (body = 'image') => Readable.from([Buffer.from(body)]);

test('blocks private, mapped, special, documentation, and multicast addresses', async () => {
    for (const address of [
        '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
        '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
        '224.0.0.1', '::', '::1', '::ffff:192.168.0.1', 'fc00::1', 'fe80::1', 'ff02::1',
        '2001:db8::1', '2001:2::1'
    ]) assert.equal(isBlockedAddress(address), true, address);
    for (const address of ['8.8.8.8', '2001:4860:4860::8888']) assert.equal(isBlockedAddress(address), false, address);
    await assert.rejects(
        resolvePublicArtworkUrl('https://cdn.example.test/art.png', {
            lookup: async () => [{ address: '192.168.0.170', family: 4 }]
        }),
        /blocked/u
    );
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
    assert.equal(requests[0].options.httpsAgent.options.rejectUnauthorized, true);
    await assert.rejects(fetchArtwork('http://cdn.example.test/art.png', { axiosInstance, lookup: async () => [{ address: '8.8.8.8', family: 4 }] }), /HTTP/u);
    await assert.rejects(fetchArtwork('http://cdn.example.test/art.png', {
        axiosInstance: { get: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: image('<x>') }) },
        allowInsecureHttp: true,
        lookup: async () => [{ address: '8.8.8.8', family: 4 }]
    }), /not an image/u);
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createArtworkCache, fetchArtwork, resolvePublicArtworkUrl } = require('../server/services/wiim-art-proxy');

function response({ status = 200, headers = { 'content-type': 'image/jpeg' }, body = Buffer.from('image') } = {}) {
    return { status, headers, data: Readable.from([body]) };
}

test('WiiM artwork rejects private, loopback, link-local, and IPv6 private DNS results', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.2', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
        await assert.rejects(() => resolvePublicArtworkUrl('https://cover.example/a.jpg', { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }));
    }
    await assert.rejects(() => resolvePublicArtworkUrl('https://[::1]/cover.jpg'));
});

test('WiiM artwork allows only the exact configured local WiiM address', async () => {
    const target = await resolvePublicArtworkUrl('https://wiim.local/cover.jpg', {
        lookup: async () => [{ address: '192.168.0.170', family: 4 }],
        allowedPrivateAddresses: ['192.168.0.170']
    });
    assert.equal(target.allowSelfSigned, true);
    await assert.rejects(() => resolvePublicArtworkUrl('https://other.local/cover.jpg', {
        lookup: async () => [{ address: '192.168.0.171', family: 4 }],
        allowedPrivateAddresses: ['192.168.0.170']
    }));
});

test('WiiM artwork streams from the exact local WiiM address with its self-signed TLS only', async () => {
    let options;
    const image = await fetchArtwork('https://192.168.0.170/cover.jpg', {
        axiosInstance: { get: async (_url, requestOptions) => { options = requestOptions; return response(); } },
        allowedPrivateAddresses: ['192.168.0.170']
    });
    assert.equal(image.type, 'image/jpeg');
    assert.equal(options.httpsAgent.options.rejectUnauthorized, false);
});

test('WiiM artwork validates every redirect target and caps redirects', async () => {
    const axios = { get: async () => response({ status: 302, headers: { location: 'http://private.example/cover.jpg' } }) };
    await assert.rejects(() => fetchArtwork('https://public.example/cover.jpg', {
        axiosInstance: axios,
        lookup: async hostname => [{ address: hostname === 'private.example' ? '10.0.0.1' : '203.0.113.4', family: 4 }]
    }));
});

test('WiiM artwork redirect revalidates protocol and disables environment proxies', async () => {
    let request;
    const axios = { get: async (_url, options) => { request = options; return response({ status: 302, headers: { location: 'file:///etc/passwd' } }); } };
    await assert.rejects(() => fetchArtwork('https://public.example/cover.jpg', {
        axiosInstance: axios, lookup: async () => [{ address: '203.0.113.4', family: 4 }]
    }));
    assert.equal(request.proxy, false);
});

test('WiiM artwork streams with content, MIME, and cache limits', async () => {
    await assert.rejects(() => fetchArtwork('https://public.example/cover.jpg', {
        axiosInstance: { get: async () => response({ headers: { 'content-type': 'text/html' } }) },
        lookup: async () => [{ address: '203.0.113.4', family: 4 }]
    }));
    await assert.rejects(() => fetchArtwork('https://public.example/cover.svg', {
        axiosInstance: { get: async () => response({ headers: { 'content-type': 'image/svg+xml' } }) },
        lookup: async () => [{ address: '203.0.113.4', family: 4 }]
    }));
    await assert.rejects(() => fetchArtwork('https://public.example/cover.jpg', {
        axiosInstance: { get: async () => response({ body: Buffer.alloc(9) }) },
        lookup: async () => [{ address: '203.0.113.4', family: 4 }], maxBytes: 8
    }));
    const cache = createArtworkCache({ maxEntries: 1, maxItemBytes: 8, maxBytes: 8 });
    cache.set('one', { type: 'image/jpeg', buffer: Buffer.alloc(8) });
    assert.throws(() => cache.set('large', { type: 'image/jpeg', buffer: Buffer.alloc(9) }));
    assert.equal(cache.size(), 1);
});

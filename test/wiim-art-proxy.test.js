'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createWiimArtProxy, publicAddress } = require('../server/services/wiim-art-proxy');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function requestFactory({ status = 200, type = 'image/jpeg', chunks = [JPEG] } = {}) {
    let calls = 0;
    const request = (_url, _options, callback) => {
        calls += 1;
        const handle = new EventEmitter();
        handle.end = () => setImmediate(() => {
            const response = Readable.from(chunks);
            response.statusCode = status;
            response.headers = { 'content-type': type, 'content-length': String(chunks.reduce((sum, chunk) => sum + chunk.length, 0)) };
            callback(response);
        });
        handle.destroy = error => handle.emit('error', error || new Error('destroyed'));
        return handle;
    };
    return { request, calls: () => calls };
}

function proxy(request, resolve = async () => [{ address: '198.51.100.10', family: 4 }], options = {}) {
    return createWiimArtProxy({ getAllowedHosts: () => 'cdn.example', request, resolve, ...options });
}

test('public address policy rejects private, link-local, CGNAT, multicast, loopback, and IPv6 local ranges', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:192.168.1.1']) {
        assert.equal(publicAddress(address), false, address);
    }
    assert.equal(publicAddress('198.51.100.10'), true);
    assert.equal(publicAddress('2001:db8::10'), true);
});

test('proxy requires allowlisted host, rejects DNS-private answers and validates type plus magic bytes', async () => {
    const valid = requestFactory();
    await assert.rejects(() => proxy(valid.request).fetch('https://other.example/a.jpg'), /allowlisted/u);
    await assert.rejects(() => proxy(valid.request, async () => [{ address: '127.0.0.1', family: 4 }]).fetch('https://cdn.example/a.jpg'), /forbidden/u);
    await assert.rejects(() => proxy(requestFactory({ type: 'image/jpeg', chunks: [Buffer.from('<html>')] }).request).fetch('https://cdn.example/a.jpg'), /magic/u);
    await assert.rejects(() => proxy(requestFactory({ type: 'image/svg+xml', chunks: [PNG] }).request).fetch('https://cdn.example/a.svg'), /content type/u);
});

test('proxy bounds streamed bytes, rejects redirects, caches bounded images, and singleflights identical URLs', async () => {
    await assert.rejects(() => proxy(requestFactory({ chunks: [Buffer.alloc(10)] }).request, undefined, { maxBytes: 5 }).fetch('https://cdn.example/a.jpg'), /content length|body/u);
    await assert.rejects(() => proxy(requestFactory({ status: 302 }).request).fetch('https://cdn.example/a.jpg'), /status/u);
    const fake = requestFactory();
    const service = proxy(fake.request);
    const [first, second] = await Promise.all([service.fetch('https://cdn.example/a.jpg', 'v1'), service.fetch('https://cdn.example/a.jpg', 'v1')]);
    assert.equal(first.type, 'image/jpeg');
    assert.deepEqual(first.buffer, JPEG);
    assert.deepEqual(second.buffer, JPEG);
    assert.equal(fake.calls(), 1);
    await service.fetch('https://cdn.example/a.jpg', 'v1');
    assert.equal(fake.calls(), 1);
    assert.equal(service.diagnostics().cacheItems, 1);
});

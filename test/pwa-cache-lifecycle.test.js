'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PWA_SHELL } = require('../server/services/pwa-service-worker');
const { createWorkerHarness } = require('./helpers/pwa-worker-harness');

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('every executable SPA shell asset is explicitly precached, including lifecycle', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    for (const [, src] of html.matchAll(/<script[^>]* src="([^"]+)"/g)) assert.ok(PWA_SHELL.includes(src), src);
});

test('runtime caching is bounded to same-origin shell URLs, not arbitrary paths or query variants', async () => {
    const worker = createWorkerHarness();
    await worker.dispatch('install').settled();
    const excluded = ['/api/settings', '/health/ready', '/private-export', 'https://other.test/js/app.js'];
    for (let i = 0; i < 1000; i += 1) excluded.push(`/js/app.js?revision=${i}`);
    for (const url of excluded) {
        const event = worker.dispatch('fetch', worker.request(url));
        assert.equal(event.response, undefined, `not intercepted/cacheable: ${url}`);
        await event.settled();
    }
    assert.equal(worker.stores.get('smarthub-test').size, PWA_SHELL.length);
    assert.equal(worker.dispatch('fetch', worker.request('/js/app.js', { method: 'POST' })).response, undefined);
    assert.equal(worker.dispatch('fetch', worker.request('/js/app.js', { cache: 'no-store' })).response, undefined);
});

test('cache writes extend event lifetime and do not delay the successful network response', async () => {
    const pending = deferred();
    const worker = createWorkerHarness({ put: () => pending.promise });
    const event = worker.dispatch('fetch', worker.request('/js/app.js'));
    assert.equal((await event.response).status, 200);
    assert.ok(event.waits.length > 0, 'worker may not be terminated before cache.put finishes');
    pending.resolve();
    await event.settled();
    assert.equal(worker.stores.get('smarthub-test').size, 1);
});

test('cache quota failures are handled without hiding network success or rejecting event lifetime', async () => {
    const worker = createWorkerHarness({ put: async () => { throw new Error('quota exceeded'); } });
    const event = worker.dispatch('fetch', worker.request('/js/app.js'));
    assert.equal((await event.response).status, 200);
    await event.settled();
});

test('private, no-store, unsuccessful and redirected responses are never saved at runtime', async () => {
    for (const control of ['private', 'max-age=0, no-store', 'PRIVATE, max-age=0']) {
        const worker = createWorkerHarness({ network: async () => new Response('private', { headers: { 'cache-control': control } }) });
        await worker.dispatch('fetch', worker.request('/js/app.js')).settled();
        assert.equal(worker.stores.get('smarthub-test')?.size || 0, 0);
    }
    for (const response of [new Response('', { status: 503 }), { ok: true, redirected: true }]) {
        const worker = createWorkerHarness({ network: async () => response });
        await worker.dispatch('fetch', worker.request('/js/app.js')).settled();
        assert.equal(worker.stores.get('smarthub-test')?.size || 0, 0);
    }
});

test('offline fallback only reads the current build cache and does not retain private navigations', async () => {
    const worker = createWorkerHarness({ network: async () => { throw new Error('offline'); } });
    await (await worker.caches.open('old-build')).put('/js/app.js', new Response('stale'));
    assert.equal(await worker.dispatch('fetch', worker.request('/js/app.js')).response, undefined);
    await worker.dispatch('install').settled();
    const navigation = worker.dispatch('fetch', worker.request('/settings', { mode: 'navigate' }));
    assert.equal(await (await navigation.response).text(), '/login');
    assert.equal(worker.stores.get('smarthub-test').has(`${worker.origin}/settings`), false);
    await worker.dispatch('activate').settled();
    assert.deepEqual([...worker.stores.keys()], ['smarthub-test']);
});

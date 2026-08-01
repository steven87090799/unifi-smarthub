'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeviceCollectorCache } = require('../server/services/device-collector-cache');

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
};

test('API, watcher, and history sampler share one collector singleflight', async () => {
    const cache = createDeviceCollectorCache({ cacheAgeMs: () => 5_000 });
    const gate = deferred();
    let upstreamCalls = 0;
    const collectClients = async () => {
        upstreamCalls += 1;
        await gate.promise;
        return { clients: 3 };
    };

    const reads = [
        cache.read('unifi.clients', collectClients),
        cache.read('unifi.clients', collectClients),
        cache.read('unifi.clients', collectClients)
    ];
    await Promise.resolve();
    assert.equal(upstreamCalls, 1);
    gate.resolve();
    const values = await Promise.all(reads);
    assert.deepEqual(values, [{ clients: 3 }, { clients: 3 }, { clients: 3 }]);
    assert.equal(cache.snapshot('unifi.clients').healthy, true);
    assert.equal(cache.snapshot('unifi.clients').inflight, false);
});

test('stale payload and collector health remain separate across failure and recovery', async () => {
    let now = 0;
    let shouldFail = false;
    const cache = createDeviceCollectorCache({ now: () => now, cacheAgeMs: () => 1_000 });
    const collect = async () => {
        if (shouldFail) throw new Error('upstream offline');
        return { value: now };
    };

    assert.deepEqual(await cache.read('nas.common', collect), { value: 0 });
    now = 2_000;
    shouldFail = true;
    assert.deepEqual(await cache.read('nas.common', collect, { allowStale: true }), { value: 0 });
    const offline = cache.snapshot('nas.common');
    assert.equal(offline.stale, true);
    assert.equal(offline.healthy, false);
    assert.equal(offline.consecutiveFailures, 1);
    assert.equal(offline.lastError.message, 'upstream offline');
    await assert.rejects(() => cache.read('nas.common', collect), /upstream offline/u);

    shouldFail = false;
    now = 3_000;
    assert.deepEqual(await cache.read('nas.common', collect), { value: 3_000 });
    const recovered = cache.snapshot('nas.common');
    assert.equal(recovered.healthy, true);
    assert.equal(recovered.stale, false);
    assert.equal(recovered.lastError, null);
    assert.equal(recovered.consecutiveFailures, 0);
});

test('collector freshness follows active and idle backend sampling settings', async () => {
    let now = 0;
    let active = true;
    let calls = 0;
    const settings = { activeMs: 5_000, idleMs: 600_000 };
    const cache = createDeviceCollectorCache({
        now: () => now,
        cacheAgeMs: () => active ? settings.activeMs : settings.idleMs
    });
    const collect = async () => ({ sequence: ++calls });

    assert.deepEqual(await cache.read('linux.stats', collect), { sequence: 1 });
    now = 6_000;
    assert.deepEqual(await cache.read('linux.stats', collect), { sequence: 2 });
    active = false;
    now = 100_000;
    assert.deepEqual(await cache.read('linux.stats', collect), { sequence: 2 });
    assert.equal(calls, 2);
});

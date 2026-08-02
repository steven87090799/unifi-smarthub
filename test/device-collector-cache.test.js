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

test('mixed stale and strict callers share upstream but keep independent failure policy', async () => {
    let now = 0;
    const cache = createDeviceCollectorCache({ now: () => now, cacheAgeMs: () => 1_000 });
    let fail = false;
    let calls = 0;
    const gate = deferred();
    const collect = async () => {
        calls += 1;
        if (fail) {
            await gate.promise;
            throw new Error('mixed caller outage');
        }
        return { value: 1 };
    };
    await cache.read('nas.logs.page.0', collect);
    now = 2_000;
    fail = true;
    const stale = cache.read('nas.logs.page.0', collect, { allowStale: true });
    const strict = cache.read('nas.logs.page.0', collect, { allowStale: false });
    await Promise.resolve();
    assert.equal(calls, 2);
    gate.resolve();
    assert.deepEqual(await stale, { value: 1 });
    await assert.rejects(strict, /mixed caller outage/u);
    const snapshot = cache.snapshot('nas.logs.page.0');
    assert.equal(snapshot.healthy, false);
    assert.equal(snapshot.consecutiveFailures, 1);
    assert.equal(snapshot.lastError.message, 'mixed caller outage');
});

test('strict-first mixed callers still receive independent stale policy', async () => {
    let now = 0;
    const cache = createDeviceCollectorCache({ now: () => now, cacheAgeMs: () => 1_000 });
    let fail = false;
    let calls = 0;
    const gate = deferred();
    const collect = async () => {
        calls += 1;
        if (fail) {
            await gate.promise;
            throw new Error('strict-first outage');
        }
        return { value: 1 };
    };
    await cache.read('nas.logs.page.1', collect);
    now = 2_000;
    fail = true;
    const strict = cache.read('nas.logs.page.1', collect, { allowStale: false });
    const stale = cache.read('nas.logs.page.1', collect, { allowStale: true });
    await Promise.resolve();
    assert.equal(calls, 2);
    gate.resolve();
    await assert.rejects(strict, /strict-first outage/u);
    assert.deepEqual(await stale, { value: 1 });
    assert.equal(cache.snapshot('nas.logs.page.1').healthy, false);
});

test('explicit collector scope controls freshness even when key name suggests another scope', async () => {
    let now = 0;
    let calls = 0;
    const cache = createDeviceCollectorCache({
        now: () => now,
        cacheAgeMs: (_name, entry) => entry?.scope === 'ups' ? 100 : 1_000
    });
    const collect = async () => ({ sample: ++calls });
    assert.deepEqual(await cache.read('nas.logs.page.0', collect, { scope: 'ups' }), { sample: 1 });
    now = 200;
    assert.deepEqual(await cache.read('nas.logs.page.0', collect, { scope: 'ups' }), { sample: 2 });
    now = 500;
    assert.deepEqual(await cache.read('nas.logs.page.0', collect, { scope: 'trend' }), { sample: 2 });
    assert.equal(calls, 2);
});

test('bounded collector cache evicts LRU entries, expires TTL, and invalidates prefixes', async () => {
    let now = 0;
    const cache = createDeviceCollectorCache({
        now: () => now,
        cacheAgeMs: () => 60_000,
        maxEntries: 3,
        entryTtlMs: 100,
        maxEstimatedBytes: 100
    });
    const read = (name, value = name) => cache.read(name, async () => value);

    await read('nas.logs.page.0', 'a');
    now += 1;
    await read('nas.logs.page.1', 'b');
    now += 1;
    await read('nas.logs.page.2', 'c');
    assert.equal(cache.diagnostics().entryCount, 3);
    cache.peek('nas.logs.page.0');
    now += 1;
    await read('nas.logs.page.3', 'd');
    assert.equal(cache.has('nas.logs.page.0'), true);
    assert.equal(cache.has('nas.logs.page.1'), false);
    assert.ok(cache.diagnostics().evictionCount >= 1);

    now += 200;
    assert.equal(cache.peek('nas.logs.page.0'), undefined);
    assert.ok(cache.diagnostics().expiredCount >= 1);

    await read('nas.logs.page.4', 'e');
    await read('nas.logs.page.5', 'f');
    assert.equal(cache.invalidatePrefix('nas.logs.page.'), 2);
    assert.equal(cache.names().some(name => name.startsWith('nas.logs.page.')), false);
    assert.ok(cache.diagnostics().estimatedBytes <= 100);
});

test('inflight entries are not evicted until their upstream settles', async () => {
    const cache = createDeviceCollectorCache({ maxEntries: 1, entryTtlMs: 10 });
    const first = deferred();
    const one = cache.read('docker.one', async () => {
        await first.promise;
        return { id: 1 };
    });
    const two = cache.read('docker.two', async () => ({ id: 2 }));
    await Promise.resolve();
    assert.equal(cache.diagnostics().inflightCount, 2);
    first.resolve();
    await Promise.all([one, two]);
    assert.equal(cache.diagnostics().inflightCount, 0);
    assert.ok(cache.diagnostics().entryCount <= 1);
});

test('oversized payloads are returned but not retained and errors are bounded', async () => {
    const cache = createDeviceCollectorCache({ maxEstimatedBytes: 32 });
    const payload = await cache.read('adguard.querylog.large', async () => 'x'.repeat(100));
    assert.equal(payload.length, 100);
    assert.equal(cache.snapshot('adguard.querylog.large').data, undefined);
    assert.ok(cache.diagnostics().estimatedBytes <= 32);
    await assert.rejects(() => cache.read('adguard.querylog.large', async () => {
        throw new Error(`token=secret ${'x'.repeat(5000)}`);
    }), /token=secret/u);
    const error = cache.snapshot('adguard.querylog.large').lastError;
    assert.ok(error.message.length <= 512);
    assert.doesNotMatch(error.message, /secret/u);
});

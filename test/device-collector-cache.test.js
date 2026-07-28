'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceCollectorCache } = require('../server/services/device-collector-cache');

test('collector cache shares one upstream request between sampler and API readers', async () => {
    const cache = createDeviceCollectorCache({ cacheAgeMs: () => 10_000 });
    let calls = 0;
    const upstream = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { value: calls }; };
    const [sampler, api] = await Promise.all([
        cache.read('nas.disks', upstream, { refresh: true }),
        cache.read('nas.disks', upstream)
    ]);
    assert.deepEqual(sampler, { value: 1 });
    assert.deepEqual(api, { value: 1 });
    assert.equal(calls, 1);
});

test('old data remains displayable but failed upstream health is offline until recovery', async () => {
    let timestamp = 1000;
    const cache = createDeviceCollectorCache({ cacheAgeMs: () => 1, now: () => timestamp });
    await cache.read('unifi.health', async () => ({ ok: true, payload: { data: [] } }));
    timestamp += 10;
    await assert.rejects(() => cache.read('unifi.health', async () => { throw new Error('offline'); }, { refresh: true }));
    let snapshot = cache.snapshot('unifi.health');
    assert.deepEqual(snapshot.data, { ok: true, payload: { data: [] } });
    assert.equal(snapshot.consecutiveFailures, 1);
    assert.ok(snapshot.lastErrorAt);
    assert.equal(Boolean(snapshot.data?.ok) && !snapshot.lastErrorAt, false);
    timestamp += 10;
    await cache.read('unifi.health', async () => ({ ok: true, payload: { data: [{ subsystem: 'wan' }] } }), { refresh: true });
    snapshot = cache.snapshot('unifi.health');
    assert.equal(snapshot.consecutiveFailures, 0);
    assert.equal(snapshot.lastError, null);
    assert.equal(Boolean(snapshot.data?.ok) && !snapshot.lastErrorAt, true);
});

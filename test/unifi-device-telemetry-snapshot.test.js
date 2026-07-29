'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiDeviceTelemetrySnapshot } = require('../server/services/unifi-device-telemetry-snapshot');

test('snapshot reads are pure and initial refresh is singleflight', async () => {
    let calls = 0;
    let resolveSample;
    const sample = () => {
        calls += 1;
        return new Promise(resolve => { resolveSample = resolve; });
    };
    const snapshot = createUnifiDeviceTelemetrySnapshot({ sample, now: () => 1000, staleAfterMs: () => 5000 });
    assert.equal(snapshot.read().stale, true);
    assert.equal(calls, 0);
    const first = snapshot.refresh();
    const second = snapshot.refresh();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    resolveSample({ collectedAt: '1970-01-01T00:00:01.000Z', devices: [] });
    assert.equal((await first).stale, false);
    snapshot.read();
    snapshot.read();
    assert.equal(calls, 1);
});

test('failure preserves last success and marks every device and temperature stale', async () => {
    let now = 1000;
    let fail = false;
    const snapshot = createUnifiDeviceTelemetrySnapshot({
        now: () => now,
        staleAfterMs: () => 5000,
        sample: async () => {
            if (fail) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
            return { collectedAt: new Date(now).toISOString(), devices: [{ id: 'device-1', freshness: {}, temperature: { value: 60, status: 'supported', stale: false } }] };
        }
    });
    await snapshot.refresh();
    fail = true;
    now = 2000;
    const retained = await snapshot.refresh();
    assert.equal(retained.lastSuccessfulAt, '1970-01-01T00:00:01.000Z');
    assert.equal(retained.stale, true);
    assert.equal(retained.errorReason, 'timeout');
    assert.equal(retained.devices[0].temperature.status, 'stale');
    assert.equal(retained.devices[0].freshness.stale, true);
});

test('stale threshold expires an otherwise successful retained value', async () => {
    let now = 1000;
    const snapshot = createUnifiDeviceTelemetrySnapshot({
        now: () => now,
        staleAfterMs: () => 100,
        sample: async () => ({ collectedAt: new Date(now).toISOString(), devices: [] })
    });
    await snapshot.refresh();
    now = 1101;
    assert.equal(snapshot.read().stale, true);
});

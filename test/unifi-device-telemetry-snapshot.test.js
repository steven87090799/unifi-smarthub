'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiDeviceTelemetrySnapshot } = require('../server/services/unifi-device-telemetry-snapshot');

test('API reads are singleflight and read-only while only the sampler refreshes the telemetry snapshot', async () => {
    let clock = Date.parse('2026-07-29T00:00:00.000Z');
    let controllerFetches = 0, sshCollects = 0, historyWrites = 0, notifications = 0;
    const snapshot = createUnifiDeviceTelemetrySnapshot({
        now: () => clock,
        staleAfterMs: () => 60_000 * 3,
        sample: async () => {
            controllerFetches += 1; sshCollects += 1;
            return { sampledAt: new Date(clock).toISOString(), devices: [] };
        }
    });
    await Promise.all(Array.from({ length: 12 }, () => snapshot.read()));
    assert.deepEqual({ controllerFetches, sshCollects, historyWrites, notifications }, { controllerFetches: 1, sshCollects: 1, historyWrites: 0, notifications: 0 });
    clock += 60_000;
    await snapshot.read();
    assert.equal(controllerFetches, 1, 'a frequent GET cannot bypass the dedicated 60 second sampler');
    await snapshot.refresh();
    historyWrites += 1;
    assert.equal(controllerFetches, 2);
    assert.equal(sshCollects, 2);
    assert.equal(historyWrites, 1);
});

test('snapshot remains readable but stale after the active or idle three-interval deadline', async () => {
    let clock = 0;
    const active = createUnifiDeviceTelemetrySnapshot({ now: () => clock, staleAfterMs: () => 60_000 * 3, sample: async () => ({ sampledAt: new Date(clock).toISOString(), devices: [] }) });
    await active.read(); clock = 180_001;
    assert.equal((await active.read()).stale, true);
    clock = 0;
    const idle = createUnifiDeviceTelemetrySnapshot({ now: () => clock, staleAfterMs: () => 300_000 * 3, sample: async () => ({ sampledAt: new Date(clock).toISOString(), devices: [] }) });
    await idle.read(); clock = 899_999;
    assert.equal((await idle.read()).stale, false);
    clock = 900_001;
    assert.equal((await idle.read()).stale, true);
});

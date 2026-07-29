'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiDeviceTelemetrySnapshot, markSnapshotDevicesStale } = require('../server/services/unifi-device-telemetry-snapshot');

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

test('stale snapshot presentation immutably marks every temperature stale without changing its successful sample time', async () => {
    let clock = Date.parse('2026-07-29T00:03:01.000Z');
    const original = {
        sampledAt: '2026-07-29T00:00:00.000Z', stale: false,
        devices: [{ id: 'aa:bb:cc:dd:ee:ff', temperature: { value: 80, stale: false, sampledAt: '2026-07-29T00:00:00.000Z' }, temperatureStatus: 'device_ssh_reported' }]
    };
    const snapshot = createUnifiDeviceTelemetrySnapshot({ now: () => clock, staleAfterMs: () => 180_000, sample: async () => original });
    const result = await snapshot.read();
    assert.equal(result.stale, true);
    assert.equal(result.devices[0].telemetryStale, true);
    assert.equal(result.devices[0].temperature.stale, true);
    assert.equal(result.devices[0].temperature.sampledAt, original.devices[0].temperature.sampledAt);
    assert.equal(result.devices[0].temperatureStatus, 'telemetry_snapshot_stale');
    assert.equal(original.devices[0].temperature.stale, false);
    assert.equal(original.devices[0].temperatureStatus, 'device_ssh_reported');
    assert.equal(markSnapshotDevicesStale(original).devices[0].temperature.value, 80);
    clock = Date.parse('2026-07-29T00:00:01.000Z');
    const fresh = createUnifiDeviceTelemetrySnapshot({ now: () => clock, staleAfterMs: () => 180_000, sample: async () => original });
    assert.equal((await fresh.read()).stale, false);
    assert.equal((await fresh.read()).devices[0].temperatureStatus, 'device_ssh_reported');
});

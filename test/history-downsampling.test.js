'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');

function fixture(t, prefix = 'smarthub-history-rollup-') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('long-range history keeps tiered rollups, point budgets, null truth, and idempotent cleanup', async t => {
    const directory = fixture(t);
    const db = createHistoryDb(directory, { maxPendingPoints: 20_000 });
    t.after(() => db.close());
    const now = Date.now();
    const step = 10 * 60 * 1000;
    for (let ts = now - 45 * 86400000; ts <= now; ts += step) {
        db.insertPoint('trend', {
            t: new Date(ts).toISOString(),
            clients: (ts / step) % 100,
            temperature: ts % (3 * step) === 0 ? null : 42
        });
    }
    db.flush();

    const firstCleanup = db.cleanup(90, 100_000, { batchSize: 40 });
    assert.strictEqual(firstCleanup, db.cleanup(90, 100_000, { batchSize: 40 }));
    const first = await firstCleanup;
    assert.ok(first.rollups_created > 0);
    assert.ok(first.rows_processed > 0);

    const result = db.getHistory('trend', now - 45 * 86400000, { pointBudget: 240 });
    assert.equal(result.resolution, '1h');
    assert.ok(result.data.length <= 240);
    assert.equal(result.point_budget, 240);
    assert.ok(result.data.some(point => new Date(point.t).getTime() < now - 30 * 86400000));
    assert.ok(result.data.every(point => point.temperature === 42 || point.temperature === null));

    const second = await db.cleanup(90, 100_000, { batchSize: 40 });
    assert.equal(second.rollups_created, 0);
    assert.deepEqual(db.getHistory('trend', now - 45 * 86400000, { pointBudget: 240 }), result);
});

test('telemetry rollups stay per-device and never turn unavailable temperature into zero', async t => {
    const directory = fixture(t, 'smarthub-telemetry-rollup-');
    const db = createHistoryDb(directory);
    t.after(() => db.close());
    const now = Date.now();
    for (let ts = now - 45 * 86400000; ts <= now; ts += 60 * 60 * 1000) {
        for (const [deviceId, temperature] of [['device-a', 50], ['device-b', null]]) {
            db.insertUnifiTelemetryBatch({
                collectedAt: new Date(ts).toISOString(),
                stale: false,
                rows: [{
                    deviceId, name: deviceId, model: 'fixture', type: 'uap', online: temperature !== null,
                    cpu: deviceId === 'device-a' ? 20 : null,
                    temperature,
                    temperatureStatus: temperature === null ? 'offline' : 'supported',
                    temperatureSource: temperature === null ? null : 'fixture',
                    clientCount: deviceId === 'device-a' ? 5 : 0, linkSpeedMbps: 1000,
                    rxBytes: ts, txBytes: ts, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0
                }]
            }, { hardCap: 100_000 });
        }
    }

    const cleanup = await db.cleanup(90, 100_000, { batchSize: 50 });
    assert.ok(cleanup.rollups_created > 0);
    const result = db.listUnifiTelemetryHistory(now - 45 * 86400000, { pointBudget: 200 });
    assert.equal(result.resolution, '1h');
    assert.ok(result.data.length <= 200);
    const deviceA = result.data.filter(row => row.deviceId === 'device-a');
    const deviceB = result.data.filter(row => row.deviceId === 'device-b');
    assert.ok(deviceA.length > 0 && deviceB.length > 0);
    assert.ok(deviceA.every(row => row.temperature === 50));
    assert.ok(deviceB.every(row => row.temperature === null));
    assert.ok(result.data.every(row => row.temperature !== 0));
});

test('time progression promotes the same history and telemetry through every tier without gaps', async t => {
    const directory = fixture(t, 'smarthub-time-progression-');
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let clock = base;
    const db = createHistoryDb(directory, { now: () => clock });
    t.after(() => db.close());
    const start = base - 2 * 60 * 60 * 1000;
    const points = [
        [0, 0], [10_000, 100], [60_000, 100], [20 * 60_000, 42], [40 * 60_000, 42]
    ];
    for (const [offset, temperature] of points) {
        db.insertPoint('trend', { t: new Date(start + offset).toISOString(), temperature, clients: offset / 1000 });
    }
    for (const [offset, temperature, deviceId] of [
        [0, 50, 'device-a'], [10_000, 70, 'device-a'], [60_000, 90, 'device-a'],
        [0, null, 'device-b'], [10_000, null, 'device-b'], [60_000, null, 'device-b']
    ]) {
        db.insertUnifiTelemetryBatch({
            collectedAt: new Date(start + offset).toISOString(), stale: false,
            rows: [{
                deviceId, name: deviceId, model: 'fixture', type: 'uap', online: temperature !== null,
                cpu: temperature === null ? null : 20, temperature,
                temperatureStatus: temperature === null ? 'offline' : 'supported',
                temperatureSource: temperature === null ? null : 'fixture',
                clientCount: 3, linkSpeedMbps: 1000,
                rxBytes: offset + (deviceId === 'device-a' ? 100 : 200), txBytes: offset,
                rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0
            }]
        }, { hardCap: 1000 });
    }
    db.flush();
    const inspect = () => new Database(db.file, { readonly: true });

    let result = db.getHistory('trend', start - 60 * 60 * 1000, { pointBudget: 100 });
    assert.equal(result.resolution, 'raw');
    assert.equal(result.data.length, points.length);

    clock = base + 25 * 60 * 60 * 1000;
    await db.cleanup(40, 1000);
    let sqlite = inspect();
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM history WHERE series='trend'").get().count, 0);
    assert.ok(sqlite.prepare("SELECT COUNT(*) count FROM history_rollups WHERE series='trend' AND resolution='1m'").get().count > 0);
    assert.equal(sqlite.prepare("SELECT sample_count FROM history_rollups WHERE series='trend' AND resolution='1m' ORDER BY bucket_ts LIMIT 1").get().sample_count, 2);
    sqlite.close();
    result = db.getHistory('trend', start - 60 * 60 * 1000, { pointBudget: 100 });
    assert.equal(result.resolution, '1m');
    assert.ok(result.data.length > 0);
    let telemetry = db.listUnifiTelemetryHistory(start - 60 * 60 * 1000, { pointBudget: 100 });
    assert.equal(telemetry.resolution, '1m');
    assert.ok(telemetry.data.some(row => row.deviceId === 'device-a'));
    assert.ok(telemetry.data.some(row => row.deviceId === 'device-b' && row.temperature === null));

    clock = base + 8 * 86400000;
    await db.cleanup(40, 1000);
    sqlite = inspect();
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM history_rollups WHERE series='trend' AND resolution='1m'").get().count, 0);
    assert.ok(sqlite.prepare("SELECT COUNT(*) count FROM history_rollups WHERE series='trend' AND resolution='5m'").get().count > 0);
    assert.equal(sqlite.prepare("SELECT data FROM history_rollups WHERE series='trend' AND resolution='5m' ORDER BY bucket_ts LIMIT 1").get().data.includes('66.6667'), true);
    sqlite.close();
    result = db.getHistory('trend', start - 60 * 60 * 1000, { pointBudget: 100 });
    assert.equal(result.resolution, '5m');
    assert.ok(result.data.length > 0);
    telemetry = db.listUnifiTelemetryHistory(start - 60 * 60 * 1000, { pointBudget: 100 });
    assert.equal(telemetry.resolution, '5m');
    assert.deepEqual(new Set(telemetry.data.map(row => row.deviceId)), new Set(['device-a', 'device-b']));

    clock = base + 31 * 86400000;
    await db.cleanup(40, 1000);
    sqlite = inspect();
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM history_rollups WHERE series='trend' AND resolution='5m'").get().count, 0);
    assert.ok(sqlite.prepare("SELECT COUNT(*) count FROM history_rollups WHERE series='trend' AND resolution='1h'").get().count > 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM unifi_device_telemetry_rollups WHERE resolution='5m'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM unifi_device_telemetry_rollups WHERE resolution='1h'").get().count, 2);
    sqlite.close();
    result = db.getHistory('trend', start - 60 * 60 * 1000, { pointBudget: 100 });
    assert.equal(result.resolution, '1h');
    assert.ok(result.data.length > 0);
    assert.ok(db.listUnifiTelemetryHistory(start - 60 * 60 * 1000, { pointBudget: 100 }).data.length > 0);

    const repeated = await db.cleanup(40, 1000);
    assert.equal(repeated.rollups_created, 0);

    clock = base + 41 * 86400000;
    await db.cleanup(40, 1000);
    sqlite = inspect();
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM history_rollups WHERE series='trend'").get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) count FROM unifi_device_telemetry_rollups').get().count, 0);
    sqlite.close();
    assert.equal(db.getHistory('trend', start - 60 * 60 * 1000, { pointBudget: 100 }).data.length, 0);
    assert.equal(db.listUnifiTelemetryHistory(start - 60 * 60 * 1000, { pointBudget: 100 }).data.length, 0);
});

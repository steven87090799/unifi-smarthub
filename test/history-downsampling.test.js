'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

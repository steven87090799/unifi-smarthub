'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');

const START = Date.parse('2026-01-01T00:00:00.000Z');
const NOW = START + 60 * 86400000;

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-p1-integrity-'));
    let history = createHistoryDb(directory, { now: () => NOW });
    t.after(() => { history.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return {
        get db() { return history; },
        restart() { history.close(); history = createHistoryDb(directory, { now: () => NOW }); },
        inspect(callback) {
            const sql = new Database(history.file, { readonly: true });
            try { return callback(sql); } finally { sql.close(); }
        }
    };
}

function telemetry(i, deviceId = 'device-a') {
    return {
        collectedAt: new Date(START + i * 60000).toISOString(), stale: false,
        rows: [{
            deviceId, online: true, cpu: i % 100, temperature: 40 + i % 40,
            temperatureStatus: 'supported', temperatureSource: 'fixture',
            clientCount: 2, linkSpeedMbps: 1000,
            rxBytes: i, txBytes: i, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0
        }]
    };
}

test('P1 history promotion conserves samples across 100-bucket batch boundaries and restart', async t => {
    const f = fixture(t);
    for (let i = 0; i < 240; i += 1) {
        f.db.insertPoint('trend', { t: new Date(START + i * 60000).toISOString(), temperature: i });
    }
    await f.db.cleanup(365, 100000, { now: NOW });
    const rows = f.inspect(sql => sql.prepare("SELECT sample_count, data FROM history_rollups WHERE series='trend' ORDER BY bucket_ts").all());
    assert.deepEqual(rows.map(row => row.sample_count), [60, 60, 60, 60]);
    assert.deepEqual(rows.map(row => JSON.parse(row.data).temperature), [29.5, 89.5, 149.5, 209.5]);
    f.restart();
    const repeated = await f.db.cleanup(365, 100000, { now: NOW });
    assert.equal(repeated.rollups_created, 0);
    assert.deepEqual(f.inspect(sql => sql.prepare("SELECT sample_count, data FROM history_rollups WHERE series='trend' ORDER BY bucket_ts").all()), rows);
});

test('P1 telemetry promotion conserves every device across interleaved batch boundaries', async t => {
    const f = fixture(t);
    for (let i = 0; i < 240; i += 1) {
        for (const device of ['device-a', 'device-b']) f.db.insertUnifiTelemetryBatch(telemetry(i, device));
    }
    await f.db.cleanup(365, 100000, { now: NOW });
    const rows = f.inspect(sql => sql.prepare('SELECT device_id, SUM(sample_count) AS samples FROM unifi_device_telemetry_rollups GROUP BY device_id').all());
    assert.deepEqual(rows.map(row => row.samples), [240, 240]);
    // A new raw counter in a previously rolled-up bucket must win by its
    // actual timestamp, even before maintenance promotes that late sample.
    const late = telemetry(59.5);
    late.rows[0].rxBytes = 5000;
    late.rows[0].txBytes = 5000;
    assert.equal(f.db.insertUnifiTelemetryBatch(late).inserted, 1);
    const firstDeviceBucket = () => f.db.listUnifiTelemetryHistory(START).data
        .find(row => row.deviceId === 'device-a');
    assert.equal(firstDeviceBucket().rxBytes, 5000);
    await f.db.cleanup(365, 100000, { now: NOW });
    assert.equal(firstDeviceBucket().rxBytes, 5000);
});

test('P1 rollups preserve per-core arrays and per-disk null gauges, including raw reads', async t => {
    const f = fixture(t);
    for (let i = 0; i < 2; i += 1) {
        f.db.insertPoint('ucg', { t: new Date(START + i * 1000).toISOString(), cores: [10 + i * 20, 40] });
        f.db.insertPoint('nas', { t: new Date(START + i * 1000).toISOString(), disks: { disk1: 30 + i * 10, sleeping: null } });
    }
    assert.deepEqual(f.db.getHistory('ucg', START).data[0].cores, [20, 40]);
    assert.deepEqual(f.db.getHistory('nas', START).data[0].disks, { disk1: 35, sleeping: null });
    await f.db.cleanup(365, 100000, { now: NOW });
    f.restart();
    assert.deepEqual(f.db.getHistory('ucg', START).data[0].cores, [20, 40]);
    assert.deepEqual(f.db.getHistory('nas', START).data[0].disks, { disk1: 35, sleeping: null });
});

test('P1 multi-tier averaging weights only non-null observations, not the whole bucket', async t => {
    const f = fixture(t);
    for (let i = 0; i < 120; i += 1) {
        const temperature = i === 0 ? 50 : i < 60 ? null : 100;
        f.db.insertPoint('trend', { t: new Date(START + i * 1000).toISOString(), temperature });
    }
    await f.db.cleanup(365, 100000, { now: NOW });
    assert.equal(f.db.getHistory('trend', START).data[0].temperature, 99.1803);
    assert.equal(Object.keys(f.db.getHistory('trend', START).data[0]).some(key => key.startsWith('_smarthub')), false);
});

test('P1 late disjoint source rows merge into retained rollups without losing newer counters', async t => {
    const f = fixture(t);
    f.db.insertPoint('trend', { t: new Date(START + 59000).toISOString(), temperature: 100, rxBytes: 500 });
    await f.db.cleanup(365, 100000, { now: NOW });
    f.db.insertPoint('trend', { t: new Date(START + 1000).toISOString(), temperature: 50, rxBytes: 20 });
    // During cleanup the retained coarse bucket and new raw data are disjoint.
    assert.equal(f.db.getHistory('trend', START).data[0].temperature, 75);
    await f.db.cleanup(365, 100000, { now: NOW });
    const result = f.db.getHistory('trend', START).data[0];
    assert.equal(result.temperature, 75);
    assert.equal(result.rxBytes, 500);
    assert.equal(f.inspect(sql => sql.prepare("SELECT SUM(sample_count) AS samples FROM history_rollups WHERE series='trend'").get().samples), 2);
});

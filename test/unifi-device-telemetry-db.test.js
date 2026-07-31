'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-unifi-telemetry-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function row(deviceId, overrides = {}) {
    return {
        deviceId, name: 'U7 Pro', model: 'U7PRO', type: 'uap', online: true,
        cpu: 20, temperature: 60, temperatureStatus: 'supported', temperatureSource: 'device_ssh',
        clientCount: 4, linkSpeedMbps: 2500, rxBytes: 10, txBytes: 20,
        rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0, ...overrides
    };
}

test('fresh and existing databases receive an idempotent dedicated telemetry migration', t => {
    const directory = fixture(t);
    const file = path.join(directory, 'smarthub.db');
    const legacy = new Database(file);
    legacy.exec('CREATE TABLE legacy_fixture (id INTEGER PRIMARY KEY)');
    legacy.close();
    let db = createHistoryDb(directory);
    db.close();
    db = createHistoryDb(directory);
    db.close();
    const inspect = new Database(file, { readonly: true });
    assert.equal(inspect.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='unifi_device_telemetry'").get().count, 1);
    assert.equal(inspect.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='legacy_fixture'").get().count, 1);
    inspect.close();
});

test('telemetry history batches are transactional, deduplicated, bounded, and persistent across restart', t => {
    const directory = fixture(t);
    const collectedAt = new Date().toISOString();
    let db = createHistoryDb(directory);
    const snapshot = { collectedAt, stale: false, rows: [row('aa:bb:cc:dd:ee:01'), row('aa:bb:cc:dd:ee:02', { temperature: 61 })] };
    assert.deepEqual(db.insertUnifiTelemetryBatch(snapshot, { keepDays: 30, hardCap: 10 }), { inserted: 2, rejected: 0 });
    assert.equal(db.insertUnifiTelemetryBatch(snapshot, { keepDays: 30, hardCap: 10 }).inserted, 0);
    db.close();
    db = createHistoryDb(directory);
    assert.equal(db.listUnifiTelemetrySince(0).length, 2);
    db.close();
});

test('stale, invalid, and unsafe values are rejected while offline residual temperature becomes null', t => {
    const directory = fixture(t);
    const db = createHistoryDb(directory);
    t.after(() => db.close());
    const collectedAt = new Date().toISOString();
    assert.deepEqual(db.insertUnifiTelemetryBatch({ collectedAt, stale: true, rows: [row('aa:bb:cc:dd:ee:01')] }), { inserted: 0, rejected: 1 });
    const result = db.insertUnifiTelemetryBatch({ collectedAt, stale: false, rows: [
        row('bad\nidentity'), row('aa:bb:cc:dd:ee:02', { cpu: 101 }),
        row('aa:bb:cc:dd:ee:03', { online: false, temperature: 88, temperatureStatus: 'offline' })
    ] });
    assert.deepEqual(result, { inserted: 1, rejected: 2 });
    assert.equal(db.listUnifiTelemetrySince(0)[0].temperature, null);
});

test('retention and hard cap prevent unbounded telemetry growth', t => {
    const directory = fixture(t);
    const db = createHistoryDb(directory);
    t.after(() => db.close());
    for (let index = 0; index < 4; index += 1) {
        db.insertUnifiTelemetryBatch({ collectedAt: new Date(Date.now() - (3 - index) * 1000).toISOString(), stale: false, rows: [row(`device-${index}`)] }, { keepDays: 30, hardCap: 2 });
    }
    const rows = db.listUnifiTelemetrySince(0);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(value => value.deviceId), ['device-2', 'device-3']);
});

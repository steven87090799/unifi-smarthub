'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');

test('telemetry stays queryable in memory until a batch flush persists it', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-buffer-test-'));
    const db = createHistoryDb(dir, { slowQueryMs: 10000, maxPendingPoints: 1000 });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    const timestamp = new Date().toISOString();
    db.insertPoint('trend', { t: timestamp, clients: 3 });
    assert.equal(db.getSince('trend', 0).length, 1);
    assert.equal(db.getLatest('trend').clients, 3);
    assert.equal(db.diagnostics().write_buffer.pending_points, 1);

    const before = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(before.prepare("SELECT COUNT(*) count FROM history WHERE series = 'trend'").get().count, 0);
    before.close();

    assert.equal(db.flush().flushed, 1);
    const after = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(after.prepare("SELECT COUNT(*) count FROM history WHERE series = 'trend'").get().count, 1);
    after.close();
    assert.equal(db.diagnostics().write_buffer.pending_points, 0);
});

test('buffer limits force a batch flush while critical UPS events remain immediate', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-buffer-limit-test-'));
    const db = createHistoryDb(dir, { slowQueryMs: 10000, maxPendingPoints: 2 });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    db.insertPoint('ups', { t: new Date().toISOString(), batt: 100 });
    db.insertUpsEvent({ start: new Date().toISOString(), minBattery: 100, startVoltage: 110 });
    let readonly = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(readonly.prepare('SELECT COUNT(*) count FROM history').get().count, 0);
    assert.equal(readonly.prepare('SELECT COUNT(*) count FROM ups_events').get().count, 1);
    readonly.close();

    db.insertPoint('ups', { t: new Date().toISOString(), batt: 99 });
    readonly = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(readonly.prepare('SELECT COUNT(*) count FROM history').get().count, 2);
    readonly.close();
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryDb } = require('../db');

test('cleanup keeps recent five-second samples and compacts older history to minute buckets', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-history-rollup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = createHistoryDb(dir, { slowQueryMs: 10_000, maxPendingPoints: 10_000 });
    const old = Date.now() - (25 * 60 * 60 * 1000);
    for (let offset = 0; offset < 60 * 60 * 1000; offset += 5000) db.insertPoint('trend', { t: new Date(old + offset).toISOString(), clients: offset / 5000 });
    const recent = Date.now() - 60_000;
    for (let offset = 0; offset < 60_000; offset += 5000) db.insertPoint('trend', { t: new Date(recent + offset).toISOString(), clients: 99 });
    db.cleanup(30, 100_000);
    const rows = db.getSince('trend', old - 1000);
    // The most recent 24 hours stay raw, so the boundary hour may include up
    // to one additional minute of five-second samples.
    assert.ok(rows.length <= 84, `expected minute rollup plus recent samples, got ${rows.length}`);
    assert.ok(rows.filter(row => Date.parse(row.t) >= recent).length >= 10);
    db.close();
});

test('cleanup leaves the active partial minute raw and is idempotent with weighted averages', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-history-idempotent-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = createHistoryDb(dir, { slowQueryMs: 10_000, maxPendingPoints: 10_000 });
    const base = Date.now() - 26 * 60 * 60 * 1000;
    const minute = Math.floor(base / 60_000) * 60_000;
    // A completed minute: 1 and 3 must remain average 2 after repeated cleanup.
    db.insertPoint('trend', { t: new Date(minute + 5_000).toISOString(), clients: 1 });
    db.insertPoint('trend', { t: new Date(minute + 15_000).toISOString(), clients: 3 });
    // The last old minute can be partial relative to cleanup's cutoff and must survive raw.
    const partial = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 60_000) * 60_000;
    db.insertPoint('trend', { t: new Date(partial + 55_000).toISOString(), clients: 9 });
    db.cleanup(30, 100_000);
    const once = db.getSince('trend', minute - 1);
    const rolled = once.find(row => Date.parse(row.t) === minute);
    assert.equal(rolled.clients, 2);
    assert.ok(once.some(row => Date.parse(row.t) === partial + 55_000));
    db.cleanup(30, 100_000);
    const twice = db.getSince('trend', minute - 1);
    assert.equal(twice.find(row => Date.parse(row.t) === minute).clients, 2);
    db.close();
});

test('cleanup retains 365 days through coarser rollups while enforcing hard cap', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-history-cap-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = createHistoryDb(dir, { slowQueryMs: 10_000, maxPendingPoints: 10_000 });
    const start = Date.now() - 364 * 86400000;
    // Representative high-frequency source data; cleanup must not keep an unbounded raw set.
    for (let i = 0; i < 12_000; i += 1) db.insertPoint('trend', { t: new Date(start + i * 5000).toISOString(), clients: i % 10 });
    db.cleanup(365, 1000);
    const rows = db.getSince('trend', start - 1);
    assert.ok(rows.length <= 1000, `hard cap exceeded: ${rows.length}`);
    assert.ok(rows.length > 0);
    db.close();
});

test('yielding cleanup uses bounded batches and coalesces concurrent requests', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-history-yielding-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = createHistoryDb(dir, { slowQueryMs: 10_000, maxPendingPoints: 10_000 });
    const old = Date.now() - (26 * 60 * 60 * 1000);
    for (let offset = 0; offset < 250 * 5000; offset += 5000) {
        db.insertPoint('trend', { t: new Date(old + offset).toISOString(), clients: offset / 5000 });
    }
    let yields = 0;
    const first = db.cleanupYielding(30, 100_000, {
        batchSize: 25,
        yieldToLoop: async () => { yields += 1; }
    });
    const second = db.cleanupYielding(30, 100_000);
    assert.strictEqual(second, first);
    const result = await first;
    assert.ok(yields >= 10, `expected multiple event-loop yields, got ${yields}`);
    assert.ok(result.processed >= 250);
    db.close();
});

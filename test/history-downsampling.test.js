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
    assert.ok(rows.length <= 72, `expected minute rollup plus recent samples, got ${rows.length}`);
    assert.ok(rows.filter(row => Date.parse(row.t) >= recent).length >= 10);
    db.close();
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');

function fixture(t, options) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-p1-backpressure-'));
    const history = createHistoryDb(directory, options);
    const sql = new Database(history.file);
    t.after(() => {
        sql.exec('DROP TRIGGER IF EXISTS p1_storage_failure');
        history.close(); sql.close(); fs.rmSync(directory, { recursive: true, force: true });
    });
    return { history, sql };
}
const point = i => ({ t: new Date(1700000000000 + i * 1000).toISOString(), clients: i });

test('P1 repeated storage write failures cannot grow the history buffer beyond its cap', t => {
    const { history, sql } = fixture(t, { maxPendingPoints: 4, maxPendingBytes: 1024 });
    // Transaction failure injection is isolated to telemetry, never a real disk.
    sql.exec("CREATE TRIGGER p1_storage_failure BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
    let rejected = 0;
    for (let i = 0; i < 500; i += 1) {
        try { history.insertPoint('trend', point(i)); } catch { rejected += 1; }
    }
    assert.ok(rejected > 0);
    const state = history.diagnostics().write_buffer;
    assert.equal(state.pending_points, 4);
    assert.ok(state.pending_bytes <= state.max_bytes);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0, 'failed transaction must remain atomic');
    sql.exec('DROP TRIGGER p1_storage_failure');
    assert.equal(history.flush().flushed, 4, 'accepted points must survive the failure');
    assert.deepEqual(history.getSince('trend', 0).map(value => value.clients), [0, 1, 2, 3]);
    history.insertPoint('trend', point(500));
    history.flush();
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM history').get().n, 5);
});

test('P1 byte pressure flushes before admission and rejects a single oversized point', t => {
    const { history, sql } = fixture(t, { maxPendingPoints: 100, maxPendingBytes: 1024 });
    const large = i => ({ ...point(i), payload: 'x'.repeat(600) });
    history.insertPoint('trend', large(0));
    sql.exec("CREATE TRIGGER p1_storage_failure BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
    for (let i = 1; i < 50; i += 1) assert.throws(() => history.insertPoint('trend', large(i)));
    assert.equal(history.diagnostics().write_buffer.pending_points, 1);
    assert.ok(history.diagnostics().write_buffer.pending_bytes <= 1024);
    sql.exec('DROP TRIGGER p1_storage_failure');
    assert.throws(() => history.insertPoint('trend', { ...point(100), payload: 'x'.repeat(2048) }), /exceeds.*buffer/i);
    history.flush();
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
});

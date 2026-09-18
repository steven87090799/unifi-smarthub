'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');

test('P1 a failed rollup transaction retains raw data and can recover without duplicates', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-p1-rollback-'));
    const now = Date.parse('2026-09-18T00:00:00Z');
    const history = createHistoryDb(directory, { now: () => now });
    const sql = new Database(history.file);
    t.after(() => { sql.close(); history.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    for (let i = 0; i < 120; i += 1) history.insertPoint('trend', {
        t: new Date(now - 60 * 86400000 + i * 60000).toISOString(), temperature: i % 2 ? 40 : null
    });
    history.flush();
    sql.exec("CREATE TRIGGER p1_rollup_failure BEFORE INSERT ON history_rollups BEGIN SELECT RAISE(ABORT, 'injected rollup failure'); END");
    await assert.rejects(history.cleanup(90, 100000, { now }), /injected rollup failure/);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM history').get().n, 120);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM history_rollups').get().n, 0);
    sql.exec('DROP TRIGGER p1_rollup_failure');
    await history.cleanup(90, 100000, { now });
    assert.equal(sql.prepare('SELECT SUM(sample_count) AS n FROM history_rollups').get().n, 120);
    assert.equal(history.getHistory('trend', 0).data[0].temperature, 40);
    assert.equal((await history.cleanup(90, 100000, { now })).rollups_created, 0);
    assert.equal(sql.pragma('quick_check', { simple: true }), 'ok');
});

test('P1 flushed telemetry survives an isolated process crash and WAL recovery', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-p1-wal-crash-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dbModule = path.resolve(__dirname, '../db.js');
    const child = spawnSync(process.execPath, ['-e', `
        const { createHistoryDb } = require(${JSON.stringify(dbModule)});
        const db = createHistoryDb(process.argv[1]);
        for (let i = 0; i < 20; i++) db.insertPoint('trend', { t: new Date(1700000000000 + i * 1000).toISOString(), clients: i });
        db.flush();
        process.kill(process.pid, 'SIGKILL');
    `, directory], { timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL');
    assert.ok(fs.statSync(path.join(directory, 'smarthub.db-wal')).size > 0);
    const history = createHistoryDb(directory);
    try {
        assert.equal(history.getSince('trend', 0).length, 20);
        assert.equal(history.diagnostics().ok, true);
        const checkpoint = history.checkpoint();
        assert.equal(checkpoint[0].busy, 0);
    } finally { history.close(); }
    const restarted = createHistoryDb(directory);
    try { assert.equal(restarted.getSince('trend', 0).length, 20); }
    finally { restarted.close(); }
});

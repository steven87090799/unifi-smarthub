'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { captureHistoryCandidates, candidateParams } = require('./helpers/history-candidates');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-candidate-plan-'));
    const { history, statements } = captureHistoryCandidates(directory);
    const db = new Database(history.file);
    t.after(() => { db.close(); history.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { db, statements };
}

test('all ten cleanup candidate queries stop at the batch limit without a full-range sort', async t => {
    const { db, statements } = fixture(t);
    assert.equal(statements.length, 10, 'cover raw and promotion queries for both storage families');
    for (const [index, sql] of statements.entries()) {
        await t.test(`candidate ${index + 1}`, () => {
            const ops = db.prepare(`EXPLAIN ${sql}`).all(...candidateParams(sql, 0, 2e12, 100));
            assert.equal(ops.some(row => /^(?:SorterOpen|SorterSort|Sort)$/.test(row.opcode)), false,
                `batch LIMIT must not follow a full-range sort: ${sql}`);
        });
    }
});

test('candidate batching preserves complete buckets, sparse devices, range edges and uniqueness', t => {
    const { db, statements } = fixture(t);
    const start = Date.parse('2026-01-01T00:00:00Z');
    const historyInsert = db.prepare('INSERT INTO history(series,ts,data) VALUES(?,?,?)');
    const rollupInsert = db.prepare('INSERT INTO history_rollups(series,resolution,bucket_ts,data,sample_count) VALUES(?,?,?,?,?)');
    const telemetryInsert = db.prepare('INSERT INTO unifi_device_telemetry(sampled_ts,device_id,data) VALUES(?,?,?)');
    const telemetryRollup = db.prepare('INSERT INTO unifi_device_telemetry_rollups(device_id,resolution,bucket_ts,data,sample_count) VALUES(?,?,?,?,?)');
    db.transaction(() => {
        for (let minute = 0; minute < 1500; minute += 1) {
            const ts = start + minute * 60000;
            historyInsert.run('trend', ts, '{}');
            historyInsert.run('trend', ts + 10000, '{}');
            historyInsert.run('other', ts, '{}');
            rollupInsert.run('trend', '1m', ts, '{}', 2);
            for (const [device, offset] of [['device-z', 0], ['device-a', 10000]]) {
                if (device === 'device-a' && minute % 2) continue;
                telemetryInsert.run(ts + offset, device, '{}');
                telemetryRollup.run(device, '1m', ts, '{}', 1);
            }
        }
    })();
    for (const sql of statements) {
        const end = start + 1499 * 60000;
        const params = candidateParams(sql, start, end, 100000);
        const all = db.prepare(sql).all(...params);
        const first = db.prepare(sql).all(...candidateParams(sql, start, end, 7));
        assert.deepEqual(first, all.slice(0, 7), 'LIMIT is a stable prefix of the chronological source scan');
        assert.equal(new Set(all.map(row => `${row.device_id || ''}:${row.bucket_ts}`)).size, all.length);
        assert.ok(all.every(row => row.bucket_ts >= start && row.bucket_ts < end));
        assert.ok(all.every((row, i) => !i || row.bucket_ts >= all[i - 1].bucket_ts));
        assert.equal(db.prepare(sql).all(...candidateParams(sql, end, end, 7)).length, 0);
        if (/SELECT DISTINCT device_id/.test(sql)) {
            assert.deepEqual(new Set(all.map(row => row.device_id)), new Set(['device-a', 'device-z']));
        }
    }
});

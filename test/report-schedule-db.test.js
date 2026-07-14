'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const {
    REPORT_CLAIM_RETRY_AFTER_MS,
    REPORT_CLAIM_STALE_MS,
    REPORT_MAX_ATTEMPTS,
    REPORT_SCHEDULE_KEY_RETENTION,
    createHistoryDb
} = require('../db');

const SCHEDULE_KEY = 'scheduled:2026-07-13:08';
const CLAIM_TS = '2026-07-13T00:07:00.000Z';
const NON_OWNER_TOKEN = '00000000-0000-4000-8000-000000000000';

function tempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function openHistoryDb(t, dir) {
    const db = createHistoryDb(dir, { slowQueryMs: 10000 });
    t.after(() => db.close());
    return db;
}

function workerResult(worker) {
    return new Promise((resolve, reject) => {
        let result;
        worker.once('message', message => { result = message; });
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve(result) : reject(new Error(`worker exited ${code}`)));
    });
}

async function releaseWorkerBarrier(signal, workers) {
    const readyDeadline = Date.now() + 5000;
    while (Atomics.load(signal, 0) < workers.length && Date.now() < readyDeadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(Atomics.load(signal, 0), workers.length, 'workers did not reach the barrier');
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1, workers.length);
}

function claim(db, overrides = {}) {
    return db.claimScheduledReport({
        scheduleKey: SCHEDULE_KEY,
        ts: CLAIM_TS,
        title: 'Scheduled report',
        ...overrides
    });
}

function complete(db, owner, overrides = {}) {
    return db.completeScheduledReport(owner.scheduleKey, {
        ts: CLAIM_TS,
        attemptCount: owner.attemptCount,
        claimToken: owner.claimToken,
        deliveryStatus: 'sent',
        body: 'scheduled report body',
        ...overrides
    });
}

test('existing report_runs databases migrate in place and keep report history reads compatible', t => {
    const dir = tempDir(t, 'smarthub-report-migration-');
    const file = path.join(dir, 'smarthub.db');
    const legacy = new Database(file);
    legacy.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            trigger TEXT NOT NULL,
            title TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            channel TEXT,
            delivery_error TEXT,
            body TEXT NOT NULL
        );
    `);
    legacy.prepare(`
        INSERT INTO report_runs (ts, trigger, title, delivery_status, channel, delivery_error, body)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Date.parse('2026-07-12T00:00:00.000Z'), 'manual', 'Legacy report', 'sent', 'discord', null, 'legacy body');
    legacy.close();

    let db = createHistoryDb(dir, { slowQueryMs: 10000 });
    const runs = db.listReportRuns();
    assert.deepEqual(runs, [{
        id: 1,
        ts: '2026-07-12T00:00:00.000Z',
        trigger: 'manual',
        title: 'Legacy report',
        deliveryStatus: 'sent',
        channel: 'discord',
        deliveryError: null,
        body: 'legacy body',
        scheduleKey: null,
        runStatus: 'completed',
        claimedAt: null,
        completedAt: '2026-07-12T00:00:00.000Z',
        attemptCount: 1
    }]);

    const inspector = new Database(file, { readonly: true });
    const columns = new Set(inspector.pragma('table_info(report_runs)').map(column => column.name));
    for (const column of ['schedule_key', 'run_status', 'claimed_ts', 'completed_ts', 'attempt_count', 'claim_token']) {
        assert.equal(columns.has(column), true, `missing migrated column ${column}`);
    }
    assert.ok(inspector.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_report_runs_schedule_key'").get());
    inspector.close();

    assert.equal(claim(db).claimed, true);
    db.close();
    db = createHistoryDb(dir, { slowQueryMs: 10000 });
    const afterReopen = claim(db);
    assert.equal(afterReopen.claimed, false);
    assert.equal(afterReopen.status, 'claimed');
    assert.equal(afterReopen.claimToken, null);
    db.close();
});

test('partial migration preserves crashed claimed work as retryable', t => {
    const dir = tempDir(t, 'smarthub-report-claimed-migration-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, trigger TEXT NOT NULL,
            title TEXT NOT NULL, delivery_status TEXT NOT NULL, channel TEXT,
            delivery_error TEXT, body TEXT NOT NULL, schedule_key TEXT
        );
    `);
    const ts = Date.parse(CLAIM_TS);
    partial.prepare(`
        INSERT INTO report_runs (ts, trigger, title, delivery_status, body, schedule_key)
        VALUES (?, 'scheduled', 'Crashed partial claim', 'claimed', '', ?)
    `).run(ts, SCHEDULE_KEY);
    partial.close();

    const db = openHistoryDb(t, dir);
    const beforeStale = claim(db, { ts: ts + REPORT_CLAIM_STALE_MS - 1 });
    assert.equal(beforeStale.claimed, false);
    assert.equal(beforeStale.status, 'claimed');
    const recovered = claim(db, { ts: ts + REPORT_CLAIM_STALE_MS });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.attemptCount, 2);
});

test('migration normalizes invalid attempt and run status values without blocking a slot forever', t => {
    const dir = tempDir(t, 'smarthub-report-invalid-state-migration-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, trigger TEXT NOT NULL,
            title TEXT NOT NULL, delivery_status TEXT NOT NULL, channel TEXT,
            delivery_error TEXT, body TEXT NOT NULL, schedule_key TEXT,
            run_status TEXT, claimed_ts INTEGER, completed_ts INTEGER,
            attempt_count, claim_token TEXT
        );
    `);
    const ts = Date.parse(CLAIM_TS);
    partial.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, delivery_error, body, schedule_key,
            run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (?, 'scheduled', 'Corrupt partial claim', 'claimed', NULL, '', ?,
                  'mystery', NULL, ?, 'many', ?)
    `).run(ts, SCHEDULE_KEY, ts + 5000, NON_OWNER_TOKEN);
    partial.close();

    const db = openHistoryDb(t, dir);
    const recovered = claim(db, { ts: ts + REPORT_CLAIM_STALE_MS });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.attemptCount, 2);
    assert.equal(recovered.status, 'claimed');
});

test('migration repairs malformed report timestamps and list mapping remains defensive', t => {
    const dir = tempDir(t, 'smarthub-report-invalid-time-migration-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, trigger TEXT NOT NULL,
            title TEXT NOT NULL, delivery_status TEXT NOT NULL, channel TEXT,
            delivery_error TEXT, body TEXT NOT NULL, schedule_key TEXT,
            run_status TEXT, claimed_ts, completed_ts, attempt_count,
            claim_token TEXT
        );
    `);
    const validTs = Date.parse(CLAIM_TS);
    partial.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, body, schedule_key, run_status,
            claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (?, 'scheduled', 'Malformed claimed time', 'claimed', '', ?, 'claimed',
                  'not-a-timestamp', 'also-invalid', 1, ?)
    `).run(validTs, SCHEDULE_KEY, NON_OWNER_TOKEN);
    partial.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, body, schedule_key, run_status,
            claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES ('bad-ts', 'manual', 'Malformed terminal time', 'sent', '', NULL,
                  'completed', NULL, 'bad-completion', 1, NULL)
    `).run();
    partial.close();

    const db = openHistoryDb(t, dir);
    const runs = db.listReportRuns();
    assert.equal(runs.length, 2);
    for (const run of runs) {
        assert.match(run.ts, /^\d{4}-\d{2}-\d{2}T/);
        if (run.runStatus !== 'claimed') assert.match(run.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    const recovered = db.claimNextScheduledReport({ ts: validTs + REPORT_CLAIM_STALE_MS });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.scheduleKey, SCHEDULE_KEY);

    const corrupter = new Database(file);
    corrupter.prepare('UPDATE report_runs SET completed_ts = ? WHERE title = ?').run('runtime-corruption', 'Malformed terminal time');
    corrupter.close();
    const terminal = db.listReportRuns().find(run => run.title === 'Malformed terminal time');
    assert.equal(terminal.completedAt, null);
});

test('partial migration preserves duplicate history while repairing unique slot identity', t => {
    const dir = tempDir(t, 'smarthub-report-partial-migration-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            trigger TEXT NOT NULL,
            title TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            channel TEXT,
            delivery_error TEXT,
            body TEXT NOT NULL,
            schedule_key TEXT
        );
    `);
    const insert = partial.prepare(`
        INSERT INTO report_runs (ts, trigger, title, delivery_status, body, schedule_key)
        VALUES (?, 'scheduled', ?, 'sent', '', ?)
    `);
    insert.run(Date.parse(CLAIM_TS), 'First partial row', SCHEDULE_KEY);
    insert.run(Date.parse(CLAIM_TS) + 1, 'Duplicate partial row', SCHEDULE_KEY);
    partial.exec(`
        CREATE UNIQUE INDEX idx_report_runs_schedule_key
        ON report_runs(schedule_key)
        WHERE schedule_key LIKE 'reserved:%';
    `);
    partial.close();

    const db = openHistoryDb(t, dir);
    assert.equal(db.listReportRuns().length, 2);
    assert.equal(claim(db).claimed, false);

    const raw = new Database(file, { readonly: true });
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM report_runs').get().count, 2);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key = ?').get(SCHEDULE_KEY).count, 1);
    const index = raw.pragma('index_list(report_runs)').find(candidate => candidate.name === 'idx_report_runs_schedule_key');
    raw.close();
    assert.equal(index.unique, 1);
    assert.equal(index.partial, 0);
});

test('duplicate-key migration preserves delivered identity over an older claimed row', t => {
    const dir = tempDir(t, 'smarthub-report-duplicate-delivery-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            trigger TEXT NOT NULL,
            title TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            channel TEXT,
            delivery_error TEXT,
            body TEXT NOT NULL,
            schedule_key TEXT,
            run_status TEXT NOT NULL DEFAULT 'completed',
            claimed_ts INTEGER,
            completed_ts INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 1
        );
    `);
    const insert = partial.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, channel, delivery_error, body,
            schedule_key, run_status, claimed_ts, completed_ts, attempt_count
        ) VALUES (?, 'scheduled', ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1)
    `);
    const claimedTs = Date.parse(CLAIM_TS);
    insert.run(claimedTs, 'Old claimed row', 'claimed', null, '', SCHEDULE_KEY, 'claimed', claimedTs, null);
    insert.run(claimedTs + 1000, 'Delivered row', 'sent', 'discord', 'delivered', SCHEDULE_KEY,
        'completed', claimedTs, claimedTs + 1000);
    partial.close();

    const db = openHistoryDb(t, dir);
    const duplicate = claim(db, { ts: claimedTs + REPORT_CLAIM_STALE_MS + 1 });
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.status, 'completed');
    const raw = new Database(file, { readonly: true });
    const identified = raw.prepare('SELECT title, run_status FROM report_runs WHERE schedule_key = ?').get(SCHEDULE_KEY);
    const detached = raw.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key IS NULL').get().count;
    raw.close();
    assert.deepEqual(identified, { title: 'Delivered row', run_status: 'completed' });
    assert.equal(detached, 1);
});

test('duplicate-key migration preserves exhausted identity over a stale claim', t => {
    const dir = tempDir(t, 'smarthub-report-exhausted-migration-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, trigger TEXT NOT NULL,
            title TEXT NOT NULL, delivery_status TEXT NOT NULL, channel TEXT,
            delivery_error TEXT, body TEXT NOT NULL, schedule_key TEXT,
            run_status TEXT NOT NULL DEFAULT 'completed', claimed_ts INTEGER,
            completed_ts INTEGER, attempt_count INTEGER NOT NULL DEFAULT 1,
            claim_token TEXT
        );
    `);
    const insert = partial.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, delivery_error, body, schedule_key,
            run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (@ts, 'scheduled', @title, @delivery_status, @delivery_error, '',
                  @schedule_key, @run_status, @claimed_ts, @completed_ts, @attempt_count, @claim_token)
    `);
    const ts = Date.parse(CLAIM_TS);
    insert.run({
        ts, title: 'Stale active duplicate', delivery_status: 'claimed', delivery_error: null,
        schedule_key: SCHEDULE_KEY, run_status: 'claimed', claimed_ts: ts,
        completed_ts: null, attempt_count: 1, claim_token: NON_OWNER_TOKEN
    });
    insert.run({
        ts: ts + 1000, title: 'Exhausted durable identity', delivery_status: 'failed',
        delivery_error: 'attempts exhausted', schedule_key: SCHEDULE_KEY, run_status: 'exhausted',
        claimed_ts: ts, completed_ts: ts + 1000, attempt_count: REPORT_MAX_ATTEMPTS, claim_token: null
    });
    partial.close();

    const db = openHistoryDb(t, dir);
    const duplicate = claim(db, { ts: ts + REPORT_CLAIM_STALE_MS + 1 });
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.status, 'exhausted');
    const raw = new Database(file, { readonly: true });
    assert.deepEqual(raw.prepare('SELECT title, run_status FROM report_runs WHERE schedule_key = ?').get(SCHEDULE_KEY), {
        title: 'Exhausted durable identity', run_status: 'exhausted'
    });
    raw.close();
});

test('migration detaches non-scheduled and malformed schedule identities', t => {
    const dir = tempDir(t, 'smarthub-report-poison-migration-');
    const file = path.join(dir, 'smarthub.db');
    const partial = new Database(file);
    partial.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, trigger TEXT NOT NULL,
            title TEXT NOT NULL, delivery_status TEXT NOT NULL, channel TEXT,
            delivery_error TEXT, body TEXT NOT NULL, schedule_key TEXT,
            run_status TEXT NOT NULL DEFAULT 'completed', claimed_ts INTEGER,
            completed_ts INTEGER, attempt_count INTEGER NOT NULL DEFAULT 1,
            claim_token TEXT
        );
    `);
    const insert = partial.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, delivery_error, body, schedule_key,
            run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (?, ?, ?, 'failed', 'legacy poison', '', ?, 'failed', ?, ?, 1, NULL)
    `);
    const ts = Date.parse(CLAIM_TS);
    insert.run(ts, 'manual', 'Manual poison', SCHEDULE_KEY, ts, ts);
    insert.run(ts + 1, 'scheduled', 'Malformed poison', 'not-a-schedule-key', ts, ts + 1);
    partial.close();

    const db = openHistoryDb(t, dir);
    const rows = db.listReportRuns();
    assert.equal(rows.filter(row => row.scheduleKey === null).length, 2);
    assert.equal(claim(db).claimed, true);
});

test('a scheduled slot is claimed once and only its claimed row can be completed', t => {
    const dir = tempDir(t, 'smarthub-report-claim-');
    const db = openHistoryDb(t, dir);

    assert.equal(db.completeScheduledReport(SCHEDULE_KEY, {
        ts: CLAIM_TS,
        attemptCount: 1,
        claimToken: NON_OWNER_TOKEN,
        deliveryStatus: 'sent',
        body: 'must not be inserted'
    }), false);

    const first = claim(db);
    assert.equal(first.claimed, true);
    assert.ok(Number.isInteger(first.id));
    assert.equal(first.scheduleKey, SCHEDULE_KEY);
    assert.equal(first.title, 'Scheduled report');
    assert.equal(first.status, 'claimed');
    assert.equal(first.attemptCount, 1);
    assert.equal(first.recovered, false);
    assert.match(first.claimToken, /^[0-9a-f-]{36}$/i);

    assert.equal(complete(db, first, {
        ts: '2026-07-13T00:08:00.000Z',
        title: 'Completed scheduled report',
        channel: 'discord',
        body: 'report body'
    }), true);
    assert.equal(db.completeScheduledReport(SCHEDULE_KEY, {
        ts: '2026-07-13T00:09:00.000Z',
        attemptCount: first.attemptCount,
        claimToken: first.claimToken,
        deliveryStatus: 'failed',
        body: 'must not overwrite completion'
    }), false);

    const duplicate = claim(db);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.status, 'completed');
    assert.equal(duplicate.attemptCount, 1);
    assert.equal(duplicate.claimToken, null);

    const runs = db.listReportRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].title, 'Completed scheduled report');
    assert.equal(runs[0].deliveryStatus, 'sent');
    assert.equal(runs[0].body, 'report body');

    const raw = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    const row = raw.prepare(`
        SELECT trigger, schedule_key, run_status, claimed_ts, completed_ts, attempt_count
        FROM report_runs WHERE schedule_key = ?
    `).get(SCHEDULE_KEY);
    raw.close();
    assert.deepEqual(row, {
        trigger: 'scheduled',
        schedule_key: SCHEDULE_KEY,
        run_status: 'completed',
        claimed_ts: Date.parse(CLAIM_TS),
        completed_ts: Date.parse('2026-07-13T00:08:00.000Z'),
        attempt_count: 1
    });
});

test('failed completion retries after backoff and successful retry becomes terminal', t => {
    const dir = tempDir(t, 'smarthub-report-failure-');
    let db = createHistoryDb(dir, { slowQueryMs: 10000 });
    const first = claim(db);
    assert.equal(first.claimed, true);
    assert.equal(complete(db, first, {
        ts: '2026-07-13T00:08:00.000Z',
        deliveryStatus: 'failed',
        deliveryError: 'delivery unavailable',
        body: 'report failed'
    }), true);
    db.close();

    db = createHistoryDb(dir, { slowQueryMs: 10000 });
    const duplicate = claim(db);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.status, 'failed');
    assert.equal(db.completeScheduledReport(SCHEDULE_KEY, {
        ts: '2026-07-13T00:10:00.000Z',
        attemptCount: 1,
        claimToken: first.claimToken,
        deliveryStatus: 'sent',
        body: 'must not retry implicitly'
    }), false);

    const retryTs = Date.parse('2026-07-13T00:08:00.000Z') + REPORT_CLAIM_RETRY_AFTER_MS;
    const retry = claim(db, { ts: retryTs });
    assert.equal(retry.claimed, true);
    assert.equal(retry.attemptCount, 2);
    assert.equal(retry.recovered, true);
    assert.notEqual(retry.claimToken, first.claimToken);
    assert.equal(complete(db, retry, {
        ts: retryTs + 1,
        channel: 'discord',
        body: 'retry succeeded'
    }), true);
    const terminal = claim(db, { ts: retryTs + REPORT_CLAIM_STALE_MS + 1 });
    assert.equal(terminal.claimed, false);
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.attemptCount, 2);
    db.close();
});

test('a stale crash claim is reclaimed after its lease and retries are bounded', t => {
    const dir = tempDir(t, 'smarthub-report-stale-claim-');
    const db = openHistoryDb(t, dir);
    const initialTs = Date.parse(CLAIM_TS);
    const initial = claim(db, { ts: initialTs });
    assert.equal(initial.claimed, true);
    assert.equal(claim(db, { ts: initialTs + REPORT_CLAIM_STALE_MS - 1 }).claimed, false);

    let current = initial;
    for (let attempt = 2; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
        const result = claim(db, { ts: initialTs + (attempt - 1) * REPORT_CLAIM_STALE_MS });
        assert.equal(result.claimed, true);
        assert.equal(result.attemptCount, attempt);
        if (attempt === 2) {
            assert.equal(db.completeScheduledReport(SCHEDULE_KEY, {
                ts: initialTs + REPORT_CLAIM_STALE_MS + 1,
                attemptCount: 1,
                claimToken: initial.claimToken,
                deliveryStatus: 'sent',
                body: 'stale owner must not finalize the reclaimed lease'
            }), false);
        }
        current = result;
    }
    const exhausted = claim(db, { ts: initialTs + REPORT_MAX_ATTEMPTS * REPORT_CLAIM_STALE_MS });
    assert.equal(exhausted.claimed, false);
    assert.equal(exhausted.status, 'exhausted');
    assert.equal(exhausted.attemptCount, REPORT_MAX_ATTEMPTS);
    assert.equal(exhausted.claimToken, null);
    assert.equal(complete(db, current, { ts: initialTs + REPORT_MAX_ATTEMPTS * REPORT_CLAIM_STALE_MS + 1 }), false);
});

test('lease renewal fences stale owners and prevents premature reclaim', t => {
    const dir = tempDir(t, 'smarthub-report-renewal-');
    const db = openHistoryDb(t, dir);
    const initialTs = Date.parse(CLAIM_TS);
    const owner = claim(db, { ts: initialTs });
    const renewedTs = initialTs + REPORT_CLAIM_STALE_MS - 1000;

    assert.equal(db.renewScheduledReportClaim(SCHEDULE_KEY, {
        ts: renewedTs,
        attemptCount: owner.attemptCount,
        claimToken: NON_OWNER_TOKEN
    }), false);
    assert.equal(db.renewScheduledReportClaim(SCHEDULE_KEY, {
        ts: renewedTs,
        attemptCount: owner.attemptCount,
        claimToken: owner.claimToken
    }), true);
    assert.equal(claim(db, { ts: initialTs + REPORT_CLAIM_STALE_MS + 1 }).claimed, false);

    const next = claim(db, { ts: renewedTs + REPORT_CLAIM_STALE_MS });
    assert.equal(next.claimed, true);
    assert.equal(next.attemptCount, 2);
    assert.notEqual(next.claimToken, owner.claimToken);
    assert.equal(complete(db, owner, {
        ts: renewedTs + REPORT_CLAIM_STALE_MS + 1,
        body: 'stale owner cannot finalize'
    }), false);
    assert.equal(complete(db, next, {
        ts: renewedTs + REPORT_CLAIM_STALE_MS + 1,
        body: 'new owner finalizes'
    }), true);
});

test('completion cannot predate the latest lease renewal', t => {
    const dir = tempDir(t, 'smarthub-report-completion-clock-');
    const db = openHistoryDb(t, dir);
    const initialTs = Date.parse(CLAIM_TS);
    const owner = claim(db, { ts: initialTs });
    const renewedTs = initialTs + 5000;
    assert.equal(db.renewScheduledReportClaim(SCHEDULE_KEY, {
        ts: renewedTs,
        attemptCount: owner.attemptCount,
        claimToken: owner.claimToken
    }), true);
    assert.equal(complete(db, owner, { ts: renewedTs - 1 }), false);
    assert.equal(complete(db, owner, { ts: renewedTs + 1 }), true);
});

test('DB-backed recovery scan retries failed work without schedule derivation', t => {
    const dir = tempDir(t, 'smarthub-report-recovery-scan-');
    const db = openHistoryDb(t, dir);
    const owner = claim(db);
    const failedTs = Date.parse(CLAIM_TS) + 1000;
    assert.equal(complete(db, owner, {
        ts: failedTs,
        deliveryStatus: 'failed',
        deliveryError: 'provider unavailable'
    }), true);
    assert.equal(db.claimNextScheduledReport({ ts: failedTs + REPORT_CLAIM_RETRY_AFTER_MS - 1 }), null);

    const recovery = db.claimNextScheduledReport({ ts: failedTs + REPORT_CLAIM_RETRY_AFTER_MS });
    assert.equal(recovery.claimed, true);
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.scheduleKey, SCHEDULE_KEY);
    assert.equal(recovery.attemptCount, 2);
    assert.match(recovery.claimToken, /^[0-9a-f-]{36}$/i);
    assert.equal(complete(db, recovery, {
        ts: failedTs + REPORT_CLAIM_RETRY_AFTER_MS + 1,
        body: 'recovered independently'
    }), true);
    assert.equal(db.claimNextScheduledReport({ ts: failedTs + 2 * REPORT_CLAIM_RETRY_AFTER_MS }), null);
});

test('manual failures cannot starve the scheduled recovery queue', t => {
    const dir = tempDir(t, 'smarthub-report-manual-starvation-');
    const db = openHistoryDb(t, dir);
    db.insertReportRun({
        ts: '2026-07-13T00:00:00.000Z',
        trigger: 'manual',
        title: 'Older manual failure',
        deliveryStatus: 'failed',
        deliveryError: 'manual failure',
        body: 'manual'
    });
    const owner = claim(db);
    const failedTs = Date.parse(CLAIM_TS) + 1000;
    assert.equal(complete(db, owner, {
        ts: failedTs,
        deliveryStatus: 'failed',
        deliveryError: 'scheduled failure'
    }), true);

    const recovery = db.claimNextScheduledReport({ ts: failedTs + REPORT_CLAIM_RETRY_AFTER_MS });
    assert.equal(recovery.claimed, true);
    assert.equal(recovery.scheduleKey, SCHEDULE_KEY);
    assert.equal(recovery.attemptCount, 2);
});

test('recovery detaches a malformed external schedule key before selecting valid work', t => {
    const dir = tempDir(t, 'smarthub-report-runtime-poison-');
    const db = openHistoryDb(t, dir);
    const validOwner = claim(db);
    const failedTs = Date.parse(CLAIM_TS) + 1000;
    assert.equal(complete(db, validOwner, {
        ts: failedTs,
        deliveryStatus: 'failed',
        deliveryError: 'valid retry'
    }), true);

    const raw = new Database(path.join(dir, 'smarthub.db'));
    raw.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, delivery_error, body, schedule_key,
            run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (?, 'scheduled', 'External malformed row', 'failed', 'bad key', '',
                  'malformed-key', 'failed', ?, ?, 1, NULL)
    `).run(failedTs - 1000, failedTs - 1000, failedTs - 1000);
    raw.close();

    const recovery = db.claimNextScheduledReport({ ts: failedTs + REPORT_CLAIM_RETRY_AFTER_MS });
    assert.equal(recovery.claimed, true);
    assert.equal(recovery.scheduleKey, SCHEDULE_KEY);
    const inspector = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(inspector.prepare("SELECT schedule_key FROM report_runs WHERE title = 'External malformed row'").get().schedule_key, null);
    inspector.close();
});

test('the final failed attempt becomes terminal instead of remaining retryable', t => {
    const dir = tempDir(t, 'smarthub-report-final-failure-');
    const db = openHistoryDb(t, dir);
    let now = Date.parse(CLAIM_TS);
    let owner = claim(db, { ts: now });

    for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
        now += 1000;
        assert.equal(complete(db, owner, {
            ts: now,
            deliveryStatus: 'failed',
            deliveryError: `attempt ${attempt} failed`
        }), true);
        if (attempt < REPORT_MAX_ATTEMPTS) {
            now += REPORT_CLAIM_RETRY_AFTER_MS;
            owner = db.claimNextScheduledReport({ ts: now });
            assert.equal(owner.attemptCount, attempt + 1);
        }
    }

    assert.equal(db.claimNextScheduledReport({ ts: now + REPORT_CLAIM_RETRY_AFTER_MS }), null);
    const run = db.listReportRuns(1)[0];
    assert.equal(run.runStatus, 'exhausted');
    assert.equal(run.attemptCount, REPORT_MAX_ATTEMPTS);
    assert.equal(run.deliveryStatus, 'failed');
});

test('manual reports remain independent and never consume scheduled identities', t => {
    const dir = tempDir(t, 'smarthub-report-manual-');
    const db = openHistoryDb(t, dir);

    for (let index = 0; index < 2; index++) {
        db.insertReportRun({
            ts: `2026-07-13T00:0${index}:00.000Z`,
            trigger: 'manual',
            scheduleKey: SCHEDULE_KEY,
            title: `Manual report ${index}`,
            deliveryStatus: 'generated',
            body: 'manual body'
        });
    }
    db.insertReportRun({
        ts: '2026-07-13T00:02:00.000Z',
        trigger: 'scheduled',
        title: 'Legacy unkeyed scheduled report',
        deliveryStatus: 'sent',
        body: 'legacy scheduled body'
    });
    assert.equal(claim(db).claimed, true);

    const raw = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM report_runs WHERE trigger = 'manual'").get().count, 2);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key IS NULL').get().count, 3);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key = ?').get(SCHEDULE_KEY).count, 1);
    raw.close();
});

test('durable schedule identity survives bounded report-history cleanup', t => {
    const dir = tempDir(t, 'smarthub-report-retention-');
    let db = createHistoryDb(dir, { slowQueryMs: 10000 });
    const scheduled = claim(db);
    assert.equal(scheduled.claimed, true);
    assert.equal(complete(db, scheduled, {
        ts: CLAIM_TS,
        body: 'scheduled body'
    }), true);

    for (let index = 0; index < 60; index++) {
        db.insertReportRun({
            ts: new Date(Date.parse('2026-07-14T00:00:00.000Z') + index * 1000).toISOString(),
            trigger: 'manual',
            title: `Manual report ${index}`,
            body: 'manual body'
        });
    }
    db.close();

    db = createHistoryDb(dir, { slowQueryMs: 10000 });
    assert.equal(claim(db).claimed, false);
    const raw = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key = ?').get(SCHEDULE_KEY).count, 1);
    assert.ok(raw.prepare('SELECT COUNT(*) AS count FROM report_runs').get().count <= 51);
    raw.close();
    db.close();
});

test('claim validation rejects malformed keys and unbounded metadata', t => {
    const dir = tempDir(t, 'smarthub-report-validation-');
    const db = openHistoryDb(t, dir);
    const invalidKeys = [
        'manual:2026-07-13:08',
        'scheduled:2026-02-30:08',
        'scheduled:2026-07-13:24',
        'scheduled:2026-7-13:08',
        `scheduled:${'x'.repeat(80)}`
    ];
    for (const scheduleKey of invalidKeys) {
        assert.throws(() => claim(db, { scheduleKey }), /scheduleKey/);
    }
    assert.throws(() => claim(db, { ts: Infinity }), /finite timestamp/);
    assert.throws(() => claim(db, { ts: Number.MAX_SAFE_INTEGER }), /finite timestamp/);
    assert.throws(() => claim(db, { ts: 'not-a-date' }), /finite timestamp/);
    assert.throws(() => claim(db, { title: '' }), /non-empty string/);
    assert.throws(() => claim(db, { title: 'x'.repeat(201) }), /at most 200/);
    assert.throws(() => db.completeScheduledReport(SCHEDULE_KEY, {
        ts: CLAIM_TS, deliveryStatus: 'sent', body: 'missing attempt'
    }), /attemptCount/);
    assert.throws(() => db.completeScheduledReport(SCHEDULE_KEY, {
        ts: CLAIM_TS, attemptCount: 1, deliveryStatus: 'sent', body: 'missing token'
    }), /claimToken/);
    assert.equal(db.listReportRuns().length, 0);
});

test('separate SQLite callers racing for one key receive exactly one claim', async t => {
    const dir = tempDir(t, 'smarthub-report-concurrency-');
    const initialized = createHistoryDb(dir, { slowQueryMs: 10000 });
    initialized.close();

    const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(signalBuffer);
    const modulePath = path.resolve(__dirname, '../db.js');
    const workerSource = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { createHistoryDb } = require(workerData.modulePath);
        const signal = new Int32Array(workerData.signalBuffer);
        const db = createHistoryDb(workerData.dir, { slowQueryMs: 10000 });
        Atomics.add(signal, 0, 1);
        Atomics.notify(signal, 0);
        Atomics.wait(signal, 1, 0);
        try {
            parentPort.postMessage(db.claimScheduledReport(workerData.claim));
        } finally {
            db.close();
        }
    `;

    const workers = Array.from({ length: 2 }, () => new Worker(workerSource, {
        eval: true,
        workerData: {
            modulePath,
            dir,
            signalBuffer,
            claim: { scheduleKey: SCHEDULE_KEY, ts: CLAIM_TS, title: 'Concurrent scheduled report' }
        }
    }));
    t.after(() => workers.forEach(worker => worker.terminate()));
    const resultsPromise = Promise.all(workers.map(workerResult));

    await releaseWorkerBarrier(signal, workers);
    const results = await resultsPromise;

    assert.equal(results.filter(result => result.claimed).length, 1);
    assert.equal(results.filter(result => !result.claimed).length, 1);
    assert.equal(new Set(results.map(result => result.id)).size, 1);

    const raw = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    const row = raw.prepare('SELECT COUNT(*) AS count, MAX(attempt_count) AS attempts FROM report_runs WHERE schedule_key = ?').get(SCHEDULE_KEY);
    raw.close();
    assert.deepEqual(row, { count: 1, attempts: 1 });
});

test('concurrent callers serialize legacy report schema migration', async t => {
    const dir = tempDir(t, 'smarthub-report-concurrent-migration-');
    const file = path.join(dir, 'smarthub.db');
    const legacy = new Database(file);
    legacy.exec(`
        CREATE TABLE report_runs (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            trigger TEXT NOT NULL,
            title TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            channel TEXT,
            delivery_error TEXT,
            body TEXT NOT NULL
        );
    `);
    legacy.close();

    const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(signalBuffer);
    const modulePath = path.resolve(__dirname, '../db.js');
    const workerSource = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { createHistoryDb } = require(workerData.modulePath);
        const signal = new Int32Array(workerData.signalBuffer);
        Atomics.add(signal, 0, 1);
        Atomics.notify(signal, 0);
        Atomics.wait(signal, 1, 0);
        const db = createHistoryDb(workerData.dir, { slowQueryMs: 10000 });
        db.close();
        parentPort.postMessage({ ok: true });
    `;
    const workers = Array.from({ length: 4 }, () => new Worker(workerSource, {
        eval: true,
        workerData: { modulePath, dir, signalBuffer }
    }));
    t.after(() => workers.forEach(worker => worker.terminate()));
    const resultsPromise = Promise.all(workers.map(workerResult));
    await releaseWorkerBarrier(signal, workers);
    assert.deepEqual(await resultsPromise, Array.from({ length: 4 }, () => ({ ok: true })));

    const inspector = new Database(file, { readonly: true });
    const columns = new Set(inspector.pragma('table_info(report_runs)').map(column => column.name));
    inspector.close();
    assert.equal(columns.has('claim_token'), true);
});

test('startup retries journal-mode negotiation across a transient SQLite writer lock', async t => {
    const dir = tempDir(t, 'smarthub-report-startup-lock-');
    const initialized = createHistoryDb(dir, { slowQueryMs: 10000 });
    initialized.close();

    const file = path.join(dir, 'smarthub.db');
    const locker = new Database(file);
    locker.pragma('journal_mode = WAL');
    locker.exec('BEGIN IMMEDIATE');
    t.after(() => {
        try { locker.exec('ROLLBACK'); } catch { }
        try { locker.close(); } catch { }
    });

    const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(signalBuffer);
    const modulePath = path.resolve(__dirname, '../db.js');
    const workerSource = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { createHistoryDb } = require(workerData.modulePath);
        const signal = new Int32Array(workerData.signalBuffer);
        Atomics.add(signal, 0, 1);
        Atomics.notify(signal, 0);
        Atomics.wait(signal, 1, 0);
        const started = Date.now();
        const db = createHistoryDb(workerData.dir, { slowQueryMs: 10000 });
        db.close();
        parentPort.postMessage({ ok: true, elapsed: Date.now() - started });
    `;
    const worker = new Worker(workerSource, {
        eval: true,
        workerData: { modulePath, dir, signalBuffer }
    });
    t.after(() => worker.terminate());
    const resultPromise = workerResult(worker);
    await releaseWorkerBarrier(signal, [worker]);
    const release = new Promise(resolve => setTimeout(() => {
        locker.exec('COMMIT');
        resolve();
    }, 100));

    const result = await resultPromise;
    await release;
    assert.equal(result.ok, true);
    assert.ok(result.elapsed >= 50, `startup did not encounter the held lock (${result.elapsed} ms)`);
});

test('concurrent recovery scanners reclaim a failed row exactly once', async t => {
    const dir = tempDir(t, 'smarthub-report-concurrent-recovery-');
    const setup = createHistoryDb(dir, { slowQueryMs: 10000 });
    const owner = claim(setup);
    const failedTs = Date.parse(CLAIM_TS) + 1000;
    assert.equal(complete(setup, owner, {
        ts: failedTs,
        deliveryStatus: 'failed',
        deliveryError: 'retry me'
    }), true);
    setup.close();

    const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const signal = new Int32Array(signalBuffer);
    const modulePath = path.resolve(__dirname, '../db.js');
    const workerSource = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { createHistoryDb } = require(workerData.modulePath);
        const signal = new Int32Array(workerData.signalBuffer);
        const db = createHistoryDb(workerData.dir, { slowQueryMs: 10000 });
        Atomics.add(signal, 0, 1);
        Atomics.notify(signal, 0);
        Atomics.wait(signal, 1, 0);
        try {
            parentPort.postMessage(db.claimNextScheduledReport({ ts: workerData.ts }));
        } finally {
            db.close();
        }
    `;
    const workers = Array.from({ length: 2 }, () => new Worker(workerSource, {
        eval: true,
        workerData: {
            modulePath,
            dir,
            signalBuffer,
            ts: failedTs + REPORT_CLAIM_RETRY_AFTER_MS
        }
    }));
    t.after(() => workers.forEach(worker => worker.terminate()));
    const resultsPromise = Promise.all(workers.map(workerResult));
    await releaseWorkerBarrier(signal, workers);
    const results = await resultsPromise;

    const claimed = results.filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].claimed, true);
    assert.equal(claimed[0].attemptCount, 2);
    assert.match(claimed[0].claimToken, /^[0-9a-f-]{36}$/i);
});

test('scheduled identity retention is explicitly bounded while recent slots remain durable', t => {
    const dir = tempDir(t, 'smarthub-report-schedule-retention-');
    const db = openHistoryDb(t, dir);
    const base = Date.UTC(2025, 0, 1, 0, 0, 0);
    const total = REPORT_SCHEDULE_KEY_RETENTION + 8;
    let latestKey;
    for (let index = 0; index < total; index++) {
        const date = new Date(base + index * 60 * 60 * 1000);
        latestKey = `scheduled:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}:${String(date.getUTCHours()).padStart(2, '0')}`;
        const ts = date.getTime();
        const owner = db.claimScheduledReport({ scheduleKey: latestKey, ts, title: 'Retention report' });
        assert.equal(owner.claimed, true);
        assert.equal(complete(db, owner, { ts: ts + 1, body: 'ok' }), true);
    }

    const raw = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    const count = raw.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key IS NOT NULL').get().count;
    const latest = raw.prepare('SELECT run_status FROM report_runs WHERE schedule_key = ?').get(latestKey);
    raw.close();
    assert.equal(count, REPORT_SCHEDULE_KEY_RETENTION);
    assert.deepEqual(latest, { run_status: 'completed' });
});

test('retention never deletes an active claim and cannot reopen its schedule key', t => {
    const dir = tempDir(t, 'smarthub-report-active-retention-');
    const db = openHistoryDb(t, dir);
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    let first;
    let firstKey;
    for (let index = 0; index <= REPORT_SCHEDULE_KEY_RETENTION; index++) {
        const date = new Date(base + index * 60 * 60 * 1000);
        const key = `scheduled:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}:${String(date.getUTCHours()).padStart(2, '0')}`;
        const result = db.claimScheduledReport({ scheduleKey: key, ts: base, title: 'Concurrent active report' });
        if (index === 0) { first = result; firstKey = key; }
    }
    const duplicate = db.claimScheduledReport({ scheduleKey: firstKey, ts: base, title: 'Duplicate active report' });
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.attemptCount, 1);

    const raw = new Database(path.join(dir, 'smarthub.db'), { readonly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM report_runs WHERE run_status = 'claimed'").get().count,
        REPORT_SCHEDULE_KEY_RETENTION + 1);
    raw.close();
});

test('bulk exhaustion immediately reapplies the terminal schedule-key bound', t => {
    const dir = tempDir(t, 'smarthub-report-exhaustion-retention-');
    const db = openHistoryDb(t, dir);
    const file = path.join(dir, 'smarthub.db');
    const raw = new Database(file);
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const insert = raw.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, delivery_error, body, schedule_key,
            run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (@ts, 'scheduled', 'Stale final claim', 'claimed', NULL, '', @schedule_key,
                  'claimed', @ts, NULL, ${REPORT_MAX_ATTEMPTS}, @claim_token)
    `);
    const seed = raw.transaction(() => {
        for (let index = 0; index <= REPORT_SCHEDULE_KEY_RETENTION; index++) {
            const date = new Date(base + index * 60 * 60 * 1000);
            insert.run({
                ts: base,
                schedule_key: `scheduled:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}:${String(date.getUTCHours()).padStart(2, '0')}`,
                claim_token: NON_OWNER_TOKEN
            });
        }
    });
    seed();
    raw.close();

    assert.equal(db.claimNextScheduledReport({ ts: base + REPORT_CLAIM_STALE_MS }), null);
    const inspector = new Database(file, { readonly: true });
    const count = inspector.prepare('SELECT COUNT(*) AS count FROM report_runs WHERE schedule_key IS NOT NULL').get().count;
    const exhausted = inspector.prepare("SELECT COUNT(*) AS count FROM report_runs WHERE run_status = 'exhausted'").get().count;
    inspector.close();
    assert.equal(count, REPORT_SCHEDULE_KEY_RETENTION);
    assert.equal(exhausted, REPORT_SCHEDULE_KEY_RETENTION);
});

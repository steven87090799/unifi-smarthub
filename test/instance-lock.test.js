'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
    LOCK_FILE_MODE,
    InstanceLockError,
    acquireInstanceLock,
    canonicalRuntimeId,
    parseLegacyOwner
} = require('../server/storage/instance-lock');

const OWNER_SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid > 0),
    token TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    runtime_id TEXT NOT NULL DEFAULT '',
    lease_expires_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-instance-lock-'));
    const lockFile = path.join(directory, '.instance-lock.sqlite');
    const legacyLockFile = path.join(directory, '.instance.lock');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, lockFile, legacyLockFile };
}

function deadProcess(_pid, _signal) {
    const error = new Error('no such process');
    error.code = 'ESRCH';
    throw error;
}

function seedOwner(lockFile, { pid, token, runtimeId = canonicalRuntimeId('stale-runtime'), leaseExpiresAt = 0 }) {
    const database = new Database(lockFile);
    database.pragma('journal_mode = DELETE');
    database.exec(OWNER_SCHEMA);
    database.prepare(`
        INSERT INTO instance_owner(singleton, pid, token, acquired_at, runtime_id, lease_expires_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
            pid = excluded.pid,
            token = excluded.token,
            acquired_at = excluded.acquired_at,
            runtime_id = excluded.runtime_id,
            lease_expires_at = excluded.lease_expires_at
    `).run(pid, token, new Date().toISOString(), runtimeId, leaseExpiresAt);
    database.close();
}

function readOwner(lockFile) {
    const database = new Database(lockFile, { readonly: true, fileMustExist: true });
    try {
        return database.prepare(`
            SELECT pid, token, acquired_at AS acquiredAt, runtime_id AS runtimeId, lease_expires_at AS leaseExpiresAt
            FROM instance_owner WHERE singleton = 1
        `).get() || null;
    }
    finally { database.close(); }
}

test('transactional acquisition admits one owner and exact release permits the next owner', t => {
    const f = fixture(t);
    const first = acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile });
    const persistedFirst = readOwner(f.lockFile);
    assert.deepEqual(
        { pid: persistedFirst.pid, token: persistedFirst.token, runtimeId: persistedFirst.runtimeId, acquiredAt: persistedFirst.acquiredAt },
        first.owner
    );
    assert.ok(persistedFirst.leaseExpiresAt > Date.now());
    assert.equal(fs.statSync(f.lockFile).mode & 0o777, LOCK_FILE_MODE);
    assert.throws(
        () => acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile }),
        error => error instanceof InstanceLockError
            && error.code === 'INSTANCE_LOCK_HELD'
            && error.ownerPid === process.pid
    );
    assert.equal(first.release(), true);
    assert.equal(first.release(), false);
    assert.equal(readOwner(f.lockFile), null);
    const second = acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile });
    assert.notEqual(second.owner.token, first.owner.token);
    assert.equal(second.release(), true);
});

test('stale legacy owners and same-PID container reuse are recoverable', t => {
    const f = fixture(t);
    fs.writeFileSync(f.legacyLockFile, '999999999\n', { mode: 0o600 });
    assert.equal(parseLegacyOwner(fs.readFileSync(f.legacyLockFile, 'utf8')), 999999999);
    const legacyRecovery = acquireInstanceLock({
        lockFile: f.lockFile,
        legacyLockFile: f.legacyLockFile,
        kill: deadProcess
    });
    assert.equal(fs.existsSync(f.legacyLockFile), false);
    assert.equal(legacyRecovery.release(), true);

    seedOwner(f.lockFile, {
        pid: process.pid,
        token: '00000000-0000-4000-8000-000000000000',
        runtimeId: canonicalRuntimeId(process.env.HOSTNAME || os.hostname()),
        leaseExpiresAt: 0
    });
    const pidReuseRecovery = acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile });
    assert.notEqual(pidReuseRecovery.owner.token, '00000000-0000-4000-8000-000000000000');
    assert.equal(pidReuseRecovery.release(), true);
});

test('live, recent malformed, and non-regular legacy owners fail closed', t => {
    const f = fixture(t);
    fs.writeFileSync(f.legacyLockFile, `${process.pid}\n`, { mode: 0o600 });
    assert.throws(
        () => acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile, pid: process.pid + 1, kill: () => {} }),
        error => error.code === 'INSTANCE_LOCK_HELD' && error.ownerPid === process.pid
    );
    assert.equal(readOwner(f.lockFile), null, 'failed legacy validation rolled back the provisional owner');

    fs.writeFileSync(f.legacyLockFile, '{partial');
    assert.throws(
        () => acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile, invalidGraceMs: 5000 }),
        error => error.code === 'INSTANCE_LOCK_INITIALIZING'
    );
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(f.legacyLockFile, old, old);
    const recovered = acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile, invalidGraceMs: 5000 });
    assert.equal(recovered.release(), true);

    const target = path.join(f.directory, 'target');
    fs.writeFileSync(target, 'unused');
    fs.symlinkSync(target, f.legacyLockFile);
    assert.throws(
        () => acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile }),
        error => error.code === 'INSTANCE_LOCK_NOT_REGULAR'
    );
    assert.equal(readOwner(f.lockFile), null);
});

test('release never removes replacement owner metadata', t => {
    const f = fixture(t);
    const lock = acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile });
    const replacement = {
        pid: 424242,
        token: '11111111-1111-4111-8111-111111111111',
        runtimeId: canonicalRuntimeId('replacement-runtime'),
        leaseExpiresAt: Date.now() + 60_000
    };
    seedOwner(f.lockFile, replacement);
    assert.equal(lock.release(), false);
    assert.equal(readOwner(f.lockFile).token, replacement.token);
});

test('cross-container equal PIDs require lease expiry and renewal is token-fenced', t => {
    const f = fixture(t);
    let timestamp = 10_000;
    seedOwner(f.lockFile, {
        pid: 1,
        token: '33333333-3333-4333-8333-333333333333',
        runtimeId: canonicalRuntimeId('container-a'),
        leaseExpiresAt: timestamp + 8000
    });
    assert.throws(
        () => acquireInstanceLock({
            lockFile: f.lockFile,
            legacyLockFile: f.legacyLockFile,
            pid: 1,
            runtimeId: 'container-b',
            now: () => timestamp
        }),
        error => error.code === 'INSTANCE_LOCK_HELD' && error.ownerPid === 1
    );

    seedOwner(f.lockFile, {
        pid: 1,
        token: '66666666-6666-4666-8666-666666666666',
        runtimeId: canonicalRuntimeId('container-b'),
        leaseExpiresAt: timestamp + 8000
    });
    assert.throws(
        () => acquireInstanceLock({
            lockFile: f.lockFile,
            legacyLockFile: f.legacyLockFile,
            pid: 1,
            runtimeId: 'container-b',
            now: () => timestamp
        }),
        error => error.code === 'INSTANCE_LOCK_HELD' && error.ownerPid === 1,
        'same runtime and PID cannot bypass an unexpired lease'
    );

    timestamp += 8001;
    const recovered = acquireInstanceLock({
        lockFile: f.lockFile,
        legacyLockFile: f.legacyLockFile,
        pid: 1,
        runtimeId: 'container-b',
        now: () => timestamp
    });
    const initialExpiry = readOwner(f.lockFile).leaseExpiresAt;
    timestamp += 2000;
    assert.equal(recovered.renew(), true);
    assert.equal(readOwner(f.lockFile).leaseExpiresAt, initialExpiry + 2000);
    timestamp -= 1000;
    assert.equal(recovered.renew(), true);
    assert.equal(
        readOwner(f.lockFile).leaseExpiresAt,
        initialExpiry + 2000,
        'clock rollback must not shorten the accepted lease'
    );
    timestamp += 1000;
    seedOwner(f.lockFile, {
        pid: 1,
        token: '44444444-4444-4444-8444-444444444444',
        runtimeId: canonicalRuntimeId('replacement-container'),
        leaseExpiresAt: timestamp + 8000
    });
    assert.equal(recovered.renew(), false);
    assert.equal(recovered.release(), false);
});

test('pre-lease lock database schema migrates in place before stale takeover', t => {
    const f = fixture(t);
    const database = new Database(f.lockFile);
    database.exec(`
        CREATE TABLE instance_owner (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            pid INTEGER NOT NULL CHECK (pid > 0),
            token TEXT NOT NULL,
            acquired_at TEXT NOT NULL
        ) WITHOUT ROWID;
        INSERT INTO instance_owner(singleton, pid, token, acquired_at)
        VALUES (1, 999999999, '55555555-5555-4555-8555-555555555555', '2026-07-15T00:00:00.000Z');
    `);
    database.close();
    const migrated = acquireInstanceLock({
        lockFile: f.lockFile,
        legacyLockFile: f.legacyLockFile,
        kill: deadProcess
    });
    const migratedDatabase = new Database(f.lockFile, { readonly: true });
    const columns = migratedDatabase.pragma('table_info(instance_owner)').map(column => column.name);
    migratedDatabase.close();
    assert.ok(columns.includes('runtime_id'));
    assert.ok(columns.includes('lease_expires_at'));
    assert.equal(migrated.release(), true);
});

test('malformed owner lease metadata fails closed without replacing the evidence', t => {
    const f = fixture(t);
    const malformedToken = '88888888-8888-4888-8888-888888888888';
    seedOwner(f.lockFile, {
        pid: 424242,
        token: malformedToken,
        leaseExpiresAt: -1
    });
    assert.throws(
        () => acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile }),
        error => error.code === 'INSTANCE_LOCK_OWNER_INVALID' && error.ownerPid === 424242
    );
    assert.equal(readOwner(f.lockFile).token, malformedToken);
});

test('corrupt lock authority fails closed without replacing the evidence', t => {
    const f = fixture(t);
    fs.writeFileSync(f.lockFile, 'not a sqlite database', { mode: 0o600 });
    assert.throws(
        () => acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile }),
        error => error.code === 'INSTANCE_LOCK_DB_FAILED'
    );
    assert.equal(fs.readFileSync(f.lockFile, 'utf8'), 'not a sqlite database');
});

test('simultaneous OS processes produce exactly one DATA_DIR owner', { timeout: 15_000 }, async t => {
    const f = fixture(t);
    const modulePath = path.join(__dirname, '..', 'server', 'storage', 'instance-lock.js');
    const childSource = String.raw`
const fs = require('node:fs');
const { acquireInstanceLock } = require(process.argv[1]);
const lockFile = process.argv[2];
const legacyLockFile = process.argv[3];
const startFile = process.argv[4];
process.stdout.write('ready\n');
const poll = setInterval(() => {
    if (!fs.existsSync(startFile)) return;
    clearInterval(poll);
    try {
        const lock = acquireInstanceLock({ lockFile, legacyLockFile });
        process.stdout.write('acquired\n');
        setTimeout(() => { lock.release(); process.exit(0); }, 600);
    } catch (error) {
        process.stdout.write('rejected:' + error.code + '\n');
        process.exit(0);
    }
}, 2);
`;

    function contender(startFile) {
        const child = spawn(process.execPath, [
            '--eval', childSource, modulePath, f.lockFile, f.legacyLockFile, startFile
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { errorOutput += chunk; });
        const ready = new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error(`contender readiness timeout: ${output}${errorOutput}`)), 5000);
            const inspect = () => {
                if (!output.includes('ready\n')) return;
                clearTimeout(deadline);
                resolve();
            };
            child.stdout.on('data', inspect);
            child.once('error', reject);
        });
        const closed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal, output, errorOutput }));
        });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
        return { ready, closed };
    }

    async function runRound(name, seedStaleOwner = false) {
        const startFile = path.join(f.directory, `start-${name}`);
        if (seedStaleOwner) {
            seedOwner(f.lockFile, {
                pid: 999999999,
                token: '22222222-2222-4222-8222-222222222222',
                leaseExpiresAt: 0
            });
        }
        const contenders = Array.from({ length: 12 }, () => contender(startFile));
        await Promise.all(contenders.map(item => item.ready));
        fs.writeFileSync(startFile, 'go');
        const results = await Promise.all(contenders.map(item => item.closed));
        for (const result of results) {
            assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.errorOutput);
        }
        const outputSummary = results.map(result => result.output.trim()).sort().join(' | ');
        assert.equal(results.filter(result => result.output.includes('acquired\n')).length, 1, `${name} acquired count: ${outputSummary}`);
        assert.equal(results.filter(result => result.output.includes('rejected:INSTANCE_LOCK_HELD\n')).length, 11, `${name} held count: ${outputSummary}`);
        assert.equal(readOwner(f.lockFile), null, `${name} owner cleanup`);
    }

    await runRound('fresh');
    await runRound('stale', true);
});

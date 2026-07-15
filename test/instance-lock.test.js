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
    parseLegacyOwner
} = require('../server/storage/instance-lock');

const OWNER_SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid > 0),
    token TEXT NOT NULL,
    acquired_at TEXT NOT NULL
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

function seedOwner(lockFile, { pid, token }) {
    const database = new Database(lockFile);
    database.pragma('journal_mode = DELETE');
    database.exec(OWNER_SCHEMA);
    database.prepare(`
        INSERT INTO instance_owner(singleton, pid, token, acquired_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET pid = excluded.pid, token = excluded.token, acquired_at = excluded.acquired_at
    `).run(pid, token, new Date().toISOString());
    database.close();
}

function readOwner(lockFile) {
    const database = new Database(lockFile, { readonly: true, fileMustExist: true });
    try { return database.prepare('SELECT pid, token, acquired_at AS acquiredAt FROM instance_owner WHERE singleton = 1').get() || null; }
    finally { database.close(); }
}

test('transactional acquisition admits one owner and exact release permits the next owner', t => {
    const f = fixture(t);
    const first = acquireInstanceLock({ lockFile: f.lockFile, legacyLockFile: f.legacyLockFile });
    assert.deepEqual(readOwner(f.lockFile), first.owner);
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
        token: '00000000-0000-4000-8000-000000000000'
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
        token: '11111111-1111-4111-8111-111111111111'
    };
    seedOwner(f.lockFile, replacement);
    assert.equal(lock.release(), false);
    assert.equal(readOwner(f.lockFile).token, replacement.token);
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
                token: '22222222-2222-4222-8222-222222222222'
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

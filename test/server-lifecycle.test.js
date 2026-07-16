'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = String.raw`
const Module = require('node:module');
const realDotenv = require('dotenv');
const originalLoad = Module._load;
Module._load = function isolatedDotenv(request, parent, isMain) {
    if (request === 'dotenv') return { config: () => ({ parsed: {} }), parse: realDotenv.parse };
    return originalLoad.call(this, request, parent, isMain);
};
require(process.argv[1]);
`;

async function unusedPort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', resolve);
    });
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    return port;
}

async function waitForHealth(baseUrl, child, output) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited during startup (${child.exitCode})\n${output()}`);
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.status === 200) return;
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`server did not become healthy\n${output()}`);
}

function productionEnvironment(dataDir, port) {
    return {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        DATA_DIR: dataDir,
        SMARTHUB_ENV_FILE: path.join(dataDir, '.env'),
        PANEL_PASSWORD: 'lifecycle-admin-secret',
        PANEL_READONLY_PASSWORD: 'lifecycle-readonly-secret',
        LOG_LEVEL: 'INFO',
        LOG_FORMAT: 'json',
        LOG_JSON: 'true',
        MONITOR_ENABLED: 'false',
        UCG_IP: '127.0.0.1',
        SSH_PORT: '1',
        SSH_USER: '',
        SSH_PASSWORD: '',
        UNIFI_CONTROLLER_URL: 'http://127.0.0.1:1',
        UNIFI_USERNAME: '',
        UNIFI_PASSWORD: '',
        UNIFI_API_KEY: '',
        NAS_HOST: '',
        NAS_USER: '',
        NAS_PASSWORD: '',
        NAS_MONITOR_URL: '',
        WIIM_IP: '127.0.0.1',
        UPS_SOURCE: 'nut',
        NUT_HOST: '127.0.0.1',
        ADGUARD_HOST: '',
        LINUX_HOST: ''
    };
}

test('SIGTERM drains owned work, closes SQLite, and releases the instance owner row', { timeout: 30_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-lifecycle-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, '.env'), '# isolated lifecycle config\n', { mode: 0o600 });
    const port = await unusedPort();
    const isolatedEnvironment = productionEnvironment(dataDir, port);
    const child = spawn(process.execPath, ['--eval', BOOTSTRAP, path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: isolatedEnvironment,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let logs = '';
    const retain = chunk => { logs = `${logs}${chunk}`.slice(-50_000); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });

    await waitForHealth(`http://127.0.0.1:${port}`, child, () => logs);
    const lockDatabasePath = path.join(dataDir, '.instance-lock.sqlite');
    assert.equal(fs.existsSync(lockDatabasePath), true);
    const ownedLockDatabase = new Database(lockDatabasePath, { readonly: true });
    assert.equal(ownedLockDatabase.prepare('SELECT pid FROM instance_owner WHERE singleton = 1').get().pid, child.pid);
    ownedLockDatabase.close();

    const contenderPort = await unusedPort();
    const contender = spawn(process.execPath, ['--eval', BOOTSTRAP, path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: { ...isolatedEnvironment, PORT: String(contenderPort) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => {
        if (contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL');
    });
    let contenderLogs = '';
    contender.stdout.on('data', chunk => { contenderLogs += chunk; });
    contender.stderr.on('data', chunk => { contenderLogs += chunk; });
    const contenderResult = await new Promise((resolve, reject) => {
        contender.once('error', reject);
        contender.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(contenderResult, { code: 1, signal: null });
    assert.match(contenderLogs, /INSTANCE_LOCK_HELD|Another SmartHub instance is already using this DATA_DIR/u);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);

    const started = Date.now();
    child.kill('SIGTERM');
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`SIGTERM timeout\n${logs}`)), 8_000);
    });
    let result;
    try { result = await Promise.race([closed, timeout]); }
    finally { clearTimeout(timeoutHandle); }

    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(Date.now() - started < 6_000, `shutdown exceeded deadline\n${logs}`);
    assert.match(logs, /SmartHub shutdown started/);
    const releasedLockDatabase = new Database(lockDatabasePath, { readonly: true });
    assert.equal(releasedLockDatabase.prepare('SELECT COUNT(*) count FROM instance_owner').get().count, 0);
    releasedLockDatabase.close();

    const db = new Database(path.join(dataDir, 'smarthub.db'), { readonly: true });
    assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }]);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='report_runs'").get());
    db.close();
});

test('instance owner replacement triggers fail-safe shutdown without deleting the replacement', { timeout: 30_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-owner-loss-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, '.env'), '# isolated owner-loss config\n', { mode: 0o600 });
    const port = await unusedPort();
    const child = spawn(process.execPath, ['--eval', BOOTSTRAP, path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: productionEnvironment(dataDir, port),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let logs = '';
    const retain = chunk => { logs = `${logs}${chunk}`.slice(-50_000); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });

    await waitForHealth(`http://127.0.0.1:${port}`, child, () => logs);
    const lockDatabasePath = path.join(dataDir, '.instance-lock.sqlite');
    const lockDatabase = new Database(lockDatabasePath);
    const replacementToken = '77777777-7777-4777-8777-777777777777';
    const replaced = lockDatabase.prepare(`
        UPDATE instance_owner SET token = ?, lease_expires_at = ? WHERE singleton = 1
    `).run(replacementToken, Date.now() + 60_000);
    lockDatabase.close();
    assert.equal(replaced.changes, 1);

    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`owner-loss shutdown timeout\n${logs}`)), 10_000);
    });
    let result;
    try { result = await Promise.race([closed, timeout]); }
    finally { clearTimeout(timeoutHandle); }

    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(logs, /SmartHub lost DATA_DIR instance ownership/u);
    assert.match(logs, /instance-lock-lost/u);
    const replacementDatabase = new Database(lockDatabasePath, { readonly: true });
    assert.equal(
        replacementDatabase.prepare('SELECT token FROM instance_owner WHERE singleton = 1').get().token,
        replacementToken,
        'exact release must preserve the replacement owner row'
    );
    replacementDatabase.close();
});

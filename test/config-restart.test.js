'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'config-restart-admin-secret';
const AUTHORIZATION = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;

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

async function startServer(dataDir, envFile, extraEnv = {}) {
    const port = await unusedPort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_ENV: 'production',
            PORT: String(port),
            DATA_DIR: dataDir,
            SMARTHUB_ENV_FILE: envFile,
            LOG_LEVEL: 'INFO',
            LOG_FORMAT: 'json',
            LOG_JSON: 'true',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    const retain = chunk => { logs = `${logs}${chunk}`.slice(-50_000); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited during startup (${child.exitCode})\n${logs}`);
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.status === 200) return { baseUrl, child, closed, logs: () => logs };
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    child.kill('SIGKILL');
    await closed;
    throw new Error(`server startup timeout\n${logs}`);
}

async function stopServer(runtime) {
    runtime.child.kill('SIGTERM');
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`server shutdown timeout\n${runtime.logs()}`)), 8_000);
    });
    try {
        const result = await Promise.race([runtime.closed, timeout]);
        assert.deepEqual(result, { code: 0, signal: null });
    } finally { clearTimeout(timeoutHandle); }
}

async function adminRead(runtime, route) {
    return fetch(`${runtime.baseUrl}${route}`, {
        headers: { Authorization: AUTHORIZATION },
        signal: AbortSignal.timeout(3_000)
    });
}

async function adminWrite(runtime, route, body) {
    const csrfResponse = await adminRead(runtime, '/api/security/csrf');
    assert.equal(csrfResponse.status, 200);
    const { csrfToken } = await csrfResponse.json();
    return fetch(`${runtime.baseUrl}${route}`, {
        method: 'POST',
        headers: {
            Authorization: AUTHORIZATION,
            Origin: runtime.baseUrl,
            'X-SmartHub-CSRF': csrfToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000)
    });
}

async function adminRestore(runtime, backupText) {
    const csrfResponse = await adminRead(runtime, '/api/security/csrf');
    assert.equal(csrfResponse.status, 200);
    const { csrfToken } = await csrfResponse.json();
    return fetch(`${runtime.baseUrl}/api/config/restore`, {
        method: 'POST',
        headers: {
            Authorization: AUTHORIZATION,
            Origin: runtime.baseUrl,
            'X-SmartHub-CSRF': csrfToken,
            'X-SmartHub-Restore-Confirmation': 'RESTORE',
            'Content-Type': 'application/vnd.unifi-smarthub.backup+json'
        },
        body: backupText,
        signal: AbortSignal.timeout(8_000)
    });
}

test('a UI-persisted connection setting survives a real production process restart', { timeout: 30_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-config-restart-'));
    const envFile = path.join(dataDir, '.env');
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(envFile, [
        `PANEL_PASSWORD=${ADMIN_PASSWORD}`,
        'PANEL_READONLY_PASSWORD=config-restart-readonly-secret',
        'MONITOR_ENABLED=false',
        'UCG_IP=127.0.0.1',
        'SSH_PORT=1',
        'SSH_USER=',
        'SSH_PASSWORD=',
        'UNIFI_CONTROLLER_URL=http://127.0.0.1:1',
        'UNIFI_USERNAME=',
        'UNIFI_PASSWORD=',
        'UNIFI_API_KEY=',
        'NAS_HOST=',
        'NAS_USER=',
        'NAS_PASSWORD=',
        'NAS_MONITOR_URL=',
        'NAS_MONITOR_API_KEY=',
        'NAS_MONITOR_MODE=docker_only',
        'WIIM_IP=192.0.2.10',
        'UPS_SOURCE=pwrstat',
        'PWRSTAT_PATH=/definitely/missing/pwrstat',
        'PPB_USER=',
        'PPB_PASSWORD=',
        'ADGUARD_HOST=',
        'LINUX_HOST='
    ].join('\n') + '\n', { mode: 0o600 });

    const first = await startServer(dataDir, envFile);
    t.after(() => {
        if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
    });
    let response = await adminRead(first, '/api/connections');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fields.WIIM_IP, '192.0.2.10');

    response = await adminWrite(first, '/api/connections', { WIIM_IP: '192.0.2.55' });
    assert.equal(response.status, 200, await response.text());
    response = await adminWrite(first, '/api/connections', {
        NAS_MONITOR_URL: 'http://nas-monitor:8000',
        NAS_MONITOR_API_KEY: '0123456789abcdef0123456789abcdef',
        NAS_MONITOR_MODE: 'full'
    });
    const tupleWriteText = await response.text();
    assert.equal(response.status, 200, tupleWriteText);
    assert.deepEqual(JSON.parse(tupleWriteText).restartRequired, [
        'NAS_MONITOR_URL', 'NAS_MONITOR_API_KEY', 'NAS_MONITOR_MODE'
    ]);
    for (const [route, body] of [
        ['/api/settings', { watcherSec: 45, reportEnabled: false }],
        ['/api/ui-preferences', { preferences: { theme: 'dark' } }],
        ['/api/client-aliases', { mac: 'AA:BB:CC:DD:EE:FF', name: 'Restart Lamp' }],
        ['/api/security/settings', { autoDefense: true }],
        ['/api/notifications/settings', { enabled: false, triggerSystemWarning: true }]
    ]) {
        response = await adminWrite(first, route, body);
        assert.equal(response.status, 200, `${route}: ${await response.text()}`);
    }
    for (const name of [
        'app-settings.json',
        'ui-preferences.json',
        'client-aliases.json',
        'security-settings.json',
        'notification-settings.json'
    ]) {
        assert.equal(fs.statSync(path.join(dataDir, name)).mode & 0o777, 0o600, `${name} mode`);
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')), `${name} JSON`);
    }
    assert.deepEqual(fs.readdirSync(dataDir).filter(name => name.includes('.tmp-')), []);
    await stopServer(first);
    assert.equal(dotenv.parse(fs.readFileSync(envFile)).WIIM_IP, '192.0.2.55');

    const second = await startServer(dataDir, envFile, {
        NAS_MONITOR_URL: '',
        NAS_MONITOR_API_KEY: '',
        NAS_MONITOR_MODE: 'docker_only'
    });
    t.after(() => {
        if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill('SIGKILL');
    });
    response = await adminRead(second, '/api/connections');
    assert.equal(response.status, 200);
    const afterOrdinaryRestart = await response.json();
    assert.equal(afterOrdinaryRestart.fields.WIIM_IP, '192.0.2.55');
    assert.equal(afterOrdinaryRestart.fields.NAS_MONITOR_URL, 'http://nas-monitor:8000');
    assert.equal(afterOrdinaryRestart.fields.NAS_MONITOR_MODE, 'full');
    assert.equal(afterOrdinaryRestart.secretsSet.NAS_MONITOR_API_KEY, true);
    assert.deepEqual(afterOrdinaryRestart.pendingRestartFields.sort(), [
        'NAS_MONITOR_API_KEY', 'NAS_MONITOR_MODE', 'NAS_MONITOR_URL'
    ]);
    assert.equal((await adminRead(second, '/api/settings').then(r => r.json())).watcherSec, 45);
    assert.equal((await adminRead(second, '/api/settings').then(r => r.json())).reportEnabled, false);
    assert.equal((await adminRead(second, '/api/ui-preferences').then(r => r.json())).preferences.theme, 'dark');
    assert.equal((await adminRead(second, '/api/client-aliases').then(r => r.json())).aliases['aa:bb:cc:dd:ee:ff'], 'Restart Lamp');
    assert.equal((await adminRead(second, '/api/security/settings').then(r => r.json())).autoDefense, true);
    const restartedNotifications = await adminRead(second, '/api/notifications/settings').then(r => r.json());
    assert.equal(restartedNotifications.enabled, false);
    assert.equal(restartedNotifications.triggerSystemWarning, true);
    await stopServer(second);

    const third = await startServer(dataDir, envFile, {
        NAS_MONITOR_URL: 'http://nas-monitor:8000',
        NAS_MONITOR_API_KEY: '0123456789abcdef0123456789abcdef',
        NAS_MONITOR_MODE: 'full'
    });
    t.after(() => {
        if (third.child.exitCode === null && third.child.signalCode === null) third.child.kill('SIGKILL');
    });
    response = await adminRead(third, '/api/connections');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).pendingRestartFields, []);
    await stopServer(third);
});

test('a validated backup applies on real production restart with rollback and secret retention', { timeout: 30_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-restore-restart-'));
    const envFile = path.join(dataDir, '.env');
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(envFile, [
        `PANEL_PASSWORD=${ADMIN_PASSWORD}`,
        'PANEL_READONLY_PASSWORD=config-restart-readonly-secret',
        'MONITOR_ENABLED=false',
        'UCG_IP=127.0.0.1',
        'SSH_PORT=1',
        'UNIFI_CONTROLLER_URL=http://127.0.0.1:1',
        'WIIM_IP=127.0.0.1',
        'UPS_SOURCE=pwrstat',
        'PWRSTAT_PATH=/definitely/missing/pwrstat',
        'NAS_MONITOR_MODE=docker_only'
    ].join('\n') + '\n', { mode: 0o600 });

    const first = await startServer(dataDir, envFile);
    t.after(() => {
        if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
    });
    let response = await adminWrite(first, '/api/settings', { watcherSec: 41 });
    assert.equal(response.status, 200, await response.text());
    response = await adminRead(first, '/api/config/backup');
    const backupText = await response.text();
    assert.equal(response.status, 200, backupText.slice(0, 500));
    assert.doesNotMatch(backupText, /config-restart-admin-secret|config-restart-readonly-secret/);
    response = await adminWrite(first, '/api/settings', { watcherSec: 77 });
    assert.equal(response.status, 200, await response.text());
    response = await adminRestore(first, backupText);
    assert.equal(response.status, 202, await response.text());
    assert.equal((await adminRead(first, '/api/config/backup/status').then(r => r.json())).pending, true);
    assert.equal((await adminRead(first, '/api/settings').then(r => r.json())).watcherSec, 77);
    await stopServer(first);

    const second = await startServer(dataDir, envFile);
    t.after(() => {
        if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill('SIGKILL');
    });
    assert.equal((await adminRead(second, '/api/settings').then(r => r.json())).watcherSec, 41);
    assert.equal((await adminRead(second, '/api/config/backup/status').then(r => r.json())).pending, false);
    const rollbackRoot = path.join(dataDir, 'restore-backups');
    const rollbackDirectories = fs.readdirSync(rollbackRoot).map(name => path.join(rollbackRoot, name));
    assert.equal(rollbackDirectories.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rollbackDirectories[0], 'app-settings.json'))).watcherSec, 77);
    const rollbackDb = new Database(path.join(rollbackDirectories[0], 'smarthub.db'), { readonly: true });
    assert.equal(rollbackDb.pragma('quick_check')[0].quick_check, 'ok');
    rollbackDb.close();
    const retainedEnv = fs.readFileSync(envFile, 'utf8');
    assert.match(retainedEnv, /config-restart-admin-secret/);
    assert.match(retainedEnv, /config-restart-readonly-secret/);
    await stopServer(second);
});

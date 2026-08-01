'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'ups-runtime-admin-secret';
const AUTHORIZATION = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;
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

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 100, description = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await predicate();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`timed out waiting for ${description}; last=${JSON.stringify(last)}`);
}

test('production UPS route retains last-good data across confirmed outage and recovery', { timeout: 45_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-ups-runtime-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, '.env'), '# isolated UPS runtime config\n', { mode: 0o600 });

    const modeFile = path.join(dataDir, 'ups-mode');
    const pwrstat = path.join(dataDir, 'pwrstat-fixture');
    fs.writeFileSync(modeFile, 'success');
    fs.writeFileSync(pwrstat, `#!/bin/sh\nIFS= read -r mode < \"$UPS_MODE_FILE\"\n[ \"$mode\" = success ] || exit 1\nprintf '%s\\n' 'Model Name.............. Runtime Test UPS' 'State................... Normal' 'Utility Voltage......... 120.0 V' 'Output Voltage.......... 120.0 V' 'Battery Capacity........ 95 %' 'Remaining Runtime....... 30 min' 'Load.................... 20 %'\n`);
    fs.chmodSync(pwrstat, 0o700);
    fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
        reportEnabled: false,
        upsSampleSec: 5
    }));

    const port = await unusedPort();
    const child = spawn(process.execPath, ['--eval', BOOTSTRAP, path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            SMARTHUB_BIND_ADDRESS: '127.0.0.1',
            PANEL_REQUIRE_HTTPS: 'false',
            PANEL_ALLOW_INSECURE_HTTP: 'false',
            PORT: String(port),
            DATA_DIR: dataDir,
            PATH: dataDir,
            SMARTHUB_ENV_FILE: path.join(dataDir, '.env'),
            PANEL_PASSWORD: ADMIN_PASSWORD,
            PANEL_READONLY_PASSWORD: '',
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
            UPS_SOURCE: 'pwrstat',
            PWRSTAT_PATH: pwrstat,
            UPS_MODE_FILE: modeFile,
            PPB_USER: '',
            PPB_PASSWORD: '',
            ADGUARD_HOST: '',
            LINUX_HOST: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });

    let logs = '';
    const retain = chunk => { logs = `${logs}${chunk}`.slice(-100_000); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const getUps = async () => {
        if (child.exitCode !== null) throw new Error(`server exited unexpectedly (${child.exitCode})\n${logs}`);
        try {
            const response = await fetch(`${baseUrl}/api/ups/status`, {
                headers: { Authorization: AUTHORIZATION },
                signal: AbortSignal.timeout(1_000)
            });
            if (response.status !== 200) return null;
            return response.json();
        } catch {
            return null;
        }
    };

    const healthy = await waitFor(async () => {
        const status = await getUps();
        return status?.fetchHealth === 'healthy' ? status : null;
    }, { description: 'initial healthy UPS sample' });
    assert.equal(healthy.source, 'pwrstat');
    assert.equal(healthy.battery, 95);
    assert.equal(healthy.dataIsStale, false);

    fs.writeFileSync(modeFile, 'failure');
    const observedHealth = new Set();
    const offline = await waitFor(async () => {
        const status = await getUps();
        if (status) observedHealth.add(status.fetchHealth);
        return status?.fetchHealth === 'offline' ? status : null;
    }, { timeoutMs: 22_000, description: 'three-failure confirmed outage' });
    assert.ok(observedHealth.has('degraded'), `degraded state was not observed: ${[...observedHealth]}`);
    assert.equal(offline.consecutiveFailures, 3);
    assert.equal(offline.failureThreshold, 3);
    assert.equal(offline.source, 'unreachable');
    assert.equal(offline.dataIsStale, true);
    assert.equal(offline.lastKnown.battery, 95);
    assert.ok(offline.offlineSince > 0);

    fs.writeFileSync(modeFile, 'success');
    const recovered = await waitFor(async () => {
        const status = await getUps();
        return status?.fetchHealth === 'healthy' && status.lastSuccessAt > healthy.lastSuccessAt ? status : null;
    }, { timeoutMs: 10_000, description: 'UPS recovery' });
    assert.equal(recovered.source, 'pwrstat');
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.dataIsStale, false);

    child.kill('SIGTERM');
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`SIGTERM timeout\n${logs}`)), 8_000);
    });
    let result;
    try { result = await Promise.race([closed, timeout]); }
    finally { clearTimeout(timeoutHandle); }
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal((logs.match(/UPS monitoring sources are confirmed offline/g) || []).length, 1);
    assert.equal((logs.match(/UPS monitoring source recovered/g) || []).length, 1);
});

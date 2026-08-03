'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'ups-runtime-admin-secret';
const AUTHORIZATION = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
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

function listenServer(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function closeServer(server) {
    return new Promise(resolve => server.close(() => resolve()));
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

test('UPS in-flight reads return generation-scoped metadata before the poll commits it', () => {
    const readStart = SERVER_SOURCE.indexOf('async function readUpsLive()');
    const pollStart = SERVER_SOURCE.indexOf('async function pollUpsFetchState()');
    assert.ok(readStart >= 0 && pollStart > readStart);
    const readSource = SERVER_SOURCE.slice(readStart, pollStart);
    assert.match(readSource, /const selectionSnapshot =/u);
    assert.match(readSource, /selection: selectionSnapshot/u);
    assert.doesNotMatch(readSource, /upsLastSelection\s*=/u);
    assert.match(SERVER_SOURCE, /generation !== upsConfigGeneration[\s\S]+readResult\.configGeneration/u);
});

test('production UPS route retains last-good data across confirmed outage and recovery', { timeout: 45_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-ups-runtime-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, '.env'), '# isolated UPS runtime config\n', { mode: 0o600 });

    const modeFile = path.join(dataDir, 'ups-mode');
    const countFile = path.join(dataDir, 'ups-count');
    const pwrstat = path.join(dataDir, 'pwrstat-fixture');
    fs.writeFileSync(modeFile, 'success');
    fs.writeFileSync(countFile, '0');
    fs.writeFileSync(pwrstat, `#!/bin/sh\ncount=$(cat \"$UPS_COUNT_FILE\" 2>/dev/null || printf '0')\nprintf '%s\\n' $((count + 1)) > \"$UPS_COUNT_FILE\"\nIFS= read -r mode < \"$UPS_MODE_FILE\"\n[ \"$mode\" = success ] || exit 1\nprintf '%s\\n' 'Model Name.............. Runtime Test UPS' 'State................... Normal' 'Utility Voltage......... 120.0 V' 'Output Voltage.......... 120.0 V' 'Battery Capacity........ 95 %' 'Remaining Runtime....... 30 min' 'Load.................... 20 %'\n`);
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
            UPS_ALLOW_FALLBACK: 'false',
            PWRSTAT_PATH: pwrstat,
            UPS_MODE_FILE: modeFile,
            UPS_COUNT_FILE: countFile,
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
    assert.equal(healthy.configuredSource, 'pwrstat');
    assert.equal(healthy.actualSource, 'pwrstat');
    assert.equal(healthy.fallbackAllowed, false);
    assert.equal(healthy.fallbackUsed, false);
    assert.equal(healthy.battery, 95);
    assert.equal(healthy.dataIsStale, false);

    const countBeforeReadOnlyGets = Number(fs.readFileSync(countFile, 'utf8'));
    for (let index = 0; index < 3; index += 1) assert.equal((await getUps()).source, 'pwrstat');
    assert.equal(Number(fs.readFileSync(countFile, 'utf8')), countBeforeReadOnlyGets, 'UPS status GET triggered an upstream poll');

    fs.writeFileSync(modeFile, 'failure');
    const observedHealth = new Set();
    let degradedStatus = null;
    const offline = await waitFor(async () => {
        const status = await getUps();
        if (status) {
            observedHealth.add(status.fetchHealth);
            if (status.fetchHealth === 'degraded') degradedStatus = status;
        }
        return status?.fetchHealth === 'offline' ? status : null;
    }, { timeoutMs: 22_000, description: 'three-failure confirmed outage' });
    assert.ok(observedHealth.has('degraded'), `degraded state was not observed: ${[...observedHealth]}`);
    assert.equal(degradedStatus.source, 'pwrstat');
    assert.equal(degradedStatus.actualSource, null);
    assert.equal(degradedStatus.lastKnownSource, 'pwrstat');
    assert.equal(degradedStatus.dataIsStale, true);
    assert.equal(offline.consecutiveFailures, 3);
    assert.equal(offline.failureThreshold, 3);
    assert.equal(offline.source, 'unreachable');
    assert.equal(offline.actualSource, null);
    assert.equal(offline.configuredSource, 'pwrstat');
    assert.equal(offline.fallbackAllowed, false);
    assert.equal(offline.fallbackUsed, false);
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

test('production UPS auto mode reports the first healthy PPB source without fallback', { timeout: 35_000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-ups-auto-runtime-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, '.env'), '# isolated UPS auto runtime config\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ reportEnabled: false, upsSampleSec: 5 }));

    const keyFile = path.join(dataDir, 'ppb-key.pem');
    const certFile = path.join(dataDir, 'ppb-cert.pem');
    const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || 'openssl certificate generation failed');

    let statusCalls = 0;
    const ppbServer = https.createServer({
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile)
    }, (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST' && request.url === '/local/rest/v1/login/verify') {
            request.resume();
            response.end(JSON.stringify('runtime-ppb-token'));
            return;
        }
        if (request.method === 'GET' && request.url === '/local/rest/v1/ups/status'
            && request.headers.authorization === 'runtime-ppb-token') {
            statusCalls += 1;
            response.end(JSON.stringify({
                input: { state: 0, stateText: 'Normal', voltages: ['120 V'] },
                output: { voltages: ['120 V'], loads: ['20 %'] },
                battery: { capacity: '95 %', remainingRunTimeInSecs: 1800 }
            }));
            return;
        }
        response.statusCode = 401;
        response.end(JSON.stringify({ ok: false }));
    });
    const ppbPort = await listenServer(ppbServer);
    const discoveryServer = http.createServer((_request, response) => {
        response.statusCode = 302;
        response.setHeader('location', `https://127.0.0.1:${ppbPort}/local/`);
        response.end();
    });
    const discoveryPort = await listenServer(discoveryServer);
    t.after(async () => {
        await Promise.all([closeServer(discoveryServer), closeServer(ppbServer)]);
    });

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
            UPS_SOURCE: 'auto',
            UPS_ALLOW_FALLBACK: 'false',
            PPB_HOST: '127.0.0.1',
            PPB_PORT: String(discoveryPort),
            PPB_USER: 'runtime-user',
            PPB_PASSWORD: 'runtime-password',
            PPB_TLS_VERIFY: 'true',
            PPB_TLS_INSECURE: 'true',
            PPB_CA_FILE: '',
            SMARTHUB_INTERNET_PROXY_MODE: 'disabled',
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
    }, { description: 'auto PPB healthy UPS sample' });
    assert.equal(healthy.source, 'ppb');
    assert.equal(healthy.configuredSource, 'auto');
    assert.equal(healthy.actualSource, 'ppb');
    assert.equal(healthy.fallbackUsed, false);
    assert.equal(healthy.fallbackReason, null);
    assert.equal(healthy.fallbackAllowed, true);
    assert.equal(healthy.battery, 95);

    const countBeforeReadOnlyGets = statusCalls;
    for (let index = 0; index < 3; index += 1) assert.equal((await getUps()).actualSource, 'ppb');
    assert.equal(statusCalls, countBeforeReadOnlyGets, 'UPS status GET triggered an upstream poll');
    assert.doesNotMatch(logs, /UPS auto 前一來源不可用/u);

    child.kill('SIGTERM');
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`SIGTERM timeout\n${logs}`)), 8_000);
    });
    let result;
    try { result = await Promise.race([closed, timeout]); }
    finally { clearTimeout(timeoutHandle); }
    assert.deepEqual(result, { code: 0, signal: null });
});

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'docker-background-integration-secret';
const AUTHORIZATION = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 15_000, interval = 50, message = 'condition was not met' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(interval);
    }
    throw new Error(message);
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

async function startServer(dataDir, envFile) {
    const panelPort = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(error => error ? reject(error) : resolve(port));
        });
    });
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_ENV: 'production',
            SMARTHUB_BIND_ADDRESS: '127.0.0.1',
            PANEL_REQUIRE_HTTPS: 'false',
            PANEL_ALLOW_INSECURE_HTTP: 'false',
            PORT: String(panelPort),
            DATA_DIR: dataDir,
            SMARTHUB_ENV_FILE: envFile,
            LOG_LEVEL: 'INFO',
            LOG_FORMAT: 'json',
            LOG_JSON: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    const retain = chunk => { logs = `${logs}${chunk}`.slice(-120_000); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const baseUrl = `http://127.0.0.1:${panelPort}`;
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`server exited during startup (${child.exitCode})\n${logs}`);
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            return response.status === 200;
        } catch {
            return false;
        }
    }, { message: `server startup timeout\n${logs}` });
    return { baseUrl, child, closed, logs: () => logs };
}

async function stopServer(runtime) {
    if (runtime.child.exitCode !== null) return;
    runtime.child.kill('SIGTERM');
    const timeout = new Promise((_, reject) => setTimeout(
        () => reject(new Error(`server shutdown timeout\n${runtime.logs()}`)),
        8_000
    ));
    const result = await Promise.race([runtime.closed, timeout]);
    assert.deepEqual(result, { code: 0, signal: null });
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

let heartbeatSequence = 0;
async function promptNasSampling(runtime) {
    const response = await adminRead(runtime,
        `/api/heartbeat?scope=nas&focus=1&session=docker-integration&seq=${++heartbeatSequence}`);
    assert.equal(response.status, 200, await response.text());
}

test('server Docker background gate, manual API, and watcher isolation use shared snapshots', {
    timeout: 45_000
}, async t => {
    const counters = {
        inventory: 0,
        logs: 0,
        alerts: 0
    };
    let malformedInventory = false;
    const monitor = http.createServer((req, res) => {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        if (requestUrl.pathname === '/api/docker/containers') {
            counters.inventory += 1;
            if (malformedInventory) return json(res, 200, { data: { invalid: true } });
            return json(res, 200, {
                containers: [{ id: 'container-a', name: 'integration-a', state: 'running' }]
            });
        }
        if (requestUrl.pathname === '/api/docker/containers/container-a/logs') {
            counters.logs += 1;
            return json(res, 200, { logs: 'ERROR integration log\n' });
        }
        if (requestUrl.pathname === '/api/alerts/events') {
            counters.alerts += 1;
            return json(res, 200, { events: [] });
        }
        return json(res, 404, { error: 'not_found' });
    });
    const monitorPort = await listen(monitor);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-docker-background-'));
    const envFile = path.join(dataDir, '.env');
    fs.writeFileSync(envFile, [
        `PANEL_PASSWORD=${ADMIN_PASSWORD}`,
        'PANEL_READONLY_PASSWORD=docker-background-readonly',
        'MONITOR_ENABLED=false',
        'NAS_MONITOR_MODE=full',
        `NAS_MONITOR_URL=http://127.0.0.1:${monitorPort}`,
        'NAS_MONITOR_API_KEY=integration-docker-monitor-key-0123456789abcdef',
        'NAS_MONITOR_ALLOW_INSECURE_HTTP=false',
        'NAS_HOST=',
        'NAS_USER=',
        'NAS_PASSWORD=',
        'UNIFI_CONTROLLER_URL=',
        'UNIFI_USERNAME=',
        'UNIFI_PASSWORD=',
        'UNIFI_API_KEY=',
        'WIIM_IP=127.0.0.1',
        'LINUX_HOST=127.0.0.1',
        'LINUX_SSH_PORT=1',
        'LINUX_SSH_USER=integration',
        'LINUX_SSH_PASSWORD=integration-linux-password',
        'UPS_SOURCE=pwrstat',
        'PWRSTAT_PATH=/definitely/missing/pwrstat',
        'PPB_USER=',
        'PPB_PASSWORD=',
        'ADGUARD_HOST='
    ].join('\n') + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
        deviceActiveBackendSampleSec: 1,
        deviceIdleBackendSampleSec: 1,
        activeLeaseSec: 30,
        heartbeatSec: 5,
        watcherSec: 5
    }));
    fs.writeFileSync(path.join(dataDir, 'notification-settings.json'), JSON.stringify({
        enabled: true,
        triggerDockerCriticalLog: true,
        triggerDockerErrorLog: false,
        triggerDockerState: false,
        triggerDockerHealth: false,
        triggerDockerRestart: false,
        triggerDockerInventory: false,
        triggerDockerOom: false,
        triggerDockerHighCpu: false,
        triggerDockerHighMemory: false,
        triggerThreats: false,
        triggerNasAlerts: false,
        triggerLinuxTemp: false,
        triggerLinuxOffline: false,
        triggerWiimOffline: false
    }));

    let runtime;
    try {
        runtime = await startServer(dataDir, envFile);
        t.after(async () => {
            await stopServer(runtime);
            await new Promise((resolve, reject) => monitor.close(error => error ? reject(error) : resolve()));
            fs.rmSync(dataDir, { recursive: true, force: true });
        });

        // Case A: global notification + Docker trigger enables background log upstream.
        await promptNasSampling(runtime);
        await waitFor(() => counters.inventory > 0 && counters.logs > 0, {
            message: `enabled background collection did not reach Docker upstream\n${runtime.logs()}`
        });
        assert.ok(counters.inventory > 0);
        assert.ok(counters.logs > 0);

        // Case B: globally disabled settings clear the background cache and do not
        // create a new log upstream request.
        const beforeDisabled = counters.logs;
        let response = await adminWrite(runtime, '/api/notifications/settings', {
            enabled: false,
            triggerDockerCriticalLog: true,
            triggerDockerErrorLog: true
        });
        assert.equal(response.status, 200, await response.text());
        await promptNasSampling(runtime);
        await sleep(300);
        assert.equal(counters.logs, beforeDisabled);

        // Case C: enabled without either Docker log trigger has the same gate.
        response = await adminWrite(runtime, '/api/notifications/settings', {
            enabled: true,
            triggerDockerCriticalLog: false,
            triggerDockerErrorLog: false
        });
        assert.equal(response.status, 200, await response.text());
        await promptNasSampling(runtime);
        await sleep(300);
        assert.equal(counters.logs, beforeDisabled);

        // Case D: the manual route remains independent of the background gate and
        // retains the existing { logs, source } response schema.
        response = await adminRead(runtime, '/api/nas/docker/container-a/logs?lines=1');
        const manualText = await response.text();
        assert.equal(response.status, 200, manualText);
        const manualBody = JSON.parse(manualText);
        assert.deepEqual(Object.keys(manualBody).sort(), ['logs', 'source']);
        assert.equal(manualBody.source, 'nas_monitor');
        assert.equal(typeof manualBody.logs, 'string');
        assert.equal(counters.logs, beforeDisabled + 1);

        // Case E: make the shared inventory malformed.  The Docker scan throws,
        // but its module-level boundary allows the later UniFi watcher path to run.
        malformedInventory = true;
        response = await adminWrite(runtime, '/api/notifications/settings', {
            enabled: true,
            triggerDockerCriticalLog: false,
            triggerDockerErrorLog: false,
            triggerDockerState: true,
            triggerDockerHealth: false,
            triggerDockerRestart: false,
            triggerDockerInventory: false,
            triggerDockerOom: false,
            triggerDockerHighCpu: false,
            triggerDockerHighMemory: false,
            triggerThreats: true,
            triggerNasAlerts: true,
            triggerLinuxTemp: true
        });
        assert.equal(response.status, 200, await response.text());
        await sleep(1_200);
        const previousInventoryCalls = counters.inventory;
        await promptNasSampling(runtime);
        await waitFor(() => counters.inventory > previousInventoryCalls, {
            message: 'malformed Docker inventory was not sampled'
        });
        await waitFor(() => runtime.logs().includes('"function":"scanDockerNotifications"'), {
            timeout: 12_000,
            message: `Docker watcher failure was not isolated\n${runtime.logs()}`
        });
        assert.match(runtime.logs(), /"function":"scanThreats"/);
    } finally {
        if (!runtime) {
            await new Promise((resolve, reject) => monitor.close(error => error ? reject(error) : resolve()));
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    }
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const durationMs = Math.max(Number(process.env.SOAK_DURATION_MS) || 90_000, 5_000);
const metrics = {
    rssStart: 0, rssPeak: 0, rssEnd: 0,
    heapStart: 0, heapPeak: 0, heapEnd: 0,
    externalStart: 0, externalPeak: 0, externalEnd: 0,
    activeHandlesPeak: 0, activeRequestsPeak: 0,
    requests: 0, failures: 0, sseClients: 0
};

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function request(url, options = {}) {
    metrics.requests += 1;
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(8_000) });
    const text = await response.text();
    return { response, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

async function waitForHealth(baseUrl, child) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`SmartHub exited before health: ${child.exitCode}`);
        try {
            const result = await request(`${baseUrl}/health/ready`);
            if (result.response.status === 200) return;
        } catch { }
        await wait(150);
    }
    throw new Error('SmartHub did not become ready');
}

async function startApp({ dataDir, envFile, port, monitorPort, controllerPort }) {
    const env = {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        SMARTHUB_BIND_ADDRESS: '127.0.0.1',
        SMARTHUB_ENV_FILE: envFile,
        DATA_DIR: dataDir,
        PANEL_PASSWORD: 'soak-panel-password',
        PANEL_REQUIRE_HTTPS: 'false',
        PANEL_ALLOW_INSECURE_HTTP: 'false',
        UNIFI_CONTROLLER_URL: `http://127.0.0.1:${controllerPort}`,
        UNIFI_USERNAME: 'soak-controller-user', UNIFI_PASSWORD: 'soak-controller-password',
        NAS_HOST: '', NAS_USER: '', NAS_PASSWORD: '',
        NAS_MONITOR_URL: `http://127.0.0.1:${monitorPort}`,
        NAS_MONITOR_API_KEY: '0123456789abcdef0123456789abcdef',
        NAS_MONITOR_MODE: 'full',
        UCG_IP: '', SSH_PASSWORD: '', LINUX_HOST: '', LINUX_SSH_PASSWORD: '',
        WIIM_IP: '', UPS_SOURCE: 'pmset',
        SMARTHUB_SHUTDOWN_GRACE_MS: '15000',
        SSE_DRAIN_TIMEOUT_MS: '1000'
    };
    fs.writeFileSync(envFile, 'PANEL_REQUIRE_HTTPS=false\nPANEL_ALLOW_INSECURE_HTTP=false\n', { mode: 0o600 });
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk.toString(); });
    child.stderr.on('data', chunk => { logs += chunk.toString(); });
    return { child, baseUrl: `http://127.0.0.1:${port}`, getLogs: () => logs };
}

async function login(baseUrl) {
    const result = await request(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'soak-panel-password', remember: false })
    });
    assert.equal(result.response.status, 200, result.text);
    const cookie = result.response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    return { cookie, csrf: result.data.csrfToken };
}

function authHeaders(session) { return { Cookie: session.cookie, 'x-smarthub-csrf': session.csrf, 'content-type': 'application/json' }; }

function recordRuntime(runtime) {
    const processState = runtime?.data?.runtime?.process || {};
    const rss = Number(processState.rss_bytes) || 0;
    const heap = Number(processState.heap_used_bytes) || 0;
    const external = Number(processState.external_bytes) || 0;
    metrics.rssPeak = Math.max(metrics.rssPeak, rss);
    metrics.heapPeak = Math.max(metrics.heapPeak, heap);
    metrics.externalPeak = Math.max(metrics.externalPeak, external);
    metrics.activeHandlesPeak = Math.max(metrics.activeHandlesPeak, Number(processState.active_handles) || 0);
    metrics.activeRequestsPeak = Math.max(metrics.activeRequestsPeak, Number(processState.active_requests) || 0);
    return processState;
}

async function run() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-runtime-soak-'));
    const dataDir = path.join(directory, 'data');
    const envFile = path.join(directory, '.env');
    const port = await freePort();
    const monitorPort = await freePort();
    const controllerPort = await freePort();
    let upstreamClients = new Set();
    let monitorAvailable = true;
    let controllerExpiredOnce = false;
    let controllerLoginCount = 0;
    const monitor = http.createServer((req, res) => {
        if (req.url === '/health') return res.end('ok');
        if (!monitorAvailable) {
            res.statusCode = 503;
            return res.end('monitor unavailable');
        }
        if (req.url === '/api/stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
            res.write(': soak\n\n');
            upstreamClients.add(res);
            const timer = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { } }, 500);
            req.on('close', () => { clearInterval(timer); upstreamClients.delete(res); });
            return;
        }
        if (req.url === '/api/docker/containers') return res.end(JSON.stringify({ containers: [] }));
        res.statusCode = 404;
        res.end('not found');
    });
    await new Promise(resolve => monitor.listen(monitorPort, '127.0.0.1', resolve));
    const controller = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/auth/login') {
            controllerLoginCount += 1;
            res.writeHead(200, {
                'content-type': 'application/json',
                'set-cookie': [`soak-session-${controllerLoginCount}=1; Path=/`],
                'x-csrf-token': `soak-csrf-${controllerLoginCount}`
            });
            return res.end(JSON.stringify({ data: { ok: true } }));
        }
        if (req.url === '/proxy/network/api/s/default/stat/sta') {
            if (controllerExpiredOnce) {
                controllerExpiredOnce = false;
                res.writeHead(401, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'session expired' }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [] }));
        }
        res.writeHead(404);
        res.end('not found');
    });
    await new Promise(resolve => controller.listen(controllerPort, '127.0.0.1', resolve));
    let runtime;
    try {
        runtime = await startApp({ dataDir, envFile, port, monitorPort, controllerPort });
        await waitForHealth(runtime.baseUrl, runtime.child);
        const sessions = await Promise.all([login(runtime.baseUrl), login(runtime.baseUrl), login(runtime.baseUrl)]);
        const controllerBefore = controllerLoginCount;
        controllerExpiredOnce = true;
        const controllerRecovery = await request(`${runtime.baseUrl}/api/clients`, { headers: { Cookie: sessions[0].cookie } });
        assert.equal(controllerRecovery.response.status, 200, controllerRecovery.text);
        assert.ok(controllerLoginCount > controllerBefore, 'controller session recovery did not relogin');
        const sseControllers = sessions.map(() => new AbortController());
        const sseResponses = await Promise.all(sessions.map((session, index) => fetch(`${runtime.baseUrl}/api/nas/stream`, {
            headers: { Cookie: session.cookie }, signal: sseControllers[index].signal
        })));
        sseResponses.forEach(response => assert.equal(response.status, 200));
        metrics.sseClients = sseResponses.length;
        const initialRuntime = await request(`${runtime.baseUrl}/api/system/status`, { headers: { Cookie: sessions[0].cookie } });
        assert.equal(initialRuntime.response.status, 200, initialRuntime.text);
        const initialProcess = recordRuntime(initialRuntime);
        metrics.rssStart = initialProcess.rss_bytes;
        metrics.heapStart = initialProcess.heap_used_bytes;
        metrics.externalStart = initialProcess.external_bytes;
        const started = Date.now();
        let cycle = 0;
        while (Date.now() - started < durationMs) {
            for (const [index, session] of sessions.entries()) {
                const focus = cycle % 2 === 0 ? 1 : 0;
                const heartbeat = await request(`${runtime.baseUrl}/api/heartbeat?scope=general,trend,nas,ups&focus=${focus}&session=soak-${index}`, { headers: authHeaders(session) });
                assert.equal(heartbeat.response.status, 200, heartbeat.text);
                const settings = await request(`${runtime.baseUrl}/api/settings`, { headers: { Cookie: session.cookie } });
                assert.equal(settings.response.status, 200, settings.text);
                const health = await request(`${runtime.baseUrl}/health/operational`, { headers: { Cookie: session.cookie } });
                assert.ok([200, 503].includes(health.response.status), health.text);
            }
            if (cycle === 1) {
                monitorAvailable = false;
                const monitorFailure = await request(`${runtime.baseUrl}/api/nas/docker`, { headers: { Cookie: sessions[0].cookie } });
                assert.equal(monitorFailure.response.status, 200, monitorFailure.text);
                monitorAvailable = true;
                const monitorRecovery = await request(`${runtime.baseUrl}/api/nas/docker`, { headers: { Cookie: sessions[0].cookie } });
                assert.equal(monitorRecovery.response.status, 200, monitorRecovery.text);
            }
            const runtimeStatus = await request(`${runtime.baseUrl}/api/system/status`, { headers: { Cookie: sessions[0].cookie } });
            assert.equal(runtimeStatus.response.status, 200, runtimeStatus.text);
            recordRuntime(runtimeStatus);
            const backup = await request(`${runtime.baseUrl}/api/config/backup/v2`, { headers: { Cookie: sessions[0].cookie } });
            assert.equal(backup.response.status, 200, backup.text);
            cycle += 1;
            await wait(500);
        }
        const finalRuntime = await request(`${runtime.baseUrl}/api/system/status`, { headers: { Cookie: sessions[0].cookie } });
        const finalProcess = recordRuntime(finalRuntime);
        metrics.rssEnd = finalProcess.rss_bytes;
        metrics.heapEnd = finalProcess.heap_used_bytes;
        metrics.externalEnd = finalProcess.external_bytes;
        sseControllers.forEach(controller => controller.abort());
        runtime.child.kill('SIGTERM');
        const exitCode = await new Promise(resolve => runtime.child.once('exit', resolve));
        assert.equal(exitCode, 0, runtime.getLogs());
        runtime = await startApp({ dataDir, envFile, port, monitorPort, controllerPort });
        await waitForHealth(runtime.baseUrl, runtime.child);
        runtime.child.kill('SIGTERM');
        const restartExit = await new Promise(resolve => runtime.child.once('exit', resolve));
        assert.equal(restartExit, 0, runtime.getLogs());
        process.stdout.write(`Runtime soak passed\nduration_ms=${durationMs}\nrss_start=${metrics.rssStart}\nrss_peak=${metrics.rssPeak}\nrss_end=${metrics.rssEnd}\nheap_start=${metrics.heapStart}\nheap_peak=${metrics.heapPeak}\nheap_end=${metrics.heapEnd}\nexternal_start=${metrics.externalStart}\nexternal_peak=${metrics.externalPeak}\nexternal_end=${metrics.externalEnd}\nactive_handles_peak=${metrics.activeHandlesPeak}\nactive_requests_peak=${metrics.activeRequestsPeak}\nrequests=${metrics.requests}\nsse_clients=${metrics.sseClients}\nactive_upstream_sse=${upstreamClients.size}\n`);
    } finally {
        if (runtime?.child && runtime.child.exitCode === null) runtime.child.kill('SIGTERM');
        for (const response of upstreamClients) { try { response.end(); } catch { } }
        await new Promise(resolve => monitor.close(resolve));
        await new Promise(resolve => controller.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

run().catch(error => {
    metrics.failures += 1;
    process.stderr.write(`Runtime soak failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
});

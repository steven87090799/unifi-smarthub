'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'sse-admin-secret';
const API_KEY = '0123456789abcdef0123456789abcdef';
const AUTHORIZATION = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForHealth(baseUrl, child, output) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited during startup\n${output()}`);
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.status === 200) return;
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`server startup timeout\n${output()}`);
}

async function waitFor(predicate, description) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`timeout waiting for ${description}`);
}

async function openPanelStream(baseUrl) {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/nas/stream`, {
        headers: { Authorization: AUTHORIZATION },
        signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString('utf8'), /:ok/);
    return { controller, reader };
}

test('stalled NAS Monitor SSE handshakes are coalesced and shutdown-owned', { timeout: 30_000 }, async t => {
    let upstreamRequests = 0;
    const upstreamSockets = new Set();
    const upstream = http.createServer((req, res) => {
        if (req.url === '/api/stream') {
            upstreamRequests += 1;
            assert.equal(req.headers['x-api-key'], API_KEY);
            assert.equal(req.headers.authorization, undefined);
            return; // Deliberately never send response headers.
        }
        res.writeHead(404).end();
    });
    upstream.on('connection', socket => {
        upstreamSockets.add(socket);
        socket.on('close', () => upstreamSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => {
        for (const socket of upstreamSockets) socket.destroy();
        return new Promise(resolve => upstream.close(resolve));
    });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-sse-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const envFile = path.join(dataDir, '.env');
    fs.writeFileSync(envFile, '# isolated SSE config\n', { mode: 0o600 });
    const port = await unusedPort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'production', PORT: String(port), DATA_DIR: dataDir,
            SMARTHUB_BIND_ADDRESS: '127.0.0.1', PANEL_REQUIRE_HTTPS: 'false',
            PANEL_ALLOW_INSECURE_HTTP: 'false',
            SMARTHUB_ENV_FILE: envFile, PANEL_PASSWORD: ADMIN_PASSWORD,
            PANEL_READONLY_PASSWORD: 'sse-readonly-secret', MONITOR_ENABLED: 'false',
            UCG_IP: '127.0.0.1', SSH_PORT: '1', SSH_USER: '', SSH_PASSWORD: '',
            UNIFI_CONTROLLER_URL: 'http://127.0.0.1:1', UNIFI_USERNAME: '', UNIFI_PASSWORD: '',
            UNIFI_API_KEY: '', NAS_HOST: '', NAS_USER: '', NAS_PASSWORD: '',
            NAS_MONITOR_URL: `http://127.0.0.1:${upstream.address().port}`,
            NAS_MONITOR_API_KEY: API_KEY, NAS_MONITOR_MODE: 'full',
            WIIM_IP: '127.0.0.1', UPS_SOURCE: 'nut', NUT_HOST: '127.0.0.1',
            ADGUARD_HOST: '', LINUX_HOST: '', LOG_LEVEL: 'ERROR'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const retain = chunk => { output = `${output}${chunk}`.slice(-50_000); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => output);
    const streams = await Promise.all([openPanelStream(baseUrl), openPanelStream(baseUrl)]);
    t.after(() => streams.forEach(stream => stream.controller.abort()));
    await waitFor(() => upstreamRequests >= 1, 'first upstream SSE request');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(upstreamRequests, 1, 'subscribers must share one pending upstream handshake');

    child.kill('SIGTERM');
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null });
    await waitFor(() => upstreamSockets.size === 0, 'stalled upstream socket cleanup');
});

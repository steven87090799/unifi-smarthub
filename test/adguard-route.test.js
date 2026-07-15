'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'adguard-route-admin-secret';
const READONLY_PASSWORD = 'adguard-route-readonly-secret';
const ADGUARD_PASSWORD = 'adguard-route-upstream-secret';
const auth = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startApp(extraEnvironment, script = 'server.js') {
    const port = await unusedPort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smarthub-adguard-route-'));
    const envFile = path.join(dataDir, '.env');
    await fs.writeFile(envFile, '# isolated AdGuard route test\n', { mode: 0o600 });
    const child = spawn(process.execPath, [path.join(ROOT, script)], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: String(port),
            DATA_DIR: dataDir,
            SMARTHUB_ENV_FILE: envFile,
            ALLOW_MULTI_INSTANCE: '1',
            PANEL_PASSWORD: ADMIN_PASSWORD,
            PANEL_READONLY_PASSWORD: READONLY_PASSWORD,
            LOG_LEVEL: 'CRITICAL',
            MONITOR_ENABLED: 'false',
            UNIFI_USERNAME: '',
            UNIFI_PASSWORD: '',
            UNIFI_API_KEY: '',
            NAS_HOST: '',
            NAS_MONITOR_URL: '',
            WIIM_IP: '127.0.0.1',
            UPS_SOURCE: 'nut',
            NUT_HOST: '127.0.0.1',
            NUT_UPS_NAME: 'test',
            LINUX_HOST: '',
            ...extraEnvironment
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000); });
    const exited = new Promise(resolve => child.once('close', resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited during startup\n${output}`);
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.ok) return { baseUrl, child, dataDir, exited, output: () => output };
        } catch { }
        await delay(50);
    }
    child.kill('SIGKILL');
    await exited;
    throw new Error(`server did not start\n${output}`);
}

async function stopApp(runtime) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGTERM');
    const stopped = await Promise.race([runtime.exited.then(() => true), delay(6_000).then(() => false)]);
    if (!stopped) {
        runtime.child.kill('SIGKILL');
        await runtime.exited;
    }
    await fs.rm(runtime.dataDir, { recursive: true, force: true });
}

async function csrf(baseUrl, authorization) {
    const response = await fetch(`${baseUrl}/api/security/csrf`, { headers: { authorization } });
    assert.equal(response.status, 200);
    return (await response.json()).csrfToken;
}

async function write(baseUrl, authorization, token, route, body) {
    return fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
            authorization,
            origin: baseUrl,
            'x-smarthub-csrf': token,
            'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
    });
}

function startFakeAdGuard() {
    const requests = [];
    let clients = [{
        name: 'Living Room',
        ids: ['192.168.1.50'],
        tags: ['user_child'],
        use_global_settings: true,
        filtering_enabled: true,
        parental_enabled: false,
        safebrowsing_enabled: true,
        safesearch_enabled: false,
        use_global_blocked_services: true,
        blocked_services: [],
        blocked_services_schedule: {}
    }];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({
            method: req.method,
            url: req.url,
            authorization: req.headers.authorization,
            body: Buffer.concat(chunks).toString('utf8')
        });
        assert.equal(req.headers.authorization, 'Basic ' + Buffer.from(`admin:${ADGUARD_PASSWORD}`).toString('base64'));
        res.setHeader('content-type', 'application/json');
        if (req.url === '/control/status') {
            return res.end(JSON.stringify({ version: 'v0.107-test', protection_enabled: true }));
        }
        if (req.url === '/control/stats') {
            return res.end(JSON.stringify({ num_dns_queries: 12, num_blocked_filtering: 3 }));
        }
        if (req.url === '/control/querylog?limit=2&response_status=filtered') {
            return res.end(JSON.stringify({
                data: [{
                    time: '2026-07-15T00:00:00Z',
                    question: { name: 'blocked.example', type: 'A' },
                    client: '192.168.1.10',
                    reason: 'FilteredBlockedService',
                    elapsedMs: '0.4'
                }]
            }));
        }
        if (req.url === '/control/protection' && req.method === 'POST') return res.end('{}');
        if (req.url === '/control/clients' && req.method === 'GET') {
            return res.end(JSON.stringify({ clients: { persistent: clients } }));
        }
        if (req.url === '/control/blocked_services/all' && req.method === 'GET') {
            return res.end(JSON.stringify([{ id: 'youtube' }, { id: 'tiktok' }]));
        }
        if (req.url === '/control/clients/update' && req.method === 'POST') {
            const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            clients = clients.map(client => client.name === update.name ? update.data : client);
            return res.end('{}');
        }
        res.writeHead(404);
        res.end('{}');
    });
    return { server, requests };
}

test('production AdGuard routes preserve auth and use the bounded same-origin credential transport', { timeout: 20_000 }, async t => {
    const fake = startFakeAdGuard();
    await new Promise((resolve, reject) => fake.server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    t.after(() => new Promise(resolve => fake.server.close(resolve)));
    const runtime = await startApp({
        ADGUARD_URL: `http://127.0.0.1:${fake.server.address().port}`,
        ADGUARD_USER: 'admin',
        ADGUARD_PASSWORD
    });
    t.after(() => stopApp(runtime));
    const adminAuth = auth('admin', ADMIN_PASSWORD);
    const readonlyAuth = auth('readonly', READONLY_PASSWORD);
    const adminCsrf = await csrf(runtime.baseUrl, adminAuth);
    const readonlyCsrf = await csrf(runtime.baseUrl, readonlyAuth);

    let response = await fetch(`${runtime.baseUrl}/api/adguard/overview`, {
        headers: { authorization: adminAuth }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        status: { version: 'v0.107-test', protection_enabled: true },
        stats: { num_dns_queries: 12, num_blocked_filtering: 3 },
        source: 'adguard'
    });

    response = await fetch(`${runtime.baseUrl}/api/adguard/querylog?limit=2&filtered=1`, {
        headers: { authorization: adminAuth }
    });
    assert.equal(response.status, 200);
    const log = await response.json();
    assert.equal(log.source, 'adguard');
    assert.equal(log.entries[0].domain, 'blocked.example');
    assert.equal(log.entries[0].blocked, true);

    response = await write(runtime.baseUrl, readonlyAuth, readonlyCsrf, '/api/adguard/protection', { enabled: false });
    assert.equal(response.status, 403);
    response = await write(runtime.baseUrl, adminAuth, adminCsrf, '/api/adguard/protection', { enabled: false });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, enabled: false });
    assert.equal(fake.requests.at(-1).body, '{"enabled":false}');

    response = await write(runtime.baseUrl, adminAuth, adminCsrf, '/api/connections', {
        ADGUARD_URL: 'http://192.0.2.1'
    });
    assert.equal(response.status, 400);
    const rejected = await response.json();
    assert.equal(rejected.code, 'API-VALID-001');
    assert.doesNotMatch(JSON.stringify(rejected), new RegExp(ADGUARD_PASSWORD, 'u'));

    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies`, {
        headers: { authorization: readonlyAuth }
    });
    assert.equal(response.status, 403);
    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies`, {
        headers: { authorization: adminAuth }
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).policies, []);

    response = await write(runtime.baseUrl, adminAuth, adminCsrf, '/api/adguard/service-policies', {
        deviceId: '192.168.1.50',
        categories: ['youtube', 'tiktok'],
        timeZone: 'Asia/Taipei',
        allowWindows: { mon: { start: '18:00', end: '20:00' } }
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json();
    assert.equal(created.applied, true);
    const clientUpdate = fake.requests.find(request => request.url === '/control/clients/update');
    assert.ok(clientUpdate);
    const updateBody = JSON.parse(clientUpdate.body);
    assert.equal(updateBody.data.use_global_blocked_services, false);
    assert.deepEqual(updateBody.data.blocked_services, ['tiktok', 'youtube']);
    assert.deepEqual(updateBody.data.tags, ['user_child']);

    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies`, {
        headers: { authorization: adminAuth }
    });
    const snapshot = await response.json();
    assert.equal(snapshot.policies.length, 1);
    assert.equal(snapshot.policies[0].syncState, 'applied');
    assert.equal(Object.hasOwn(snapshot.policies[0], 'baseline'), false);
    response = await fetch(`${runtime.baseUrl}/api/connections/status`, {
        headers: { authorization: adminAuth }
    });
    assert.equal((await response.json()).devices.find(device => device.name === 'AdGuard 裝置政策').detail, '1 筆 · healthy');

    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies/${created.policy.id}`, {
        method: 'DELETE',
        headers: {
            authorization: adminAuth,
            origin: runtime.baseUrl,
            'x-smarthub-csrf': adminCsrf,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ confirmation: 'REMOVE_ADGUARD_SERVICE_POLICY' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).applied, true);
});

test('mock AdGuard service-policy routes mirror admin, validation, state, and removal contracts', { timeout: 20_000 }, async t => {
    const runtime = await startApp({}, 'server-mock.js');
    t.after(() => stopApp(runtime));
    const adminAuth = auth('admin', ADMIN_PASSWORD);
    const readonlyAuth = auth('readonly', READONLY_PASSWORD);
    const adminCsrf = await csrf(runtime.baseUrl, adminAuth);
    const readonlyCsrf = await csrf(runtime.baseUrl, readonlyAuth);

    let response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies`, {
        headers: { authorization: readonlyAuth }
    });
    assert.equal(response.status, 403);
    response = await write(runtime.baseUrl, readonlyAuth, readonlyCsrf, '/api/adguard/service-policies', {
        deviceId: '192.168.1.50', categories: ['youtube'],
        timeZone: 'Asia/Taipei', allowWindows: {}
    });
    assert.equal(response.status, 403);
    response = await write(runtime.baseUrl, adminAuth, adminCsrf, '/api/adguard/service-policies', {
        deviceId: '192.168.1.50', categories: ['youtube'],
        timeZone: 'Asia/Taipei', allowWindows: { sat: { start: '08:00', end: '22:00' } }
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json();
    assert.equal(created.applied, true);

    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies`, {
        headers: { authorization: adminAuth }
    });
    const snapshot = await response.json();
    assert.equal(snapshot.policies.length, 1);
    assert.equal(snapshot.definitions.scheduleSemantics, 'allow_windows_when_blocking_is_inactive');
    response = await fetch(`${runtime.baseUrl}/api/connections/status`, {
        headers: { authorization: adminAuth }
    });
    assert.equal((await response.json()).devices.find(device => device.name === 'AdGuard 裝置政策').detail, '1 筆 · healthy');

    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies/${created.policy.id}`, {
        method: 'DELETE',
        headers: {
            authorization: adminAuth,
            origin: runtime.baseUrl,
            'x-smarthub-csrf': adminCsrf,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ confirmation: 'REMOVE_ADGUARD_SERVICE_POLICY' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetch(`${runtime.baseUrl}/api/adguard/service-policies`, {
        headers: { authorization: adminAuth }
    });
    assert.deepEqual((await response.json()).policies, []);
});

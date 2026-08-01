'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EMPTY_LIST_SENTINEL } = require('../server/integrations/unifi-traffic-list-client');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'threat-route-admin-secret';
const READONLY_PASSWORD = 'threat-route-readonly-secret';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const LIST_ID = '22222222-2222-4222-8222-222222222222';
const LIST_NAME = 'SmartHub Threat Blocks';
const auth = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startApp(script, extraEnvironment = {}) {
    const port = await unusedPort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smarthub-threat-route-'));
    const envFile = path.join(dataDir, '.env');
    await fs.writeFile(envFile, '# isolated threat route test\n', { mode: 0o600 });
    const child = spawn(process.execPath, [path.join(ROOT, script)], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            SMARTHUB_BIND_ADDRESS: '127.0.0.1',
            PANEL_REQUIRE_HTTPS: 'false',
            PANEL_ALLOW_INSECURE_HTTP: 'false',
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
            ADGUARD_HOST: '',
            LINUX_HOST: '',
            ...extraEnvironment
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20000); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20000); });
    const exited = new Promise(resolve => child.once('close', resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`${script} exited during startup\n${output}`);
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.ok) return { baseUrl, child, dataDir, exited, output: () => output };
        } catch { }
        await delay(50);
    }
    child.kill('SIGKILL');
    await exited;
    throw new Error(`${script} did not start\n${output}`);
}

async function stopApp(runtime) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGTERM');
    const stopped = await Promise.race([runtime.exited.then(() => true), delay(6000).then(() => false)]);
    if (!stopped) {
        runtime.child.kill('SIGKILL');
        await runtime.exited;
    }
    await fs.rm(runtime.dataDir, { recursive: true, force: true });
}

async function securityContext(baseUrl, authorization) {
    const response = await fetch(`${baseUrl}/api/security/csrf`, { headers: { authorization } });
    assert.equal(response.status, 200);
    return response.json();
}

async function write(baseUrl, { authorization, csrf, origin = baseUrl }, method, route, body) {
    return fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            authorization,
            origin,
            'x-smarthub-csrf': csrf,
            'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
    });
}

function startFakeUniFi() {
    let remoteAddresses = [EMPTY_LIST_SENTINEL];
    let unavailable = false;
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], body });
        if (unavailable) {
            res.writeHead(503, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'offline' }));
        }
        assert.equal(req.headers['x-api-key'], 'route-integration-key');
        assert.equal(req.url, `/v1/sites/${SITE_ID}/traffic-matching-lists/${LIST_ID}`);
        if (req.method === 'PUT') remoteAddresses = body.items.map(item => item.value).sort();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: LIST_ID,
            name: LIST_NAME,
            type: 'IPV4_ADDRESSES',
            items: remoteAddresses.map(value => ({ type: 'IP_ADDRESS', value }))
        }));
    });
    return {
        server,
        requests,
        addresses: () => remoteAddresses,
        setUnavailable(value) { unavailable = value; }
    };
}

test('production threat-block routes enforce auth/CSRF/safety and recover persisted intent without real UniFi actions', { timeout: 30000 }, async t => {
    const fake = startFakeUniFi();
    await new Promise((resolve, reject) => fake.server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    t.after(() => fake.server.close());
    const runtime = await startApp('server.js', {
        UNIFI_CONTROLLER_URL: 'http://127.0.0.1:1',
        UNIFI_NETWORK_API_URL: `http://127.0.0.1:${fake.server.address().port}`,
        UNIFI_NETWORK_API_KEY: 'route-integration-key',
        UNIFI_NETWORK_SITE_ID: SITE_ID,
        UNIFI_THREAT_BLOCK_LIST_ID: LIST_ID,
        UNIFI_THREAT_BLOCK_LIST_NAME: LIST_NAME
    });
    t.after(() => stopApp(runtime));
    const adminAuth = auth('admin', ADMIN_PASSWORD);
    const readonlyAuth = auth('readonly', READONLY_PASSWORD);
    const admin = await securityContext(runtime.baseUrl, adminAuth);
    const readonly = await securityContext(runtime.baseUrl, readonlyAuth);

    assert.equal((await fetch(`${runtime.baseUrl}/api/security/threat-blocks`)).status, 401);
    assert.equal((await fetch(`${runtime.baseUrl}/api/security/threat-blocks`, { headers: { authorization: readonlyAuth } })).status, 403);
    assert.equal((await fetch(`${runtime.baseUrl}/api/security/threat-blocks`, { headers: { authorization: adminAuth } })).status, 200);

    const valid = { ip: '8.8.8.8', expiresInMinutes: 60, confirmation: 'BLOCK_EXTERNAL_IP' };
    assert.equal((await write(runtime.baseUrl, { authorization: readonlyAuth, csrf: readonly.csrfToken }, 'POST', '/api/security/threat-blocks', valid)).status, 403);
    assert.equal((await write(runtime.baseUrl, { authorization: adminAuth, csrf: '' }, 'POST', '/api/security/threat-blocks', valid)).status, 403);
    assert.equal((await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken, origin: 'https://evil.example' }, 'POST', '/api/security/threat-blocks', valid)).status, 403);
    assert.equal((await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', { ...valid, ip: '192.168.1.1' })).status, 400);
    assert.equal((await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', { ...valid, confirmation: 'yes' })).status, 400);

    let response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', valid);
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json();
    assert.deepEqual(fake.addresses(), [EMPTY_LIST_SENTINEL, '8.8.8.8'].sort());
    response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', valid);
    assert.equal(response.status, 200);

    fake.setUnavailable(true);
    response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', {
        ...valid, ip: '9.9.9.9'
    });
    assert.equal(response.status, 202);
    let body = await response.json();
    assert.equal(body.applied, false);
    fake.setUnavailable(false);
    response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', {
        ...valid, ip: '9.9.9.9'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fake.addresses(), [EMPTY_LIST_SENTINEL, '8.8.8.8', '9.9.9.9'].sort());

    response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'DELETE', `/api/security/threat-blocks/${created.block.id}`, {
        confirmation: 'REMOVE_EXTERNAL_IP_BLOCK'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fake.addresses(), [EMPTY_LIST_SENTINEL, '9.9.9.9'].sort());
    assert.ok(fake.requests.some(request => request.method === 'PUT'));
});

test('mock threat-block routes preserve the same admin, confirmation, expiry, add, and remove contract', async t => {
    const runtime = await startApp('server-mock.js');
    t.after(() => stopApp(runtime));
    const adminAuth = auth('admin', ADMIN_PASSWORD);
    const readonlyAuth = auth('readonly', READONLY_PASSWORD);
    const admin = await securityContext(runtime.baseUrl, adminAuth);
    const readonly = await securityContext(runtime.baseUrl, readonlyAuth);
    const valid = { ip: '8.8.4.4', expiresInMinutes: 15, confirmation: 'BLOCK_EXTERNAL_IP' };
    assert.equal((await write(runtime.baseUrl, { authorization: readonlyAuth, csrf: readonly.csrfToken }, 'POST', '/api/security/threat-blocks', valid)).status, 403);
    let response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'POST', '/api/security/threat-blocks', valid);
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json();
    assert.equal(created.block.ip, '8.8.4.4');
    response = await write(runtime.baseUrl, { authorization: adminAuth, csrf: admin.csrfToken }, 'DELETE', `/api/security/threat-blocks/${created.block.id}`, {
        confirmation: 'REMOVE_EXTERNAL_IP_BLOCK'
    });
    assert.equal(response.status, 200);
});

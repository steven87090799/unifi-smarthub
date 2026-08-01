'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const webPush = require('web-push');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'web-push-route-admin-secret';
const READONLY_PASSWORD = 'web-push-route-readonly-secret';
const auth = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const vapid = webPush.generateVAPIDKeys();

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startApp(script) {
    const port = await unusedPort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smarthub-web-push-route-'));
    const envFile = path.join(dataDir, '.env');
    await fs.writeFile(envFile, '# isolated Web Push route test\n', { mode: 0o600 });
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
            UNIFI_USERNAME: '', UNIFI_PASSWORD: '', UNIFI_API_KEY: '',
            NAS_HOST: '', NAS_MONITOR_URL: '', WIIM_IP: '127.0.0.1',
            UPS_SOURCE: 'nut', NUT_HOST: '127.0.0.1', NUT_UPS_NAME: 'test',
            LINUX_HOST: '',
            WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
            WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
            WEB_PUSH_PRIVATE_KEY: vapid.privateKey
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
    const stopped = await Promise.race([runtime.exited.then(() => true), delay(6_000).then(() => false)]);
    if (!stopped) { runtime.child.kill('SIGKILL'); await runtime.exited; }
    await fs.rm(runtime.dataDir, { recursive: true, force: true });
}

async function csrf(baseUrl, authorization) {
    const response = await fetch(`${baseUrl}/api/security/csrf`, { headers: { authorization } });
    assert.equal(response.status, 200);
    return (await response.json()).csrfToken;
}

async function write(runtime, authorization, token, method, route, body) {
    return fetch(`${runtime.baseUrl}${route}`, {
        method,
        headers: {
            authorization,
            origin: runtime.baseUrl,
            'x-smarthub-csrf': token,
            'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
    });
}

test('production and mock Web Push routes preserve config secrecy, admin lifecycle, validation, and worker parity', { timeout: 40_000 }, async t => {
    for (const script of ['server.js', 'server-mock.js']) {
        const runtime = await startApp(script);
        t.after(() => stopApp(runtime));
        const admin = auth('admin', ADMIN_PASSWORD);
        const readonly = auth('readonly', READONLY_PASSWORD);
        const adminCsrf = await csrf(runtime.baseUrl, admin);
        const readonlyCsrf = await csrf(runtime.baseUrl, readonly);

        let response = await fetch(`${runtime.baseUrl}/api/web-push/config`, { headers: { authorization: readonly } });
        assert.equal(response.status, 200, script);
        let state = await response.json();
        assert.equal(state.configured, true, script);
        assert.match(state.publicKey, /^[A-Za-z0-9_-]+$/u);
        assert.equal(Object.hasOwn(state, 'privateKey'), false);
        assert.equal(state.subscriptionCount, 0);

        const subscription = {
            endpoint: 'https://push.example.test/subscriptions/browser-1',
            expirationTime: null,
            keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 9).toString('base64url') }
        };
        response = await write(runtime, readonly, readonlyCsrf, 'POST', '/api/web-push/subscriptions', { subscription });
        assert.equal(response.status, 403, script);
        response = await write(runtime, admin, adminCsrf, 'POST', '/api/web-push/subscriptions', {
            subscription: { ...subscription, endpoint: 'http://push.example.test/insecure' }
        });
        assert.equal(response.status, 400, script);

        response = await write(runtime, admin, adminCsrf, 'POST', '/api/web-push/subscriptions', { subscription });
        assert.equal(response.status, 201, `${script}: ${await response.clone().text()}`);
        assert.equal((await response.json()).subscriptionCount, 1);
        response = await write(runtime, admin, adminCsrf, 'POST', '/api/web-push/subscriptions', { subscription });
        assert.equal(response.status, 200, script);
        assert.equal((await response.json()).created, false);

        response = await write(runtime, admin, adminCsrf, 'POST', '/api/notifications/settings', { webPushEnabled: true });
        assert.equal(response.status, 200, script);
        response = await fetch(`${runtime.baseUrl}/api/web-push/config`, { headers: { authorization: admin } });
        state = await response.json();
        assert.equal(state.enabled, true, script);
        assert.equal(state.subscriptionCount, 1, script);

        response = await fetch(`${runtime.baseUrl}/sw.js`, { headers: { authorization: readonly } });
        assert.equal(response.status, 200, script);
        const worker = await response.text();
        assert.match(worker, /addEventListener\('push'/u);
        assert.match(worker, /showNotification/u);
        assert.match(worker, /addEventListener\('notificationclick'/u);
        assert.match(worker, /pathname\.startsWith\('\/api\/'\)/u);

        response = await fetch(`${runtime.baseUrl}/js/web-push.js`, { headers: { authorization: readonly } });
        assert.equal(response.status, 200, script);
        const frontendModule = await response.text();
        assert.match(frontendModule, /window\.fetchWebPushState = fetchWebPushState/u);
        assert.match(frontendModule, /window\.subscribeWebPush = subscribeWebPush/u);
        assert.doesNotMatch(frontendModule, /WEB_PUSH_PRIVATE_KEY|privateKey/u);

        response = await write(runtime, admin, adminCsrf, 'DELETE', '/api/web-push/subscriptions', { endpoint: subscription.endpoint });
        assert.equal(response.status, 200, script);
        assert.equal((await response.json()).removed, true);
        response = await write(runtime, admin, adminCsrf, 'DELETE', '/api/web-push/subscriptions', { endpoint: subscription.endpoint });
        assert.equal(response.status, 200, script);
        assert.equal((await response.json()).removed, false);

        await stopApp(runtime);
    }
});

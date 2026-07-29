'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRYPOINT = path.join(ROOT, 'server.js');
const ADMIN_PASSWORD = 'ci-runtime-admin-password';
const READONLY_PASSWORD = 'ci-runtime-readonly-password';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 4_000;
const BAD_RUNTIME_OUTPUT = /unhandled(?: promise )?rejection|uncaughtException|SQLITE_(?:BUSY|LOCKED)|database is locked/iu;

let activeRuntime = null;
let temporaryRoot = null;
let cleanupPromise = null;
let fatalHandling = false;
const sessionCookies = [];

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function unusedLoopbackPort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    return address.port;
}

function childEnvironment({ port, dataDir, envFile }) {
    return {
        PATH: process.env.PATH || '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        NODE_ENV: 'production',
        PORT: String(port),
        DATA_DIR: dataDir,
        SMARTHUB_ENV_FILE: envFile,
        PANEL_PASSWORD: ADMIN_PASSWORD,
        PANEL_READONLY_USERNAME: 'readonly',
        PANEL_READONLY_PASSWORD: READONLY_PASSWORD,
        PANEL_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        PANEL_AUTH_MAX_FAILURES: '100',
        LOG_LEVEL: 'CRITICAL',
        LOG_FORMAT: 'json',
        LOG_JSON: 'true',
        DEBUG_HTTP: '0',
        MONITOR_ENABLED: 'false',
        UCG_IP: '127.0.0.1',
        SSH_PORT: '1',
        SSH_USER: '',
        SSH_PASSWORD: '',
        UNIFI_CONTROLLER_URL: 'http://127.0.0.1:1',
        UNIFI_USERNAME: '',
        UNIFI_PASSWORD: '',
        UNIFI_API_KEY: '',
        UNIFI_NETWORK_API_URL: '',
        UNIFI_NETWORK_API_KEY: '',
        NAS_HOST: '',
        NAS_USER: '',
        NAS_PASSWORD: '',
        NAS_MONITOR_URL: '',
        NAS_MONITOR_API_KEY: '',
        WIIM_IP: '127.0.0.1',
        UPS_SOURCE: 'ppb',
        PPB_HOST: '127.0.0.1',
        PPB_PORT: '1',
        PPB_USER: '',
        PPB_PASSWORD: '',
        PPB_TLS_VERIFY: 'true',
        PPB_TLS_INSECURE: 'false',
        NUT_HOST: '127.0.0.1',
        ADGUARD_URL: '',
        ADGUARD_HOST: '',
        ADGUARD_USER: '',
        ADGUARD_PASSWORD: '',
        LINUX_HOST: '',
        LINUX_SSH_USER: '',
        LINUX_SSH_PASSWORD: '',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        WEB_PUSH_ENABLED: 'false',
        WEB_PUSH_PUBLIC_KEY: '',
        WEB_PUSH_PRIVATE_KEY: ''
    };
}

function retainOutput(runtime, chunk) {
    runtime.output = `${runtime.output}${chunk}`.slice(-50_000);
}

async function startRuntime({ dataDir, envFile, label }) {
    const port = await unusedLoopbackPort();
    const runtime = {
        label,
        output: '',
        forcedKill: false,
        child: null,
        closed: null,
        baseUrl: `http://127.0.0.1:${port}`
    };
    runtime.child = spawn(process.execPath, [SERVER_ENTRYPOINT], {
        cwd: ROOT,
        env: childEnvironment({ port, dataDir, envFile }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    runtime.child.stdout.on('data', chunk => retainOutput(runtime, chunk));
    runtime.child.stderr.on('data', chunk => retainOutput(runtime, chunk));
    runtime.closed = new Promise((resolve, reject) => {
        runtime.child.once('error', reject);
        runtime.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    activeRuntime = runtime;

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
            const result = await runtime.closed;
            throw new Error(`${label} exited during startup: ${JSON.stringify(result)}\n${runtime.output}`);
        }
        try {
            const health = await requestJson(runtime, '/health');
            if (health.response.status === 200) return runtime;
        } catch {
            // Startup polling is bounded by the deadline and never assumes a fixed delay.
        }
        await delay(75);
    }
    throw new Error(`${label} startup timeout\n${runtime.output}`);
}

async function requestJson(runtime, route, options = {}) {
    const response = await fetch(`${runtime.baseUrl}${route}`, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        throw new Error(`${runtime.label} ${route} returned invalid JSON: ${text.slice(0, 500)}`);
    }
    return { response, body };
}

function cookieFrom(response) {
    const header = response.headers.get('set-cookie');
    assert.ok(header, 'login must return a session cookie');
    const cookie = header.split(';', 1)[0];
    assert.match(cookie, /^smarthub_session=[A-Za-z0-9_-]+$/u);
    sessionCookies.push(cookie);
    return cookie;
}

async function login(runtime, username, password, expectedRole) {
    const result = await requestJson(runtime, '/api/auth/login', {
        method: 'POST',
        headers: {
            origin: runtime.baseUrl,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ username, password, remember: false })
    });
    assert.equal(result.response.status, 200, `${expectedRole} login: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.role, expectedRole);
    const cookie = cookieFrom(result.response);

    const csrf = await requestJson(runtime, '/api/security/csrf', {
        headers: { cookie }
    });
    assert.equal(csrf.response.status, 200);
    assert.equal(csrf.body.role, expectedRole);
    assert.equal(typeof csrf.body.csrfToken, 'string');
    assert.ok(csrf.body.csrfToken.length >= 32);
    return { cookie, csrfToken: csrf.body.csrfToken };
}

async function verifyHealth(runtime) {
    const health = await requestJson(runtime, '/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, 'healthy');

    const ready = await requestJson(runtime, '/health/ready');
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.status, 'ready');
    assert.equal(ready.body.checks.database.status, 'healthy');
    assert.notEqual(ready.body.checks.worker.status, 'critical');
}

async function writeSetting(runtime, auth, { includeCsrf = true } = {}) {
    const headers = {
        cookie: auth.cookie,
        origin: runtime.baseUrl,
        'content-type': 'application/json'
    };
    if (includeCsrf) headers['x-smarthub-csrf'] = auth.csrfToken;
    return requestJson(runtime, '/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ watcherSec: 41 })
    });
}

async function verifySecurityAndPersistenceWrite(runtime) {
    const admin = await login(runtime, 'admin', ADMIN_PASSWORD, 'admin');
    const readonly = await login(runtime, 'readonly', READONLY_PASSWORD, 'readonly');

    const readonlyWrite = await writeSetting(runtime, readonly);
    assert.equal(readonlyWrite.response.status, 403);

    const missingCsrf = await writeSetting(runtime, admin, { includeCsrf: false });
    assert.equal(missingCsrf.response.status, 403);

    const validWrite = await writeSetting(runtime, admin);
    assert.equal(validWrite.response.status, 200);
    assert.equal(validWrite.body.settings.watcherSec, 41);

    const persisted = await requestJson(runtime, '/api/settings', {
        headers: { cookie: admin.cookie }
    });
    assert.equal(persisted.response.status, 200);
    assert.equal(persisted.body.watcherSec, 41);
}

function assertCleanRuntimeOutput(runtime) {
    assert.doesNotMatch(runtime.output, BAD_RUNTIME_OUTPUT, `${runtime.label} emitted fatal or SQLite lock output`);
}

async function stopRuntime(runtime) {
    assert.equal(runtime, activeRuntime, 'only the active production runtime may be stopped');
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
        assert.equal(runtime.child.kill('SIGTERM'), true, `${runtime.label} did not accept SIGTERM`);
    }

    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${runtime.label} shutdown timeout`)), SHUTDOWN_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([runtime.closed, timeout]);
        assert.deepEqual(result, { code: 0, signal: null }, `${runtime.label} did not exit cleanly`);
        assert.equal(runtime.forcedKill, false, `${runtime.label} required SIGKILL`);
        assertCleanRuntimeOutput(runtime);
    } finally {
        clearTimeout(timeoutHandle);
    }
    activeRuntime = null;
}

async function forceCleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
        const runtime = activeRuntime;
        if (runtime?.child && runtime.child.exitCode === null && runtime.child.signalCode === null) {
            runtime.child.kill('SIGTERM');
            const closed = await Promise.race([
                runtime.closed.then(() => true, () => true),
                delay(SHUTDOWN_TIMEOUT_MS).then(() => false)
            ]);
            if (!closed && runtime.child.exitCode === null && runtime.child.signalCode === null) {
                runtime.forcedKill = true;
                runtime.child.kill('SIGKILL');
                await runtime.closed.catch(() => {});
            }
        }
        activeRuntime = null;
        sessionCookies.length = 0;
        if (temporaryRoot) {
            await fs.rm(temporaryRoot, { recursive: true, force: true });
            try {
                await fs.access(temporaryRoot);
                throw new Error(`temporary root still exists: ${temporaryRoot}`);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            temporaryRoot = null;
        }
    })();
    return cleanupPromise;
}

function handleFatal(kind, value) {
    if (fatalHandling) return;
    fatalHandling = true;
    const error = value instanceof Error ? value : new Error(String(value));
    process.stderr.write(`runtime smoke ${kind}: ${error.stack || error.message}\n`);
    process.exitCode = 1;
    void forceCleanup().catch(cleanupError => {
        process.stderr.write(`runtime smoke cleanup failed: ${cleanupError.stack || cleanupError.message}\n`);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => handleFatal(signal, new Error(`runtime smoke interrupted by ${signal}`)));
}
process.once('uncaughtException', error => handleFatal('uncaughtException', error));
process.once('unhandledRejection', reason => handleFatal('unhandledRejection', reason));

async function main() {
    try {
        temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smarthub-runtime-smoke-'));
        const dataDir = path.join(temporaryRoot, 'data');
        const configDir = path.join(temporaryRoot, 'config');
        const envFile = path.join(configDir, '.env');
        await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(envFile, '# Runtime smoke values are supplied only to the child process.\n', { mode: 0o600 });

        const first = await startRuntime({ dataDir, envFile, label: 'first runtime' });
        await verifyHealth(first);
        await verifySecurityAndPersistenceWrite(first);
        await stopRuntime(first);

        const second = await startRuntime({ dataDir, envFile, label: 'restart runtime' });
        await verifyHealth(second);
        const admin = await login(second, 'admin', ADMIN_PASSWORD, 'admin');
        const persisted = await requestJson(second, '/api/settings', {
            headers: { cookie: admin.cookie }
        });
        assert.equal(persisted.response.status, 200);
        assert.equal(persisted.body.watcherSec, 41);
        await stopRuntime(second);

        process.stdout.write([
            'Runtime smoke PASS',
            'health=200',
            'ready=200',
            'admin_login=200',
            'readonly_login=200',
            'readonly_write=403',
            'admin_missing_csrf=403',
            'admin_valid_csrf=200',
            'sigterm_exits=0,0',
            'restart_persistence=PASS'
        ].join(' ') + '\n');
    } finally {
        await forceCleanup();
    }
    process.stdout.write('Runtime smoke cleanup PASS\n');
}

main().catch(error => {
    process.exitCode = 1;
    process.stderr.write(`Runtime smoke FAIL: ${error.stack || error.message}\n`);
});

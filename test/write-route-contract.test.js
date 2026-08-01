'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');
const { ERROR_CODES } = require('../observability/error-codes');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'integration-admin-secret';
const BASIC_AUTH = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;
const READONLY_AUTH = `Basic ${Buffer.from('readonly:integration-readonly-secret').toString('base64')}`;
const VALIDATION_CODE = 'API-VALID-001';
const ISOLATED_CHILD_BOOTSTRAP = String.raw`
const Module = require('node:module');
const realDotenv = require('dotenv');
const originalLoad = Module._load;
Module._load = function loadWithoutDotenv(request, parent, isMain) {
    if (request === 'dotenv') return { config: () => ({ parsed: {} }), parse: realDotenv.parse };
    return originalLoad.call(this, request, parent, isMain);
};
require(process.argv[1]);
`;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

function safeChildEnvironment({ port, dataDir }) {
    return {
        ...process.env,
        NODE_ENV: 'production',
        SMARTHUB_BIND_ADDRESS: '127.0.0.1',
        PANEL_REQUIRE_HTTPS: 'false',
        PANEL_ALLOW_INSECURE_HTTP: 'false',
        PORT: String(port),
        DATA_DIR: dataDir,
        SMARTHUB_ENV_FILE: path.join(dataDir, '.env'),
        ALLOW_MULTI_INSTANCE: '1',
        PANEL_PASSWORD: ADMIN_PASSWORD,
        PANEL_READONLY_PASSWORD: 'integration-readonly-secret',
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
        UNIFI_NETWORK_API_URL: 'http://127.0.0.1:1',
        UNIFI_NETWORK_TLS_VERIFY: 'true',
        UNIFI_NETWORK_CA_FILE: '',
        UNIFI_NETWORK_TLS_INSECURE: 'false',
        UNIFI_NETWORK_ALLOW_INSECURE_HTTP: 'false',
        UNIFI_USERNAME: '',
        UNIFI_PASSWORD: '',
        UNIFI_API_KEY: '',
        NAS_HOST: '',
        NAS_USER: '',
        NAS_PASSWORD: '',
        NAS_MONITOR_URL: '',
        NAS_MONITOR_API_KEY: '',
        WIIM_IP: '127.0.0.1',
        UPS_SOURCE: 'nut',
        NUT_HOST: '127.0.0.1',
        NUT_UPS_NAME: 'integration-test',
        PPB_HOST: '127.0.0.1',
        PPB_PORT: '1',
        PPB_USER: '',
        PPB_PASSWORD: '',
        ADGUARD_HOST: '',
        ADGUARD_USER: '',
        ADGUARD_PASSWORD: '',
        LINUX_HOST: '',
        LINUX_SSH_USER: '',
        LINUX_SSH_PASSWORD: ''
    };
}

async function startRuntime(script, label) {
    const port = await unusedPort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `smarthub-${label}-`));
    await fs.writeFile(path.join(dataDir, '.env'), '# isolated integration config\n', { mode: 0o600 });
    // Never let a child load the repository's real .env: the explicit loopback-only
    // environment below is the entire integration surface available to the server.
    const child = spawn(process.execPath, ['--eval', ISOLATED_CHILD_BOOTSTRAP, path.join(ROOT, script)], {
        cwd: ROOT,
        env: safeChildEnvironment({ port, dataDir }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let spawnError = null;
    const retainOutput = chunk => { output = `${output}${chunk}`.slice(-30_000); };
    child.stdout.on('data', retainOutput);
    child.stderr.on('data', retainOutput);
    child.once('error', error => { spawnError = error; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null) {
                throw new Error(`${label} exited during startup (${child.exitCode})\n${output}`);
            }
            try {
                const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
                if (response.ok) return { baseUrl, child, dataDir, exited, label, output: () => output };
            } catch { /* retry until the child begins listening */ }
            await delay(50);
        }
        throw new Error(`${label} did not become ready\n${output}`);
    } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        await fs.rm(dataDir, { recursive: true, force: true });
        throw error;
    }
}

async function stopRuntime(runtime) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGTERM');
    const closed = await Promise.race([
        runtime.exited.then(() => true),
        delay(6_000).then(() => false)
    ]);
    if (!closed) {
        runtime.child.kill('SIGKILL');
        await runtime.exited;
    }
    await fs.rm(runtime.dataDir, { recursive: true, force: true });
}

async function createClient(runtime) {
    const response = await fetch(`${runtime.baseUrl}/api/security/csrf`, {
        headers: { authorization: BASIC_AUTH },
        signal: AbortSignal.timeout(4_000)
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} CSRF endpoint: ${text}`);
    const body = JSON.parse(text);
    assert.equal(body.role, 'admin');
    assert.equal(typeof body.csrfToken, 'string');
    assert.ok(body.csrfToken.length >= 16);

    const commonHeaders = {
        authorization: BASIC_AUTH,
        origin: runtime.baseUrl,
        'x-smarthub-csrf': body.csrfToken
    };
    return {
        async read(route) {
            return fetch(`${runtime.baseUrl}${route}`, {
                headers: { authorization: BASIC_AUTH },
                signal: AbortSignal.timeout(4_000)
            });
        },
        async write(method, route, payload) {
            return fetch(`${runtime.baseUrl}${route}`, {
                method,
                headers: { ...commonHeaders, 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(4_000)
            });
        },
        async writeRaw(method, route, bodyText) {
            return fetch(`${runtime.baseUrl}${route}`, {
                method,
                headers: { ...commonHeaders, 'content-type': 'application/json' },
                body: bodyText,
                signal: AbortSignal.timeout(4_000)
            });
        }
    };
}

const INVALID_WRITES = Object.freeze([
    ['WiFi path identifier', 'PUT', '/api/wifi-networks/bad%24id', { enabled: true }],
    ['WiFi boolean string', 'PUT', '/api/wifi-networks/wifi-1', { enabled: 'false' }],
    ['WiFi unknown field', 'PUT', '/api/wifi-networks/wifi-1', { enabled: true, extra: 1 }],
    ['WiFi QR weak password', 'POST', '/api/wifi/qr', { ssid: 'Guest', password: 'short' }],
    ['WiFi QR unknown field', 'POST', '/api/wifi/qr', { ssid: 'Guest', password: 'safe passphrase', external: true }],
    ['device restriction malformed MAC', 'PUT', '/api/device/restrict', { deviceId: 'not-a-mac', blockState: false }],
    ['device restriction boolean string', 'PUT', '/api/device/restrict', { deviceId: '00:11:22:33:44:55', blockState: 'false' }],
    ['device restriction unknown field', 'PUT', '/api/device/restrict', { deviceId: '00:11:22:33:44:55', blockState: false, extra: 1 }],
    ['PoE malformed switch MAC', 'POST', '/api/poe/power-cycle', { switchMac: 'bad', portIndex: 1 }],
    ['PoE numeric string', 'POST', '/api/poe/power-cycle', { switchMac: '00:11:22:33:44:55', portIndex: '1' }],
    ['PoE zero port', 'POST', '/api/poe/power-cycle', { switchMac: '00:11:22:33:44:55', portIndex: 0 }],
    ['PoE port max plus one', 'POST', '/api/poe/power-cycle', { switchMac: '00:11:22:33:44:55', portIndex: 129 }],
    ['PoE fractional port', 'POST', '/api/poe/power-cycle', { switchMac: '00:11:22:33:44:55', portIndex: 1.5 }],
    ['security boolean string', 'POST', '/api/security/settings', { autoDefense: 'false' }],
    ['AdGuard numeric boolean', 'POST', '/api/adguard/protection', { enabled: 1 }],
    ['notification threshold below minimum', 'POST', '/api/notifications/settings', { clientSignalAlert: 49 }],
    ['notification threshold above maximum', 'POST', '/api/notifications/settings', { clientSignalAlert: 96 }],
    ['notification invalid channel', 'POST', '/api/notifications/settings', { channel: 'sms' }],
    ['notification boolean string', 'POST', '/api/notifications/settings', { enabled: 'true' }],
    ['Web Push insecure endpoint', 'POST', '/api/web-push/subscriptions', {
        subscription: { endpoint: 'http://push.example.test/device', expirationTime: null, keys: { p256dh: 'bad', auth: 'bad' } }
    }],
    ['Web Push unsubscribe unknown field', 'DELETE', '/api/web-push/subscriptions', {
        endpoint: 'https://push.example.test/device', extra: true
    }],
    ['settings minimum minus one', 'POST', '/api/settings', { trendActiveSec: 4 }],
    ['settings maximum plus one', 'POST', '/api/settings', { trendActiveSec: 3601 }],
    ['settings invalid hour', 'POST', '/api/settings', { reportHour: 24 }],
    ['settings retention maximum plus one', 'POST', '/api/settings', { historyKeepDays: 366 }],
    ['settings telemetry active below minimum', 'POST', '/api/settings', { unifiTelemetryActiveSec: 14 }],
    ['settings telemetry idle below minimum', 'POST', '/api/settings', { unifiTelemetryIdleSec: 59 }],
    ['settings lease must exceed heartbeat', 'POST', '/api/settings', { heartbeatSec: 30, activeLeaseSec: 30 }],
    ['settings unknown field', 'POST', '/api/settings', { unexpected: true }],
    ['Docker invalid identifier', 'POST', '/api/nas/docker/bad%24id/start', {}],
    ['Docker invalid action', 'POST', '/api/nas/docker/container-1/destroy', {}],
    ['Docker nonempty body', 'POST', '/api/nas/docker/container-1/start', { extra: true }],
    ['alert invalid identifier', 'POST', '/api/nas/alerts/bad%24id/ack', {}],
    ['alert acknowledgement nonempty body', 'POST', '/api/nas/alerts/al-1/ack', { extra: true }],
    ['alert config invalid metric', 'POST', '/api/nas/alerts/config', { metric: '../disk', threshold: 50, condition: 'above', enabled: true }],
    ['alert config numeric string', 'POST', '/api/nas/alerts/config', { metric: 'disk_temp', threshold: '50', condition: 'above', enabled: true }],
    ['alert config numeric boolean', 'POST', '/api/nas/alerts/config', { metric: 'disk_temp', threshold: 50, condition: 'above', enabled: 1 }],
    ['alert config invalid condition', 'POST', '/api/nas/alerts/config', { metric: 'disk_temp', threshold: 50, condition: 'gte', enabled: true }],
    ['speed test nonempty body', 'POST', '/api/speedtest', { extra: true }],
    ['notification test nonempty body', 'POST', '/api/notifications/test', { extra: true }],
    ['report run nonempty body', 'POST', '/api/reports/run', { extra: true }],
    ['connection newline injection', 'POST', '/api/connections', { PPB_PASSWORD: 'safe\nEVIL=1' }],
    ['connection shell host injection', 'POST', '/api/connections', { PPB_HOST: 'host$(id)' }],
    ['connection noncanonical port', 'POST', '/api/connections', { PPB_PORT: '03052' }],
    ['connection invalid UniFi device SSH username', 'POST', '/api/connections', { UNIFI_DEVICE_SSH_USER: 'root;id' }],
    ['connection invalid UniFi device SSH host key', 'POST', '/api/connections', { UNIFI_DEVICE_SSH_HOST_KEYS: 'aa:bb:cc:dd:ee:ff=SHA256:bad' }],
    ['connection excessive UniFi device SSH targets', 'POST', '/api/connections', {
        UNIFI_DEVICE_SSH_TARGET_IDS: Array.from({ length: 33 }, (_, index) => `02:00:00:00:00:${index.toString(16).padStart(2, '0')}`).join(',')
    }],
    ['connection insecure remote Integration API', 'POST', '/api/connections', { UNIFI_NETWORK_API_URL: 'http://192.168.1.1/proxy/network/integration' }],
    ['connection invalid Integration API TLS flag', 'POST', '/api/connections', { UNIFI_NETWORK_TLS_VERIFY: 'FALSE' }],
    ['connection invalid PPB TLS flag', 'POST', '/api/connections', { PPB_TLS_INSECURE: 'TRUE' }],
    ['connection ambiguous PPB TLS disable', 'POST', '/api/connections', { PPB_TLS_VERIFY: 'false' }],
    ['connection relative PPB CA path', 'POST', '/api/connections', { PPB_CA_FILE: 'relative.pem' }],
    ['connection insecure remote AdGuard', 'POST', '/api/connections', {
        ADGUARD_URL: 'http://192.0.2.10',
        ADGUARD_USER: 'admin',
        ADGUARD_PASSWORD: 'adguard-contract-test-secret'
    }],
    ['connection ambiguous AdGuard URL', 'POST', '/api/connections', { ADGUARD_URL: 'https://adguard.internal/control?key=leak' }],
    ['connection invalid AdGuard HTTP flag', 'POST', '/api/connections', { ADGUARD_ALLOW_INSECURE_HTTP: '1' }],
    ['connection invalid AdGuard TLS flag', 'POST', '/api/connections', { ADGUARD_TLS_VERIFY: 'FALSE' }],
    ['AdGuard policy invalid identity', 'POST', '/api/adguard/service-policies', {
        deviceId: 'living-room', categories: ['youtube'], timeZone: 'Asia/Taipei', allowWindows: {}
    }],
    ['AdGuard policy invalid schedule boundary', 'POST', '/api/adguard/service-policies', {
        deviceId: '192.168.1.50', categories: ['youtube'], timeZone: 'Asia/Taipei',
        allowWindows: { mon: { start: '20:00', end: '18:00' } }
    }],
    ['AdGuard policy invalid removal confirmation', 'DELETE', '/api/adguard/service-policies/11111111-1111-4111-8111-111111111111', {
        confirmation: 'yes'
    }],
    ['connection unknown field', 'POST', '/api/connections', { SURPRISE_SECRET: 'value' }],
    ['connection oversized secret', 'POST', '/api/connections', { PPB_PASSWORD: 'x'.repeat(4097) }]
]);

const INVALID_QUERIES = Object.freeze([
    ['trend fractional hours', '/api/history?hours=1.5'],
    ['heartbeat repeated scope', '/api/heartbeat?scope=trend&scope=nas'],
    ['hardware zero hours', '/api/hardware/history?hours=0'],
    ['WiiM invalid status type', '/api/wiim/status?type=ALL'],
    ['WiiM art missing URL', '/api/wiim/art?v=track'],
    ['WiiM art non-HTTP URL', '/api/wiim/art?u=file%3A%2F%2F%2Fetc%2Fpasswd'],
    ['UPS ambiguous hours', '/api/ups/history?hours=01'],
    ['Linux unknown query', '/api/linux/history?days=1']
]);

async function assertValidationFailure(runtime, client, [label, method, route, payload]) {
    const response = await client.write(method, route, payload);
    const text = await response.text();
    assert.equal(response.status, 400, `${runtime.label} ${label}: ${text.slice(0, 500)}`);
    assert.match(response.headers.get('content-type') || '', /^application\/json\b/i, `${runtime.label} ${label}`);
    const body = JSON.parse(text);
    assert.equal(body.code, VALIDATION_CODE, `${runtime.label} ${label}: ${text}`);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
}

async function assertSafeLocalWrites(runtime, client) {
    let response = await client.read('/');
    assert.equal(response.status, 200, `${runtime.label} frontend shell`);
    assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/u);
    for (const asset of [
        '/assets/tailwind.css',
        '/vendor/chart.js/4.5.1/chart.umd.js',
        '/vendor/d3/7.9.0/d3.min.js',
        '/vendor/topojson-client/3.1.0/topojson-client.min.js',
        '/vendor/world-atlas/2.0.2/countries-110m.json'
    ]) {
        response = await client.read(asset);
        assert.equal(response.status, 200, `${runtime.label} same-origin asset ${asset}`);
    }

    response = await client.write('POST', '/api/wifi/qr', {
        ssid: 'Guest;Network', password: 'correct horse battery'
    });
    let text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} WiFi QR: ${text}`);
    assert.match(response.headers.get('content-type') || '', /image\/svg\+xml/u);
    assert.match(response.headers.get('cache-control') || '', /no-store/u);
    assert.doesNotMatch(text, /Guest;Network|correct horse battery/u);

    response = await client.write('POST', '/api/ui-preferences', {
        preferences: { theme: 'light', pollConfig: { hardware: 5 } }
    });
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} UI preferences: ${text}`);
    let body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.preferences.theme, 'light');

    response = await client.write('POST', '/api/client-aliases', {
        mac: 'AA:BB:CC:DD:EE:FF', name: 'Integration Lamp'
    });
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} client alias: ${text}`);
    body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.aliases['aa:bb:cc:dd:ee:ff'], 'Integration Lamp');

    response = await client.write('POST', '/api/settings', {
        trendActiveSec: 5,
        reportEnabled: false,
        reportFreq: 'weekly',
        reportHour: 0,
        historyKeepDays: 365
    });
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} app settings: ${text}`);
    body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.settings.trendActiveSec, 5);
    assert.equal(body.settings.reportEnabled, false);
    assert.equal(body.settings.reportFreq, 'weekly');
    assert.equal(body.settings.reportHour, 0);
    assert.equal(body.settings.historyKeepDays, 365);

    response = await client.write('POST', '/api/settings', {
        deviceActiveFrontendPollSec: 7,
        deviceActiveBackendSampleSec: 8,
        deviceIdleBackendSampleSec: 601,
        heartbeatSec: 6,
        activeLeaseSec: 31,
        upsFrontendPollSec: 4,
        upsActiveBackendSampleSec: 5,
        upsIdleBackendSampleSec: 11,
        unifiTelemetryActiveSec: 61,
        unifiTelemetryIdleSec: 301
    });
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} adaptive sampling settings: ${text}`);
    body = JSON.parse(text);
    assert.equal(body.settings.deviceActiveFrontendPollSec, 7);
    assert.equal(body.settings.deviceActiveBackendSampleSec, 8);
    assert.equal(body.settings.deviceIdleBackendSampleSec, 601);
    assert.equal(body.settings.heartbeatSec, 6);
    assert.equal(body.settings.activeLeaseSec, 31);
    assert.equal(body.settings.upsFrontendPollSec, 4);
    assert.equal(body.settings.upsActiveBackendSampleSec, 5);
    assert.equal(body.settings.upsIdleBackendSampleSec, 11);
    assert.equal(body.settings.unifiTelemetryActiveSec, 61);
    assert.equal(body.settings.unifiTelemetryIdleSec, 301);

    response = await client.read('/api/client-aliases');
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} client alias readback: ${text}`);
    assert.equal(JSON.parse(text).aliases['aa:bb:cc:dd:ee:ff'], 'Integration Lamp');

    const secret = "pass with # and 'quote $HOME";
    const deviceSecret = 'telemetry-device-secret';
    const deviceFingerprint = `SHA256:${'A'.repeat(43)}`;
    response = await client.write('POST', '/api/connections', {
        UPS_SOURCE: 'ppb', PPB_HOST: '127.0.0.1', PPB_PORT: '3052', PPB_PASSWORD: secret,
        UNIFI_NETWORK_TLS_VERIFY: 'false', UNIFI_NETWORK_TLS_INSECURE: 'true', UNIFI_DEVICE_SSH_PORT: '2222', UNIFI_DEVICE_SSH_USER: 'monitor',
        UNIFI_DEVICE_SSH_PASSWORD: deviceSecret, UNIFI_DEVICE_SSH_TARGET_IDS: 'AA:BB:CC:DD:EE:FF',
        UNIFI_DEVICE_SSH_HOST_KEYS: `AA:BB:CC:DD:EE:FF=${deviceFingerprint}`
    });
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} connections: ${text}`);
    body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.changed, 11);

    response = await client.read('/api/connections');
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} connection readback: ${text}`);
    body = JSON.parse(text);
    assert.equal(body.fields.UPS_SOURCE, 'ppb');
    assert.equal(body.fields.PPB_HOST, '127.0.0.1');
    assert.equal(body.fields.PPB_PORT, '3052');
    assert.equal(body.fields.UNIFI_NETWORK_TLS_VERIFY, 'false');
    assert.equal(body.fields.UNIFI_DEVICE_SSH_PORT, '2222');
    assert.equal(body.fields.UNIFI_DEVICE_SSH_USER, 'monitor');
    assert.equal(body.secretsSet.PPB_PASSWORD, true);
    assert.equal(body.secretsSet.UNIFI_DEVICE_SSH_PASSWORD, true);
    assert.equal(body.secretsSet.UNIFI_DEVICE_SSH_TARGET_IDS, true);
    assert.equal(body.secretsSet.UNIFI_DEVICE_SSH_HOST_KEYS, true);
    assert.equal(text.includes(secret), false, `${runtime.label} secret leaked in readback`);
    assert.equal(text.includes(deviceSecret), false, `${runtime.label} device secret leaked in readback`);
    assert.equal(text.includes('aa:bb:cc:dd:ee:ff'), false, `${runtime.label} target MAC leaked in readback`);
    assert.equal(text.includes(deviceFingerprint), false, `${runtime.label} host key leaked in readback`);

    response = await client.write('POST', '/api/connections', {
        NAS_MONITOR_URL: 'http://nas-monitor:8000',
        NAS_MONITOR_API_KEY: '0123456789abcdef0123456789abcdef',
        NAS_MONITOR_MODE: 'full'
    });
    text = await response.text();
    assert.equal(response.status, 200, `${runtime.label} restart-required connection: ${text}`);
    body = JSON.parse(text);
    assert.deepEqual(body.restartRequired, [
        'NAS_MONITOR_URL', 'NAS_MONITOR_API_KEY', 'NAS_MONITOR_MODE'
    ]);

    response = await client.read('/api/connections');
    body = await response.json();
    assert.deepEqual(body.restartRequiredFields, [
        'NAS_MONITOR_URL', 'NAS_MONITOR_API_KEY', 'NAS_MONITOR_MODE'
    ]);
    assert.deepEqual([...body.pendingRestartFields].sort(), [
        'NAS_MONITOR_API_KEY', 'NAS_MONITOR_MODE', 'NAS_MONITOR_URL'
    ]);

    if (runtime.label === 'production') {
        const serialized = await fs.readFile(path.join(runtime.dataDir, '.env'), 'utf8');
        const parsed = dotenv.parse(serialized);
        assert.equal(parsed.UPS_SOURCE, 'ppb');
        assert.equal(parsed.PPB_HOST, '127.0.0.1');
        assert.equal(parsed.PPB_PORT, '3052');
        assert.equal(parsed.PPB_PASSWORD, secret);
        assert.equal(parsed.UNIFI_DEVICE_SSH_PORT, '2222');
        assert.equal(parsed.UNIFI_DEVICE_SSH_USER, 'monitor');
        assert.equal(parsed.UNIFI_DEVICE_SSH_PASSWORD, deviceSecret);
        assert.equal(parsed.UNIFI_DEVICE_SSH_TARGET_IDS, 'aa:bb:cc:dd:ee:ff');
        assert.equal(parsed.UNIFI_DEVICE_SSH_HOST_KEYS, `aa:bb:cc:dd:ee:ff=${deviceFingerprint}`);
        assert.equal(parsed.EVIL, undefined);
    }
}

async function exerciseRuntimeContract(t, script, label) {
    const runtime = await startRuntime(script, label);
    t.after(() => stopRuntime(runtime));
    const client = await createClient(runtime);

    await t.test('readonly cannot fetch privileged Docker logs', async () => {
        const response = await fetch(`${runtime.baseUrl}/api/nas/docker/${'a'.repeat(64)}/logs?lines=20`, {
            headers: { authorization: READONLY_AUTH },
            signal: AbortSignal.timeout(4_000)
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, ERROR_CODES.API_AUTHORIZATION_FAILED);
    });

    await t.test('readonly can read retained UniFi telemetry without receiving connection secrets', async () => {
        for (const route of ['/api/network/devices/telemetry', '/api/network/devices/telemetry/history?hours=24']) {
            const response = await fetch(`${runtime.baseUrl}${route}`, {
                headers: { authorization: READONLY_AUTH }, signal: AbortSignal.timeout(4_000)
            });
            const text = await response.text();
            assert.equal(response.status, 200, `${runtime.label} ${route}: ${text.slice(0, 500)}`);
            assert.doesNotMatch(text, /UNIFI_DEVICE_SSH_PASSWORD|PRIVATE_KEY|SHA256:[A-Za-z0-9+/]{43}/u);
        }
    });

    await t.test('WiFi QR remains admin-only with same-origin CSRF proof', async () => {
        const body = JSON.stringify({ ssid: 'Guest', password: 'safe passphrase' });
        assert.equal((await fetch(`${runtime.baseUrl}/api/wifi/qr`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body
        })).status, 401);
        const readonlyCsrfResponse = await fetch(`${runtime.baseUrl}/api/security/csrf`, {
            headers: { authorization: READONLY_AUTH }
        });
        const readonlyCsrf = (await readonlyCsrfResponse.json()).csrfToken;
        assert.equal((await fetch(`${runtime.baseUrl}/api/wifi/qr`, {
            method: 'POST',
            headers: {
                authorization: READONLY_AUTH,
                origin: runtime.baseUrl,
                'x-smarthub-csrf': readonlyCsrf,
                'content-type': 'application/json'
            },
            body
        })).status, 403);
        assert.equal((await fetch(`${runtime.baseUrl}/api/wifi/qr`, {
            method: 'POST',
            headers: { authorization: BASIC_AUTH, origin: runtime.baseUrl, 'content-type': 'application/json' },
            body
        })).status, 403);
        const adminCsrfResponse = await fetch(`${runtime.baseUrl}/api/security/csrf`, {
            headers: { authorization: BASIC_AUTH }
        });
        const adminCsrf = (await adminCsrfResponse.json()).csrfToken;
        assert.equal((await fetch(`${runtime.baseUrl}/api/wifi/qr`, {
            method: 'POST',
            headers: {
                authorization: BASIC_AUTH,
                origin: 'https://hostile.example',
                'x-smarthub-csrf': adminCsrf,
                'content-type': 'application/json'
            },
            body
        })).status, 403);
    });

    await t.test('admin-only backup export and staged restore share the production contract', async () => {
        const denied = await fetch(`${runtime.baseUrl}/api/config/backup`, {
            headers: { authorization: READONLY_AUTH }, signal: AbortSignal.timeout(8_000)
        });
        assert.equal(denied.status, 403);

        const exported = await fetch(`${runtime.baseUrl}/api/config/backup`, {
            headers: { authorization: BASIC_AUTH }, signal: AbortSignal.timeout(8_000)
        });
        const backupText = await exported.text();
        assert.equal(exported.status, 200, `${runtime.label} backup export: ${backupText.slice(0, 500)}`);
        assert.match(exported.headers.get('content-type') || '', /^application\/vnd\.unifi-smarthub\.backup\+json\b/i);
        const backup = JSON.parse(backupText);
        assert.equal(backup.manifest.format, 'unifi-smarthub-backup');
        assert.equal(backup.environment.restorable, false);
        assert.doesNotMatch(backupText, /integration-admin-secret|integration-readonly-secret/);

        const csrfResponse = await fetch(`${runtime.baseUrl}/api/security/csrf`, {
            headers: { authorization: BASIC_AUTH }, signal: AbortSignal.timeout(4_000)
        });
        const { csrfToken } = await csrfResponse.json();
        const headers = {
            authorization: BASIC_AUTH,
            origin: runtime.baseUrl,
            'x-smarthub-csrf': csrfToken,
            'content-type': 'application/vnd.unifi-smarthub.backup+json'
        };
        const missingConfirmation = await fetch(`${runtime.baseUrl}/api/config/restore`, {
            method: 'POST', headers, body: backupText, signal: AbortSignal.timeout(8_000)
        });
        assert.equal(missingConfirmation.status, 400);
        const staged = await fetch(`${runtime.baseUrl}/api/config/restore`, {
            method: 'POST',
            headers: { ...headers, 'x-smarthub-restore-confirmation': 'RESTORE' },
            body: backupText,
            signal: AbortSignal.timeout(8_000)
        });
        const stagedText = await staged.text();
        assert.equal(staged.status, 202, `${runtime.label} staged restore: ${stagedText.slice(0, 500)}`);
        assert.deepEqual(JSON.parse(stagedText), { staged: true, restartRequired: true, secretsRestored: false });
    });

    for (const invalidCase of INVALID_WRITES) {
        await t.test(invalidCase[0], () => assertValidationFailure(runtime, client, invalidCase));
    }

    for (const [queryLabel, route] of INVALID_QUERIES) {
        await t.test(queryLabel, async () => {
            const response = await client.read(route);
            const text = await response.text();
            assert.equal(response.status, 400, `${runtime.label} ${queryLabel}: ${text.slice(0, 500)}`);
            assert.match(response.headers.get('content-type') || '', /^application\/json\b/i);
            assert.equal(JSON.parse(text).code, VALIDATION_CODE);
        });
    }

    await t.test('safe local-only writes persist canonical values', () => assertSafeLocalWrites(runtime, client));

    await t.test('oversized JSON has a stable rejection contract', async () => {
        const oversizedBody = JSON.stringify({ padding: 'x'.repeat(270 * 1024) });
        const response = await client.writeRaw('POST', '/api/settings', oversizedBody);
        const text = await response.text();
        assert.equal(response.status, 413, `${runtime.label} oversized body: ${text.slice(0, 500)}`);
        assert.match(response.headers.get('content-type') || '', /^application\/json\b/i);
        const body = JSON.parse(text);
        assert.equal(body.code, VALIDATION_CODE);
        assert.equal(typeof body.error, 'string');
        assert.ok(body.error.length > 0);
    });
}

test('production server rejects malformed writes before integrations are called', { timeout: 60_000 }, async t => {
    await exerciseRuntimeContract(t, 'server.js', 'production');
});

test('mock server mirrors the production write-input contract', { timeout: 60_000 }, async t => {
    await exerciseRuntimeContract(t, 'server-mock.js', 'mock');
});

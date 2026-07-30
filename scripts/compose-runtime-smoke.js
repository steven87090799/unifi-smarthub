'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
let root = null;
let project = null;

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => execFile(command, args, { cwd: ROOT, timeout: 120000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
        if (error) { error.output = `${stdout}\n${stderr}`; reject(error); return; }
        resolve({ stdout, stderr });
    }));
}
function compose(...args) { return run('docker', ['compose', '--env-file', path.join(root, 'compose.env'), '--project-name', project, ...args]); }
async function waitFor(url, predicate, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (await predicate(response)) return response; } catch { }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`compose smoke timeout: ${url}`);
}
async function waitForContainerHealth(container, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const inspect = JSON.parse((await run('docker', ['inspect', container])).stdout)[0];
        if (inspect.State.Health?.Status === 'healthy') return inspect;
        if (inspect.State.Health?.Status === 'unhealthy' || inspect.State.Status === 'exited') {
            throw new Error(`container health is ${inspect.State.Health?.Status || inspect.State.Status}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('container did not become healthy');
}
async function adminHeaders(baseUrl) {
    const auth = `Basic ${Buffer.from('admin:compose-smoke-admin').toString('base64')}`;
    const csrf = await (await fetch(`${baseUrl}/api/security/csrf`, { headers: { authorization: auth } })).json();
    return { authorization: auth, origin: baseUrl, 'x-smarthub-csrf': csrf.csrfToken, 'content-type': 'application/json' };
}
async function main() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'smarthub-compose-smoke-'));
    project = `smarthubsmoke${crypto.randomBytes(5).toString('hex')}`;
    const config = path.join(root, 'config');
    const port = 38000 + crypto.randomInt(1000);
    await fs.mkdir(config, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(config, '.env'), 'PANEL_PASSWORD=compose-smoke-admin\nPANEL_READONLY_USERNAME=readonly\nPANEL_READONLY_PASSWORD=compose-smoke-readonly\nWIIM_IP=192.0.2.10\n', { mode: 0o600 });
    await fs.writeFile(path.join(root, 'compose.env'), [
        `SMARTHUB_CONFIG_DIR=${config}`, `SMARTHUB_HOST_PORT=${port}`,
        'PANEL_PASSWORD=compose-smoke-admin', 'PANEL_READONLY_USERNAME=readonly', 'PANEL_READONLY_PASSWORD=compose-smoke-readonly',
        'WIIM_IP=192.0.2.10', 'UPS_SOURCE=nut', 'NUT_HOST=192.0.2.10', 'PPB_HOST=192.0.2.10',
        'NAS_MONITOR_API_KEY=compose-smoke-nas-monitor-api-key-123456789'
    ].join('\n') + '\n', { mode: 0o600 });
    // The production image runs as UID 1000. Give that identity ownership of
    // the disposable bind mount so this works on Linux runners as well as Docker Desktop.
    await run('docker', ['run', '--rm', '--user', '0', '-v', `${config}:/config`, 'unifi-smarthub:latest', 'chown', '-R', '1000:1000', '/config']);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await compose('up', '-d', '--no-build', 'unifi-smarthub');
        await waitFor(`${baseUrl}/health/ready`, response => response.status === 200);
        await waitFor(`${baseUrl}/health/live`, response => response.status === 200);
        const inspect = await waitForContainerHealth(`${project}-unifi-smarthub-1`);
        if (!inspect.Config.User || /^(?:0|root)(?::0)?$/u.test(inspect.Config.User)) throw new Error('container must not run as root');
        const readonly = await fetch(`${baseUrl}/api/network/devices/telemetry`, { headers: { authorization: `Basic ${Buffer.from('readonly:compose-smoke-readonly').toString('base64')}` } });
        if (readonly.status !== 200) throw new Error('readonly telemetry request failed');
        const headers = await adminHeaders(baseUrl);
        const setting = await fetch(`${baseUrl}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ deviceActiveFrontendPollSec: 9 }) });
        if (!setting.ok) throw new Error('settings persistence write failed');
        const connection = await fetch(`${baseUrl}/api/connections`, { method: 'POST', headers, body: JSON.stringify({ WIIM_IP: '192.0.2.11' }) });
        if (!connection.ok) throw new Error('config bind mount write failed');
        await run('docker', ['exec', `${project}-unifi-smarthub-1`, 'node', '-e', "const db=require('./db').createHistoryDb('/app/data');db.insertPoint('compose-smoke',{t:new Date().toISOString(),value:1});db.close();"]);
        await compose('restart', 'unifi-smarthub');
        await waitFor(`${baseUrl}/health/ready`, response => response.status === 200);
        const settings = await (await fetch(`${baseUrl}/api/settings`, { headers: { authorization: headers.authorization } })).json();
        if (settings.deviceActiveFrontendPollSec !== 9) throw new Error('setting did not survive restart');
        const historyResult = await run('docker', ['exec', `${project}-unifi-smarthub-1`, 'node', '-e', "const db=require('./db').createHistoryDb('/app/data');console.log(db.getSince('compose-smoke',0).length);db.close();"]);
        const history = historyResult.stdout.trim();
        if (history !== '1') throw new Error('SQLite volume did not survive restart');
        const logs = (await compose('logs', '--no-color')).stdout;
        if (/compose-smoke-admin|compose-smoke-readonly|UNIFI_DEVICE_SSH_HOST_KEYS|PRIVATE KEY/u.test(logs)) throw new Error('container logs exposed a smoke secret');
        await compose('--profile', 'nas-monitor', 'config', '--quiet');
        await compose('--profile', 'nas-monitor', 'up', '-d', '--no-build', 'nas-monitor');
        const monitor = JSON.parse((await run('docker', ['inspect', `${project}-nas-monitor-1`])).stdout)[0];
        if (monitor.State.Status !== 'running') throw new Error(`nas-monitor profile did not start: ${monitor.State.Status}`);
        console.log('Compose runtime smoke PASS health=healthy nonroot=true bind_mount=true sqlite_restart=true readonly=200 nas_monitor=running');
    } finally {
        if (root && project) { try { await compose('down', '-v', '--remove-orphans'); } catch { } }
        if (root) await fs.rm(root, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(`Compose runtime smoke FAIL: ${error.message}`); process.exitCode = 1; });

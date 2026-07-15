'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    buildConfig,
    createNasMonitor,
    validateApiKey
} = require('../nas-monitor/server');
const {
    createBuildIdentity,
    createRuntimeBuildIdentity
} = require('../nas-monitor/build-identity');

const API_KEY = '0123456789abcdef0123456789ABCDEF!@#$';
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const VALID_BUILD_ENV = Object.freeze({
    BUILD_VERSION: '3.0.0-rc.1+prod',
    BUILD_REVISION: 'abcdef0123456789abcdef0123456789abcdef01',
    BUILD_CREATED: '2026-07-15T00:00:00.000Z',
    BUILD_DIRTY: 'false'
});

function listen(server, ...args) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(...args, () => {
            server.off('error', reject);
            resolve(server.address());
        });
    });
}

function closeServer(server) {
    return new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
}

function sendJson(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
    });
    res.end(payload);
}

async function createFixture(t, dockerHandler, monitorConfig = {}, monitorEnv = {}) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-monitor-test-'));
    const socketPath = path.join(temporaryDirectory, 'docker.sock');
    const dockerSockets = new Set();
    const docker = http.createServer(dockerHandler);
    docker.on('connection', socket => {
        dockerSockets.add(socket);
        socket.on('close', () => dockerSockets.delete(socket));
    });
    await listen(docker, socketPath);

    const monitor = createNasMonitor({
        env: monitorEnv,
        logger: { error() {} },
        config: {
            apiKey: API_KEY,
            socketPath,
            port: 0,
            actionStopSeconds: 0,
            logsEnabled: true,
            logIds: new Set([ID_A, ID_B]),
            timeouts: {
                health: 100,
                list: 150,
                inspect: 100,
                stats: 100,
                logs: 150,
                action: 150
            },
            ...monitorConfig
        }
    });
    const address = await monitor.listen({ port: 0, host: '127.0.0.1' });

    t.after(async () => {
        await monitor.close({ graceMs: 100 }).catch(() => {});
        for (const socket of dockerSockets) socket.destroy();
        await closeServer(docker);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });
    return { monitor, docker, dockerSockets, port: address.port };
}

function monitorRequest(port, requestPath, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    const body = options.body === undefined ? null : Buffer.from(String(options.body));
    if (body && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
        headers['Content-Length'] = body.length;
    }
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: requestPath,
            method,
            headers,
            agent: false
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch {}
                resolve({ status: response.statusCode, headers: response.headers, text, json });
            });
        });
        request.setTimeout(options.clientTimeout || 2000, () => request.destroy(new Error('client timeout')));
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

function authenticated(headers = {}) {
    return { 'X-Api-Key': API_KEY, ...headers };
}

function idFor(number) {
    return number.toString(16).padStart(64, '0');
}

test('configuration rejects absent, weak, and unsafe mutation credentials', () => {
    assert.throws(() => validateApiKey(''), /invalid NAS monitor API key/);
    assert.throws(() => validateApiKey('smarthub-local-monitor'), /invalid NAS monitor API key/);
    assert.throws(() => validateApiKey('x'.repeat(64)), /invalid NAS monitor API key/);
    assert.equal(validateApiKey(API_KEY), API_KEY);

    assert.throws(() => buildConfig({}, { apiKey: API_KEY, mutationsEnabled: true }), /require an action allowlist/);
    assert.throws(() => buildConfig({}, {
        apiKey: API_KEY,
        mutationsEnabled: true,
        actionIds: new Set(['not-a-canonical-id'])
    }), /invalid NAS monitor action ID allowlist/);
    assert.throws(() => buildConfig({}, {
        apiKey: API_KEY,
        mutationsEnabled: true,
        actionLabels: [{ key: 'bad key', value: 'yes' }]
    }), /invalid NAS monitor action label allowlist/);
    assert.throws(() => buildConfig({}, { apiKey: API_KEY, socketPath: 'tcp://docker' }), /invalid Docker socket path/);
});

test('release identity is strict, sanitized, and available to health and startup logs', async t => {
    const strictEnvironment = { ...VALID_BUILD_ENV, BUILD_IDENTITY_REQUIRED: 'true' };
    assert.equal(createRuntimeBuildIdentity(strictEnvironment).status, 'clean');
    assert.equal(createRuntimeBuildIdentity({
        BUILD_VERSION: '', BUILD_REVISION: '', BUILD_CREATED: '', BUILD_DIRTY: '',
        BUILD_IDENTITY_REQUIRED: 'false'
    }).status, 'incomplete');
    assert.throws(
        () => createRuntimeBuildIdentity({ ...strictEnvironment, BUILD_DIRTY: 'true' }),
        error => error.code === 'BUILD_IDENTITY_DIRTY'
    );
    assert.throws(
        () => createRuntimeBuildIdentity({ ...strictEnvironment, BUILD_REVISION: 'short' }),
        error => error.code === 'BUILD_IDENTITY_INVALID'
    );
    assert.throws(
        () => createRuntimeBuildIdentity({ ...strictEnvironment, BUILD_IDENTITY_REQUIRED: '' }),
        error => error.code === 'BUILD_IDENTITY_POLICY_INVALID'
    );

    const marker = 'do-not-log-this-build-value';
    const sanitized = createBuildIdentity({ ...VALID_BUILD_ENV, BUILD_REVISION: marker });
    assert.equal(sanitized.revision, 'unknown');
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));

    const { port, monitor } = await createFixture(t, (req, res) => {
        if (req.url === '/version') return sendJson(res, 200, { Version: 'test' });
        return sendJson(res, 404, {});
    }, {}, strictEnvironment);
    const health = await monitorRequest(port, '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json.build, createBuildIdentity(VALID_BUILD_ENV));
    const startup = JSON.parse(monitor.startupLog(port));
    assert.equal(startup.event, 'nas_monitor_started');
    assert.deepEqual(startup.build, health.json.build);
});

test('authentication, routes, queries, bodies, and IDs are exact', async t => {
    let dockerCalls = 0;
    const { port } = await createFixture(t, (req, res) => {
        dockerCalls += 1;
        if (req.url === '/version') return sendJson(res, 200, { Version: 'test' });
        if (/\/containers\/[a-f0-9]{64}\/json$/.test(req.url)) {
            return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} } });
        }
        if (req.url.includes('/logs?')) return res.end('plain log');
        return sendJson(res, 404, { message: 'daemon detail must stay private' });
    });

    assert.equal((await monitorRequest(port, '/api/capabilities')).status, 401);
    assert.equal((await monitorRequest(port, '/api/capabilities', { headers: authenticated() })).status, 200);
    assert.equal((await monitorRequest(port, '/api/capabilities', { headers: { Authorization: `Bearer ${API_KEY}` } })).status, 200);
    assert.equal((await monitorRequest(port, '/api/capabilities', {
        headers: { Authorization: `Bearer ${API_KEY}`, 'X-Api-Key': API_KEY }
    })).status, 401);
    assert.equal((await monitorRequest(port, '/api/capabilities', { headers: { Authorization: `bearer  ${API_KEY}` } })).status, 401);
    assert.equal((await monitorRequest(port, '/api/capabilities?', { headers: authenticated() })).status, 400);
    assert.equal((await monitorRequest(port, '/api/capabilities?extra=1', { headers: authenticated() })).status, 400);
    assert.equal((await monitorRequest(port, '/api/capabilities', { method: 'HEAD', headers: authenticated() })).status, 404);
    assert.equal((await monitorRequest(port, `http://attacker.invalid/api/capabilities`, { headers: authenticated() })).status, 400);

    assert.equal((await monitorRequest(port, `/api/docker/containers/short/logs`, { headers: authenticated() })).status, 400);
    assert.equal((await monitorRequest(port, `/api/docker/containers/${ID_A}/logs?lines=020`, { headers: authenticated() })).status, 400);
    assert.equal((await monitorRequest(port, `/api/docker/containers/${ID_A}/logs?lines=20&lines=21`, { headers: authenticated() })).status, 400);
    assert.equal((await monitorRequest(port, `/api/docker/containers/${ID_A}/logs?lines=1001`, { headers: authenticated() })).status, 400);
    const logResult = await monitorRequest(port, `/api/docker/containers/${ID_A}/logs?lines=20`, { headers: authenticated() });
    assert.equal(logResult.status, 200);
    assert.equal(logResult.json.logs, 'plain log');

    const bodyResult = await monitorRequest(port, `/api/docker/containers/${ID_A}/restart`, {
        method: 'POST',
        headers: authenticated(),
        body: '{}'
    });
    assert.equal(bodyResult.status, 400);
    assert.equal(bodyResult.headers.connection, 'close');
    assert.equal(dockerCalls, 2, 'invalid requests must not reach the Docker socket');
});

test('Docker timeouts are bounded and health does not expose internals', async t => {
    const { port } = await createFixture(t, (req, res) => {
        if (/\/containers\/[a-f0-9]{64}\/json$/.test(req.url)) {
            return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} } });
        }
        // Health and the authorized log request intentionally never finish.
    }, {
        timeouts: { health: 35, logs: 35 }
    });
    const startedAt = Date.now();
    const health = await monitorRequest(port, '/health');
    assert.equal(health.status, 503);
    assert.deepEqual(health.json, {
        status: 'unhealthy',
        docker: false,
        build: {
            version: 'unknown', revision: 'unknown', created: 'unknown', dirty: null,
            status: 'incomplete', complete: false
        }
    });
    assert.ok(Date.now() - startedAt < 500);

    const logs = await monitorRequest(port, `/api/docker/containers/${ID_A}/logs`, { headers: authenticated() });
    assert.equal(logs.status, 504);
    assert.deepEqual(logs.json, { error: 'docker_timeout' });
});

test('chunked Docker responses are aborted at the endpoint byte cap', async t => {
    let closedByBroker = false;
    const { port } = await createFixture(t, (req, res) => {
        req.on('close', () => { closedByBroker = true; });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const timer = setInterval(() => res.write('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), 2);
        timer.unref?.();
        res.on('close', () => clearInterval(timer));
    }, {
        responseCaps: { list: 128 }
    });

    const result = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(result.status, 502);
    assert.deepEqual(result.json, { error: 'docker_response_too_large' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closedByBroker, true);
});

test('Docker daemon error bodies never cross the broker boundary', async t => {
    const daemonSecret = 'socket stack trace: root-token=do-not-leak';
    const { port } = await createFixture(t, (_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(daemonSecret);
    });

    const result = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(result.status, 502);
    assert.deepEqual(result.json, { error: 'docker_unavailable' });
    assert.equal(result.text.includes(daemonSecret), false);
});

test('container list fails closed when the configured maximum is exceeded', async t => {
    const rows = [1, 2, 3].map(number => ({ Id: idFor(number), State: 'exited' }));
    const { port } = await createFixture(t, (_req, res) => sendJson(res, 200, rows), { maxContainers: 2 });
    const result = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(result.status, 503);
    assert.deepEqual(result.json, { error: 'container_limit_exceeded' });
});

test('aggregate inventory output is truncated below the client byte budget', async t => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
        Id: idFor(index + 1), Names: [`/wide-${index}`], Image: 'x'.repeat(512), State: 'exited', Status: 'Exited'
    }));
    const mounts = Array.from({ length: 32 }, (_, index) => ({
        Type: 'bind', Destination: `/${String(index).padStart(3, '0')}-${'m'.repeat(300)}`, RW: true
    }));
    const { port } = await createFixture(t, (req, res) => {
        if (req.url === '/containers/json?all=1') return sendJson(res, 200, rows);
        const id = req.url.split('/')[2];
        return sendJson(res, 200, { Id: id, Config: { Labels: {} }, State: {}, NetworkSettings: {}, Mounts: mounts });
    }, { maxListResponseBytes: 64 * 1024 });

    const result = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(result.status, 200);
    assert.equal(result.json.total, rows.length);
    assert.equal(result.json.truncated, true);
    assert.ok(result.json.containers.length > 0 && result.json.containers.length < rows.length);
    assert.ok(Buffer.byteLength(result.text) <= 64 * 1024);
    assert.ok(result.json.containers.every(container => container.mounts.length === 32
        && container.mounts.every(mount => mount.destination.length <= 256)));
});

test('concurrent container lists coalesce, cache, and respect worker/global limits', async t => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
        Id: idFor(index + 1),
        Names: [`/container-${index + 1}`],
        Image: 'test-image',
        State: 'running',
        Status: 'Up'
    }));
    let listCalls = 0;
    let detailActive = 0;
    let maximumDetailActive = 0;
    const { port } = await createFixture(t, (req, res) => {
        if (req.url === '/containers/json?all=1') {
            listCalls += 1;
            return sendJson(res, 200, rows);
        }
        detailActive += 1;
        maximumDetailActive = Math.max(maximumDetailActive, detailActive);
        setTimeout(() => {
            detailActive -= 1;
            if (/\/json$/.test(req.url)) {
                const id = req.url.split('/')[2];
                return sendJson(res, 200, { Id: id, Config: { Labels: {} }, State: {}, NetworkSettings: {} });
            }
            return sendJson(res, 200, {
                cpu_stats: {},
                precpu_stats: {},
                memory_stats: {},
                networks: {},
                blkio_stats: {},
                pids_stats: {}
            });
        }, 15);
    }, {
        maxDockerConcurrency: 2,
        listWorkerConcurrency: 2,
        listCacheMs: 5000
    });

    const results = await Promise.all(Array.from({ length: 8 }, () =>
        monitorRequest(port, '/api/docker/containers', { headers: authenticated() })));
    assert.ok(results.every(result => result.status === 200));
    assert.ok(results.every(result => result.json.containers.length === rows.length));
    assert.ok(results.every(result => result.json.containers.every(container =>
        Array.isArray(container.allowed_actions) && container.allowed_actions.length === 0)));
    assert.equal(listCalls, 1);
    assert.ok(maximumDetailActive <= 2, `observed ${maximumDetailActive} concurrent detail requests`);

    const cached = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(cached.status, 200);
    assert.equal(listCalls, 1);
});

test('Docker request queue is bounded instead of growing without limit', async t => {
    let firstResponse;
    let sawFirst;
    const firstSeen = new Promise(resolve => { sawFirst = resolve; });
    const { port } = await createFixture(t, (req, res) => {
        if (/\/containers\/[a-f0-9]{64}\/json$/.test(req.url)) {
            const id = req.url.split('/')[2];
            return sendJson(res, 200, { Id: id, Config: { Labels: {} } });
        }
        firstResponse = res;
        sawFirst();
    }, {
        maxDockerConcurrency: 1,
        maxDockerQueue: 0,
        timeouts: { logs: 500 }
    });

    const first = monitorRequest(port, `/api/docker/containers/${ID_A}/logs`, { headers: authenticated() });
    await firstSeen;
    const overflow = await monitorRequest(port, `/api/docker/containers/${ID_B}/logs`, { headers: authenticated() });
    assert.equal(overflow.status, 503);
    assert.deepEqual(overflow.json, { error: 'docker_busy' });
    firstResponse.end('first finished');
    assert.equal((await first).status, 200);
});

test('mutations are disabled by default and never inspect the target', async t => {
    let dockerCalls = 0;
    const { port } = await createFixture(t, (_req, res) => {
        dockerCalls += 1;
        sendJson(res, 200, {});
    });
    const result = await monitorRequest(port, `/api/docker/containers/${ID_A}/restart`, {
        method: 'POST',
        headers: authenticated()
    });
    assert.equal(result.status, 403);
    assert.deepEqual(result.json, { error: 'mutations_disabled' });
    assert.equal(dockerCalls, 0);
});

test('container logs are disabled by default and require a separate allowlist', async t => {
    let dockerCalls = 0;
    const disabled = await createFixture(t, (_req, res) => {
        dockerCalls += 1;
        res.end('must not be reached');
    }, { logsEnabled: false, logIds: new Set() });
    const denied = await monitorRequest(disabled.port, `/api/docker/containers/${ID_A}/logs`, { headers: authenticated() });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.json, { error: 'logs_disabled' });
    assert.equal(dockerCalls, 0);

    const allowed = await createFixture(t, (req, res) => {
        if (/\/json$/.test(req.url)) {
            const id = req.url.split('/')[2];
            const labels = id === ID_B ? { 'com.unifi.smarthub.nas-monitor.protected': 'true' } : {};
            return sendJson(res, 200, { Id: id, Config: { Labels: labels } });
        }
        res.end('quote " newline\n nul\u0000 </script>');
    });
    const visible = await monitorRequest(allowed.port, `/api/docker/containers/${ID_A}/logs`, { headers: authenticated() });
    assert.equal(visible.status, 200);
    assert.equal(visible.json.logs, 'quote " newline\n nul\u0000 </script>');
    const protectedResult = await monitorRequest(allowed.port, `/api/docker/containers/${ID_B}/logs`, { headers: authenticated() });
    assert.equal(protectedResult.status, 403);
    assert.deepEqual(protectedResult.json, { error: 'logs_not_allowed' });
});

test('inventory publishes per-container actions from the same fail-closed policy', async t => {
    const rows = [
        { Id: ID_A, Names: ['/managed'], State: 'running' },
        { Id: ID_B, Names: ['/broker'], State: 'running' }
    ];
    const { port } = await createFixture(t, (req, res) => {
        if (req.url === '/containers/json?all=1') return sendJson(res, 200, rows);
        const id = req.url.split('/')[2];
        const labels = id === ID_B ? { 'com.docker.compose.service': 'nas-monitor' } : {};
        return sendJson(res, 200, { Id: id, Config: { Labels: labels }, State: {}, NetworkSettings: {} });
    }, {
        mutationsEnabled: true,
        actionIds: new Set([ID_A, ID_B])
    });

    const result = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(result.status, 200);
    const managed = result.json.containers.find(container => container.id === ID_A);
    const broker = result.json.containers.find(container => container.id === ID_B);
    assert.deepEqual(managed.allowed_actions, ['start', 'stop', 'restart']);
    assert.deepEqual(broker.allowed_actions, []);
});

test('canonical ID allowlists permit actions but protected broker containers always win', async t => {
    let actionCalls = 0;
    const { port } = await createFixture(t, (req, res) => {
        if (/\/json$/.test(req.url)) {
            const id = req.url.split('/')[2];
            const labels = id === ID_B ? { 'com.docker.compose.service': 'nas-monitor' } : {};
            return sendJson(res, 200, { Id: id, Config: { Labels: labels } });
        }
        actionCalls += 1;
        res.writeHead(204);
        res.end();
    }, {
        mutationsEnabled: true,
        actionIds: new Set([ID_A, ID_B])
    });

    const allowed = await monitorRequest(port, `/api/docker/containers/${ID_A}/restart`, {
        method: 'POST', headers: authenticated()
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.json, { ok: true, id: ID_A, action: 'restart', ambiguous: false });

    const protectedResult = await monitorRequest(port, `/api/docker/containers/${ID_B}/stop`, {
        method: 'POST', headers: authenticated()
    });
    assert.equal(protectedResult.status, 403);
    assert.deepEqual(protectedResult.json, { error: 'action_not_allowed' });
    assert.equal(actionCalls, 1);
});

test('label allowlists permit only exact label values', async t => {
    let actionCalls = 0;
    const { port } = await createFixture(t, (req, res) => {
        if (/\/json$/.test(req.url)) {
            const id = req.url.split('/')[2];
            return sendJson(res, 200, {
                Id: id,
                Config: { Labels: { 'com.example.smarthub.manage': id === ID_A ? 'true' : 'TRUE' } }
            });
        }
        actionCalls += 1;
        res.writeHead(204);
        res.end();
    }, {
        mutationsEnabled: true,
        actionLabels: [{ key: 'com.example.smarthub.manage', value: 'true' }]
    });

    assert.equal((await monitorRequest(port, `/api/docker/containers/${ID_A}/start`, {
        method: 'POST', headers: authenticated()
    })).status, 200);
    assert.equal((await monitorRequest(port, `/api/docker/containers/${ID_B}/start`, {
        method: 'POST', headers: authenticated()
    })).status, 403);
    assert.equal(actionCalls, 1);
});

test('action timeout is reported once as an ambiguous result and is never retried', async t => {
    let actionCalls = 0;
    const { port } = await createFixture(t, (req, res) => {
        if (/\/json$/.test(req.url)) return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} } });
        actionCalls += 1;
        // Intentionally never respond: the daemon may have accepted the mutation.
    }, {
        mutationsEnabled: true,
        actionIds: new Set([ID_A]),
        timeouts: { inspect: 40, action: 40 }
    });

    const result = await monitorRequest(port, `/api/docker/containers/${ID_A}/restart`, {
        method: 'POST', headers: authenticated()
    });
    assert.equal(result.status, 504);
    assert.deepEqual(result.json, { error: 'action_result_unknown', action: 'restart', ambiguous: true });
    assert.equal(actionCalls, 1);
});

test('a slow valid stop receives an explicit grace and completes before the broker deadline', async t => {
    let actionPath;
    const { port } = await createFixture(t, (req, res) => {
        if (/\/json$/.test(req.url)) return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} } });
        actionPath = req.url;
        setTimeout(() => { res.writeHead(204); res.end(); }, 50);
    }, {
        mutationsEnabled: true,
        actionIds: new Set([ID_A]),
        actionStopSeconds: 1,
        timeouts: { inspect: 100, action: 1500 }
    });
    const result = await monitorRequest(port, `/api/docker/containers/${ID_A}/stop`, {
        method: 'POST', headers: authenticated()
    });
    assert.equal(result.status, 200);
    assert.equal(actionPath, `/containers/${ID_A}/stop?t=1`);
});

test('an ambiguous action invalidates cached inventory before reconciliation', async t => {
    let listCalls = 0;
    const { port } = await createFixture(t, (req, res) => {
        if (req.url === '/containers/json?all=1') {
            listCalls += 1;
            return sendJson(res, 200, [{ Id: ID_A, Names: ['/target'], State: 'exited', Status: `snapshot-${listCalls}` }]);
        }
        if (/\/json$/.test(req.url)) return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} }, State: {}, NetworkSettings: {} });
        if (req.method === 'POST') return; // accepted by daemon; response outcome is unknown
        return sendJson(res, 404, {});
    }, {
        mutationsEnabled: true,
        actionIds: new Set([ID_A]),
        listCacheMs: 5000,
        timeouts: { inspect: 40, action: 40 }
    });
    assert.equal((await monitorRequest(port, '/api/docker/containers', { headers: authenticated() })).status, 200);
    assert.equal(listCalls, 1);
    const action = await monitorRequest(port, `/api/docker/containers/${ID_A}/restart`, { method: 'POST', headers: authenticated() });
    assert.equal(action.status, 504);
    const refreshed = await monitorRequest(port, '/api/docker/containers', { headers: authenticated() });
    assert.equal(refreshed.status, 200);
    assert.equal(listCalls, 2);
    assert.equal(refreshed.json.containers[0].status, 'snapshot-2');
});

test('graceful close drains a finite in-flight Docker request', async t => {
    let sawRequest;
    const requestSeen = new Promise(resolve => { sawRequest = resolve; });
    const fixture = await createFixture(t, (req, res) => {
        if (/\/containers\/[a-f0-9]{64}\/json$/.test(req.url)) {
            return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} } });
        }
        sawRequest();
        setTimeout(() => res.end('finished'), 35);
    }, { timeouts: { logs: 200 } });

    const responsePromise = monitorRequest(fixture.port, `/api/docker/containers/${ID_A}/logs`, { headers: authenticated() });
    await requestSeen;
    const closePromise = fixture.monitor.close({ graceMs: 300 });
    const response = await responsePromise;
    const closed = await closePromise;
    assert.equal(response.status, 200);
    assert.equal(response.json.logs, 'finished');
    assert.deepEqual(closed, { forced: false });
});

test('graceful close force-aborts a stuck Docker request at its deadline', async t => {
    let sawRequest;
    const requestSeen = new Promise(resolve => { sawRequest = resolve; });
    let dockerRequestClosed = false;
    const fixture = await createFixture(t, (req, res) => {
        if (/\/containers\/[a-f0-9]{64}\/json$/.test(req.url)) {
            return sendJson(res, 200, { Id: ID_A, Config: { Labels: {} } });
        }
        sawRequest();
        req.on('close', () => { dockerRequestClosed = true; });
    }, { timeouts: { logs: 1000 }, shutdownGraceMs: 100 });

    const responsePromise = monitorRequest(fixture.port, `/api/docker/containers/${ID_A}/logs`, {
        headers: authenticated(),
        clientTimeout: 1000
    }).then(() => null, error => error);
    await requestSeen;
    const startedAt = Date.now();
    const closed = await fixture.monitor.close({ graceMs: 80 });
    assert.deepEqual(closed, { forced: true });
    assert.ok(Date.now() - startedAt < 500);
    assert.ok(await responsePromise instanceof Error);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dockerRequestClosed, true);
});

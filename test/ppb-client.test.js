'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const axios = require('axios');
const {
    PPB_CLIENT_CLOSED_CODE,
    PPB_REQUEST_SUPERSEDED_CODE,
    createPpbClient
} = require('../server/integrations/ppb-client');

function fakeAxios(sequence = []) {
    const calls = [];
    return {
        calls,
        async get(url, options) {
            calls.push({ method: 'get', url, options });
            const next = sequence.shift();
            if (next instanceof Error) throw next;
            return next || { status: 200, data: {}, headers: {} };
        },
        async post(url, body, options) {
            calls.push({ method: 'post', url, body, options });
            const next = sequence.shift();
            if (next instanceof Error) throw next;
            return next || { status: 200, data: 'token', headers: {} };
        }
    };
}

class FakeAgent {
    static instances = [];
    constructor(options) {
        this.options = options;
        this.destroyCalls = 0;
        FakeAgent.instances.push(this);
    }
    destroy() { this.destroyCalls += 1; }
}

function baseConfig(overrides = {}) {
    return {
        host: 'ppb.test',
        httpPort: '3052',
        user: 'admin',
        password: 'test-only-password',
        tlsInsecure: false,
        caFile: '',
        ...overrides
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitUntil(predicate, description) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`timed out waiting for ${description}`);
}

function routedAxios({ get: getResponse, post: postResponse }) {
    const calls = [];
    return {
        calls,
        async get(url, options) {
            const call = { method: 'get', url, options };
            calls.push(call);
            return getResponse(call);
        },
        async post(url, body, options) {
            const call = { method: 'post', url, body, options };
            calls.push(call);
            return postResponse(call);
        }
    };
}

function discovery(host, port) {
    return { status: 302, data: null, headers: { location: `https://${host}:${port}/local/` } };
}

function isSuperseded(error) {
    return error?.code === PPB_REQUEST_SUPERSEDED_CODE;
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function closeServer(server) {
    return new Promise(resolve => server.close(resolve));
}

test('PPB TLS is secure by default, reuses an agent, and rotates it on configuration changes', async () => {
    FakeAgent.instances.length = 0;
    let config = baseConfig();
    const axios = fakeAxios([
        { status: 302, data: null, headers: { location: 'https://ppb.test:8443/local/' } },
        { status: 200, data: 'token-value', headers: {} },
        { status: 200, data: { ok: true }, headers: {} },
        { status: 200, data: { ok: true }, headers: {} },
        { status: 302, data: null, headers: { location: 'https://ppb.test:8443/local/' } },
        { status: 200, data: 'token-value-2', headers: {} },
        { status: 200, data: { ok: true }, headers: {} }
    ]);
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => config
    });

    await client.get('/local/rest/v1/ups/status');
    await client.get('/local/rest/v1/eventlogs/report');
    assert.equal(FakeAgent.instances.length, 1);
    assert.equal(FakeAgent.instances[0].options.rejectUnauthorized, true);
    assert.equal(axios.calls[1].body.password, 'test-only-password');

    config = baseConfig({ tlsInsecure: true });
    client.reset();
    await client.get('/local/rest/v1/ups/status');
    assert.equal(FakeAgent.instances.length, 2);
    assert.equal(FakeAgent.instances[0].destroyCalls, 1);
    assert.equal(FakeAgent.instances[1].options.rejectUnauthorized, false);
    config = baseConfig({ tlsInsecure: true, password: 'rotated-password' });
    client.reset();
    assert.equal(FakeAgent.instances.length, 3);
    assert.equal(FakeAgent.instances[1].destroyCalls, 1);
    assert.equal(FakeAgent.instances[2].options.rejectUnauthorized, false);
    client.close();
    client.close();
    assert.equal(FakeAgent.instances[2].destroyCalls, 1);
});

test('PPB custom CA must be an absolute regular non-symlink file and read failures fail closed', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-ppb-ca-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const caFile = path.join(tempDir, 'ca.pem');
    fs.writeFileSync(caFile, 'test-ca-data', { mode: 0o600 });
    const linkFile = path.join(tempDir, 'ca-link.pem');
    fs.symlinkSync(caFile, linkFile);

    for (const candidate of ['relative.pem', path.join(tempDir, 'missing.pem'), linkFile]) {
        assert.throws(() => createPpbClient({
            axios: fakeAxios(),
            httpsModule: { Agent: FakeAgent },
            getConfig: () => baseConfig({ caFile: candidate })
        }), /CA|absolute|regular|symlink|read/i);
    }

    const axios = fakeAxios([
        { status: 302, data: null, headers: { location: 'https://ppb.test:8443/local/' } },
        { status: 200, data: 'token', headers: {} },
        { status: 200, data: {}, headers: {} }
    ]);
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => baseConfig({ caFile })
    });
    await client.get('/local/rest/v1/ups/status');
    assert.equal(FakeAgent.instances.at(-1).options.ca.toString(), 'test-ca-data');
    assert.equal(FakeAgent.instances.at(-1).options.rejectUnauthorized, true);
});

test('PPB authorization retries once, warns once for explicit insecure mode, and never logs secrets', async () => {
    const events = [];
    const token = 'test-token-must-not-be-logged';
    const axios = fakeAxios([
        { status: 302, data: null, headers: { location: 'https://ppb.test:8443/local/' } },
        { status: 200, data: token, headers: {} },
        { status: 401, data: {}, headers: {} },
        { status: 200, data: token, headers: {} },
        { status: 200, data: { ok: true }, headers: {} },
        { status: 200, data: { ok: true }, headers: {} }
    ]);
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => baseConfig({ tlsInsecure: true, password: 'log-secret-password' }),
        logger: { warn: event => events.push(event) }
    });
    await client.get('/local/rest/v1/ups/status');
    await client.get('/local/rest/v1/eventlogs/report');
    assert.equal(axios.calls.filter(call => call.method === 'get' && /ups\/status$/u.test(call.url)).length, 2);
    assert.equal(events.length, 1);
    assert.match(events[0].message, /certificate verification is disabled/u);
    assert.doesNotMatch(JSON.stringify(events), /log-secret-password|test-token-must-not-be-logged/u);
});

test('late discovery cannot commit an old port after a configuration reset', async () => {
    FakeAgent.instances.length = 0;
    let config = baseConfig({ host: 'ppb-a.test' });
    const oldDiscovery = deferred();
    const axios = routedAxios({
        get: call => {
            if (call.url === 'http://ppb-a.test:3052/local/') return oldDiscovery.promise;
            if (call.url === 'http://ppb-b.test:3052/local/') return discovery('ppb-b.test', 9444);
            if (call.url.startsWith('https://ppb-b.test:9444/')) return { status: 200, data: { host: 'b' }, headers: {} };
            throw new Error(`unexpected GET ${call.url}`);
        },
        post: call => {
            assert.match(call.url, /^https:\/\/ppb-b\.test:9444\//u);
            return { status: 200, data: 'token-b', headers: {} };
        }
    });
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => config
    });

    const oldRequest = client.get('/local/rest/v1/ups/status');
    await waitUntil(() => axios.calls.some(call => call.url === 'http://ppb-a.test:3052/local/'), 'old discovery');
    config = baseConfig({ host: 'ppb-b.test' });
    client.reset();
    assert.deepEqual(await client.get('/local/rest/v1/ups/status'), { host: 'b' });

    oldDiscovery.resolve(discovery('ppb-a.test', 8443));
    await assert.rejects(oldRequest, isSuperseded);
    const newHostCalls = axios.calls.filter(call => call.url.startsWith('https://ppb-b.test:'));
    assert.ok(newHostCalls.length > 0);
    assert.ok(newHostCalls.every(call => call.url.startsWith('https://ppb-b.test:9444/')));
    client.close();
});

test('late login cannot activate an old token or authorize a new host', async () => {
    FakeAgent.instances.length = 0;
    let config = baseConfig({ host: 'ppb-a.test' });
    const oldLogin = deferred();
    const axios = routedAxios({
        get: call => {
            if (call.url === 'http://ppb-a.test:3052/local/') return discovery('ppb-a.test', 8443);
            if (call.url === 'http://ppb-b.test:3052/local/') return discovery('ppb-b.test', 9444);
            if (call.url.startsWith('https://ppb-b.test:9444/')) return { status: 200, data: { host: 'b' }, headers: {} };
            throw new Error(`unexpected GET ${call.url}`);
        },
        post: call => {
            if (call.url.startsWith('https://ppb-a.test:8443/')) return oldLogin.promise;
            if (call.url.startsWith('https://ppb-b.test:9444/')) return { status: 200, data: 'token-b', headers: {} };
            throw new Error(`unexpected POST ${call.url}`);
        }
    });
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => config
    });

    const oldRequest = client.get('/local/rest/v1/ups/status');
    await waitUntil(() => axios.calls.some(call => call.method === 'post' && call.url.startsWith('https://ppb-a.test:8443/')), 'old login');
    config = baseConfig({ host: 'ppb-b.test' });
    client.reset();
    await client.get('/local/rest/v1/ups/status');

    oldLogin.resolve({ status: 200, data: 'token-a', headers: {} });
    await assert.rejects(oldRequest, isSuperseded);
    await client.get('/local/rest/v1/eventlogs/report');
    const newHostRequests = axios.calls.filter(call => call.method === 'get' && call.url.startsWith('https://ppb-b.test:9444/'));
    assert.ok(newHostRequests.every(call => call.options.headers.Authorization === 'token-b'));
    assert.equal(axios.calls.filter(call => call.method === 'post' && call.url.startsWith('https://ppb-b.test:9444/')).length, 1);
    client.close();
});

test('a superseded 401 cannot clear the new token or trigger an old-generation retry', async () => {
    FakeAgent.instances.length = 0;
    let config = baseConfig({ host: 'ppb-a.test' });
    const oldStatus = deferred();
    const axios = routedAxios({
        get: call => {
            if (call.url === 'http://ppb-a.test:3052/local/') return discovery('ppb-a.test', 8443);
            if (call.url === 'http://ppb-b.test:3052/local/') return discovery('ppb-b.test', 9444);
            if (call.url.startsWith('https://ppb-a.test:8443/')) return oldStatus.promise;
            if (call.url.startsWith('https://ppb-b.test:9444/')) return { status: 200, data: { host: 'b' }, headers: {} };
            throw new Error(`unexpected GET ${call.url}`);
        },
        post: call => {
            if (call.url.startsWith('https://ppb-a.test:8443/')) return { status: 200, data: 'token-a', headers: {} };
            if (call.url.startsWith('https://ppb-b.test:9444/')) return { status: 200, data: 'token-b', headers: {} };
            throw new Error(`unexpected POST ${call.url}`);
        }
    });
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => config
    });

    const oldRequest = client.get('/local/rest/v1/ups/status');
    await waitUntil(() => axios.calls.some(call => call.method === 'get' && call.url.startsWith('https://ppb-a.test:8443/')), 'old status request');
    config = baseConfig({ host: 'ppb-b.test' });
    client.reset();
    await client.get('/local/rest/v1/ups/status');

    oldStatus.resolve({ status: 401, data: {}, headers: {} });
    await assert.rejects(oldRequest, isSuperseded);
    assert.equal(axios.calls.filter(call => call.method === 'post' && call.url.startsWith('https://ppb-a.test:8443/')).length, 1);
    assert.equal(axios.calls.filter(call => call.method === 'get' && call.url.startsWith('https://ppb-a.test:8443/')).length, 1);
    await client.get('/local/rest/v1/eventlogs/report');
    assert.equal(axios.calls.filter(call => call.method === 'post' && call.url.startsWith('https://ppb-b.test:9444/')).length, 1);
    assert.ok(axios.calls
        .filter(call => call.method === 'get' && call.url.startsWith('https://ppb-b.test:9444/'))
        .every(call => call.options.headers.Authorization === 'token-b'));
    client.close();
});

test('login is singleflight within one lease', async () => {
    FakeAgent.instances.length = 0;
    const loginFlight = deferred();
    const axios = routedAxios({
        get: call => {
            if (call.url === 'http://ppb.test:3052/local/') return discovery('ppb.test', 8443);
            return { status: 200, data: { ok: true }, headers: {} };
        },
        post: () => loginFlight.promise
    });
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => baseConfig()
    });

    const first = client.get('/local/rest/v1/ups/status');
    const second = client.get('/local/rest/v1/eventlogs/report');
    await waitUntil(() => axios.calls.filter(call => call.method === 'post').length === 1, 'singleflight login');
    assert.equal(axios.calls.filter(call => call.method === 'post').length, 1);
    loginFlight.resolve({ status: 200, data: 'singleflight-token', headers: {} });
    await Promise.all([first, second]);
    assert.equal(axios.calls.filter(call => call.method === 'get' && call.url.startsWith('https://ppb.test:8443/')).length, 2);
    client.close();
});

test('agent lifecycle is fenced, close is idempotent, and reset after close fails closed', async () => {
    FakeAgent.instances.length = 0;
    let config = baseConfig({ host: 'ppb-a.test' });
    const oldDiscovery = deferred();
    const axios = routedAxios({
        get: call => call.url === 'http://ppb-a.test:3052/local/'
            ? oldDiscovery.promise
            : { status: 200, data: {}, headers: {} },
        post: () => ({ status: 200, data: 'token', headers: {} })
    });
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        getConfig: () => config
    });
    const oldRequest = client.get('/local/rest/v1/ups/status');
    await waitUntil(() => axios.calls.length === 1, 'old agent request');
    const oldAgent = FakeAgent.instances[0];
    config = baseConfig({ host: 'ppb-b.test' });
    client.reset();
    const newAgent = FakeAgent.instances[1];
    assert.equal(oldAgent.destroyCalls, 1);
    assert.equal(newAgent.destroyCalls, 0);
    oldDiscovery.resolve(discovery('ppb-a.test', 8443));
    await assert.rejects(oldRequest, isSuperseded);
    assert.equal(newAgent.destroyCalls, 0);

    client.close();
    client.close();
    assert.equal(oldAgent.destroyCalls, 1);
    assert.equal(newAgent.destroyCalls, 1);
    assert.equal(client.snapshot().state, 'closed');
    assert.throws(() => client.reset(), error => error?.code === PPB_CLIENT_CLOSED_CODE);
});

test('superseded errors, events, and snapshots never expose PPB secrets', async () => {
    FakeAgent.instances.length = 0;
    const events = [];
    const oldLogin = deferred();
    let config = baseConfig({
        host: 'ppb-a.test',
        password: 'ppb-password-secret',
        tlsInsecure: true
    });
    const axios = routedAxios({
        get: call => call.url === 'http://ppb-a.test:3052/local/'
            ? discovery('ppb-a.test', 8443)
            : { status: 200, data: {}, headers: {} },
        post: () => oldLogin.promise
    });
    const client = createPpbClient({
        axios,
        httpsModule: { Agent: FakeAgent },
        logger: { warn: event => events.push(event) },
        getConfig: () => config
    });
    const oldRequest = client.get('/local/rest/v1/ups/status');
    await waitUntil(() => axios.calls.some(call => call.method === 'post'), 'secret-bearing login request');
    config = baseConfig({ host: 'ppb-b.test', password: 'new-password-secret', tlsInsecure: true });
    client.reset();
    oldLogin.resolve({ status: 200, data: 'ppb-token-secret', headers: {} });
    const error = await oldRequest.catch(value => value);
    const rendered = JSON.stringify({ error, events, snapshot: client.snapshot() });
    assert.equal(error.code, PPB_REQUEST_SUPERSEDED_CODE);
    assert.doesNotMatch(rendered, /ppb-password-secret|new-password-secret|ppb-token-secret/u);
    client.close();
});

test('ambiguous legacy TLS disable cannot silently turn verification off', () => {
    assert.throws(() => createPpbClient({
        axios: fakeAxios(),
        httpsModule: { Agent: FakeAgent },
        getConfig: () => baseConfig({ tlsVerify: false, tlsInsecure: false })
    }), /PPB_TLS_INSECURE/u);
});

test('PPB real HTTPS rejects an untrusted certificate, accepts its custom CA, and allows only explicit insecure mode', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-ppb-https-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const keyFile = path.join(tempDir, 'server-key.pem');
    const certFile = path.join(tempDir, 'server-cert.pem');
    const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign'
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || 'openssl certificate generation failed');

    const secureServer = https.createServer({
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile)
    }, (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/local/rest/v1/login/verify' && request.method === 'POST') {
            response.end(JSON.stringify('local-test-token'));
            return;
        }
        if (request.url === '/local/rest/v1/ups/status' && request.headers.authorization === 'local-test-token') {
            response.end(JSON.stringify({ ok: true }));
            return;
        }
        response.statusCode = 401;
        response.end(JSON.stringify({ ok: false }));
    });
    const securePort = await listen(secureServer);
    const discoveryServer = http.createServer((_request, response) => {
        response.statusCode = 302;
        response.setHeader('location', `https://127.0.0.1:${securePort}/local/`);
        response.end();
    });
    const discoveryPort = await listen(discoveryServer);
    t.after(async () => {
        await Promise.all([closeServer(discoveryServer), closeServer(secureServer)]);
    });
    const common = { host: '127.0.0.1', httpPort: discoveryPort, user: 'local', password: 'fixture-only' };

    const secureDefault = createPpbClient({
        axios,
        getConfig: () => baseConfig(common)
    });
    await assert.rejects(
        secureDefault.get('/local/rest/v1/ups/status'),
        /self-signed|certificate|DEPTH_ZERO_SELF_SIGNED_CERT/u
    );
    secureDefault.close();

    const customCa = createPpbClient({
        axios,
        getConfig: () => baseConfig({ ...common, caFile: certFile })
    });
    assert.deepEqual(await customCa.get('/local/rest/v1/ups/status'), { ok: true });
    customCa.close();

    const explicitlyInsecure = createPpbClient({
        axios,
        getConfig: () => baseConfig({ ...common, tlsInsecure: true })
    });
    assert.deepEqual(await explicitlyInsecure.get('/local/rest/v1/ups/status'), { ok: true });
    explicitlyInsecure.close();
});

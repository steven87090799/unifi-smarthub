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
const { createPpbClient } = require('../server/integrations/ppb-client');

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

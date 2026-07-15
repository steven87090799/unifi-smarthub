'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const {
    AdGuardConfigurationError,
    createAdGuardConnection,
    normalizeBaseUrl
} = require('../server/integrations/adguard-client');

const PASSWORD = 'local-adguard-admin-password';

function fakeAxios() {
    const calls = { create: [], request: [] };
    const axios = {
        create(options) {
            calls.create.push(options);
            return {
                async request(request) {
                    calls.request.push(request);
                    return { data: { ok: true } };
                }
            };
        }
    };
    return { axios, calls };
}

test('unconfigured AdGuard remains optional and creates no credential transport', () => {
    const { axios, calls } = fakeAxios();
    assert.deepEqual(createAdGuardConnection({ env: {}, axios }), {
        url: null, client: null, configured: false, tlsVerified: false
    });
    assert.equal(calls.create.length, 0);
});

test('remote plaintext requires exact explicit opt-in while loopback remains testable', () => {
    assert.throws(() => normalizeBaseUrl('http://192.168.1.20:80'), AdGuardConfigurationError);
    assert.equal(normalizeBaseUrl('http://192.168.1.20:80', { allowInsecureHttp: true }), 'http://192.168.1.20');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    for (const flag of ['1', 'TRUE', 'yes', 1]) {
        assert.throws(() => createAdGuardConnection({
            env: {
                ADGUARD_URL: 'http://192.168.1.20',
                ADGUARD_ALLOW_INSECURE_HTTP: flag,
                ADGUARD_USER: 'admin',
                ADGUARD_PASSWORD: PASSWORD
            },
            axios: fakeAxios().axios
        }), AdGuardConfigurationError);
    }
});

test('URL and credential policy rejects ambiguous or unsafe configuration', () => {
    for (const url of [
        'ftp://adguard.internal',
        'https://user:password@adguard.internal',
        'https://adguard.internal/control',
        'https://adguard.internal?next=evil',
        'https://adguard.internal#fragment'
    ]) assert.throws(() => normalizeBaseUrl(url), AdGuardConfigurationError);
    for (const env of [
        { ADGUARD_URL: 'https://adguard.internal', ADGUARD_USER: '', ADGUARD_PASSWORD: PASSWORD },
        { ADGUARD_URL: 'https://adguard.internal', ADGUARD_USER: 'bad:user', ADGUARD_PASSWORD: PASSWORD },
        { ADGUARD_URL: 'https://adguard.internal', ADGUARD_USER: 'admin', ADGUARD_PASSWORD: 'change-me' },
        { ADGUARD_HOST: 'host/path', ADGUARD_USER: 'admin', ADGUARD_PASSWORD: PASSWORD },
        { ADGUARD_HOST: 'localhost', ADGUARD_PORT: '080', ADGUARD_USER: 'admin', ADGUARD_PASSWORD: PASSWORD }
    ]) assert.throws(() => createAdGuardConnection({ env, axios: fakeAxios().axios }), AdGuardConfigurationError);
});

test('HTTPS verifies by default, proxying is disabled, and only exact false opts out', () => {
    const first = fakeAxios();
    const verified = createAdGuardConnection({
        env: { ADGUARD_URL: 'https://adguard.internal:8443', ADGUARD_USER: 'admin', ADGUARD_PASSWORD: PASSWORD },
        axios: first.axios
    });
    assert.equal(verified.configured, true);
    assert.equal(verified.tlsVerified, true);
    assert.equal(first.calls.create[0].proxy, false);
    assert.equal(first.calls.create[0].httpsAgent.options.rejectUnauthorized, true);
    assert.deepEqual(first.calls.create[0].auth, { username: 'admin', password: PASSWORD });
    assert.equal(first.calls.create[0].timeout, 8_000);
    assert.equal(first.calls.create[0].maxRedirects, 0);

    const second = fakeAxios();
    const unverified = createAdGuardConnection({
        env: {
            ADGUARD_URL: 'https://adguard.internal',
            ADGUARD_TLS_VERIFY: 'false',
            ADGUARD_USER: 'admin',
            ADGUARD_PASSWORD: PASSWORD
        },
        axios: second.axios
    });
    assert.equal(unverified.tlsVerified, false);
    assert.equal(second.calls.create[0].httpsAgent.options.rejectUnauthorized, false);
    assert.throws(() => createAdGuardConnection({
        env: {
            ADGUARD_URL: 'https://adguard.internal',
            ADGUARD_TLS_VERIFY: '0',
            ADGUARD_USER: 'admin',
            ADGUARD_PASSWORD: PASSWORD
        },
        axios: fakeAxios().axios
    }), AdGuardConfigurationError);
});

test('custom certificate authority loading is bounded and never reads unsafe paths', () => {
    const certificate = Buffer.from('test-ca');
    const fileSystem = {
        statSync(file) {
            assert.equal(file, '/safe/adguard-ca.pem');
            return { isFile: () => true, size: certificate.length };
        },
        readFileSync(file) {
            assert.equal(file, '/safe/adguard-ca.pem');
            return certificate;
        }
    };
    const fixture = fakeAxios();
    createAdGuardConnection({
        env: {
            ADGUARD_URL: 'https://adguard.internal',
            ADGUARD_CA_FILE: '/safe/adguard-ca.pem',
            ADGUARD_USER: 'admin',
            ADGUARD_PASSWORD: PASSWORD
        },
        axios: fixture.axios,
        fs: fileSystem
    });
    assert.deepEqual(fixture.calls.create[0].httpsAgent.options.ca, certificate);
    assert.throws(() => createAdGuardConnection({
        env: {
            ADGUARD_URL: 'https://adguard.internal',
            ADGUARD_CA_FILE: '/missing/ca.pem',
            ADGUARD_USER: 'admin',
            ADGUARD_PASSWORD: PASSWORD
        },
        axios: fakeAxios().axios,
        fs: { statSync() { throw new Error('missing'); } }
    }), error => error instanceof AdGuardConfigurationError
        && error.message === 'ADGUARD_CA_FILE cannot be read'
        && !error.message.includes(PASSWORD));
});

test('request surface accepts only bounded control paths and safe methods', async () => {
    const fixture = fakeAxios();
    const connection = createAdGuardConnection({
        env: {
            ADGUARD_URL: 'http://127.0.0.1:3000',
            ADGUARD_USER: 'admin',
            ADGUARD_PASSWORD: PASSWORD
        },
        axios: fixture.axios
    });
    assert.deepEqual(await connection.client.request('/control/status'), { ok: true });
    assert.deepEqual(await connection.client.request('/control/protection', {
        method: 'post', data: { enabled: true }
    }), { ok: true });
    assert.deepEqual(fixture.calls.request, [
        { url: '/control/status', method: 'get' },
        { url: '/control/protection', method: 'post', data: { enabled: true } }
    ]);
    await assert.rejects(connection.client.request('https://evil.example/control/status'), TypeError);
    await assert.rejects(connection.client.request('/control/status?leak=1'), TypeError);
    await assert.rejects(connection.client.request('/control/status', { method: 'delete' }), TypeError);
});

test('real wire request sends one bounded Basic credential only to the configured origin', async t => {
    const requests = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({
            method: req.method,
            url: req.url,
            authorization: req.headers.authorization,
            proxyAuthorization: req.headers['proxy-authorization'],
            body: Buffer.concat(chunks).toString('utf8')
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => upstream.close(resolve)));
    const connection = createAdGuardConnection({
        env: {
            ADGUARD_URL: `http://127.0.0.1:${upstream.address().port}`,
            ADGUARD_USER: 'admin',
            ADGUARD_PASSWORD: PASSWORD
        },
        axios
    });
    await connection.client.request('/control/status');
    await connection.client.request('/control/protection', {
        method: 'post', data: { enabled: true }
    });
    assert.deepEqual(requests.map(request => ({
        method: request.method, url: request.url, body: request.body
    })), [
        { method: 'GET', url: '/control/status', body: '' },
        { method: 'POST', url: '/control/protection', body: '{"enabled":true}' }
    ]);
    assert.equal(requests[0].authorization, 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64'));
    assert.equal(requests[1].authorization, requests[0].authorization);
    assert.equal(requests[0].proxyAuthorization, undefined);
});

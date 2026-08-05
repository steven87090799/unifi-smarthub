'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const {
    NasMonitorConfigurationError,
    createNasMonitorConnection,
    normalizeApiKey,
    normalizeBaseUrl,
    strictBoolean
} = require('../server/integrations/nas-monitor-client');

const STRONG_KEY = '0123456789abcdef0123456789abcdef';

function fakeAxios() {
    const calls = [];
    return {
        calls,
        create(options) {
            calls.push(options);
            return { options };
        }
    };
}

test('an unset monitor remains optional and creates no client', () => {
    const axios = fakeAxios();
    assert.deepEqual(createNasMonitorConnection({ axios, env: {} }), {
        url: null, client: null, configured: false
    });
    assert.equal(axios.calls.length, 0);
});

test('API keys fail closed on missing, short, control, oversized, and known defaults', () => {
    for (const value of ['', 'short', 'smarthub-local-monitor', `good${String.fromCharCode(10)}${'x'.repeat(40)}`, 'x'.repeat(257), 'a'.repeat(32), '密'.repeat(32)]) {
        assert.throws(() => normalizeApiKey(value), NasMonitorConfigurationError);
    }
    assert.equal(normalizeApiKey(STRONG_KEY), STRONG_KEY);
});

test('remote plaintext HTTP is rejected unless explicitly opted in', () => {
    assert.throws(() => normalizeBaseUrl('http://192.168.1.2:8000'), /explicit/);
    assert.equal(normalizeBaseUrl('http://192.168.1.2:8000', { allowInsecureHttp: true }), 'http://192.168.1.2:8000');
    assert.equal(normalizeBaseUrl('http://nas-monitor:8000/'), 'http://nas-monitor:8000');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
});

test('URL policy rejects credentials, non-HTTP schemes, query, fragment, and controls', () => {
    for (const url of [
        'ftp://nas-monitor:8000',
        'https://user:pass@example.test',
        'https://example.test?key=value',
        'https://example.test/#fragment',
        `https://example.test/${String.fromCharCode(10)}`
    ]) assert.throws(() => normalizeBaseUrl(url), NasMonitorConfigurationError);
});

test('HTTPS verifies certificates by default and sends bounded client options', () => {
    const axios = fakeAxios();
    const connection = createNasMonitorConnection({
        axios,
        env: { NAS_MONITOR_URL: 'https://monitor.example.test', NAS_MONITOR_API_KEY: STRONG_KEY }
    });
    assert.equal(connection.configured, true);
    assert.equal(connection.tlsVerified, true);
    assert.equal(axios.calls[0].httpsAgent.options.rejectUnauthorized, true);
    assert.equal(axios.calls[0].timeout, 20_000);
    assert.equal(axios.calls[0].proxy, false);
    assert.equal(axios.calls[0].maxContentLength, 4 * 1024 * 1024);
    assert.equal(axios.calls[0].headers['X-API-Key'], STRONG_KEY);
    assert.equal(axios.calls[0].headers.Authorization, undefined);
});

test('TLS verification can only be disabled by an exact explicit flag', () => {
    const axios = fakeAxios();
    const connection = createNasMonitorConnection({
        axios,
        env: {
            NAS_MONITOR_URL: 'https://monitor.example.test',
            NAS_MONITOR_API_KEY: STRONG_KEY,
            NAS_MONITOR_TLS_INSECURE: 'true'
        }
    });
    assert.equal(connection.tlsVerified, false);
    assert.equal(axios.calls[0].httpsAgent.options.rejectUnauthorized, false);
    assert.throws(() => strictBoolean('yes', 'FLAG'), /true or false/);
});

test('custom CA loading is bounded and does not disclose the API key in errors', () => {
    const axios = fakeAxios();
    const fileSystem = {
        lstatSync: () => ({ isFile: () => true, size: 12 }),
        readFileSync: () => Buffer.from('test-ca-data')
    };
    createNasMonitorConnection({
        axios,
        fs: fileSystem,
        env: {
            NAS_MONITOR_URL: 'https://monitor.example.test',
            NAS_MONITOR_API_KEY: STRONG_KEY,
            NAS_MONITOR_CA_FILE: '/run/secrets/monitor-ca.pem'
        }
    });
    assert.deepEqual(axios.calls[0].httpsAgent.options.ca, Buffer.from('test-ca-data'));

    let error;
    try {
        createNasMonitorConnection({
            axios: fakeAxios(),
            env: { NAS_MONITOR_URL: 'https://monitor.example.test', NAS_MONITOR_API_KEY: 'too-short' }
        });
    } catch (caught) { error = caught; }
    assert.ok(error);
    assert.doesNotMatch(error.message, /too-short/);
});

test('the real HTTP client sends exactly one credential header on the wire', async t => {
    const previousAllProxy = process.env.ALL_PROXY;
    process.env.ALL_PROXY = 'http://127.0.0.1:1';
    t.after(() => {
        if (previousAllProxy === undefined) delete process.env.ALL_PROXY;
        else process.env.ALL_PROXY = previousAllProxy;
    });
    let observedHeaders;
    const server = http.createServer((req, res) => {
        observedHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"docker":true}');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const connection = createNasMonitorConnection({
        axios,
        env: {
            NAS_MONITOR_URL: `http://127.0.0.1:${server.address().port}`,
            NAS_MONITOR_API_KEY: STRONG_KEY
        }
    });
    const response = await connection.client.get('/api/capabilities');
    assert.equal(response.status, 200);
    assert.equal(observedHeaders['x-api-key'], STRONG_KEY);
    assert.equal(observedHeaders.authorization, undefined);
});

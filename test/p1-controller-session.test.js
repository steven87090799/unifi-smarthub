'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rebuildAuthRetryHeaders, shouldRetryControllerRequest } = require('../server/integrations/unifi-auth-retry');

function deferred() {
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

// Execute the production assembly's actual session and interceptor code with
// a deferred transport. No socket, credential or production server is used.
function fixture(transport) {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf("let unifiCsrfToken = '';");
    const end = source.indexOf('function buildUnifiCloudClient()', start);
    assert.ok(start >= 0 && end > start);
    let now = 1000;
    class Clock extends Date { static now() { return now; } }
    const context = vm.createContext({
        Date: Clock, process: { env: { UNIFI_USERNAME: 'fixture', UNIFI_PASSWORD: 'fixture-only' } },
        shuttingDown: false, sysLog() {}, destroyAgent() {}, createHttpsAgent: () => null,
        resolveIntegrationTlsPolicy: () => ({ url: 'https://controller.invalid', mode: 'strict' }),
        createLanAxiosConfig: config => config, rebuildAuthRetryHeaders, shouldRetryControllerRequest,
        axios: { create() {
            let before = config => config;
            let success = value => value;
            let failure = error => { throw error; };
            const client = {
                interceptors: {
                    request: { use(fn) { before = fn; } },
                    response: { use(ok, fail) { if (ok) success = ok; if (fail) failure = fail; } }
                },
                async request(config) {
                    const prepared = before({ ...config, headers: { ...config.headers } });
                    try { return success(await transport(prepared)); }
                    catch (error) { error.config = prepared; return failure(error); }
                },
                post(url, data) { return client.request({ method: 'post', url, data }); }
            };
            return client;
        } }
    });
    vm.runInContext(`${source.slice(start, end)}\n;globalThis.api = {
        get: getLocalSession, refresh: refreshLocalSession,
        reset: () => { invalidateLocalSession({ reset: true }); unifiClient = buildUnifiClient(); },
        client: () => unifiClient,
        state: () => ({ cookie: localCookie, csrf: unifiCsrfToken, failures: localSessionConsecutiveFailures }),
        stop: () => { shuttingDown = true; }
    };`, context);
    return { ...context.api, advance(ms) { now += ms; } };
}
const login = (cookie = 'session-new') => ({ headers: { 'set-cookie': [cookie], 'x-csrf-token': `csrf-${cookie}` } });

function authFailure(status = 401) {
    const error = new Error('fixture authorization expired');
    error.response = { status, data: { meta: { msg: 'LoginRequired' } } };
    return error;
}

test('P1 controller config reset detaches and fences an old login without clearing the new flight', async () => {
    const old = deferred(); const fresh = deferred(); let calls = 0;
    const f = fixture(() => (++calls === 1 ? old : fresh).promise);
    const first = f.get();
    // Attach rejection handling before settling any generation.
    const firstResult = first.then(value => ({ value }), error => ({ error }));
    f.reset();
    const second = f.get();
    assert.equal(calls, 2, 'new config must not join the previous login');
    old.resolve(login('session-old'));
    const obsolete = await firstResult;
    assert.ok(obsolete.error, 'obsolete login must reject instead of publishing credentials');
    assert.equal(f.state().cookie, '');
    const third = f.get();
    assert.equal(calls, 2, 'old finally must not detach the newer in-flight login');
    fresh.resolve(login());
    assert.deepEqual(await Promise.all([second, third]), ['session-new', 'session-new']);
    assert.equal(f.state().failures, 0);
});

test('P1 staggered 401 responses reuse the replacement session instead of causing a login storm', async () => {
    const rejectedReads = Array.from({ length: 24 }, deferred);
    let logins = 0; let index = 0;
    const f = fixture(config => {
        if (config.url === '/api/auth/login') return login(`session-${++logins}`);
        if (config._smartHubAuthRetry) return { headers: {}, data: 'recovered' };
        return rejectedReads[index++].promise;
    });
    const cookie = await f.get();
    const reads = rejectedReads.map(() => f.client().request({ method: 'get', url: '/api/stat/health', headers: { Cookie: cookie } }));
    for (let i = 0; i < rejectedReads.length; i += 1) {
        rejectedReads[i].reject(authFailure());
        assert.equal((await reads[i]).data, 'recovered');
    }
    assert.equal(logins, 2, 'one expired wave must cause only one replacement login');
});

test('P1 old controller responses cannot refresh or publish state after reconfiguration', async () => {
    const response = deferred(); let logins = 0;
    const f = fixture(config => config.url === '/api/auth/login' ? login(`session-${++logins}`) : response.promise);
    const cookie = await f.get();
    const oldClient = f.client();
    const request = oldClient.request({ method: 'get', url: '/api/stat/health', headers: { Cookie: cookie } });
    const outcome = request.then(value => ({ value }), error => ({ error }));
    f.reset();
    await f.get();
    response.reject(authFailure());
    assert.ok((await outcome).error);
    assert.equal(logins, 2, 'obsolete request must not trigger a new-config login or replay on the old host');
});

test('P1 controller outage uses bounded backoff and recovers after its deadline without timers', async () => {
    let calls = 0; let online = false;
    const f = fixture(() => { calls += 1; if (!online) throw new Error('ECONNRESET'); return login(); });
    for (let i = 0; i < 50; i += 1) await assert.rejects(f.get());
    assert.equal(calls, 1, 'sequential callers must not each attempt another login while offline');
    online = true;
    f.advance(61000);
    assert.equal(await f.get(), 'session-new');
    assert.equal(calls, 2);
    f.stop();
    await assert.rejects(f.get(), /shut.*down|stopp/i);
});

test('P1 shutdown fences successful requests and leaves session state unmodified', async () => {
    const response = deferred();
    const f = fixture(() => response.promise);
    const result = f.get().then(value => ({ value }), error => ({ error }));
    f.stop(); response.resolve(login());
    assert.ok((await result).error);
    assert.equal(f.state().cookie, '');
});

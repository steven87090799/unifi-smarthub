const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
    createPanelSecurity,
    describeTrustedProxyConfiguration,
    parseTrustedProxies
} = require('../server/middleware/panel-security');

const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

async function createHarness(options = {}) {
    const app = express();
    if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
    const events = [];
    const boundary = createPanelSecurity({
        adminPassword: 'admin-secret', readonlyPassword: 'viewer-secret',
        csrfToken: 'test-csrf-token', onEvent: event => events.push(event), ...options
    });
    app.use(boundary.requireHttpsTransport);
    app.get('/login', (_req, res) => res.type('html').send('<h1>login</h1>'));
    app.get('/api/auth/status', boundary.status);
    app.post('/api/auth/login', express.json({ limit: '8kb' }), boundary.login);
    app.post('/api/auth/logout', boundary.logout);
    app.use(boundary.authenticate);
    app.get('/api/security/csrf', boundary.csrf);
    app.use(boundary.protectWrites);
    app.use(express.json());
    app.get('/api/settings', (req, res) => res.json({ role: req.panelAuth.role }));
    app.get('/api/sensitive', boundary.requireAdmin, (req, res) => res.json({ role: req.panelAuth.role }));
    app.post('/api/settings', (req, res) => res.json({ ok: true, body: req.body }));
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { boundary, events, origin, close: () => new Promise(resolve => server.close(resolve)) };
}

test('production HTTPS policy rejects direct HTTP and ignores spoofed forwarded headers', async t => {
    const harness = await createHarness({ requireHttps: true });
    t.after(harness.close);
    const response = await fetch(`${harness.origin}/api/auth/status`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'API-HTTPS-001');
});

test('an explicitly trusted loopback proxy may assert HTTPS and receives a Secure session cookie', async t => {
    const harness = await createHarness({ requireHttps: true, trustProxy: 'loopback' });
    t.after(harness.close);
    const forwardedOrigin = harness.origin.replace(/^http:/u, 'https:');
    const response = await fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: {
            origin: forwardedOrigin,
            'x-forwarded-proto': 'https',
            'content-type': 'application/json'
        },
        body: JSON.stringify({ username: 'admin', password: 'admin-secret', remember: false })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') || '', /Secure/u);
});

test('explicit insecure migration mode keeps HTTP transport and session cookie semantics consistent', async t => {
    const harness = await createHarness({ requireHttps: true, allowInsecureHttp: true });
    t.after(harness.close);
    assert.equal(harness.boundary.getState().enforceHttps, false);
    const response = await fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-secret', remember: false })
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get('set-cookie') || '', /Secure/u);
});

test('admin can read and write with same-origin CSRF proof', async t => {
    const harness = await createHarness();
    t.after(harness.close);
    const authorization = basic('admin', 'admin-secret');
    const tokenResponse = await fetch(`${harness.origin}/api/security/csrf`, { headers: { authorization } });
    assert.equal(tokenResponse.status, 200);
    assert.deepEqual(await tokenResponse.json(), { csrfToken: 'test-csrf-token', role: 'admin' });
    const read = await fetch(`${harness.origin}/api/settings`, { headers: { authorization } });
    assert.equal(read.status, 200);
    const write = await fetch(`${harness.origin}/api/settings`, {
        method: 'POST', headers: { authorization, origin: harness.origin, 'x-smarthub-csrf': 'test-csrf-token', 'content-type': 'application/json' }, body: '{"safe":true}'
    });
    assert.equal(write.status, 200);
});

test('form login creates an HttpOnly session with per-session CSRF and logout revokes it', async t => {
    const harness = await createHarness({ publicMetadata: { version: '3.0.0' } });
    t.after(harness.close);
    const login = await fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: 'admin-secret', remember: false })
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.equal(body.ok, true);
    assert.equal(body.role, 'admin');
    assert.equal(body.principal, 'operator');
    assert.equal(body.version, '3.0.0');
    assert.notEqual(body.csrfToken, 'test-csrf-token');
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /^smarthub_session=/u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /SameSite=Strict/u);
    assert.doesNotMatch(setCookie, /Max-Age=/u);
    const cookie = setCookie.split(';', 1)[0];

    const status = await fetch(`${harness.origin}/api/auth/status`, { headers: { cookie } });
    assert.deepEqual(await status.json(), {
        authenticated: true, role: 'admin', principal: 'operator', version: '3.0.0'
    });
    const csrf = await (await fetch(`${harness.origin}/api/security/csrf`, { headers: { cookie } })).json();
    assert.equal(csrf.role, 'admin');
    assert.equal(csrf.csrfToken, body.csrfToken);
    const write = await fetch(`${harness.origin}/api/settings`, {
        method: 'POST',
        headers: {
            cookie,
            origin: harness.origin,
            'x-smarthub-csrf': csrf.csrfToken,
            'content-type': 'application/json'
        },
        body: '{"session":true}'
    });
    assert.equal(write.status, 200);

    const logout = await fetch(`${harness.origin}/api/auth/logout`, {
        method: 'POST', headers: { cookie, origin: harness.origin }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/u);
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { cookie } })).status, 401);
    assert.equal(harness.boundary.getState().sessions, 0);
});

test('remembered login receives a persistent bounded cookie', async t => {
    const harness = await createHarness({ sessionRememberMs: 86_400_000 });
    t.after(harness.close);
    const response = await fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-secret', remember: true })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') || '', /Max-Age=86400/u);
    assert.match(response.headers.get('set-cookie') || '', /Expires=/u);
});

test('non-persistent sessions extend on activity and expire after the idle window', async t => {
    let clock = 1_000_000;
    const harness = await createHarness({ now: () => clock, sessionIdleMs: 60_000 });
    t.after(harness.close);
    const login = await fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-secret', remember: false })
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
    clock += 50_000;
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { cookie } })).status, 200);
    clock += 20_000;
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { cookie } })).status, 200);
    clock += 61_000;
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { cookie } })).status, 401);
});

test('HTML navigation redirects to the custom login without a native Basic challenge', async t => {
    const harness = await createHarness();
    t.after(harness.close);
    const response = await fetch(`${harness.origin}/dashboard?section=ups`, {
        headers: { accept: 'text/html' },
        redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login?return=%2Fdashboard%3Fsection%3Dups');
    assert.equal(response.headers.get('www-authenticate'), null);
});

test('login rejects hostile origins and counts only credential attempts', async t => {
    const harness = await createHarness({ maxFailures: 2, cooldownMs: 1000 });
    t.after(harness.close);
    const hostile = await fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-secret' })
    });
    assert.equal(hostile.status, 403);
    assert.equal(harness.boundary.getState().failures, 0);

    assert.equal((await fetch(`${harness.origin}/api/settings`)).status, 401);
    assert.equal(harness.boundary.getState().failures, 0);
    const login = body => fetch(`${harness.origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    assert.equal((await login({ username: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await login({ username: 'admin', password: 'wrong' })).status, 429);
});

test('readonly can read but every unsafe API method is denied server-side', async t => {
    const harness = await createHarness();
    t.after(harness.close);
    const authorization = basic('readonly', 'viewer-secret');
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { authorization } })).status, 200);
    assert.equal((await fetch(`${harness.origin}/api/sensitive`, { headers: { authorization } })).status, 403);
    const token = await (await fetch(`${harness.origin}/api/security/csrf`, { headers: { authorization } })).json();
    const denied = await fetch(`${harness.origin}/api/settings`, {
        method: 'POST', headers: { authorization, origin: harness.origin, 'x-smarthub-csrf': token.csrfToken, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'API-AUTH-403');
});

test('admin-only safe reads do not require a CSRF token', async t => {
    const harness = await createHarness();
    t.after(harness.close);
    const response = await fetch(`${harness.origin}/api/sensitive`, {
        headers: { authorization: basic('admin', 'admin-secret') }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { role: 'admin' });
});

test('unauthenticated requests are denied while health remains public', async t => {
    const app = express();
    const boundary = createPanelSecurity({ adminPassword: 'admin-secret', csrfToken: 'token' });
    app.use(boundary.authenticate);
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/settings', (_req, res) => res.json({ ok: true }));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/settings`)).status, 401);
});

test('missing or invalid CSRF and hostile Origin are denied', async t => {
    const harness = await createHarness();
    t.after(harness.close);
    const authorization = basic('admin', 'admin-secret');
    const post = headers => fetch(`${harness.origin}/api/settings`, { method: 'POST', headers: { authorization, 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await post({ origin: harness.origin })).status, 403);
    assert.equal((await post({ origin: harness.origin, 'x-smarthub-csrf': 'wrong' })).status, 403);
    assert.equal((await post({ origin: 'https://attacker.invalid', 'x-smarthub-csrf': 'test-csrf-token' })).status, 403);
    assert.equal((await post({ referer: 'https://attacker.invalid/form', 'x-smarthub-csrf': 'test-csrf-token' })).status, 403);
    assert.equal((await post({ origin: 'null', 'x-smarthub-csrf': 'test-csrf-token' })).status, 403);
    assert.equal((await post({ origin: harness.origin, 'x-smarthub-csrf': 'test-csrf-token' })).status, 200);
    assert.ok(harness.events.every(event => !JSON.stringify(event).includes('test-csrf-token')));
});

test('failed Basic Auth is throttled and recovers after cooldown', async t => {
    let clock = 10_000;
    const harness = await createHarness({ now: () => clock, maxFailures: 3, cooldownMs: 1000, failureWindowMs: 5000 });
    t.after(harness.close);
    const bad = { authorization: basic('admin', 'wrong') };
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: bad })).status, 401);
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: bad })).status, 401);
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: bad })).status, 429);
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { authorization: basic('admin', 'admin-secret') } })).status, 429);
    clock += 1001;
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { authorization: basic('admin', 'admin-secret') } })).status, 200);
    assert.equal(harness.boundary.getState().failures, 0);
});

test('limiter state is bounded, expires, and ignores spoofed proxy headers by default', async t => {
    let clock = 50_000;
    const harness = await createHarness({ now: () => clock, maxTrackedClients: 2, failureWindowMs: 1000, cooldownMs: 1000 });
    t.after(harness.close);
    await fetch(`${harness.origin}/api/settings`, { headers: { authorization: basic('admin', 'wrong'), 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(harness.boundary.getState().failures, 1);
    assert.ok(!harness.boundary.getState().failureKeys.includes('203.0.113.9'));
    clock += 2001;
    harness.boundary.pruneFailures();
    assert.equal(harness.boundary.getState().failures, 0);
});

test('trusted proxy configuration rejects spoofable blanket trust', () => {
    assert.equal(parseTrustedProxies(undefined), false);
    assert.equal(parseTrustedProxies('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
    assert.throws(() => parseTrustedProxies('true'), /explicit proxy/);
    assert.throws(() => parseTrustedProxies('1'), /explicit proxy/);
    assert.throws(() => parseTrustedProxies('10.0.0.0/99'), /Invalid trusted proxy/);
});

test('production HTTPS without trusted proxies emits a diagnostic without weakening enforcement', () => {
    const diagnostic = describeTrustedProxyConfiguration({
        nodeEnv: 'production', requireHttps: true, allowInsecureHttp: false, trustedProxies: false
    });
    assert.equal(diagnostic.code, 'PANEL_TRUSTED_PROXIES_MISSING');
    assert.match(diagnostic.message, /actual proxy IP\/CIDR/u);
    assert.equal(describeTrustedProxyConfiguration({
        nodeEnv: 'production', requireHttps: true, allowInsecureHttp: false, trustedProxies: 'loopback'
    }), null);
    assert.equal(describeTrustedProxyConfiguration({
        nodeEnv: 'production', requireHttps: true, allowInsecureHttp: true, trustedProxies: false
    }), null);
});

test('production mode cannot silently start without an admin password', () => {
    assert.throws(() => createPanelSecurity({ requireAdminPassword: true }), /required in production/);
    assert.throws(() => createPanelSecurity({ adminPassword: 'same', readonlyPassword: 'same' }), /must differ/);
});

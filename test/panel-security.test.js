const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPanelSecurity, parseTrustedProxies } = require('../server/middleware/panel-security');

const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

async function createHarness(options = {}) {
    const app = express();
    if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
    const events = [];
    const boundary = createPanelSecurity({
        adminPassword: 'admin-secret', readonlyPassword: 'viewer-secret',
        csrfToken: 'test-csrf-token', onEvent: event => events.push(event), ...options
    });
    app.use(boundary.authenticate);
    app.get('/api/security/csrf', boundary.csrf);
    app.use(boundary.protectWrites);
    app.use(express.json());
    app.get('/api/settings', (req, res) => res.json({ role: req.panelAuth.role }));
    app.post('/api/settings', (req, res) => res.json({ ok: true, body: req.body }));
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { boundary, events, origin, close: () => new Promise(resolve => server.close(resolve)) };
}

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

test('readonly can read but every unsafe API method is denied server-side', async t => {
    const harness = await createHarness();
    t.after(harness.close);
    const authorization = basic('readonly', 'viewer-secret');
    assert.equal((await fetch(`${harness.origin}/api/settings`, { headers: { authorization } })).status, 200);
    const token = await (await fetch(`${harness.origin}/api/security/csrf`, { headers: { authorization } })).json();
    const denied = await fetch(`${harness.origin}/api/settings`, {
        method: 'POST', headers: { authorization, origin: harness.origin, 'x-smarthub-csrf': token.csrfToken, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'API-AUTH-403');
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

test('production mode cannot silently start without an admin password', () => {
    assert.throws(() => createPanelSecurity({ requireAdminPassword: true }), /required in production/);
    assert.throws(() => createPanelSecurity({ adminPassword: 'same', readonlyPassword: 'same' }), /must differ/);
});

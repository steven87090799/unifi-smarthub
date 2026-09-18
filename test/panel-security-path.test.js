'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPanelSecurity } = require('../server/middleware/panel-security');

const basic = role => `Basic ${Buffer.from(`${role}:${role}-fixture-password`).toString('base64')}`;

async function harness(t) {
    const app = express(); // Production intentionally retains Express's case-insensitive routes.
    const boundary = createPanelSecurity({
        adminPassword: 'admin-fixture-password',
        readonlyPassword: 'readonly-fixture-password',
        csrfToken: 'fixture-csrf',
        protectedSafePaths: ['/api/protected']
    });
    let mutations = 0;
    app.post('/api/auth/login', express.json(), boundary.login);
    app.use(boundary.authenticate, boundary.protectWrites);
    app.get('/api/settings', (_req, res) => res.json({ ok: true }));
    for (const method of ['post', 'put', 'patch', 'delete']) {
        app[method]('/api/settings', (_req, res) => res.json({ mutations: ++mutations }));
    }
    app.get('/api/protected', (_req, res) => res.json({ mutations: ++mutations }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        mutations: () => mutations
    };
}

for (const route of ['/API/settings', '/Api/settings/', '/aPi/settings', '/api/settings']) {
    test(`readonly cannot mutate case-insensitive route ${route}`, async t => {
        const h = await harness(t);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const response = await fetch(`${h.origin}${route}`, {
                method,
                headers: { authorization: basic('readonly') }
            });
            assert.equal(response.status, 403, `${method} ${route}`);
            await response.arrayBuffer();
        }
        assert.equal(h.mutations(), 0);
    });
}

test('mixed-case writes still require CSRF and reject hostile origins', async t => {
    const h = await harness(t);
    for (const headers of [
        {},
        { 'x-smarthub-csrf': 'invalid' },
        { 'x-smarthub-csrf': 'fixture-csrf', origin: 'https://untrusted.invalid' },
        { 'x-smarthub-csrf': 'fixture-csrf', origin: 'null' },
        { 'x-smarthub-csrf': 'fixture-csrf', origin: 'https://untrusted.invalid', 'x-forwarded-host': 'untrusted.invalid', 'x-forwarded-proto': 'https' }
    ]) {
        const response = await fetch(`${h.origin}/API/settings/`, {
            method: 'POST', headers: { authorization: basic('admin'), ...headers }
        });
        assert.equal(response.status, 403);
        await response.arrayBuffer();
    }
    assert.equal(h.mutations(), 0);
});

test('protected safe routes cannot bypass role checks using case or trailing slash', async t => {
    const h = await harness(t);
    for (const route of ['/API/protected', '/api/protected/', '/Api/PROTECTED/']) {
        const response = await fetch(`${h.origin}${route}`, { headers: { authorization: basic('readonly') } });
        assert.equal(response.status, 403, route);
        await response.arrayBuffer();
    }
    assert.equal(h.mutations(), 0);
});

test('case normalization preserves authenticated read and valid admin write compatibility', async t => {
    const h = await harness(t);
    const unauthorized = await fetch(`${h.origin}/API/settings`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
    const read = await fetch(`${h.origin}/API/settings/`, { headers: { authorization: basic('readonly') } });
    assert.equal(read.status, 200);
    await read.arrayBuffer();
    for (const headers of [{ origin: h.origin }, {}]) {
        const write = await fetch(`${h.origin}/API/settings/`, {
            method: 'POST',
            headers: { authorization: basic('admin'), 'x-smarthub-csrf': 'fixture-csrf', ...headers }
        });
        assert.equal(write.status, 200);
        await write.arrayBuffer();
    }
    assert.equal(h.mutations(), 2);
});

test('readonly session cannot mutate mixed-case routes even with its valid CSRF token', async t => {
    const h = await harness(t);
    const login = await fetch(`${h.origin}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin },
        body: JSON.stringify({ username: 'readonly', password: 'readonly-fixture-password' })
    });
    assert.equal(login.status, 200);
    const { csrfToken } = await login.json();
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const response = await fetch(`${h.origin}/API/settings`, {
        method: 'POST', headers: { cookie, origin: h.origin, 'x-smarthub-csrf': csrfToken }
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
    assert.equal(h.mutations(), 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPanelSecurity } = require('../server/middleware/panel-security');
const { ROUTE_CODES, registerWiimCommandRoutes } = require('../server/routes/wiim-command-routes');

const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

async function harness() {
    const app = express();
    const calls = [];
    const security = createPanelSecurity({
        adminPassword: 'admin-secret', readonlyPassword: 'viewer-secret',
        csrfToken: 'route-csrf-token'
    });
    app.use(security.authenticate);
    app.get('/api/security/csrf', security.csrf);
    app.use(security.protectWrites);
    app.use(express.json());
    registerWiimCommandRoutes(app, {
        execute: async command => { calls.push(command); return `executed:${command}`; }
    });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    return {
        calls,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

test('GET executes allowlisted reads but cannot execute writes or duplicate queries', async t => {
    const h = await harness();
    t.after(h.close);
    const authorization = basic('readonly', 'viewer-secret');
    const read = await fetch(`${h.origin}/api/wiim/cmd?command=getStatusEx`, { headers: { authorization } });
    assert.equal(read.status, 200);
    assert.deepEqual(h.calls, ['getStatusEx']);
    const write = await fetch(`${h.origin}/api/wiim/cmd?command=reboot`, { headers: { authorization } });
    assert.equal(write.status, 405);
    assert.equal((await write.json()).code, ROUTE_CODES.METHOD_NOT_ALLOWED);
    const duplicate = await fetch(`${h.origin}/api/wiim/cmd?command=getStatusEx&command=reboot`, { headers: { authorization } });
    assert.equal(duplicate.status, 400);
    assert.deepEqual(h.calls, ['getStatusEx']);
});

test('POST writes require admin, same-origin CSRF, and the write method contract', async t => {
    const h = await harness();
    t.after(h.close);
    const admin = basic('admin', 'admin-secret');
    const readonly = basic('readonly', 'viewer-secret');
    const body = JSON.stringify({ command: 'setPlayerCmd:vol:25' });
    const headers = authorization => ({ authorization, origin: h.origin, 'x-smarthub-csrf': 'route-csrf-token', 'content-type': 'application/json' });
    assert.equal((await fetch(`${h.origin}/api/wiim/cmd`, { method: 'POST', headers: headers(readonly), body })).status, 403);
    assert.equal((await fetch(`${h.origin}/api/wiim/cmd`, { method: 'POST', headers: { authorization: admin, 'content-type': 'application/json' }, body })).status, 403);
    const accepted = await fetch(`${h.origin}/api/wiim/cmd`, { method: 'POST', headers: headers(admin), body });
    assert.equal(accepted.status, 200);
    assert.deepEqual(h.calls, ['setPlayerCmd:vol:25']);
    const readOverPost = await fetch(`${h.origin}/api/wiim/cmd`, {
        method: 'POST', headers: headers(admin), body: JSON.stringify({ command: 'getStatusEx' })
    });
    assert.equal(readOverPost.status, 405);
});

test('high-risk operations require an exact server-side confirmation', async t => {
    const h = await harness();
    t.after(h.close);
    const headers = { authorization: basic('admin', 'admin-secret'), origin: h.origin, 'x-smarthub-csrf': 'route-csrf-token', 'content-type': 'application/json' };
    for (const body of [
        { command: 'reboot' },
        { command: 'reboot', confirmation: true },
        { command: 'reboot', confirmation: 'setShutdown:0' }
    ]) {
        const response = await fetch(`${h.origin}/api/wiim/cmd`, { method: 'POST', headers, body: JSON.stringify(body) });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, ROUTE_CODES.CONFIRMATION_REQUIRED);
    }
    const accepted = await fetch(`${h.origin}/api/wiim/cmd`, {
        method: 'POST', headers, body: JSON.stringify({ command: 'reboot', confirmation: 'reboot' })
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(h.calls, ['reboot']);
});

test('unknown, encoded, forbidden, and extra-field requests never reach transport', async t => {
    const h = await harness();
    t.after(h.close);
    const headers = { authorization: basic('admin', 'admin-secret'), origin: h.origin, 'x-smarthub-csrf': 'route-csrf-token', 'content-type': 'application/json' };
    for (const body of [
        { command: 'arbitrary:command' },
        { command: '%72eboot' },
        { command: 'factoryReset' },
        { command: 'setPlayerCmd:vol:10', extra: 'ignored?' }
    ]) {
        const response = await fetch(`${h.origin}/api/wiim/cmd`, { method: 'POST', headers, body: JSON.stringify(body) });
        assert.ok([400, 403].includes(response.status));
    }
    assert.deepEqual(h.calls, []);
});

test('an unreachable WiiM transport is not reported as a successful command', async t => {
    const app = express();
    registerWiimCommandRoutes(app, { execute: async () => null });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/wiim/cmd?command=getStatusEx`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, ROUTE_CODES.TRANSPORT_FAILED);
});

test('an unconfigured optional WiiM is rejected before command transport', async t => {
    const app = express();
    let called = false;
    registerWiimCommandRoutes(app, {
        isConfigured: () => false,
        execute: async () => { called = true; return 'unexpected'; }
    });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/wiim/cmd?command=getStatusEx`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, ROUTE_CODES.NOT_CONFIGURED);
    assert.equal(called, false);
});

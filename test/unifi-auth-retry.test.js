'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rebuildAuthRetryHeaders, shouldRetryControllerRequest } = require('../server/integrations/unifi-auth-retry');

test('controller relogin retry replaces an expired CSRF token', () => {
    const headers = rebuildAuthRetryHeaders({
        Accept: 'application/json', Cookie: 'old-session', 'X-CSRF-Token': 'CSRF-A'
    }, 'new-session', 'CSRF-B');
    assert.equal(headers.Cookie, 'new-session');
    assert.equal(headers['x-csrf-token'], 'CSRF-B');
    assert.equal(Object.keys(headers).some(key => key.toLowerCase() === 'x-csrf-token' && headers[key] === 'CSRF-A'), false);
});

test('controller relogin retry removes stale CSRF when login returns no token', () => {
    const headers = rebuildAuthRetryHeaders({
        Accept: 'application/json', cookie: 'old-session', 'X-CSRF-TOKEN': 'CSRF-A'
    }, 'new-session', '');
    assert.equal(headers.Cookie, 'new-session');
    assert.equal(Object.keys(headers).some(key => key.toLowerCase() === 'x-csrf-token'), false);
});

test('controller retry header rebuild handles AxiosHeaders-like input', () => {
    const headers = rebuildAuthRetryHeaders({
        toJSON: () => ({ Cookie: 'old-session', 'x-csrf-token': 'CSRF-A', Accept: 'application/json' })
    }, 'new-session', 'CSRF-B');
    assert.deepEqual(headers, {
        Accept: 'application/json', Cookie: 'new-session', 'x-csrf-token': 'CSRF-B'
    });
});

test('controller retry remains bounded and excludes permission or ambiguous failures', () => {
    const base = { method: 'get', url: '/api/stat/health' };
    assert.equal(shouldRetryControllerRequest({ config: base, response: { status: 401 } }), true);
    assert.equal(shouldRetryControllerRequest({ config: { ...base, _smartHubAuthRetry: true }, response: { status: 401 } }), false);
    assert.equal(shouldRetryControllerRequest({ config: { method: 'post', url: '/api/write' }, response: { status: 403, data: { meta: { msg: 'api.err.NoPermission' } } } }), false);
    assert.equal(shouldRetryControllerRequest({ config: { method: 'post', url: '/api/write' }, response: undefined }), false);
});

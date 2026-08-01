'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNasLoginSingleflight } = require('../server/services/nas-login-singleflight');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('parallel NAS requests perform one login and share the same token', async () => {
    let token = null;
    let loginCalls = 0;
    const login = createNasLoginSingleflight({
        getCachedToken: () => token,
        isTokenValid: value => value === token && value !== null,
        login: async () => {
            loginCalls += 1;
            await wait(5);
            token = `nas-token-${loginCalls}`;
            return token;
        }
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => login.getToken()));
    assert.equal(loginCalls, 1);
    assert.deepEqual(new Set(results), new Set(['nas-token-1']));
    assert.equal(login.isInFlight(), false);
    assert.equal(await login.getToken(), 'nas-token-1');
    assert.equal(loginCalls, 1);
});

test('failed login clears the shared promise so the next request can retry', async () => {
    let attempts = 0;
    let token = null;
    const login = createNasLoginSingleflight({
        getCachedToken: () => token,
        isTokenValid: value => value === token && value !== null,
        login: async () => {
            attempts += 1;
            await wait(2);
            if (attempts === 1) throw new Error('RSA login failed');
            token = 'recovered-token';
            return token;
        }
    });

    const failures = await Promise.allSettled([
        login.getToken(), login.getToken(), login.getToken(), login.getToken(), login.getToken()
    ]);
    assert.equal(attempts, 1);
    assert.ok(failures.every(result => result.status === 'rejected'));
    assert.equal(login.isInFlight(), false);
    assert.equal(await login.getToken(), 'recovered-token');
    assert.equal(attempts, 2);
});

test('expired token enters singleflight again without overwriting a successful token', async () => {
    let currentToken = null;
    let valid = false;
    let attempts = 0;
    const login = createNasLoginSingleflight({
        getCachedToken: () => currentToken,
        isTokenValid: value => valid && value === currentToken,
        login: async () => {
            attempts += 1;
            await wait(2);
            currentToken = `token-${attempts}`;
            valid = true;
            return currentToken;
        }
    });

    assert.equal(await login.getToken(), 'token-1');
    valid = false;
    const results = await Promise.all([login.getToken(), login.getToken(), login.getToken()]);
    assert.deepEqual(new Set(results), new Set(['token-2']));
    assert.equal(attempts, 2);
});

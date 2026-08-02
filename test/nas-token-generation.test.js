'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNasLoginSingleflight } = require('../server/services/nas-login-singleflight');
const {
    NasLoginSupersededError,
    createNasTokenGeneration,
    isNasLoginSupersededError
} = require('../server/services/nas-token-generation');

test('delayed old NAS token failure cannot clear a newer token or trigger a third login', async () => {
    let now = 0;
    const tokens = createNasTokenGeneration({ now: () => now });
    tokens.set('T1', 10_000);
    const requestTokenA = tokens.getToken();
    const requestGenerationA = tokens.getGeneration();
    const requestTokenB = tokens.getToken();
    const requestGenerationB = tokens.getGeneration();

    assert.equal(tokens.clearIfCurrent(requestTokenA, requestGenerationA), true);
    let loginCalls = 0;
    const login = createNasLoginSingleflight({
        getCachedToken: tokens.getToken,
        isTokenValid: token => token === tokens.getToken() && tokens.isValid(),
        login: async () => {
            loginCalls += 1;
            tokens.set('T2', 10_000);
            return 'T2';
        }
    });
    assert.equal(await login.getToken(), 'T2');

    assert.equal(tokens.clearIfCurrent(requestTokenB, requestGenerationB), false);
    assert.equal(tokens.getToken(), 'T2');
    assert.equal(loginCalls, 1);
    assert.equal(tokens.snapshot().generation > requestGenerationB, true);
});

test('token reset fences an in-flight login and allows one bounded retry', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tokens = createNasTokenGeneration();
    let loginCalls = 0;
    const login = createNasLoginSingleflight({
        getCachedToken: tokens.getToken,
        isTokenValid: token => token === tokens.getToken() && tokens.isValid(),
        login: async () => {
            const call = ++loginCalls;
            await gate;
            tokens.set(`T${call}`, Date.now() + 10_000);
            return `T${call}`;
        }
    });

    const old = login.getToken();
    tokens.reset();
    login.reset();
    const next = login.getToken();
    release();
    const results = await Promise.all([old, next]);
    assert.equal(loginCalls, 2);
    assert.deepEqual(results.sort(), ['T1', 'T2']);
    assert.equal(tokens.getToken(), 'T2');
    assert.equal(login.isInFlight(), false);
});

test('a superseded login result is rejected before token commit', () => {
    const tokens = createNasTokenGeneration();
    const loginGeneration = tokens.getGeneration();
    tokens.reset();

    assert.equal(tokens.setIfGeneration(loginGeneration, 'old-token', Date.now() + 10_000), false);
    assert.equal(tokens.getToken(), '');
    const error = new NasLoginSupersededError();
    assert.equal(isNasLoginSupersededError(error), true);
});

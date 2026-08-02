'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNasRequestRunner } = require('../server/services/nas-request-retry');
const { NasLoginSupersededError } = require('../server/services/nas-token-generation');

function deferred() {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
}

function tokenRejected(message = 'token rejected') {
    const error = new Error(message);
    error.code = 'NAS_TOKEN_REJECTED';
    return error;
}

function createHarness(responses, { token = 'T1' } = {}) {
    let currentToken = token;
    let generation = token ? 1 : 0;
    let refreshes = 0;
    const counters = { httpCalls: 0, recordSuccessCalls: 0, recordFailureCalls: 0, consecutiveFailures: 0 };

    const runner = createNasRequestRunner({
        getToken: async () => {
            if (!currentToken) {
                refreshes += 1;
                currentToken = `T${refreshes + 1}`;
                generation += 1;
            }
            return currentToken;
        },
        getLease: () => ({ token: currentToken, generation }),
        request: async (pathName, options) => {
            counters.httpCalls += 1;
            const next = responses.shift();
            return typeof next === 'function' ? next(pathName, options) : next;
        },
        validateResponse: response => {
            if (response?.status === 401 || response?.status === 403) {
                const error = new Error(`HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            const body = response?.data;
            if (body?.code !== undefined && body.code !== 200) {
                if (body.code === 1004 || body.code === 1008) {
                    const error = new Error(`permission denied ${body.code}`);
                    error.code = 'NAS_PERMISSION_DENIED';
                    throw error;
                }
                throw tokenRejected(`body code ${body.code}`);
            }
            return body?.data !== undefined ? body.data : body;
        },
        isTokenRejectedError: error => error?.code === 'NAS_TOKEN_REJECTED'
            || error?.status === 401 || error?.status === 403,
        clearTokenIfCurrent: lease => {
            if (lease.token !== currentToken || lease.generation !== generation) return false;
            currentToken = '';
            generation += 1;
            return true;
        },
        recordSuccess: () => { counters.recordSuccessCalls += 1; },
        recordFailure: () => {
            counters.recordFailureCalls += 1;
            counters.consecutiveFailures += 1;
        }
    });

    return {
        runner,
        counters,
        get refreshes() { return refreshes; },
        get token() { return currentToken; },
        get generation() { return generation; }
    };
}

test('body token rejection retries once and records one success', async () => {
    const harness = createHarness([
        { data: { code: 999 } },
        { data: { code: 200, data: { ok: true } } }
    ]);
    assert.deepEqual(await harness.runner.run('/nas/read'), { ok: true });
    assert.equal(harness.counters.httpCalls, 2);
    assert.equal(harness.refreshes, 1);
    assert.equal(harness.counters.recordSuccessCalls, 1);
    assert.equal(harness.counters.recordFailureCalls, 0);
});

test('body token rejection followed by HTTP 401 stops after two requests', async () => {
    const harness = createHarness([
        { data: { code: 999 } },
        { status: 401 }
    ]);
    await assert.rejects(harness.runner.run('/nas/read'), error => error.status === 401);
    assert.equal(harness.counters.httpCalls, 2);
    assert.equal(harness.refreshes, 1);
    assert.equal(harness.counters.recordFailureCalls, 1);
});

test('a second-request timeout records one failure and never retries a third request', async () => {
    const timeout = new Error('NAS request timeout');
    timeout.code = 'ETIMEDOUT';
    const harness = createHarness([
        { data: { code: 999 } },
        () => { throw timeout; }
    ]);
    await assert.rejects(harness.runner.run('/nas/read'), error => error === timeout);
    assert.equal(harness.counters.httpCalls, 2);
    assert.equal(harness.counters.recordFailureCalls, 1);
    assert.equal(harness.counters.consecutiveFailures, 1);
});

test('permission denied is not treated as a token refresh', async () => {
    const harness = createHarness([{ data: { code: 1004 } }]);
    await assert.rejects(harness.runner.run('/nas/read'), error => error.code === 'NAS_PERMISSION_DENIED');
    assert.equal(harness.counters.httpCalls, 1);
    assert.equal(harness.refreshes, 0);
    assert.equal(harness.counters.recordFailureCalls, 1);
});

test('a delayed T1 rejection cannot clear T2 or cause a T3 login', async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const seenTokens = [];
    const harness = createHarness([
        async (_path, { params }) => {
            seenTokens.push(params.token);
            firstStarted.resolve();
            await releaseFirst.promise;
            return { data: { code: 999 } };
        },
        async (_path, { params }) => {
            seenTokens.push(params.token);
            secondStarted.resolve();
            await releaseSecond.promise;
            return { data: { code: 999 } };
        },
        (_path, { params }) => {
            seenTokens.push(params.token);
            return { data: { code: 200, data: { token: params.token } } };
        },
        (_path, { params }) => {
            seenTokens.push(params.token);
            return { data: { code: 200, data: { token: params.token } } };
        }
    ]);

    const first = harness.runner.run('/first');
    await firstStarted.promise;
    const second = harness.runner.run('/second');
    await secondStarted.promise;
    releaseFirst.resolve();
    releaseSecond.resolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results, [{ token: 'T2' }, { token: 'T2' }]);
    assert.equal(harness.refreshes, 1);
    assert.equal(harness.token, 'T2');
    assert.equal(seenTokens.filter(token => token === 'T3').length, 0);
    assert.equal(harness.counters.recordFailureCalls, 0);
});

test('superseded login is bounded and excluded from failure accounting', async () => {
    let getTokenCalls = 0;
    let failures = 0;
    const runner = createNasRequestRunner({
        getToken: async () => {
            getTokenCalls += 1;
            throw new NasLoginSupersededError();
        },
        getLease: () => ({ token: 'unused', generation: 1 }),
        request: async () => { throw new Error('request must not run'); },
        validateResponse: value => value,
        isTokenRejectedError: () => false,
        isSupersededError: error => error?.code === 'NAS_LOGIN_SUPERSEDED',
        clearTokenIfCurrent: () => true,
        recordSuccess: () => { throw new Error('success must not be recorded'); },
        recordFailure: () => { failures += 1; }
    });
    await assert.rejects(runner.run('/nas/read'), error => error.code === 'NAS_LOGIN_SUPERSEDED');
    assert.equal(getTokenCalls, 2);
    assert.equal(failures, 0);
});

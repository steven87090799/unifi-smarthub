'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecoverableFailureState } = require('../server/services/recoverable-failure-state');

test('recoverable failure state preserves first-log and cooldown semantics', () => {
    const state = createRecoverableFailureState({ cooldownMs: 1000 });
    assert.deepEqual(state.record('integration.operation', 0), {
        occurrences: 1, lastLoggedAt: 0, shouldLog: true
    });
    assert.deepEqual(state.record('integration.operation', 500), {
        occurrences: 2, lastLoggedAt: 0, shouldLog: false
    });
    assert.deepEqual(state.record('integration.operation', 1000), {
        occurrences: 3, lastLoggedAt: 1000, shouldLog: true
    });
});

test('recoverable failure state remains bounded through 50,000 novel keys', () => {
    const state = createRecoverableFailureState({ cooldownMs: 1, maxEntries: 2000 });
    for (let index = 0; index < 50000; index += 1) state.record(`watcher.dockerLogs:container-${index}`, index + 1);

    assert.equal(state.size(), 2000);
    assert.equal(state.remove('watcher.dockerLogs:container-0'), false);
    assert.equal(state.remove('watcher.dockerLogs:container-49999'), true);
    assert.equal(state.size(), 1999);
});

test('removing a live key releases its cooldown and the next failure logs once', () => {
    const state = createRecoverableFailureState({ cooldownMs: 1000 });
    state.record('watcher.dockerLogs:container-a', 1000);
    assert.equal(state.remove('watcher.dockerLogs:container-a'), true);
    assert.equal(state.size(), 0);
    assert.equal(state.record('watcher.dockerLogs:container-a', 1100).shouldLog, true);
});

test('recoverable failure state rejects ambiguous keys and timestamps', () => {
    const state = createRecoverableFailureState();
    assert.throws(() => state.record('', 1), /key/);
    assert.throws(() => state.record('x'.repeat(257), 1), /256/);
    assert.throws(() => state.record('valid', Number.NaN), /timestamp/);
});

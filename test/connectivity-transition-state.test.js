'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    STATES,
    createBooleanTransitionState,
    createConnectivityTransitionState
} = require('../server/services/connectivity-transition-state');

test('connectivity state uses baseline, three failures, and two successes', () => {
    const state = createConnectivityTransitionState({ offlineThreshold: 3, recoveryThreshold: 2, now: () => 1 });
    assert.equal(state.observe('success').baseline, true);
    assert.equal(state.snapshot().state, STATES.ONLINE);
    assert.equal(state.observe('failure').notify, null);
    assert.equal(state.observe('failure').notify, null);
    assert.equal(state.observe('failure').notify, 'offline');
    assert.equal(state.snapshot().state, STATES.OFFLINE);
    for (let i = 0; i < 10; i += 1) assert.equal(state.observe('failure').notify, null);
    assert.equal(state.observe('success').notify, null);
    assert.equal(state.observe('success').notify, 'recovered');
    assert.equal(state.observe('success').notify, null);
});

test('unknown and stale observations never advance or clear the debounce baseline', () => {
    const state = createConnectivityTransitionState({ offlineThreshold: 3, recoveryThreshold: 2 });
    state.observe('success');
    state.observe('failure');
    const before = state.snapshot();
    assert.equal(state.observe('stale').notify, null);
    assert.equal(state.observe('unknown').notify, null);
    assert.deepEqual(state.snapshot(), { ...before, lastObservedAt: state.snapshot().lastObservedAt });
    assert.equal(state.observe('failure').notify, null);
    assert.equal(state.snapshot().failureCount, 2);
});

test('protection state has an independent baseline and only real changes transition', () => {
    const state = createBooleanTransitionState();
    assert.equal(state.observe(true).baseline, true);
    assert.equal(state.observe(true).transition, null);
    assert.equal(state.observe(false).transition, 'offline');
    assert.equal(state.observe(true).transition, 'recovered');
    state.reset();
    assert.equal(state.observe(false).baseline, true);
});

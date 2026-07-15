'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDockerMetricAlertState } = require('../server/services/docker-notification-state');

test('Docker metric cooldown state is released with its container', () => {
    const state = createDockerMetricAlertState();
    state.record('cpu', 'container-a', 100);
    state.record('memory', 'container-a', 200);
    state.record('cpu', 'container-b', 300);

    assert.equal(state.removeContainer('container-a'), 2);
    assert.equal(state.get('cpu', 'container-a'), undefined);
    assert.equal(state.get('memory', 'container-a'), undefined);
    assert.equal(state.get('cpu', 'container-b'), 300);
    assert.equal(state.size(), 1);
});

test('Docker metric cooldown state remains bounded through 50,000 novel identities', () => {
    const state = createDockerMetricAlertState({ maxEntries: 2000 });
    for (let index = 0; index < 50000; index += 1) {
        state.record(index % 2 === 0 ? 'cpu' : 'memory', `container-${index}`, index);
    }

    assert.equal(state.size(), 2000);
    assert.equal(state.get('cpu', 'container-0'), undefined);
    assert.equal(state.get('memory', 'container-49999'), 49999);
});

test('updating a live cooldown preserves it across bounded eviction', () => {
    const state = createDockerMetricAlertState({ maxEntries: 2 });
    state.record('cpu', 'container-a', 1);
    state.record('cpu', 'container-b', 2);
    state.record('cpu', 'container-a', 3);
    state.record('cpu', 'container-c', 4);

    assert.equal(state.get('cpu', 'container-a'), 3);
    assert.equal(state.get('cpu', 'container-b'), undefined);
    assert.equal(state.get('cpu', 'container-c'), 4);
    assert.equal(state.size(), 2);
});

test('Docker metric cooldown state rejects unsupported or ambiguous input', () => {
    const state = createDockerMetricAlertState();
    assert.throws(() => state.record('disk', 'container-a', 1), /unsupported Docker metric/);
    assert.throws(() => state.record('cpu', '', 1), /containerId/);
    assert.throws(() => state.record('cpu', 'container-a', Number.NaN), /timestamp/);
});

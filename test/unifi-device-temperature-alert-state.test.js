'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiDeviceTemperatureAlertState } = require('../server/services/unifi-device-temperature-alert-state');

function sample(value, sampledAt, overrides = {}) {
    return { id: 'device-1', freshness: { stale: false }, temperature: { value, sampledAt, status: 'supported', stale: false }, ...overrides };
}

test('temperature alerts require three fresh highs, recover twice, and deduplicate samples', () => {
    const state = createUnifiDeviceTemperatureAlertState({ now: () => 1000 });
    assert.equal(state.evaluate(sample(80, '1')), null);
    assert.equal(state.evaluate(sample(80, '1')), null);
    assert.equal(state.evaluate(sample(81, '2')), null);
    assert.equal(state.evaluate(sample(82, '3')).type, 'high');
    assert.equal(state.evaluate(sample(69, '4')), null);
    assert.equal(state.evaluate(sample(69, '5')).type, 'recovered');
});

test('critical is immediate while stale, unsupported, and offline-like samples do not advance state', () => {
    const state = createUnifiDeviceTemperatureAlertState({ now: () => 1000 });
    assert.equal(state.evaluate(sample(95, '1')).type, 'critical');
    assert.equal(state.evaluate(sample(80, '2', { freshness: { stale: true } })), null);
    assert.equal(state.evaluate({ ...sample(80, '3'), temperature: { value: 80, sampledAt: '3', status: 'unsupported', stale: false } }), null);
});

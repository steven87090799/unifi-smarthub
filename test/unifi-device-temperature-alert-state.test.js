'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiDeviceTemperatureAlertState } = require('../server/services/unifi-device-temperature-alert-state');

function device(value, sampledAt, stale = false) { return { id: 'aa:bb:cc:dd:ee:ff', temperature: { value, sampledAt, stale } }; }

test('alerts after three fresh high samples, immediately at critical, and recovers after two samples', () => {
    const state = createUnifiDeviceTemperatureAlertState();
    assert.equal(state.evaluate(device(76, '1')), null);
    assert.equal(state.evaluate(device(76, '2')), null);
    assert.equal(state.evaluate(device(76, '3')).type, 'high');
    assert.equal(state.evaluate(device(69, '4')), null);
    assert.equal(state.evaluate(device(69, '5')).type, 'recovered');
    assert.equal(state.evaluate(device(91, '6')).type, 'critical');
});

test('stale values and repeated samples never advance alert state', () => {
    const state = createUnifiDeviceTemperatureAlertState();
    assert.equal(state.evaluate(device(95, '1', true)), null);
    assert.equal(state.evaluate(device(76, '2')), null);
    assert.equal(state.evaluate(device(76, '2')), null);
});

test('telemetry-stale snapshots do not advance, recover, or clear an active alert', () => {
    const state = createUnifiDeviceTemperatureAlertState();
    state.evaluate(device(91, '1'));
    assert.equal(state.snapshot('aa:bb:cc:dd:ee:ff').alertActive, true);
    const stale = { ...device(60, '2'), telemetryStale: true };
    assert.equal(state.evaluate(stale), null);
    const snapshot = state.snapshot('aa:bb:cc:dd:ee:ff');
    assert.equal(snapshot.alertActive, true);
    assert.equal(snapshot.consecutiveRecovery, 0);
    assert.equal(snapshot.lastSampledAt, '1');
});

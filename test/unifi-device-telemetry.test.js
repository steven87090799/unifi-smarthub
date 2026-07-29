'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    findTemperature,
    presentUnifiDeviceTelemetry,
    telemetryHistoryPoint
} = require('../server/services/unifi-device-telemetry');

test('presents real controller CPU while refusing temperature when capability is false', () => {
    const telemetry = presentUnifiDeviceTelemetry([{
        mac: 'AA:BB:CC:DD:EE:FF',
        name: 'U7 Pro',
        model: 'U7PRO',
        type: 'uap',
        state: 1,
        has_temperature: false,
        general_temperature: 88,
        'system-stats': { cpu: '1.8' }
    }], { sampledAt: '2026-07-29T00:00:00.000Z' });

    assert.equal(telemetry.devices[0].id, 'aa:bb:cc:dd:ee:ff');
    assert.deepEqual(telemetry.devices[0].cpu, {
        value: 1.8,
        unit: 'percent',
        sourceField: 'system-stats.cpu',
        verifiedSource: true
    });
    assert.equal(telemetry.devices[0].temperature, null);
    assert.equal(telemetry.devices[0].temperatureStatus, 'controller_unsupported');
});

test('accepts only bounded temperature from an explicitly capable device', () => {
    const direct = findTemperature({ has_temperature: true, general_temperature: '62.5' });
    assert.deepEqual(direct, { value: 62.5, sourceField: 'general_temperature' });
    assert.equal(findTemperature({ has_temperature: true, general_temperature: 999 }), null);
    assert.equal(findTemperature({ has_temperature: false, general_temperature: 62.5 }), null);
});

test('history contains presented values and their exact source fields', () => {
    const telemetry = presentUnifiDeviceTelemetry([{
        _id: 'device-1',
        name: 'Temperature device',
        state: 'connected',
        has_temperature: true,
        general_temperature: 51,
        'system-stats': { cpu: 25 }
    }], { sampledAt: '2026-07-29T00:00:00.000Z' });
    const point = telemetryHistoryPoint(telemetry);

    assert.equal(point.t, telemetry.sampledAt);
    assert.deepEqual(point.devices[0], {
        id: 'device-1',
        name: 'Temperature device',
        model: '',
        type: '',
        online: true,
        cpu: 25,
        temperature: 51,
        cpuSourceField: 'system-stats.cpu',
        temperatureSourceField: 'general_temperature',
        temperatureSourceSystem: 'controller',
        temperatureStatus: 'controller_reported',
        temperatureSampledAt: '2026-07-29T00:00:00.000Z'
    });
});

test('uses fresh device SSH only when controller has no verified temperature, while stale is marked and excluded from history', () => {
    const device = { mac: 'AA:BB:CC:DD:EE:FF', state: 1, has_temperature: false, 'system-stats': { cpu: 4 } };
    const direct = new Map([['aa:bb:cc:dd:ee:ff', { selected: true, thermal: {
        maxTemperatureC: 74.2, cpuTemperatureC: 71.1, sampledAt: '2026-07-29T00:01:00.000Z',
        zones: [{ zone: 'thermal_zone0', type: 'soc', temperatureC: 71.1 }], source: { path: '/sys/class/thermal/thermal_zone*/temp' }
    }, stale: false }]]);
    const telemetry = presentUnifiDeviceTelemetry([device], { directThermalByDevice: direct, thermalSshConfigured: true });
    assert.equal(telemetry.devices[0].temperature.sourceSystem, 'device_ssh');
    assert.equal(telemetry.devices[0].temperatureStatus, 'device_ssh_reported');
    direct.get('aa:bb:cc:dd:ee:ff').stale = true;
    const stale = presentUnifiDeviceTelemetry([device], { directThermalByDevice: direct, thermalSshConfigured: true });
    assert.equal(stale.devices[0].temperature.stale, true);
    assert.equal(telemetryHistoryPoint(stale).devices[0].temperature, null);
});

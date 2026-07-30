'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    presentUnifiDeviceTelemetry,
    telemetryHistoryRows
} = require('../server/services/unifi-device-telemetry');

const COLLECTED_AT = '2026-07-30T00:00:00.000Z';

function device(overrides = {}) {
    return {
        mac: 'AA:BB:CC:DD:EE:01', name: 'U7 Pro', model: 'U7PRO', type: 'uap', version: '8.0.7',
        ip: '192.168.1.20', state: 1, uptime: 1234, num_sta: 8,
        uplink: { uplink_mac: 'aa:bb:cc:dd:ee:ff', uplink_remote_port: 4, up: true, speed: 2500, full_duplex: true },
        rx_bytes: 1000, tx_bytes: 2000, rx_packets: 30, tx_packets: 40,
        rx_errors: 1, tx_errors: 2, rx_dropped: 3, tx_dropped: 4,
        'system-stats': { cpu: 28.5 },
        radio_table: [{ name: '5 GHz', radio: 'na', channel: 149, channel_width: 80, cu_total: 22, num_sta: 8 }],
        vap_table: [{ essid: '<img src=x onerror=alert(1)>', radio: 'na', up: true, num_sta: 8 }],
        ...overrides
    };
}

test('Controller telemetry normalizes stable identity, link, radio, counters, and explicit temperature', () => {
    const snapshot = presentUnifiDeviceTelemetry([device({ has_temperature: true, general_temperature: 62.5 })], { collectedAt: COLLECTED_AT });
    assert.equal(snapshot.devices.length, 1);
    const normalized = snapshot.devices[0];
    assert.equal(normalized.id, 'aa:bb:cc:dd:ee:01');
    assert.equal(normalized.online, true);
    assert.equal(normalized.uplink.speedMbps, 2500);
    assert.equal(normalized.uplink.duplex, 'full');
    assert.deepEqual(normalized.traffic, {
        rxBytes: 1000, txBytes: 2000, rxPackets: 30, txPackets: 40,
        rxErrors: 1, txErrors: 2, rxDropped: 3, txDropped: 4
    });
    assert.equal(normalized.radios[0].channel, 149);
    assert.equal(normalized.radios[0].utilizationPercent, 22);
    assert.equal(normalized.vaps[0].ssid, '<img src=x onerror=alert(1)>');
    assert.deepEqual(normalized.cpu, { value: 28.5, unit: 'percent', sourceField: 'system-stats.cpu' });
    assert.equal(normalized.temperature.value, 62.5);
    assert.equal(normalized.temperature.source, 'controller');
});

test('temperature truth gate rejects unsupported, out-of-range, and offline residual values', () => {
    const values = presentUnifiDeviceTelemetry([
        device({ mac: 'aa:bb:cc:dd:ee:01', has_temperature: false, general_temperature: 70 }),
        device({ mac: 'aa:bb:cc:dd:ee:02', has_temperature: true, general_temperature: 999 }),
        device({ mac: 'aa:bb:cc:dd:ee:03', state: 0, has_temperature: true, general_temperature: 61 })
    ], { collectedAt: COLLECTED_AT }).devices;
    assert.deepEqual(values.map(value => value.temperature.value), [null, null, null]);
    assert.deepEqual(values.map(value => value.temperature.status), ['unsupported', 'unavailable', 'offline']);
    const rows = telemetryHistoryRows({ collectedAt: COLLECTED_AT, stale: false, devices: values });
    assert.equal(rows[2].temperature, null);
});

test('SSH temperature is accepted only when selected, supported, fresh, and online', () => {
    const direct = new Map([['aa:bb:cc:dd:ee:01', {
        selected: true, status: 'supported', stale: false, hostKeyPinned: true,
        thermal: { maxTemperatureC: 88, cpuTemperatureC: 58.25, sampledAt: COLLECTED_AT, source: { path: '/sys/class/thermal/thermal_zone*/temp' }, zones: [{ zone: 'thermal_zone0' }] }
    }]]);
    const normalized = presentUnifiDeviceTelemetry([device({ has_temperature: false })], { collectedAt: COLLECTED_AT, directThermalByDevice: direct }).devices[0];
    assert.equal(normalized.temperature.value, 58.25);
    assert.equal(normalized.temperature.source, 'device_ssh');
    assert.equal(normalized.hostKeyPinned, true);
    direct.get(normalized.id).stale = true;
    const stale = presentUnifiDeviceTelemetry([device()], { collectedAt: COLLECTED_AT, directThermalByDevice: direct }).devices[0];
    assert.equal(stale.temperature.value, null);
    assert.equal(stale.temperature.status, 'stale');
});

test('malformed and duplicate Controller devices remain bounded and deterministic', () => {
    const snapshot = presentUnifiDeviceTelemetry([
        null, {}, device({ ip: 'not-an-ip', state: 0 }),
        device({ state: 1, ip: '192.168.1.20', radio_table: [{ channel: 36 }], 'system-stats': { cpu: 101 } }),
        device({ mac: '', _id: 'controller-id-only', ip: '', name: '\u0000Device' })
    ], { collectedAt: COLLECTED_AT });
    assert.equal(snapshot.devices.length, 2);
    const rich = snapshot.devices.find(value => value.id === 'aa:bb:cc:dd:ee:01');
    assert.equal(rich.online, true);
    assert.equal(rich.cpu, null);
    assert.equal(snapshot.devices.find(value => value.id === 'controller-id-only').ip, null);
});

test('missing Controller fields remain unknown and never become false, down, or zero', () => {
    const normalized = presentUnifiDeviceTelemetry([device({
        state: undefined, num_sta: undefined, uplink: {}, radio_table: [], vap_table: [],
        'system-stats': { cpu: null }, uptime: null
    })], { collectedAt: COLLECTED_AT }).devices[0];
    assert.equal(normalized.online, null);
    assert.equal(normalized.uplink.state, 'unknown');
    assert.equal(normalized.clientCount, null);
    assert.equal(normalized.cpu, null);
    assert.deepEqual(normalized.radios, []);
    assert.deepEqual(normalized.vaps, []);
});

test('stale snapshots produce no history rows', () => {
    assert.deepEqual(telemetryHistoryRows({ collectedAt: COLLECTED_AT, stale: true, devices: [device()] }), []);
});

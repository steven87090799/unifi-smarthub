'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseThermalZones } = require('../server/services/unifi-device-thermal');

test('thermal parser accepts bounded zones and derives max, average, and CPU temperature', () => {
    const result = parseThermalZones(`__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nsoc\n61500\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone1\nboard\n50000\n__ZONE_END__`, { sampledAt: '2026-07-30T00:00:00.000Z' });
    assert.equal(result.maxTemperatureC, 61.5);
    assert.equal(result.averageTemperatureC, 55.75);
    assert.equal(result.cpuTemperatureC, 61.5);
    assert.equal(result.zones.length, 2);
});

test('thermal parser rejects malformed, duplicate, negative, and impossible samples', () => {
    const result = parseThermalZones(`__ZONE_BEGIN__\n/sys/class/thermal/not-a-zone\nsoc\n60000\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nsoc\n-1\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone1\nsoc\n151000\n__ZONE_END__`);
    assert.equal(result, null);
});

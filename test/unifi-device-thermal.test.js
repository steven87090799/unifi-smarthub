'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseThermalZones } = require('../server/services/unifi-device-thermal');

const output = `noise\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\ncpu-thermal\n72700\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone1\nwifi\n76400\n__ZONE_END__\n`;

test('parses bounded thermal zones and identifies CPU/SoC only by explicit type', () => {
    const parsed = parseThermalZones(output, { sampledAt: '2026-07-29T00:00:00.000Z' });
    assert.equal(parsed.zones.length, 2);
    assert.equal(parsed.maxTemperatureC, 76.4);
    assert.equal(parsed.averageTemperatureC, 74.55);
    assert.equal(parsed.cpuTemperatureC, 72.7);
    assert.equal(parsed.source.verifiedSource, true);
});

test('ignores malformed, duplicate, negative, over-limit and control-character thermal zones', () => {
    const parsed = parseThermalZones(`__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nprocessor\n70000\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nprocessor\n71000\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone1\nfoo\n-1\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone2\nfoo\n151000\n__ZONE_END__\n__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone3\nfoo\nabc\n__ZONE_END__`);
    assert.equal(parsed.zones.length, 1);
    assert.equal(parsed.zones[0].temperatureC, 70);
    assert.equal(parsed.cpuTemperatureC, 70);
    assert.equal(parseThermalZones('__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nfoo\nabc\n__ZONE_END__'), null);
});

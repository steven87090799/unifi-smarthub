'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { THERMAL_READ_COMMAND, createUnifiDeviceThermalSshCollector, parseTargetIds } = require('../server/integrations/unifi-device-thermal-ssh');

const zoneOutput = '__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nsoc\n73000\n__ZONE_END__\n';

test('normalizes allowlist, uses a fixed readonly command, and refuses unselected/offline targets', async () => {
    assert.deepEqual(parseTargetIds('AA:BB:CC:DD:EE:FF, aa:bb:cc:dd:ee:ff'), ['aa:bb:cc:dd:ee:ff']);
    let command = null;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => ({ UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_TARGET_IDS: 'aa:bb:cc:dd:ee:ff' }),
        createPool: () => ({ execute: async value => { command = value; return zoneOutput; }, close() {} })
    });
    const result = await collector.collect({ mac: 'AA:BB:CC:DD:EE:FF', state: 1, ip: '192.168.1.2' });
    assert.equal(result.thermal.maxTemperatureC, 73);
    assert.equal(command, THERMAL_READ_COMMAND);
    assert.deepEqual(await collector.collect({ mac: '11:22:33:44:55:66', state: 1, ip: '192.168.1.3' }), { errorCode: 'not_selected' });
    assert.deepEqual(await collector.collect({ mac: 'AA:BB:CC:DD:EE:FF', state: 0, ip: '192.168.1.2' }), { errorCode: 'device_offline' });
});

test('limits independent device SSH work to two concurrent connections', async () => {
    let running = 0, maximum = 0;
    const collector = createUnifiDeviceThermalSshCollector({
        maxConcurrent: 2,
        getEnvironment: () => ({ UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_TARGET_IDS: 'aa:bb:cc:dd:ee:01,aa:bb:cc:dd:ee:02,aa:bb:cc:dd:ee:03' }),
        createPool: () => ({ execute: async () => { running += 1; maximum = Math.max(maximum, running); await new Promise(resolve => setTimeout(resolve, 5)); running -= 1; return zoneOutput; }, close() {} })
    });
    await Promise.all(['01', '02', '03'].map(suffix => collector.collect({ mac: `AA:BB:CC:DD:EE:${suffix}`, state: 1, ip: `192.168.1.${Number(suffix)}` })));
    assert.equal(maximum, 2);
});

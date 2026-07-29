'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    THERMAL_READ_COMMAND, createUnifiDeviceThermalSshCollector, managementIp, parseTargetIds, safeManagementIp
} = require('../server/integrations/unifi-device-thermal-ssh');

const zoneOutput = '__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nsoc\n73000\n__ZONE_END__\n';
const target = 'aa:bb:cc:dd:ee:ff';
const device = (ip = '192.168.1.20', suffix = 'ff') => ({ mac: `aa:bb:cc:dd:ee:${suffix}`, state: 1, ip });

test('normalizes allowlist, uses a fixed readonly command, and rejects unsafe management addresses', async () => {
    assert.deepEqual(parseTargetIds('AA:BB:CC:DD:EE:FF, aa:bb:cc:dd:ee:ff'), [target]);
    for (const value of ['0.0.0.0', '255.255.255.255', '127.0.0.1', '224.0.0.1', '::', '::1', 'ff02::1', 'router.local']) assert.equal(safeManagementIp(value), null);
    assert.equal(managementIp({ ip: '127.0.0.1', last_ip: '192.168.1.20' }), '192.168.1.20');
    let command = null;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => ({ UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_TARGET_IDS: target }),
        createPool: () => ({ execute: async value => { command = value; return zoneOutput; }, close() {} })
    });
    const result = await collector.collect(device());
    assert.equal(result.thermal.maxTemperatureC, 73);
    assert.equal(command, THERMAL_READ_COMMAND);
    assert.deepEqual(await collector.collect(device('192.168.1.3', '66')), { errorCode: 'not_selected' });
    assert.deepEqual(await collector.collect({ ...device(), state: 0 }), { errorCode: 'device_offline' });
    assert.deepEqual(await collector.collect(device('127.0.0.1')), { errorCode: 'management_ip_missing' });
});

test('rebuilds the pool before collection when management IP, port, or username changes', async () => {
    const env = { UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_PORT: '22', UNIFI_DEVICE_SSH_TARGET_IDS: target };
    const created = [], closed = [];
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => env,
        createPool: ({ getConfig }) => {
            const config = getConfig(); created.push(config);
            return { execute: async () => zoneOutput, close: () => closed.push(config.host) };
        }
    });
    await collector.collect(device('192.168.1.20'));
    await collector.collect(device('192.168.1.35'));
    env.UNIFI_DEVICE_SSH_PORT = '2222';
    await collector.collect(device('192.168.1.35'));
    env.UNIFI_DEVICE_SSH_USER = 'new-monitor';
    await collector.collect(device('192.168.1.35'));
    assert.deepEqual(created.map(config => config.host), ['192.168.1.20', '192.168.1.35', '192.168.1.35', '192.168.1.35']);
    assert.equal(closed.filter(host => host === '192.168.1.20').length, 1);
    assert.deepEqual(created.map(config => [config.port, config.username]), [[22, 'monitor'], [22, 'monitor'], [2222, 'monitor'], [2222, 'new-monitor']]);
});

test('an old in-flight host result is discarded when the controller reports a new management IP', async () => {
    let releaseOld;
    const oldStarted = new Promise(resolve => { releaseOld = resolve; });
    const created = [], closed = [];
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => ({ UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_TARGET_IDS: target }),
        createPool: ({ getConfig }) => {
            const config = getConfig(); created.push(config.host);
            return { execute: async () => {
                if (config.host === '192.168.1.20') await oldStarted;
                return zoneOutput;
            }, close: () => closed.push(config.host) };
        }
    });
    const oldResult = collector.collect(device('192.168.1.20'));
    await new Promise(resolve => setImmediate(resolve));
    const newResult = collector.collect(device('192.168.1.35'));
    releaseOld();
    assert.deepEqual(await oldResult, { errorCode: 'configuration_changed', discarded: true });
    assert.equal((await newResult).managementIp, '192.168.1.35');
    assert.deepEqual(created, ['192.168.1.20', '192.168.1.35']);
    assert.deepEqual(closed, ['192.168.1.20']);
});

test('reset cancels queued work, discards an old inflight result, and permits a new generation', async () => {
    const env = { UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'old-password', UNIFI_DEVICE_SSH_TARGET_IDS: 'aa:bb:cc:dd:ee:01,aa:bb:cc:dd:ee:02' };
    let releaseFirst;
    const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
    const created = [];
    let executions = 0;
    const collector = createUnifiDeviceThermalSshCollector({
        maxConcurrent: 1,
        getEnvironment: () => env,
        createPool: ({ getConfig }) => {
            const config = getConfig(); created.push(config);
            return { execute: async () => {
                executions += 1;
                if (executions === 1) { await firstStarted; return zoneOutput; }
                return zoneOutput;
            }, close() {} };
        }
    });
    const first = collector.collect(device('192.168.1.20', '01'));
    await new Promise(resolve => setImmediate(resolve));
    const queued = collector.collect(device('192.168.1.21', '02'));
    env.UNIFI_DEVICE_SSH_PASSWORD = 'new-password';
    collector.reset();
    assert.deepEqual(await queued, { errorCode: 'configuration_changed', discarded: true });
    releaseFirst();
    assert.deepEqual(await first, { errorCode: 'configuration_changed', discarded: true });
    const fresh = await collector.collect(device('192.168.1.21', '02'));
    assert.equal(fresh.thermal.maxTemperatureC, 73);
    assert.equal(created.at(-1).password, 'new-password');
    assert.equal(collector.status().activeConnections, 0);
});

test('a reset-caused pool rejection is discarded as configuration_changed instead of unknown_error', async () => {
    let rejectExecute;
    let poolClosed = 0;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => ({ UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_TARGET_IDS: target }),
        createPool: () => ({
            execute: () => new Promise((_resolve, reject) => { rejectExecute = reject; }),
            close: () => { poolClosed += 1; rejectExecute(new Error('connection closed')); }
        })
    });
    const result = collector.collect(device());
    await new Promise(resolve => setImmediate(resolve));
    collector.reset();
    assert.deepEqual(await result, { errorCode: 'configuration_changed', discarded: true });
    assert.equal(poolClosed, 1);
    assert.equal(collector.status().activeConnections, 0);
    assert.equal(collector.status().running, 0);
});

test('limits independent device SSH work to two concurrent connections', async () => {
    let running = 0, maximum = 0;
    const collector = createUnifiDeviceThermalSshCollector({
        maxConcurrent: 2,
        getEnvironment: () => ({ UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret', UNIFI_DEVICE_SSH_TARGET_IDS: 'aa:bb:cc:dd:ee:01,aa:bb:cc:dd:ee:02,aa:bb:cc:dd:ee:03' }),
        createPool: () => ({ execute: async () => { running += 1; maximum = Math.max(maximum, running); await new Promise(resolve => setTimeout(resolve, 5)); running -= 1; return zoneOutput; }, close() {} })
    });
    await Promise.all(['01', '02', '03'].map(suffix => collector.collect(device(`192.168.1.${Number(suffix)}`, suffix))));
    assert.equal(maximum, 2);
});

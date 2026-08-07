'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
    COMMAND_OUTPUT_BYTES,
    COMMAND_TIMEOUT_MS,
    THERMAL_READ_COMMAND,
    createUnifiDeviceThermalSshCollector,
    hostVerifier,
    managementIp,
    parseHostKeys,
    parseTargetIds,
    safeManagementIp,
    statusFromError
} = require('../server/integrations/unifi-device-thermal-ssh');

const IDS = Array.from({ length: 33 }, (_, index) => `02:00:00:00:00:${index.toString(16).padStart(2, '0')}`);
const THERMAL_OUTPUT = '__ZONE_BEGIN__\n/sys/class/thermal/thermal_zone0\nsoc\n61500\n__ZONE_END__\n';

function configuredEnv(overrides = {}) {
    return {
        UNIFI_DEVICE_SSH_PORT: '22', UNIFI_DEVICE_SSH_USER: 'monitor', UNIFI_DEVICE_SSH_PASSWORD: 'secret',
        UNIFI_DEVICE_SSH_TARGET_IDS: IDS[0], UNIFI_DEVICE_SSH_HOST_KEYS: '', ...overrides
    };
}

function knownDevice(id = IDS[0], ip = '192.168.1.20', overrides = {}) {
    return { mac: id, ip, state: 1, ...overrides };
}

test('device allowlist is canonical, deduplicated, and fails closed above 32 entries', () => {
    assert.deepEqual(parseTargetIds(`${IDS[0].toUpperCase()},${IDS[0]}`), [IDS[0]]);
    assert.equal(parseTargetIds(IDS.join(',')).length, 0);
    assert.deepEqual(parseTargetIds('not-a-mac'), []);
});

test('management target accepts literal unicast IPv4 and IPv6 only', () => {
    assert.equal(safeManagementIp('192.168.1.20'), '192.168.1.20');
    assert.equal(safeManagementIp('2001:db8::20'), '2001:db8::20');
    for (const target of ['localhost', '127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '169.254.1.1', '::', '::1', 'ff02::1', 'fe80::1', '[::1]', '192.168.1.2%lo0']) {
        assert.equal(safeManagementIp(target), null, target);
    }
    assert.equal(managementIp({ ip: 'bad', last_ip: '192.168.1.9' }), '192.168.1.9');
});

test('host keys validate exact per-device SHA256 fingerprints with constant-time verifier behavior', () => {
    const key = Buffer.from('test-host-key');
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
    const parsed = parseHostKeys(`${IDS[0]}=${fingerprint}`);
    assert.equal(parsed.get(IDS[0]), fingerprint);
    assert.equal(hostVerifier(fingerprint)(key), true);
    assert.equal(hostVerifier(fingerprint)(Buffer.from('other-host-key')), false);
    assert.equal(parseHostKeys(`${IDS[0]}=SHA256:bad`).size, 0);
});

test('collector executes only the fixed bounded command and passes host verification without leaking metadata to the pool contract', async () => {
    const key = Buffer.from('device-host-key');
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
    const env = configuredEnv({ UNIFI_DEVICE_SSH_HOST_KEYS: `${IDS[0]}=${fingerprint}` });
    let poolOptions;
    let command;
    let executeOptions;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => env,
        createPool: options => {
            poolOptions = options;
            return { execute: async (value, bounded) => { command = value; executeOptions = bounded; return THERMAL_OUTPUT; }, close() {} };
        },
        now: () => '2026-07-30T00:00:00.000Z'
    });
    const result = await collector.collect(knownDevice());
    assert.equal(result.status, 'supported');
    assert.equal(result.thermal.maxTemperatureC, 61.5);
    assert.equal(command, THERMAL_READ_COMMAND);
    assert.deepEqual(executeOptions, { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: COMMAND_OUTPUT_BYTES });
    const config = poolOptions.getConfig();
    assert.equal(config.host, '192.168.1.20');
    assert.equal(config.hostVerifier(key), true);
    assert.equal(result.hostKeyPinned, true);
    assert.equal(collector.diagnostics().transportMode, 'verified');
    assert.doesNotMatch(JSON.stringify(collector.diagnostics()), /secret|SHA256:/u);
    collector.close();
});

test('Trusted LAN device SSH accepts private unpinned targets but rejects public management targets', async () => {
    const privateEnv = configuredEnv({ NODE_ENV: 'production', TRUSTED_LAN_MODE: 'true' });
    let privatePoolOptions;
    const privateCollector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => privateEnv,
        createPool: options => {
            privatePoolOptions = options;
            return { execute: async () => THERMAL_OUTPUT, close() {} };
        }
    });
    const privateResult = await privateCollector.collect(knownDevice(IDS[0], '192.168.1.20'));
    assert.equal(privateResult.status, 'supported');
    assert.equal(privatePoolOptions.getConfig().hostVerifier, undefined);
    assert.equal(privateCollector.diagnostics().trustedLanMode, true);
    assert.equal(privateCollector.diagnostics().transportMode, 'trusted-lan-insecure');
    privateCollector.close();

    const publicEnv = configuredEnv({ NODE_ENV: 'production', TRUSTED_LAN_MODE: 'true' });
    const publicCollector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => publicEnv,
        createPool: () => ({ execute: async () => THERMAL_OUTPUT, close() {} })
    });
    const publicResult = await publicCollector.collect(knownDevice(IDS[0], '8.8.8.8'));
    assert.equal(publicResult.status, 'not_configured');
    assert.equal(publicResult.errorReason, 'trusted_lan_target_required');
    assert.equal(publicCollector.diagnostics().transportMode, 'unconfigured');
    publicCollector.close();
});

test('collector requires Controller-known online selected devices and retains no false temperature', async () => {
    let executions = 0;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => configuredEnv(),
        createPool: () => ({ execute: async () => { executions += 1; return ''; }, close() {} })
    });
    assert.equal((await collector.collect(knownDevice(IDS[1]))).selected, false);
    assert.equal((await collector.collect(knownDevice(IDS[0], '127.0.0.1'))).status, 'unavailable');
    assert.equal((await collector.collect(knownDevice(IDS[0], '192.168.1.20', { state: 0 }))).status, 'offline');
    assert.equal(executions, 0);
    collector.close();
});

test('collector singleflights per device and never runs more than two SSH jobs', async () => {
    const env = configuredEnv({ UNIFI_DEVICE_SSH_TARGET_IDS: IDS.slice(0, 3).join(',') });
    const releases = [];
    let active = 0;
    let peak = 0;
    let executeCalls = 0;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => env,
        createPool: () => ({
            execute: () => new Promise(resolve => {
                executeCalls += 1;
                active += 1;
                peak = Math.max(peak, active);
                releases.push(() => { active -= 1; resolve(THERMAL_OUTPUT); });
            }),
            close() {}
        })
    });
    const first = collector.collect(knownDevice(IDS[0], '192.168.1.20'));
    const duplicate = collector.collect(knownDevice(IDS[0], '192.168.1.20'));
    const second = collector.collect(knownDevice(IDS[1], '192.168.1.21'));
    const third = collector.collect(knownDevice(IDS[2], '192.168.1.22'));
    assert.equal(first, duplicate);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executeCalls, 2);
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executeCalls, 3);
    releases.splice(0).forEach(release => release());
    await Promise.all([first, duplicate, second, third]);
    assert.equal(peak, 2);
    collector.close();
});

test('configuration rotation closes old candidates and discards their late completion', async () => {
    const env = configuredEnv();
    const pools = [];
    let release;
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => env,
        createPool: () => {
            const pool = { closed: 0, execute: () => new Promise(resolve => { release = resolve; }), close() { this.closed += 1; } };
            pools.push(pool);
            return pool;
        }
    });
    const pending = collector.collect(knownDevice());
    await new Promise(resolve => setImmediate(resolve));
    env.UNIFI_DEVICE_SSH_PORT = '2222';
    collector.diagnostics();
    assert.equal(pools[0].closed, 1);
    release(THERMAL_OUTPUT);
    assert.deepEqual(await pending, { status: 'unavailable', discarded: true, errorReason: 'configuration_changed' });
    collector.close();
});

test('authentication, host mismatch, timeout, command failure, and unsupported output remain distinct', async () => {
    assert.equal(statusFromError(Object.assign(new Error('Permission denied'), { code: 'AUTH_FAILED' })), 'authentication_failed');
    assert.equal(statusFromError(new Error('Host key verification failed')), 'host_key_mismatch');
    assert.equal(statusFromError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), 'timeout');
    assert.equal(statusFromError(new Error('command failed')), 'unavailable');
    for (const [error, expected] of [[new Error('Permission denied'), 'authentication_failed'], [new Error('Host key verification failed'), 'host_key_mismatch'], [new Error('command timeout'), 'timeout']]) {
        const collector = createUnifiDeviceThermalSshCollector({ getEnvironment: () => configuredEnv(), createPool: () => ({ execute: async () => { throw error; }, close() {} }) });
        assert.equal((await collector.collect(knownDevice())).status, expected);
        collector.close();
    }
    const unsupported = createUnifiDeviceThermalSshCollector({ getEnvironment: () => configuredEnv(), createPool: () => ({ execute: async () => 'no zones', close() {} }) });
    assert.equal((await unsupported.collect(knownDevice())).status, 'unsupported');
    unsupported.close();
});

test('shutdown cancels queued work and is idempotent', async () => {
    const env = configuredEnv({ UNIFI_DEVICE_SSH_TARGET_IDS: IDS.slice(0, 3).join(',') });
    const releases = [];
    const pools = [];
    const collector = createUnifiDeviceThermalSshCollector({
        getEnvironment: () => env,
        createPool: () => {
            const pool = { endCalls: 0, execute: () => new Promise(resolve => releases.push(() => resolve(THERMAL_OUTPUT))), close() { this.endCalls += 1; } };
            pools.push(pool);
            return pool;
        }
    });
    const tasks = IDS.slice(0, 3).map((id, index) => collector.collect(knownDevice(id, `192.168.1.${20 + index}`)));
    await new Promise(resolve => setImmediate(resolve));
    collector.close();
    collector.close();
    assert.equal((await tasks[2]).discarded, true);
    releases.splice(0).forEach(release => release());
    const active = await Promise.all(tasks.slice(0, 2));
    assert.ok(active.every(result => result.discarded));
    assert.ok(pools.every(pool => pool.endCalls === 1));
});

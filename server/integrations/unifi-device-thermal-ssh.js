'use strict';

const net = require('node:net');
const { createSshConnectionPool } = require('./ssh-connection-pool');
const { parseThermalZones } = require('../services/unifi-device-thermal');

const THERMAL_READ_COMMAND = 'for z in /sys/class/thermal/thermal_zone*; do\n'
    + '    [ -r "$z/temp" ] || continue\n'
    + '    echo "__ZONE_BEGIN__"\n'
    + '    echo "$z"\n'
    + '    cat "$z/type" 2>/dev/null || true\n'
    + '    cat "$z/temp" 2>/dev/null || true\n'
    + '    echo "__ZONE_END__"\n'
    + 'done';
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu;

function normalizeDeviceId(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return MAC.test(normalized) ? normalized : null;
}

function parseTargetIds(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const targets = value.split(',').map(normalizeDeviceId);
    if (targets.some(target => !target)) return [];
    return [...new Set(targets)].slice(0, 32);
}

function safeManagementIp(value) {
    const host = typeof value === 'string' ? value.trim() : '';
    const family = net.isIP(host);
    if (!family) return null;
    if (family === 4) {
        const octets = host.split('.').map(Number);
        if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224
            || octets.every(octet => octet === 255)) return null;
    } else {
        const normalized = host.toLowerCase();
        if (normalized === '::' || normalized === '::1' || normalized.startsWith('ff')) return null;
    }
    return host;
}

function managementIp(device) {
    for (const key of ['ip', 'last_ip']) {
        const host = safeManagementIp(device?.[key]);
        if (host) return host;
    }
    return null;
}

function online(device) {
    return device?.state === 1 || device?.state === '1' || String(device?.state).toLowerCase() === 'connected';
}

function errorCode(error) {
    const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    if (/auth|authentication|permission denied/.test(text)) return 'authentication_failed';
    if (/command/.test(text) && /timed? ?out|timeout/.test(text)) return 'command_timeout';
    if (/timed? ?out|timeout/.test(text)) return 'connection_timeout';
    if (/refused/.test(text)) return 'connection_refused';
    return 'unknown_error';
}

function createPoolIdentity({ host, port, username, generation }) {
    return `${host}|${port}|${username}|${generation}`;
}

function createUnifiDeviceThermalSshCollector({
    getEnvironment = () => process.env,
    createPool = createSshConnectionPool,
    parse = parseThermalZones,
    now = () => new Date().toISOString(),
    maxConcurrent = 2
} = {}) {
    const pools = new Map();
    const inflight = new Map();
    const deviceEpochs = new Map();
    const queue = [];
    let active = 0;
    let configurationGeneration = 0;
    let configurationFingerprint = null;

    function environment() {
        const env = getEnvironment() || {};
        const targetIds = parseTargetIds(env.UNIFI_DEVICE_SSH_TARGET_IDS);
        const user = typeof env.UNIFI_DEVICE_SSH_USER === 'string' ? env.UNIFI_DEVICE_SSH_USER.trim() : '';
        const password = typeof env.UNIFI_DEVICE_SSH_PASSWORD === 'string' ? env.UNIFI_DEVICE_SSH_PASSWORD : '';
        const candidatePort = Number(env.UNIFI_DEVICE_SSH_PORT || 22);
        const port = Number.isSafeInteger(candidatePort) && candidatePort > 0 && candidatePort <= 65535 ? candidatePort : 22;
        return { targetIds, user, password, port };
    }

    function fingerprint(config) {
        return JSON.stringify([config.port, config.user, config.password, config.targetIds]);
    }

    function closePoolEntry(entry) {
        try { entry?.pool?.close(); } catch { }
    }

    function cancelQueuedTasks() {
        while (queue.length) {
            const queued = queue.shift();
            queued.resolve({ errorCode: 'configuration_changed', discarded: true });
        }
    }

    function closeAllPools() {
        pools.forEach(closePoolEntry);
        pools.clear();
    }

    function invalidateConfiguration() {
        configurationGeneration += 1;
        cancelQueuedTasks();
        closeAllPools();
    }

    function currentConfiguration() {
        const config = environment();
        const nextFingerprint = fingerprint(config);
        if (configurationFingerprint !== null && configurationFingerprint !== nextFingerprint) invalidateConfiguration();
        configurationFingerprint = nextFingerprint;
        return { ...config, generation: configurationGeneration };
    }

    function runLimited(task) {
        return new Promise(resolve => {
            const start = () => {
                active += 1;
                Promise.resolve().then(task).then(resolve, error => resolve({ errorCode: errorCode(error) })).finally(() => {
                    active -= 1;
                    const next = queue.shift();
                    if (next) next.start();
                });
            };
            if (active < maxConcurrent) start(); else queue.push({ start, resolve });
        });
    }

    function configured(config = currentConfiguration()) {
        return !!(config.targetIds.length && config.user && config.password && !/your_/iu.test(config.password));
    }

    function closeDevice(deviceId) {
        const id = normalizeDeviceId(deviceId);
        if (!id) return;
        const entry = pools.get(id);
        closePoolEntry(entry);
        pools.delete(id);
    }

    function poolFor(id, host, config) {
        const identity = createPoolIdentity({ host, port: config.port, username: config.user, generation: config.generation });
        const existing = pools.get(id);
        if (existing?.identity === identity) return existing.pool;
        if (existing) closeDevice(id);
        const pool = createPool({
            getConfig: () => ({ host, port: config.port, username: config.user, password: config.password })
        });
        pools.set(id, { pool, deviceId: id, host, port: config.port, username: config.user, configurationGeneration: config.generation, identity });
        return pool;
    }

    function deviceEpoch(id) {
        return deviceEpochs.get(id) || 0;
    }

    async function collect(device) {
        const id = normalizeDeviceId(device?.mac || device?._id);
        const config = currentConfiguration();
        if (!configured(config)) return { errorCode: 'not_configured' };
        if (!id || !config.targetIds.includes(id)) return { errorCode: 'not_selected' };
        if (!online(device)) return { errorCode: 'device_offline' };
        const host = managementIp(device);
        if (!host) return { errorCode: 'management_ip_missing' };
        const identity = createPoolIdentity({ host, port: config.port, username: config.user, generation: config.generation });
        const existing = inflight.get(id);
        if (existing?.generation === config.generation && existing.identity === identity) return existing.promise;
        if (existing) {
            deviceEpochs.set(id, deviceEpoch(id) + 1);
            closeDevice(id);
        }
        const taskGeneration = config.generation;
        const taskEpoch = deviceEpoch(id);
        const promise = runLimited(async () => {
            if (taskGeneration !== currentConfiguration().generation || taskEpoch !== deviceEpoch(id)) return { errorCode: 'configuration_changed', discarded: true };
            const pool = poolFor(id, host, config);
            try {
                const output = await pool.execute(THERMAL_READ_COMMAND);
                if (taskGeneration !== currentConfiguration().generation || taskEpoch !== deviceEpoch(id)) return { errorCode: 'configuration_changed', discarded: true };
                const thermal = parse(output, { sampledAt: now() });
                return thermal ? { thermal, managementIp: host, configurationGeneration: taskGeneration }
                    : { errorCode: 'no_thermal_zone', managementIp: host };
            } catch (error) {
                closeDevice(id);
                return { errorCode: errorCode(error), managementIp: host };
            }
        });
        const record = { generation: taskGeneration, identity, promise };
        inflight.set(id, record);
        promise.finally(() => { if (inflight.get(id) === record) inflight.delete(id); });
        return promise;
    }

    function reset() {
        invalidateConfiguration();
        configurationFingerprint = fingerprint(environment());
    }

    function closeAll() {
        reset();
    }

    function status() {
        const config = currentConfiguration();
        return { configured: configured(config), selectedDeviceCount: config.targetIds.length, running: inflight.size, activeConnections: active, configurationGeneration: config.generation };
    }

    return Object.freeze({
        collect, closeDevice, closeAll, reset, status, configured,
        parseTargetIds: () => currentConfiguration().targetIds,
        getConfigurationGeneration: () => currentConfiguration().generation
    });
}

module.exports = {
    THERMAL_READ_COMMAND, createPoolIdentity, createUnifiDeviceThermalSshCollector,
    errorCode, managementIp, normalizeDeviceId, parseTargetIds, safeManagementIp
};

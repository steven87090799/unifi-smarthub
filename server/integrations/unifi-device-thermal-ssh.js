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

function managementIp(device) {
    for (const key of ['ip', 'last_ip']) {
        const value = typeof device?.[key] === 'string' ? device[key].trim() : '';
        if (net.isIP(value)) return value;
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

function createUnifiDeviceThermalSshCollector({
    getEnvironment = () => process.env,
    createPool = createSshConnectionPool,
    parse = parseThermalZones,
    now = () => new Date().toISOString(),
    maxConcurrent = 2
} = {}) {
    const pools = new Map();
    const inflight = new Map();
    let active = 0;
    const queue = [];
    const runLimited = task => new Promise((resolve, reject) => {
        const start = () => {
            active += 1;
            Promise.resolve().then(task).then(resolve, reject).finally(() => {
                active -= 1;
                const next = queue.shift();
                if (next) next();
            });
        };
        if (active < maxConcurrent) start(); else queue.push(start);
    });
    function environment() {
        const env = getEnvironment() || {};
        const targetIds = parseTargetIds(env.UNIFI_DEVICE_SSH_TARGET_IDS);
        const user = typeof env.UNIFI_DEVICE_SSH_USER === 'string' ? env.UNIFI_DEVICE_SSH_USER.trim() : '';
        const password = typeof env.UNIFI_DEVICE_SSH_PASSWORD === 'string' ? env.UNIFI_DEVICE_SSH_PASSWORD : '';
        const port = Number(env.UNIFI_DEVICE_SSH_PORT || 22);
        return { targetIds, user, password, port: Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : 22 };
    }
    function configured() {
        const env = environment();
        return !!(env.targetIds.length && env.user && env.password && !/your_/iu.test(env.password));
    }
    function closeDevice(deviceId) {
        const id = normalizeDeviceId(deviceId);
        if (!id) return;
        pools.get(id)?.close();
        pools.delete(id);
    }
    function closeAll() {
        pools.forEach(pool => pool.close());
        pools.clear();
    }
    async function collect(device) {
        const id = normalizeDeviceId(device?.mac || device?._id);
        const env = environment();
        if (!env.user || !env.password || /your_/iu.test(env.password)) return { errorCode: 'not_configured' };
        if (!id || !env.targetIds.includes(id)) return { errorCode: 'not_selected' };
        if (!online(device)) return { errorCode: 'device_offline' };
        const host = managementIp(device);
        if (!host) return { errorCode: 'management_ip_missing' };
        if (inflight.has(id)) return inflight.get(id);
        const work = runLimited(async () => {
            let pool = pools.get(id);
            if (!pool) {
                pool = createPool({ getConfig: () => ({ host, port: env.port, username: env.user, password: env.password }) });
                pools.set(id, pool);
            }
            try {
                const output = await pool.execute(THERMAL_READ_COMMAND);
                const thermal = parse(output, { sampledAt: now() });
                return thermal ? { thermal, managementIp: host } : { errorCode: 'no_thermal_zone', managementIp: host };
            } catch (error) {
                closeDevice(id);
                return { errorCode: errorCode(error), managementIp: host };
            }
        }).finally(() => inflight.delete(id));
        inflight.set(id, work);
        return work;
    }
    function status() {
        const env = environment();
        return { configured: configured(), selectedDeviceCount: env.targetIds.length, running: inflight.size, activeConnections: active };
    }
    return Object.freeze({ collect, closeDevice, closeAll, reset: closeAll, status, configured, parseTargetIds: () => environment().targetIds });
}

module.exports = { THERMAL_READ_COMMAND, createUnifiDeviceThermalSshCollector, errorCode, managementIp, normalizeDeviceId, parseTargetIds };

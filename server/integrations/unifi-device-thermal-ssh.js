'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const net = require('node:net');
const { createSshConnectionPool } = require('./ssh-connection-pool');
const { parseThermalZones } = require('../services/unifi-device-thermal');
const {
    isTrustedLanEndpoint,
    strictBoolean: trustedLanBoolean
} = require('./trusted-lan-policy');

const THERMAL_READ_COMMAND = 'for z in /sys/class/thermal/thermal_zone*; do\n'
    + '  [ -r "$z/temp" ] || continue\n'
    + '  echo "__ZONE_BEGIN__"\n'
    + '  echo "$z"\n'
    + '  cat "$z/type" 2>/dev/null || true\n'
    + '  cat "$z/temp" 2>/dev/null || true\n'
    + '  echo "__ZONE_END__"\n'
    + 'done';
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu;
const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/u;
const COMMAND_TIMEOUT_MS = 12_000;
const COMMAND_OUTPUT_BYTES = 128 * 1024;

function normalizeDeviceId(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return MAC.test(normalized) ? normalized : null;
}

function parseTargetIds(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
    if (entries.length > 32) return [];
    const targets = entries.map(normalizeDeviceId);
    if (targets.some(target => !target)) return [];
    return [...new Set(targets)];
}

function parseIpv4(value) {
    return net.isIP(value) === 4 ? value.split('.').map(Number) : null;
}

function unsafeIpv4(octets) {
    return !octets || octets[0] === 0 || octets[0] === 127 || octets[0] >= 224
        || (octets[0] === 169 && octets[1] === 254)
        || octets.every(octet => octet === 255);
}

function ipv6Bytes(value) {
    let address = value.toLowerCase();
    const dottedIndex = address.lastIndexOf(':');
    if (address.includes('.')) {
        const octets = parseIpv4(address.slice(dottedIndex + 1));
        if (!octets) return null;
        address = `${address.slice(0, dottedIndex)}${(octets[0] * 256 + octets[1]).toString(16)}:${(octets[2] * 256 + octets[3]).toString(16)}`;
    }
    const halves = address.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    const bytes = [];
    for (const group of [...left, ...Array(missing).fill('0'), ...right]) {
        const numeric = Number.parseInt(group, 16);
        bytes.push(numeric >> 8, numeric & 0xff);
    }
    return bytes.length === 16 ? bytes : null;
}

function allZero(bytes, count) {
    return bytes.slice(0, count).every(byte => byte === 0);
}

function unsafeIpv6(host) {
    const bytes = ipv6Bytes(host);
    if (!bytes || bytes.every(byte => byte === 0)) return true;
    if (allZero(bytes, 15) && bytes[15] === 1) return true;
    if (bytes[0] === 0xff) return true;
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
    const mapped = allZero(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
    const compatible = allZero(bytes, 12);
    if ((mapped || compatible) && unsafeIpv4(bytes.slice(12))) return true;
    return host.includes('.') && unsafeIpv4(parseIpv4(host.slice(host.lastIndexOf(':') + 1)));
}

function safeManagementIp(value) {
    const host = typeof value === 'string' ? value.trim() : '';
    if (!host || /[%\[\]/@]/u.test(host)) return null;
    const family = net.isIP(host);
    if (!family) return null;
    if (family === 4 ? unsafeIpv4(parseIpv4(host)) : unsafeIpv6(host)) return null;
    return host;
}

function managementIp(device) {
    for (const key of ['ip', 'last_ip']) {
        const host = safeManagementIp(device?.[key]);
        if (host) return host;
    }
    return null;
}

function parseHostKeys(value) {
    if (typeof value !== 'string' || !value.trim()) return new Map();
    const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
    if (entries.length > 32) return new Map();
    const keys = new Map();
    for (const entry of entries) {
        const separator = entry.indexOf('=');
        const id = normalizeDeviceId(separator > 0 ? entry.slice(0, separator) : '');
        const fingerprint = separator > 0 ? entry.slice(separator + 1) : '';
        if (!id || !HOST_KEY_FINGERPRINT.test(fingerprint) || keys.has(id)) return new Map();
        keys.set(id, fingerprint.replace(/=+$/u, ''));
    }
    return keys;
}

function hostKeysConfigurationValid(value) {
    if (typeof value !== 'string' || !value.trim()) return true;
    const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
    return entries.length > 0 && entries.length <= 32 && parseHostKeys(value).size === entries.length;
}

function hostVerifier(expectedFingerprint) {
    if (!HOST_KEY_FINGERPRINT.test(expectedFingerprint || '')) return null;
    const expected = Buffer.from(expectedFingerprint.replace(/=+$/u, ''));
    return key => {
        const actual = Buffer.from(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`);
        return expected.length === actual.length && timingSafeEqual(expected, actual);
    };
}

function online(device) {
    return device?.state === 1 || device?.state === '1' || String(device?.state).toLowerCase() === 'connected';
}

function statusFromError(error) {
    const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    if (/host.*key|host.*verif|host_key_mismatch/u.test(text)) return 'host_key_mismatch';
    if (/auth|authentication|permission denied/u.test(text)) return 'authentication_failed';
    if (/timed? ?out|timeout|ssh_command_timeout/u.test(text)) return 'timeout';
    return 'unavailable';
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
    const cache = new Map();
    const queue = [];
    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrent) || 2));
    let active = 0;
    let generation = 0;
    let configurationKey = null;
    let closed = false;

    function environment() {
        const env = getEnvironment() || {};
        const targetIds = parseTargetIds(env.UNIFI_DEVICE_SSH_TARGET_IDS);
        const username = typeof env.UNIFI_DEVICE_SSH_USER === 'string' ? env.UNIFI_DEVICE_SSH_USER.trim() : '';
        const password = typeof env.UNIFI_DEVICE_SSH_PASSWORD === 'string' ? env.UNIFI_DEVICE_SSH_PASSWORD : '';
        const hostKeysRaw = typeof env.UNIFI_DEVICE_SSH_HOST_KEYS === 'string' ? env.UNIFI_DEVICE_SSH_HOST_KEYS : '';
        const hostKeys = parseHostKeys(hostKeysRaw);
        const trustedLanMode = trustedLanBoolean(env.TRUSTED_LAN_MODE, 'TRUSTED_LAN_MODE', false);
        const trustedLanHosts = typeof env.TRUSTED_LAN_HOSTS === 'string' ? env.TRUSTED_LAN_HOSTS : '';
        // Development/unit-test environments retain the legacy optional
        // behavior; production requires an explicit pin or an explicit true.
        const allowUnpinned = env.UNIFI_DEVICE_SSH_ALLOW_UNPINNED === true
            || env.UNIFI_DEVICE_SSH_ALLOW_UNPINNED === 'true'
            || (!env.NODE_ENV || env.NODE_ENV !== 'production');
        const candidatePort = Number(env.UNIFI_DEVICE_SSH_PORT || 22);
        const port = Number.isSafeInteger(candidatePort) && candidatePort > 0 && candidatePort <= 65535 ? candidatePort : 22;
        return {
            targetIds, username, password, port, hostKeys, allowUnpinned,
            trustedLanMode, trustedLanHosts,
            hostKeysValid: hostKeysConfigurationValid(hostKeysRaw)
        };
    }

    function key(config) {
        return JSON.stringify([
            config.targetIds, config.username, config.password, config.port,
            [...config.hostKeys.entries()], config.hostKeysValid, config.allowUnpinned,
            config.trustedLanMode, config.trustedLanHosts
        ]);
    }

    function closePool(entry) {
        try { entry?.pool?.close(); } catch { }
    }

    function cancelQueue() {
        while (queue.length) queue.shift().resolve({ status: 'unavailable', discarded: true, errorReason: 'configuration_changed' });
    }

    function invalidate({ clearCache = true } = {}) {
        generation += 1;
        cancelQueue();
        pools.forEach(closePool);
        pools.clear();
        if (clearCache) cache.clear();
    }

    function currentConfiguration() {
        const config = environment();
        const next = key(config);
        if (configurationKey !== null && configurationKey !== next) invalidate();
        configurationKey = next;
        return { ...config, generation };
    }

    function configured(config = currentConfiguration()) {
        return !closed && config.targetIds.length > 0 && config.username && config.password
            && config.hostKeysValid
            && (config.allowUnpinned || config.trustedLanMode || config.targetIds.every(id => config.hostKeys.has(id)))
            && !/your_/iu.test(config.password);
    }

    function limited(task) {
        return new Promise(resolve => {
            const start = () => {
                active += 1;
                Promise.resolve().then(task).then(resolve, error => resolve({ status: statusFromError(error) })).finally(() => {
                    active -= 1;
                    const next = queue.shift();
                    if (next) next.start();
                });
            };
            if (active < concurrency) start();
            else queue.push({ start, resolve });
        });
    }

    function result(id, update) {
        const previous = cache.get(id) || {};
        const next = {
            selected: true,
            thermal: update.thermal || previous.thermal || null,
            lastSuccessAt: update.status === 'supported' ? update.sampledAt : (previous.lastSuccessAt || null),
            lastErrorAt: update.status === 'supported' ? null : update.sampledAt,
            status: update.status,
            stale: update.status !== 'supported' && !!previous.thermal,
            errorReason: update.status === 'supported' ? null : (update.errorReason || update.status),
            hostKeyPinned: update.hostKeyPinned === true
        };
        cache.set(id, next);
        return { ...next };
    }

    function poolFor(id, host, config) {
        const hostKeyFingerprint = config.hostKeys.get(id) || '';
        const identity = JSON.stringify([host, config.port, config.username, hostKeyFingerprint, config.generation]);
        const existing = pools.get(id);
        if (existing?.identity === identity) return existing.pool;
        closePool(existing);
        const pool = createPool({
            getConfig: () => ({
                host,
                port: config.port,
                username: config.username,
                password: config.password,
                hostKeyFingerprint,
                ...(hostKeyFingerprint ? { hostVerifier: hostVerifier(hostKeyFingerprint) } : {})
            })
        });
        pools.set(id, { pool, identity });
        return pool;
    }

    function collect(device) {
        const id = normalizeDeviceId(device?.mac || device?._id);
        const config = currentConfiguration();
        const sampledAt = now();
        if (!id || !config.targetIds.includes(id)) return Promise.resolve({ selected: false, status: 'unsupported' });
        if (!configured(config)) {
            const missingPin = !config.allowUnpinned && !config.hostKeys.has(id);
            return Promise.resolve(result(id, { status: 'not_configured', sampledAt, errorReason: missingPin ? 'host_key_not_configured' : 'configuration_invalid' }));
        }
        if (!online(device)) return Promise.resolve(result(id, { status: 'offline', sampledAt }));
        const host = managementIp(device);
        if (!host) return Promise.resolve(result(id, { status: 'unavailable', sampledAt, errorReason: 'management_ip_missing' }));
        const hostKeyFingerprint = config.hostKeys.get(id) || '';
        const targetAllowsUnpinned = hostKeyFingerprint !== '' || (
            config.trustedLanMode
                ? isTrustedLanEndpoint(host, { enabled: true, trustedHosts: config.trustedLanHosts })
                : config.allowUnpinned
        );
        if (!targetAllowsUnpinned) {
            return Promise.resolve(result(id, {
                status: 'not_configured', sampledAt,
                errorReason: config.trustedLanMode ? 'trusted_lan_target_required' : 'host_key_not_configured'
            }));
        }
        const identity = JSON.stringify([host, config.port, config.username, hostKeyFingerprint, config.generation]);
        const existing = inflight.get(id);
        if (existing?.identity === identity) return existing.promise;
        const taskGeneration = config.generation;
        const promise = limited(async () => {
            if (closed || taskGeneration !== currentConfiguration().generation) {
                return { status: 'unavailable', discarded: true, errorReason: 'configuration_changed' };
            }
            try {
                const output = await poolFor(id, host, config).execute(THERMAL_READ_COMMAND, {
                    timeoutMs: COMMAND_TIMEOUT_MS,
                    maxOutputBytes: COMMAND_OUTPUT_BYTES
                });
                if (closed || taskGeneration !== currentConfiguration().generation) {
                    return { status: 'unavailable', discarded: true, errorReason: 'configuration_changed' };
                }
                const thermal = parse(output, { sampledAt: now() });
                return result(id, thermal
                    ? { status: 'supported', sampledAt: thermal.sampledAt, thermal, hostKeyPinned: !!hostKeyFingerprint }
                    : { status: 'unsupported', sampledAt: now(), errorReason: 'no_thermal_zone', hostKeyPinned: !!hostKeyFingerprint });
            } catch (error) {
                if (closed || taskGeneration !== currentConfiguration().generation) {
                    return { status: 'unavailable', discarded: true, errorReason: 'configuration_changed' };
                }
                closePool(pools.get(id));
                pools.delete(id);
                const status = statusFromError(error);
                return result(id, { status, sampledAt: now(), errorReason: status, hostKeyPinned: !!hostKeyFingerprint });
            }
        });
        const record = { identity, promise };
        inflight.set(id, record);
        promise.finally(() => { if (inflight.get(id) === record) inflight.delete(id); });
        return promise;
    }

    function reset() {
        closed = false;
        invalidate();
        configurationKey = key(environment());
    }

    function close() {
        if (closed) return;
        closed = true;
        invalidate();
    }

    function diagnostics() {
        const config = currentConfiguration();
        const trustedLanTargetErrors = [...cache.values()]
            .filter(entry => entry.errorReason === 'trusted_lan_target_required').length;
        const allTargetsPinned = config.targetIds.length > 0
            && config.targetIds.every(id => config.hostKeys.has(id));
        const transportMode = allTargetsPinned
            ? 'verified'
            : config.trustedLanMode && config.targetIds.length > 0 && trustedLanTargetErrors === 0
                ? 'trusted-lan-insecure'
                : !config.trustedLanMode && config.allowUnpinned
                    ? 'explicitly-insecure'
                    : 'unconfigured';
        return {
            configured: configured(config),
            selectedDeviceCount: config.targetIds.length,
            hostKeyConfigurationValid: config.hostKeysValid,
            hostKeyConfiguredDeviceCount: config.hostKeys.size,
            hostKeyMissingDeviceIds: config.allowUnpinned ? [] : config.targetIds.filter(id => !config.hostKeys.has(id)),
            allowUnpinned: config.allowUnpinned,
            trustedLanMode: config.trustedLanMode,
            cachedDeviceCount: cache.size,
            transportMode,
            running: inflight.size,
            activeConnections: active,
            queued: queue.length,
            generation: config.generation
        };
    }

    return Object.freeze({
        collect,
        reset,
        close,
        configured,
        diagnostics,
        selectedIds: () => [...currentConfiguration().targetIds],
        cached: deviceId => ({ ...(cache.get(normalizeDeviceId(deviceId)) || {}) })
    });
}

module.exports = {
    COMMAND_OUTPUT_BYTES,
    COMMAND_TIMEOUT_MS,
    HOST_KEY_FINGERPRINT,
    THERMAL_READ_COMMAND,
    createUnifiDeviceThermalSshCollector,
    hostKeysConfigurationValid,
    hostVerifier,
    managementIp,
    normalizeDeviceId,
    parseHostKeys,
    parseTargetIds,
    safeManagementIp,
    statusFromError
};

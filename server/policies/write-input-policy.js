'use strict';

const net = require('node:net');

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAC_ADDRESS = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const METRIC_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]*$/u;

class InputValidationError extends Error {
    constructor(message, { field = null } = {}) {
        super(message);
        this.name = 'InputValidationError';
        this.code = 'API_VALIDATION_FAILED';
        this.httpStatus = 400;
        this.field = field;
    }
}

function reject(message, field = null) {
    throw new InputValidationError(message, { field });
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactObject(value, {
    label = 'request body',
    allowed = [],
    required = [],
    allowEmpty = false
} = {}) {
    if (!isPlainObject(value)) reject(`${label} must be a JSON object`);
    const keys = Object.keys(value);
    const allowedSet = new Set(allowed);
    const unknown = keys.find(key => !allowedSet.has(key));
    if (unknown) reject(`${label} contains unknown field: ${unknown}`, unknown);
    const missing = required.find(key => !Object.hasOwn(value, key));
    if (missing) reject(`${label} is missing required field: ${missing}`, missing);
    if (!allowEmpty && keys.length === 0) reject(`${label} must contain at least one field`);
    return value;
}

function stringValue(value, {
    field = 'value',
    min = 1,
    max = 1024,
    trim = true,
    pattern = null,
    allowEmpty = false
} = {}) {
    if (typeof value !== 'string') reject(`${field} must be a string`, field);
    if (CONTROL_CHARACTERS.test(value)) reject(`${field} contains control characters`, field);
    const normalized = trim ? value.trim() : value;
    if (!allowEmpty && normalized.length === 0) reject(`${field} must not be empty`, field);
    if (normalized.length < min || normalized.length > max) {
        reject(`${field} must contain ${min} through ${max} characters`, field);
    }
    if (pattern && !pattern.test(normalized)) reject(`${field} has an invalid format`, field);
    return normalized;
}

function booleanValue(value, field) {
    if (typeof value !== 'boolean') reject(`${field} must be a boolean`, field);
    return value;
}

function numberValue(value, {
    field = 'value',
    min = -Number.MAX_VALUE,
    max = Number.MAX_VALUE,
    integer = false,
    step = null
} = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value)) reject(`${field} must be a finite JSON number`, field);
    if (integer && !Number.isInteger(value)) reject(`${field} must be an integer`, field);
    if (value < min || value > max) reject(`${field} must be between ${min} and ${max}`, field);
    if (step !== null) {
        const scaled = (value - min) / step;
        if (Math.abs(scaled - Math.round(scaled)) > 1e-9) reject(`${field} must use increments of ${step}`, field);
    }
    return value;
}

function enumValue(value, allowed, field) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        reject(`${field} must be one of: ${allowed.join(', ')}`, field);
    }
    return value;
}

function macValue(value, field = 'mac') {
    const normalized = stringValue(value, { field, min: 17, max: 17 });
    if (!MAC_ADDRESS.test(normalized)) reject(`${field} must be a colon-separated MAC address`, field);
    return normalized.toLowerCase();
}

function identifierValue(value, {
    field = 'id',
    min = 1,
    max = 128,
    pattern = SAFE_IDENTIFIER
} = {}) {
    return stringValue(value, { field, min, max, pattern });
}

function httpUrlValue(value, { field = 'url', max = 2048 } = {}) {
    const normalized = stringValue(value, { field, min: 8, max });
    let parsed;
    try { parsed = new URL(normalized); }
    catch { reject(`${field} must be a valid HTTP(S) URL`, field); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        reject(`${field} must be an HTTP(S) URL without embedded credentials`, field);
    }
    return normalized;
}

function unifiNetworkApiUrlValue(value, field) {
    const normalized = httpUrlValue(value, { field });
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
    if (parsed.search || parsed.hash) reject(`${field} must not contain query or fragment data`, field);
    if (parsed.protocol === 'http:' && !loopback) reject(`${field} must use HTTPS outside loopback`, field);
    return normalized;
}

function adguardUrlValue(value, field) {
    const normalized = httpUrlValue(value, { field });
    const parsed = new URL(normalized);
    if (parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
        reject(`${field} must be an origin-only URL without path, query, or fragment`, field);
    }
    return parsed.origin;
}

function hostValue(value, field) {
    const normalized = stringValue(value, { field, min: 1, max: 253 });
    if (net.isIP(normalized)) return normalized;
    if (normalized.startsWith('[') && normalized.endsWith(']') && net.isIP(normalized.slice(1, -1)) === 6) {
        return normalized;
    }
    const labels = normalized.split('.');
    if (labels.some(label => !label || label.length > 63
        || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))) {
        reject(`${field} must be an IP address or hostname`, field);
    }
    return normalized;
}

function parseAlias(body) {
    exactObject(body, { allowed: ['mac', 'name'], required: ['mac', 'name'] });
    return {
        mac: macValue(body.mac),
        name: stringValue(body.name, { field: 'name', min: 0, max: 40, allowEmpty: true })
    };
}

function parseWifiUpdate(id, body) {
    exactObject(body, { allowed: ['enabled'], required: ['enabled'] });
    return {
        id: identifierValue(id, { field: 'id', max: 128 }),
        enabled: booleanValue(body.enabled, 'enabled')
    };
}

function parseWifiQrRequest(body) {
    exactObject(body, { allowed: ['ssid', 'password'], required: ['ssid', 'password'] });
    const ssid = stringValue(body.ssid, { field: 'ssid', min: 1, max: 64, trim: false });
    if (Buffer.byteLength(ssid, 'utf8') > 32) reject('ssid must not exceed 32 UTF-8 bytes', 'ssid');
    const password = stringValue(body.password, { field: 'password', min: 8, max: 64, trim: false });
    const passphrase = /^[\x20-\x7e]{8,63}$/u.test(password);
    const rawKey = /^[0-9a-f]{64}$/iu.test(password);
    if (!passphrase && !rawKey) reject('password must be an 8-63 character WPA passphrase or 64 hex digits', 'password');
    return { ssid, password };
}

function parseDeviceRestriction(body) {
    exactObject(body, {
        allowed: ['deviceId', 'blockState', 'deviceName'],
        required: ['deviceId', 'blockState']
    });
    const parsed = {
        deviceId: macValue(body.deviceId, 'deviceId'),
        blockState: booleanValue(body.blockState, 'blockState')
    };
    if (Object.hasOwn(body, 'deviceName')) {
        parsed.deviceName = stringValue(body.deviceName, {
            field: 'deviceName', min: 0, max: 128, allowEmpty: true
        });
    }
    return parsed;
}

function parsePoePowerCycle(body) {
    exactObject(body, { allowed: ['switchMac', 'portIndex'], required: ['switchMac', 'portIndex'] });
    return {
        switchMac: macValue(body.switchMac, 'switchMac'),
        portIndex: numberValue(body.portIndex, { field: 'portIndex', integer: true, min: 1, max: 128 })
    };
}

function parseSingleBoolean(body, field) {
    exactObject(body, { allowed: [field], required: [field] });
    return { [field]: booleanValue(body[field], field) };
}

function parseEmptyBody(body) {
    if (body === undefined) return {};
    exactObject(body, { allowed: [], allowEmpty: true });
    return {};
}

const NOTIFICATION_BOOLEAN_FIELDS = Object.freeze([
    'enabled', 'webPushEnabled', 'telegramCommandsEnabled', 'triggerThreats', 'triggerNasAlerts', 'triggerWiimTemp',
    'triggerUpsOutage', 'triggerUpsLowBatt', 'triggerNewClient', 'triggerClientIpChange',
    'triggerClientWeakSignal', 'triggerClientConnectivity', 'triggerNetworkDeviceOffline',
    'triggerWifiSsidChange', 'triggerUnifiUpgrade', 'triggerCloudOffline', 'triggerUnifiDeviceTemp', 'triggerWiimOffline',
    'triggerWiimHighVolume', 'triggerWiimPlaybackChange', 'triggerBlockAction', 'triggerNasDiskTemp',
    'triggerNasSpace', 'triggerNasDiskHealth', 'triggerNasOffline', 'triggerNasHighCpu',
    'triggerNasHighMemory', 'triggerUcgTemp', 'triggerUcgHighCpu', 'triggerUcgHighMemory',
    'triggerUcgDisk', 'triggerWanDown', 'triggerWanLatency', 'triggerUnifiOffline', 'triggerNasLog',
    'triggerNasSleepWake', 'triggerUpsHighLoad', 'triggerUpsLowRuntime', 'triggerUpsVoltAbnormal', 'triggerUpsSag',
    'triggerUpsSourceChange', 'triggerUpsOffline', 'triggerAdgProtection', 'triggerAdgOffline',
    'triggerAdgHighBlockRate', 'triggerLinuxTemp', 'triggerLinuxOffline', 'triggerLinuxDisk',
    'triggerLinuxHighCpu', 'triggerLinuxHighMemory', 'triggerLinuxHighLoad', 'triggerDockerCriticalLog',
    'triggerDockerErrorLog', 'triggerDockerState', 'triggerDockerHealth', 'triggerDockerRestart',
    'triggerDockerInventory', 'triggerDockerOom', 'triggerDockerHighCpu', 'triggerDockerHighMemory',
    'triggerSystemCritical', 'triggerSystemWarning', 'triggerSystemRecovery', 'triggerSystemStartup'
]);

const NOTIFICATION_NUMBER_FIELDS = Object.freeze({
    clientSignalAlert: Object.freeze({ min: 50, max: 95, integer: true }),
    unifiDeviceTempAlert: Object.freeze({ min: 40, max: 100, integer: true }),
    wiimVolumeAlert: Object.freeze({ min: 10, max: 100, integer: true }),
    nasDiskTempAlert: Object.freeze({ min: 30, max: 70, integer: true }),
    nasSpaceAlert: Object.freeze({ min: 50, max: 99, integer: true }),
    nasCpuAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    nasMemoryAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    ucgTempAlert: Object.freeze({ min: 50, max: 95, integer: true }),
    ucgCpuAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    ucgMemoryAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    ucgDiskAlert: Object.freeze({ min: 50, max: 99, integer: true }),
    wanLatencyAlert: Object.freeze({ min: 10, max: 5000, integer: true }),
    upsLoadAlert: Object.freeze({ min: 50, max: 99, integer: true }),
    upsRuntimeAlertMin: Object.freeze({ min: 1, max: 120, integer: true }),
    upsVoltDeviationPct: Object.freeze({ min: 3, max: 30, integer: true }),
    upsSagThresholdV: Object.freeze({ min: 80, max: 125, integer: true }),
    adgBlockRateAlert: Object.freeze({ min: 1, max: 100, integer: true }),
    linuxTempAlert: Object.freeze({ min: 40, max: 95, integer: true }),
    linuxDiskAlert: Object.freeze({ min: 50, max: 99, integer: true }),
    linuxCpuAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    linuxMemoryAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    linuxLoadAlert: Object.freeze({ min: 0.1, max: 100, step: 0.1 }),
    dockerCpuAlert: Object.freeze({ min: 50, max: 100, integer: true }),
    dockerMemoryAlert: Object.freeze({ min: 50, max: 100, integer: true })
});

function parseNotificationSettings(body) {
    const stringFields = ['channel', 'chatId', 'webhookUrl', 'botToken'];
    exactObject(body, {
        allowed: [...NOTIFICATION_BOOLEAN_FIELDS, ...Object.keys(NOTIFICATION_NUMBER_FIELDS), ...stringFields]
    });
    const parsed = {};
    for (const [key, value] of Object.entries(body)) {
        if (NOTIFICATION_BOOLEAN_FIELDS.includes(key)) {
            parsed[key] = booleanValue(value, key);
        } else if (Object.hasOwn(NOTIFICATION_NUMBER_FIELDS, key)) {
            parsed[key] = numberValue(value, { field: key, ...NOTIFICATION_NUMBER_FIELDS[key] });
        } else if (key === 'channel') {
            parsed.channel = enumValue(value, ['discord', 'telegram', 'generic'], key);
        } else if (key === 'chatId') {
            parsed.chatId = stringValue(value, { field: key, min: 0, max: 32, allowEmpty: true });
            if (parsed.chatId && !/^-?[1-9]\d{0,19}$/u.test(parsed.chatId)) {
                reject('chatId must be a canonical Telegram chat identifier', key);
            }
        } else if (key === 'webhookUrl') {
            if (typeof value !== 'string') reject('webhookUrl must be a string', key);
            if (value.trim()) parsed.webhookUrl = httpUrlValue(value, { field: key });
        } else if (key === 'botToken') {
            if (typeof value !== 'string') reject('botToken must be a string', key);
            if (value.trim()) {
                parsed.botToken = stringValue(value, {
                    field: key,
                    min: 27,
                    max: 256,
                    pattern: /^[1-9]\d{5,15}:[A-Za-z0-9_-]{20,128}$/u
                });
            }
        }
    }
    return parsed;
}

const UI_PREFERENCE_KEYS = Object.freeze([
    'theme', 'pollConfig', 'layoutOrder.v1', 'pinnedBlocks.v1', 'wiimSrcOrder.v1'
]);
const UI_POLL_KEYS = Object.freeze([
    'adguard', 'linuxMon', 'critAlerts', 'hardware', 'ucgHist', 'ucgSpikes', 'switches',
    'unifiTelemetry', 'unifiTelemetryHistory',
    'clients', 'threats', 'cloud', 'isp', 'nas', 'nasAdvanced', 'docker', 'trend', 'notifLog',
    'reportLog', 'systemStatus', 'security', 'wiimSystem', 'wiimPlayback', 'ups', 'ppbEvents',
    'heartbeat'
]);
const WIIM_SOURCES = Object.freeze(['wifi', 'bluetooth', 'line-in', 'optical', 'co-axial', 'udisk']);
const SELECTOR_SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;

function safeIdArray(value, field, { max = 128 } = {}) {
    if (!Array.isArray(value) || value.length > max) reject(`${field} must be an array of at most ${max} identifiers`, field);
    const parsed = value.map((entry, index) => identifierValue(entry, {
        field: `${field}[${index}]`, max: 128, pattern: SELECTOR_SAFE_ID
    }));
    if (new Set(parsed).size !== parsed.length) reject(`${field} must not contain duplicate identifiers`, field);
    return parsed;
}

function parseUiPreferences(body) {
    exactObject(body, { allowed: ['preferences'], required: ['preferences'] });
    const preferences = exactObject(body.preferences, { label: 'preferences', allowed: UI_PREFERENCE_KEYS });
    const parsed = {};
    for (const [key, value] of Object.entries(preferences)) {
        if (key === 'theme') {
            parsed.theme = enumValue(value, ['dark', 'light'], key);
        } else if (key === 'pollConfig') {
            exactObject(value, { label: key, allowed: UI_POLL_KEYS, allowEmpty: true });
            parsed.pollConfig = Object.fromEntries(Object.entries(value).map(([job, seconds]) => [
                job,
                numberValue(seconds, { field: `${key}.${job}`, integer: true, min: 1, max: 86400 })
            ]));
        } else if (key === 'pinnedBlocks.v1') {
            parsed[key] = safeIdArray(value, key);
        } else if (key === 'layoutOrder.v1') {
            if (!isPlainObject(value)) reject(`${key} must be an object`, key);
            const entries = Object.entries(value);
            if (entries.length > 64) reject(`${key} contains too many containers`, key);
            let totalIds = 0;
            parsed[key] = {};
            for (const [container, order] of entries) {
                if (container !== '__nav' && !SELECTOR_SAFE_ID.test(container)) {
                    reject(`${key} contains an invalid container identifier`, key);
                }
                const ids = safeIdArray(order, `${key}.${container}`);
                totalIds += ids.length;
                if (totalIds > 512) reject(`${key} contains too many block identifiers`, key);
                parsed[key][container] = ids;
            }
        } else if (key === 'wiimSrcOrder.v1') {
            const sources = safeIdArray(value, key, { max: WIIM_SOURCES.length });
            if (sources.length !== WIIM_SOURCES.length
                || WIIM_SOURCES.some(source => !sources.includes(source))) {
                reject(`${key} must be an exact permutation of the supported sources`, key);
            }
            parsed[key] = sources;
        }
    }
    if (JSON.stringify(parsed).length > 65_536) reject('preferences payload is too large', 'preferences');
    return parsed;
}

function parseAlertConfig(body) {
    exactObject(body, {
        allowed: ['metric', 'threshold', 'condition', 'enabled'],
        required: ['metric', 'threshold', 'condition', 'enabled']
    });
    return {
        metric: identifierValue(body.metric, { field: 'metric', max: 64, pattern: METRIC_IDENTIFIER }),
        threshold: numberValue(body.threshold, { field: 'threshold', min: -1_000_000, max: 1_000_000 }),
        condition: enumValue(body.condition, ['above', 'below'], 'condition'),
        enabled: booleanValue(body.enabled, 'enabled')
    };
}

function parseAppSettings(body, ranges) {
    const numericKeys = Object.keys(ranges);
    exactObject(body, { allowed: [...numericKeys, 'reportEnabled', 'reportFreq'] });
    const parsed = {};
    for (const [key, value] of Object.entries(body)) {
        if (Object.hasOwn(ranges, key)) {
            const [min, max] = ranges[key];
            parsed[key] = numberValue(value, { field: key, integer: true, min, max });
        } else if (key === 'reportEnabled') {
            parsed.reportEnabled = booleanValue(value, key);
        } else if (key === 'reportFreq') {
            parsed.reportFreq = enumValue(value, ['daily', 'twice', 'every6h', 'weekly'], key);
        }
    }
    return parsed;
}

const PORT_FIELDS = new Set(['SSH_PORT', 'NAS_PORT', 'PPB_PORT', 'ADGUARD_PORT', 'LINUX_SSH_PORT']);
const URL_FIELDS = new Set(['UNIFI_CONTROLLER_URL', 'UNIFI_NETWORK_API_URL', 'NAS_MONITOR_URL', 'ADGUARD_URL']);
const UUID_FIELDS = new Set(['UNIFI_NETWORK_SITE_ID', 'UNIFI_THREAT_BLOCK_LIST_ID']);
const HOST_FIELDS = new Set([
    'UCG_IP', 'NAS_HOST', 'WIIM_IP', 'NUT_HOST', 'PPB_HOST',
    'ADGUARD_HOST', 'LINUX_HOST'
]);
const ENUM_FIELDS = Object.freeze({
    NAS_SCHEME: ['http', 'https'],
    NAS_MONITOR_MODE: ['docker_only', 'full'],
    UNIFI_NETWORK_TLS_VERIFY: ['true', 'false'],
    ADGUARD_ALLOW_INSECURE_HTTP: ['true', 'false'],
    ADGUARD_TLS_VERIFY: ['true', 'false'],
    UPS_SOURCE: ['auto', 'nut', 'pwrstat', 'pmset', 'ppb']
});

function canonicalPort(value, field) {
    const normalized = stringValue(value, { field, min: 1, max: 5 });
    if (!/^(?:[1-9]|[1-9]\d{1,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/u.test(normalized)) {
        reject(`${field} must be a canonical port from 1 through 65535`, field);
    }
    return normalized;
}

function parseConnectionUpdates(body, fields) {
    const definitions = new Map(fields.map(field => [field.key, field]));
    exactObject(body, { allowed: [...definitions.keys()] });
    const updates = {};
    for (const [key, raw] of Object.entries(body)) {
        if (typeof raw !== 'string') reject(`${key} must be a string`, key);
        if (raw.trim() === '') continue;
        const definition = definitions.get(key);
        const max = definition.secret ? 4096 : 2048;
        let value = stringValue(raw, { field: key, min: 1, max });
        if (PORT_FIELDS.has(key)) value = canonicalPort(value, key);
        else if (URL_FIELDS.has(key)) {
            value = key === 'UNIFI_NETWORK_API_URL'
                ? unifiNetworkApiUrlValue(value, key)
                : key === 'ADGUARD_URL'
                    ? adguardUrlValue(value, key)
                    : httpUrlValue(value, { field: key });
        }
        else if (UUID_FIELDS.has(key)) {
            value = stringValue(value, {
                field: key,
                min: 36,
                max: 36,
                pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
            }).toLowerCase();
        }
        else if (HOST_FIELDS.has(key)) value = hostValue(value, key);
        else if (Object.hasOwn(ENUM_FIELDS, key)) value = enumValue(value, ENUM_FIELDS[key], key);
        else if (key === 'WAN_IFACE') {
            value = stringValue(value, { field: key, min: 1, max: 32, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u });
        } else if (key === 'NUT_UPS_NAME') {
            value = stringValue(value, { field: key, min: 1, max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u });
        } else if (key === 'PWRSTAT_PATH' || key === 'ADGUARD_CA_FILE') {
            value = stringValue(value, {
                field: key,
                min: 1,
                max: 1024,
                pattern: /^(?:[A-Za-z0-9][A-Za-z0-9._+-]*|\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+)$/u
            });
        } else if (key === 'UNIFI_THREAT_BLOCK_LIST_NAME') {
            value = stringValue(value, { field: key, min: 1, max: 128 });
        }
        updates[key] = value;
    }
    return updates;
}

function quoteEnvValue(value) {
    if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
        reject('environment value must be a control-character-free string');
    }
    if (!value.includes('#')) return value;
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('`')) return `\`${value}\``;
    if (!value.includes('"') && !/\\[nr]/u.test(value)) return `"${value}"`;
    reject('environment value cannot be represented safely in dotenv syntax');
}

module.exports = {
    CONTROL_CHARACTERS,
    InputValidationError,
    NOTIFICATION_BOOLEAN_FIELDS,
    NOTIFICATION_NUMBER_FIELDS,
    UI_POLL_KEYS,
    UI_PREFERENCE_KEYS,
    WIIM_SOURCES,
    booleanValue,
    enumValue,
    exactObject,
    hostValue,
    httpUrlValue,
    identifierValue,
    isPlainObject,
    macValue,
    numberValue,
    parseAlias,
    parseAlertConfig,
    parseAppSettings,
    parseConnectionUpdates,
    parseDeviceRestriction,
    parseEmptyBody,
    parseNotificationSettings,
    parsePoePowerCycle,
    parseSingleBoolean,
    parseWifiUpdate,
    parseWifiQrRequest,
    parseUiPreferences,
    quoteEnvValue,
    stringValue
};

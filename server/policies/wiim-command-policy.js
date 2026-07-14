'use strict';

const LIMITS = Object.freeze({
    commandLength: 8192,
    encodedParameterLength: 6144,
    jsonLength: 2048,
    streamUrlLength: 2048,
    eqPresetLength: 64,
    seekSeconds: 604800,
    shutdownSeconds: 86400,
    bluetoothDiscoverySeconds: 120,
    spdifDelayMs: 3000
});

// These are the exact, parameter-free commands used by the current dashboard.
// Parameterized commands are validated independently below; they never share a
// prefix-only allow decision.
const FIXED_READ_COMMANDS = Object.freeze([
    'getPlayModeGainConfig',
    'EQGetBand',
    'getbtdiscoveryresult',
    'getbthistory',
    'getbtpairstatus',
    'Squeezelite:getState',
    'wlanGetConnectState',
    'getShutdown',
    'EQGetList',
    'EQGetStat',
    'getStatusEx',
    'getStaticIpInfo',
    'getPresetInfo'
]);

const FIXED_WRITE_COMMANDS = Object.freeze([
    'setPlayerCmd:prev',
    'setPlayerCmd:onepause',
    'setPlayerCmd:next',
    'setPlayerCmd:stop',
    'EQOn',
    'EQOff',
    'clearbtdiscoveryresult',
    'ConnectMasterAp:JoinGroupMaster:eth0',
    'Cast:EnableCast',
    'Cast:DisableCast',
    'reboot',
    'LED_SWITCH_SET:1',
    'LED_SWITCH_SET:0',
    'Button_Enable_SET:1',
    'Button_Enable_SET:0'
]);

const FIXED_READ_SET = new Set(FIXED_READ_COMMANDS);
const FIXED_WRITE_SET = new Set(FIXED_WRITE_COMMANDS);
const HIGH_RISK_FIXED = Object.freeze({
    reboot: Object.freeze({ risk: 'device-reboot', category: 'system' }),
    'ConnectMasterAp:JoinGroupMaster:eth0': Object.freeze({ risk: 'network-group', category: 'group' })
});

const ERROR_CODES = Object.freeze({
    INVALID_TYPE: 'WIIM_COMMAND_INVALID_TYPE',
    INVALID_LENGTH: 'WIIM_COMMAND_INVALID_LENGTH',
    INVALID_CHARACTERS: 'WIIM_COMMAND_INVALID_CHARACTERS',
    INVALID_PARAMETER: 'WIIM_COMMAND_INVALID_PARAMETER',
    NON_CANONICAL_ENCODING: 'WIIM_COMMAND_NON_CANONICAL_ENCODING',
    FORBIDDEN: 'WIIM_COMMAND_FORBIDDEN',
    UNKNOWN: 'WIIM_COMMAND_UNKNOWN'
});

class WiimCommandPolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WiimCommandPolicyError';
        this.code = code;
        this.httpStatus = code === ERROR_CODES.FORBIDDEN ? 403 : 400;
    }
}

function reject(code, message) {
    throw new WiimCommandPolicyError(code, message);
}

function decision(command, kind, category, options = {}) {
    const confirmationRequired = options.confirmationRequired === true;
    return Object.freeze({
        command,
        canonicalCommand: command,
        kind,
        mutating: kind === 'write',
        category,
        highRisk: confirmationRequired || options.highRisk === true,
        confirmationRequired,
        risk: options.risk || null
    });
}

function parameter(command, prefix) {
    return command.startsWith(prefix) ? command.slice(prefix.length) : null;
}

function canonicalInteger(token, min, max, label) {
    if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        reject(ERROR_CODES.INVALID_PARAMETER, `${label} must be a canonical integer`);
    }
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        reject(ERROR_CODES.INVALID_PARAMETER, `${label} is outside its allowed range`);
    }
    return value;
}

function canonicalBalance(token) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(token) || String(Number(token)) !== token) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'channel balance must use canonical decimal notation');
    }
    const value = Number(token);
    if (!Number.isFinite(value) || value < -1 || value > 1
        || Math.abs(value * 20 - Math.round(value * 20)) > Number.EPSILON * 20) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'channel balance must be -1 through 1 in 0.05 steps');
    }
    return value;
}

function decodeCanonicalComponent(encoded, decodedLimit, label) {
    if (!encoded || encoded.length > LIMITS.encodedParameterLength) {
        reject(ERROR_CODES.INVALID_LENGTH, `${label} is empty or too long`);
    }

    let decoded;
    try {
        decoded = decodeURIComponent(encoded);
        if (encodeURIComponent(decoded) !== encoded) {
            reject(ERROR_CODES.NON_CANONICAL_ENCODING, `${label} is not canonically encoded`);
        }
    } catch (error) {
        if (error instanceof WiimCommandPolicyError) throw error;
        reject(ERROR_CODES.NON_CANONICAL_ENCODING, `${label} contains invalid percent encoding`);
    }

    if (!decoded || decoded.length > decodedLimit || /[\u0000-\u001f\u007f]/u.test(decoded)) {
        reject(ERROR_CODES.INVALID_LENGTH, `${label} is empty, too long, or contains control characters`);
    }
    return decoded;
}

function parseCanonicalJson(encoded, label) {
    const decoded = decodeCanonicalComponent(encoded, LIMITS.jsonLength, label);
    let value;
    try {
        value = JSON.parse(decoded);
    } catch {
        reject(ERROR_CODES.INVALID_PARAMETER, `${label} must contain valid JSON`);
    }

    // Besides eliminating duplicate-key ambiguity, this keeps whitespace and
    // number spellings from producing a second representation of one command.
    if (JSON.stringify(value) !== decoded) {
        reject(ERROR_CODES.NON_CANONICAL_ENCODING, `${label} JSON must be minified and canonical`);
    }
    return value;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, expected, label) {
    if (!isPlainObject(value)) {
        reject(ERROR_CODES.INVALID_PARAMETER, `${label} must be an object`);
    }
    const actual = Object.keys(value);
    if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) {
        reject(ERROR_CODES.INVALID_PARAMETER, `${label} contains missing or unknown fields`);
    }
}

function finiteNumber(value, label, {
    integer = false,
    min = -Infinity,
    max = Infinity,
    allowString = false
} = {}) {
    let parsed = value;
    if (typeof value === 'string') {
        if (!allowString) {
            reject(ERROR_CODES.INVALID_PARAMETER, `${label} must be a JSON number`);
        }
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) || value === '-0') {
            reject(ERROR_CODES.INVALID_PARAMETER, `${label} is not a canonical numeric value`);
        }
        parsed = Number(value);
    }
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)
        || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
        reject(ERROR_CODES.INVALID_PARAMETER, `${label} is outside its allowed range`);
    }
    return parsed;
}

function validateGainConfig(encoded) {
    const value = parseCanonicalJson(encoded, 'play-mode gain config');
    requireExactKeys(value, ['config', 'enable', 'max_gain', 'min_gain'], 'play-mode gain config');
    if (!Array.isArray(value.config) || value.config.length < 1 || value.config.length > 32) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'gain config must contain 1 through 32 source entries');
    }
    finiteNumber(value.enable, 'gain enable flag', { integer: true, min: 0, max: 1 });
    const maxGain = finiteNumber(value.max_gain, 'maximum gain', { min: -20, max: 20, allowString: true });
    const minGain = finiteNumber(value.min_gain, 'minimum gain', { min: -20, max: 20, allowString: true });
    if (minGain > maxGain) reject(ERROR_CODES.INVALID_PARAMETER, 'minimum gain exceeds maximum gain');

    value.config.forEach((entry, index) => {
        const label = `gain config entry ${index}`;
        requireExactKeys(entry, ['gain', 'mode', 'name'], label);
        const gain = finiteNumber(entry.gain, `${label} gain`, { min: -20, max: 20, allowString: true });
        if (gain < minGain || gain > maxGain) {
            reject(ERROR_CODES.INVALID_PARAMETER, `${label} gain is outside the declared range`);
        }
        finiteNumber(entry.mode, `${label} mode`, { integer: true, min: 0, max: 255, allowString: true });
        if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(entry.name)) {
            reject(ERROR_CODES.INVALID_PARAMETER, `${label} name is invalid`);
        }
    });
}

function validateEqBandConfig(encoded) {
    const value = parseCanonicalJson(encoded, 'EQ band config');
    requireExactKeys(value, ['EQBand'], 'EQ band config');
    if (!Array.isArray(value.EQBand) || value.EQBand.length < 1 || value.EQBand.length > 32) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'EQ band config must contain 1 through 32 bands');
    }
    value.EQBand.forEach((entry, index) => {
        const label = `EQ band ${index}`;
        requireExactKeys(entry, ['index', 'param_name', 'value'], label);
        finiteNumber(entry.index, `${label} index`, { integer: true, min: 0, max: 31 });
        finiteNumber(entry.value, `${label} value`, { min: 0, max: 99 });
        if (typeof entry.param_name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(entry.param_name)) {
            reject(ERROR_CODES.INVALID_PARAMETER, `${label} parameter name is invalid`);
        }
    });
}

function validateLightConfig(encoded) {
    const value = parseCanonicalJson(encoded, 'light config');
    requireExactKeys(value, ['auto_sense_enable', 'default_bright', 'disable'], 'light config');
    finiteNumber(value.auto_sense_enable, 'auto-sense flag', { integer: true, min: 0, max: 1 });
    finiteNumber(value.default_bright, 'default brightness', { integer: true, min: 0, max: 100 });
    finiteNumber(value.disable, 'display disable flag', { integer: true, min: 0, max: 1 });
}

function validateEqPreset(encoded) {
    const preset = decodeCanonicalComponent(encoded, LIMITS.eqPresetLength, 'EQ preset');
    if (![...preset].length || [...preset].length > LIMITS.eqPresetLength
        || !/^[\p{L}\p{N}][\p{L}\p{N} _+&().,'-]{0,63}$/u.test(preset)) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'EQ preset contains unsupported characters');
    }
}

function validateTimeSync(token) {
    if (!/^\d{14}$/.test(token)) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'timeSync must use YYYYMMDDHHMMSS');
    }
    const parts = [
        Number(token.slice(0, 4)), Number(token.slice(4, 6)), Number(token.slice(6, 8)),
        Number(token.slice(8, 10)), Number(token.slice(10, 12)), Number(token.slice(12, 14))
    ];
    const [year, month, day, hour, minute, second] = parts;
    const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (year < 2000 || year > 2099
        || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1
        || instant.getUTCDate() !== day || instant.getUTCHours() !== hour
        || instant.getUTCMinutes() !== minute || instant.getUTCSeconds() !== second) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'timeSync contains an invalid date or time');
    }
}

function validateStreamUrl(rawUrl) {
    if (!rawUrl || rawUrl.length > LIMITS.streamUrlLength) {
        reject(ERROR_CODES.INVALID_LENGTH, 'stream URL is empty or too long');
    }
    if (!/^https?:\/\//.test(rawUrl) || rawUrl.includes('\\')
        || /%(?![0-9A-Fa-f]{2})/.test(rawUrl)
        || /%(?:0[0-9A-F]|1[0-9A-F]|7F|5C|25)/i.test(rawUrl)) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'stream URL is not canonical HTTP(S)');
    }
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        reject(ERROR_CODES.INVALID_PARAMETER, 'stream URL is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
        || parsed.username || parsed.password) {
        reject(ERROR_CODES.INVALID_PARAMETER, 'stream URL must not contain credentials or a non-HTTP scheme');
    }
}

function isPrivateIpv4(value) {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
    const octets = value.split('.').map(Number);
    if (octets.some(part => part > 255)) return false;
    return octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168);
}

function looksExplicitlyForbidden(command) {
    return /(?:factory(?:reset|restore)|restorefactory|resetfactory|firmware)/i.test(command)
        || /(?:^|:)(?:ota|update|upgrade|flash)(?:[A-Z0-9_:-]|$)/i.test(command)
        || /^(?:reset|shutdown|poweroff|powerdown|halt)(?::|$)/i.test(command)
        || /^(?:setStaticIp|setNetwork|networkSet|wlanSet|setWlan|setDns|setDhcp|setSSID|setPassword)/i.test(command)
        || /^ConnectMasterAp:/i.test(command);
}

function validateWiimCommand(input) {
    if (typeof input !== 'string') {
        reject(ERROR_CODES.INVALID_TYPE, 'WiiM command must be one primitive string');
    }
    if (!input || input.length > LIMITS.commandLength) {
        reject(ERROR_CODES.INVALID_LENGTH, 'WiiM command is empty or too long');
    }
    if (/[\u0000-\u001f\u007f]/u.test(input) || /\s/u.test(input)) {
        reject(ERROR_CODES.INVALID_CHARACTERS, 'WiiM command contains whitespace or control characters');
    }

    if (FIXED_READ_SET.has(input)) {
        const category = ['getStaticIpInfo', 'wlanGetConnectState'].includes(input) ? 'network-read' : 'query';
        return decision(input, 'read', category);
    }
    if (FIXED_WRITE_SET.has(input)) {
        const highRisk = HIGH_RISK_FIXED[input];
        if (highRisk) {
            return decision(input, 'write', highRisk.category, {
                highRisk: true,
                confirmationRequired: true,
                risk: highRisk.risk
            });
        }
        return decision(input, 'write', 'control');
    }

    let token;
    if ((token = parameter(input, 'setPlayerCmd:vol:')) !== null) {
        canonicalInteger(token, 0, 100, 'volume');
        return decision(input, 'write', 'playback');
    }
    if ((token = parameter(input, 'setPlayerCmd:mute:')) !== null) {
        canonicalInteger(token, 0, 1, 'mute');
        return decision(input, 'write', 'playback');
    }
    if ((token = parameter(input, 'setPlayerCmd:seek:')) !== null) {
        canonicalInteger(token, 0, LIMITS.seekSeconds, 'seek position');
        return decision(input, 'write', 'playback');
    }
    if ((token = parameter(input, 'setPlayerCmd:loopmode:')) !== null) {
        if (!['-1', '0', '1', '2'].includes(token)) {
            reject(ERROR_CODES.INVALID_PARAMETER, 'loop mode is not allowed');
        }
        return decision(input, 'write', 'playback');
    }
    if ((token = parameter(input, 'setPlayerCmd:switchmode:')) !== null) {
        if (!['wifi', 'bluetooth', 'line-in', 'optical', 'co-axial', 'udisk'].includes(token)) {
            reject(ERROR_CODES.INVALID_PARAMETER, 'input source is not allowed');
        }
        return decision(input, 'write', 'source');
    }
    if ((token = parameter(input, 'MCUKeyShortClick:')) !== null) {
        canonicalInteger(token, 1, 12, 'preset number');
        return decision(input, 'write', 'preset');
    }
    if ((token = parameter(input, 'setChannelBalance:')) !== null) {
        canonicalBalance(token);
        return decision(input, 'write', 'audio');
    }
    if ((token = parameter(input, 'setSpdifOutSwitchDelayMs:')) !== null) {
        canonicalInteger(token, 0, LIMITS.spdifDelayMs, 'SPDIF delay');
        return decision(input, 'write', 'audio');
    }
    if ((token = parameter(input, 'setPlayModeGainConfig:')) !== null) {
        validateGainConfig(token);
        return decision(input, 'write', 'audio');
    }
    if ((token = parameter(input, 'EQLoad:')) !== null) {
        validateEqPreset(token);
        return decision(input, 'write', 'equalizer');
    }
    if ((token = parameter(input, 'EQSetBand:')) !== null) {
        validateEqBandConfig(token);
        return decision(input, 'write', 'equalizer');
    }
    if ((token = parameter(input, 'startbtdiscovery:')) !== null) {
        canonicalInteger(token, 1, LIMITS.bluetoothDiscoverySeconds, 'Bluetooth discovery duration');
        return decision(input, 'write', 'bluetooth');
    }
    if ((token = parameter(input, 'connectbta2dpsynk:')) !== null
        || (token = parameter(input, 'disconnectbta2dpsynk:')) !== null) {
        if (!/^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(token)) {
            reject(ERROR_CODES.INVALID_PARAMETER, 'Bluetooth address must be six colon-separated octets');
        }
        const prefix = input.startsWith('connect') ? 'connectbta2dpsynk:' : 'disconnectbta2dpsynk:';
        return decision(`${prefix}${token.toUpperCase()}`, 'write', 'bluetooth');
    }
    if ((token = parameter(input, 'ConnectMasterAp:JoinGroupMaster:eth')) !== null) {
        if (!isPrivateIpv4(token)) {
            reject(ERROR_CODES.FORBIDDEN, 'group target must be a canonical private IPv4 address');
        }
        return decision(input, 'write', 'group', {
            highRisk: true,
            confirmationRequired: true,
            risk: 'network-group'
        });
    }
    if ((token = parameter(input, 'setShutdown:')) !== null) {
        canonicalInteger(token, 0, LIMITS.shutdownSeconds, 'shutdown delay');
        return decision(input, 'write', 'system', {
            highRisk: true,
            confirmationRequired: true,
            risk: 'scheduled-shutdown'
        });
    }
    if ((token = parameter(input, 'timeSync:')) !== null) {
        validateTimeSync(token);
        return decision(input, 'write', 'system');
    }
    if ((token = parameter(input, 'setLightOperationBrightConfig:')) !== null) {
        validateLightConfig(token);
        return decision(input, 'write', 'display');
    }
    if ((token = parameter(input, 'setPlayerCmd:play:')) !== null) {
        validateStreamUrl(token);
        return decision(input, 'write', 'stream');
    }
    if ((token = parameter(input, 'setPlayerCmd:playlist:')) !== null) {
        if (!token.endsWith(':1')) {
            reject(ERROR_CODES.INVALID_PARAMETER, 'playlist command must use the UI start index 1');
        }
        validateStreamUrl(token.slice(0, -2));
        return decision(input, 'write', 'stream');
    }

    if (looksExplicitlyForbidden(input)) {
        reject(ERROR_CODES.FORBIDDEN, 'WiiM command is an explicitly forbidden device operation');
    }
    if (/%[0-9A-Fa-f]{2}/.test(input) || input.includes('%')) {
        reject(ERROR_CODES.NON_CANONICAL_ENCODING, 'encoded command names are not accepted');
    }
    reject(ERROR_CODES.UNKNOWN, 'WiiM command is not in the product allowlist');
}

module.exports = {
    ERROR_CODES,
    FIXED_READ_COMMANDS,
    FIXED_WRITE_COMMANDS,
    LIMITS,
    WiimCommandPolicyError,
    validateWiimCommand
};

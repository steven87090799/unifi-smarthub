'use strict';

const { InputValidationError } = require('./write-input-policy');

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_PATH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ACTIVITY_SCOPES = Object.freeze(['general', 'trend', 'ucg', 'unifi-device-telemetry', 'nas', 'wiim', 'linux', 'ups']);

const QUERY_LIMITS = Object.freeze({
    nasLogsPage: Object.freeze({ defaultValue: 0, min: 0, max: 1000000 }),
    nasLogsSize: Object.freeze({ defaultValue: 50, min: 1, max: 200 }),
    nasSleepPages: Object.freeze({ defaultValue: 10, min: 1, max: 20 }),
    dockerLogLines: Object.freeze({ defaultValue: 200, min: 1, max: 1000 }),
    nasAlertHours: Object.freeze({ defaultValue: 24, min: 1, max: 720 }),
    reportLimit: Object.freeze({ defaultValue: 20, min: 1, max: 50 }),
    adGuardLimit: Object.freeze({ defaultValue: 100, min: 1, max: 200 }),
    historyHours: Object.freeze({ defaultValue: 24, min: 1, max: 8760 }),
    historyDays: Object.freeze({ defaultValue: 30, min: 1, max: 365 }),
    unifiTelemetryLimit: Object.freeze({ defaultValue: 200, min: 1, max: 500 })
});

function reject(message, field = null) {
    throw new InputValidationError(message, { field });
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function scalarQueryValue(value, { field = 'value', defaultValue } = {}) {
    if (value === undefined) {
        if (defaultValue !== undefined) return defaultValue;
        reject(`${field} is required`, field);
    }
    if (Array.isArray(value)) reject(`${field} must not be repeated`, field);
    if (typeof value !== 'string') reject(`${field} must be a scalar query string`, field);
    return value;
}

function exactQuery(query, { allowed = [], label = 'query parameters' } = {}) {
    if (!isPlainObject(query)) reject(`${label} must be a plain object`);
    const allowedSet = new Set(allowed);
    for (const key of Reflect.ownKeys(query)) {
        if (typeof key !== 'string') reject(`${label} contains a non-string field`);
        if (!allowedSet.has(key)) reject(`${label} contains unknown field: ${key}`, key);
        scalarQueryValue(query[key], { field: key });
    }
    return query;
}

function canonicalDecimalValue(value, {
    field = 'value',
    defaultValue,
    min = 0,
    max = Number.MAX_SAFE_INTEGER
} = {}) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
        throw new RangeError('canonical decimal bounds must be non-negative safe integers');
    }
    if (value === undefined) {
        if (defaultValue === undefined) reject(`${field} is required`, field);
        if (!Number.isSafeInteger(defaultValue) || defaultValue < min || defaultValue > max) {
            throw new RangeError(`${field} default must be a safe integer between ${min} and ${max}`);
        }
        return defaultValue;
    }
    const raw = scalarQueryValue(value, { field });
    if (!CANONICAL_DECIMAL.test(raw)) {
        reject(`${field} must be a canonical non-negative decimal integer`, field);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) reject(`${field} must be a safe integer`, field);
    if (parsed < min || parsed > max) reject(`${field} must be between ${min} and ${max}`, field);
    return parsed;
}

function enumQueryValue(value, {
    field = 'value',
    allowed,
    defaultValue
} = {}) {
    if (!Array.isArray(allowed) || allowed.length === 0
        || allowed.some(option => typeof option !== 'string')) {
        throw new TypeError('allowed query values must be a non-empty string array');
    }
    const raw = scalarQueryValue(value, { field, defaultValue });
    if (!allowed.includes(raw)) reject(`${field} must be one of: ${allowed.join(', ')}`, field);
    return raw;
}

function binaryFlagValue(value, { field = 'value', defaultValue = false } = {}) {
    if (typeof defaultValue !== 'boolean') throw new TypeError(`${field} default must be a boolean`);
    const raw = enumQueryValue(value, {
        field,
        allowed: ['0', '1'],
        defaultValue: defaultValue ? '1' : '0'
    });
    return raw === '1';
}

function safePathIdentifierValue(value, { field = 'id', max = 128 } = {}) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('identifier max must be a positive safe integer');
    const raw = scalarQueryValue(value, { field });
    if (raw.length === 0) reject(`${field} must not be empty`, field);
    if (raw.length > max) reject(`${field} must contain at most ${max} characters`, field);
    if (raw === '.' || raw === '..') reject(`${field} must not be a dot path segment`, field);
    if (CONTROL_OR_WHITESPACE.test(raw)) reject(`${field} must not contain whitespace or control characters`, field);
    if (/[\\/%?#]/u.test(raw)) reject(`${field} must not contain path or URL delimiters`, field);
    if (!SAFE_PATH_IDENTIFIER.test(raw)) reject(`${field} has an invalid identifier format`, field);
    return raw;
}

function boundedQueryStringValue(value, {
    field = 'value',
    defaultValue,
    min = 0,
    max = 256,
    allowControls = false
} = {}) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
        throw new RangeError('query string bounds must be non-negative safe integers');
    }
    const raw = scalarQueryValue(value, { field, defaultValue });
    if (raw.length < min || raw.length > max) reject(`${field} must contain ${min} through ${max} characters`, field);
    if (!allowControls && CONTROL_CHARACTERS.test(raw)) reject(`${field} must not contain control characters`, field);
    return raw;
}

function httpUrlQueryValue(value, { field = 'url', max = 2048 } = {}) {
    const raw = boundedQueryStringValue(value, { field, min: 1, max });
    let parsed;
    try { parsed = new URL(raw); }
    catch { reject(`${field} must be an absolute HTTP URL`, field); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        reject(`${field} must be an absolute HTTP URL`, field);
    }
    if (parsed.username || parsed.password) reject(`${field} must not contain credentials`, field);
    return raw;
}

function parseExactQuery(query, schema, { label = 'query parameters' } = {}) {
    if (!isPlainObject(schema)) throw new TypeError('query schema must be a plain object');
    const fields = Object.keys(schema);
    if (fields.some(field => typeof schema[field] !== 'function')) {
        throw new TypeError('every query schema field must be a parser function');
    }
    exactQuery(query, { allowed: fields, label });
    return Object.fromEntries(fields.map(field => [field, schema[field](query[field], field)]));
}

function integerField(options) {
    return (value, field) => canonicalDecimalValue(value, { field, ...options });
}

function binaryField(defaultValue = false) {
    return (value, field) => binaryFlagValue(value, { field, defaultValue });
}

function parseNasLogsQuery(query) {
    return parseExactQuery(query, {
        page: integerField(QUERY_LIMITS.nasLogsPage),
        size: integerField(QUERY_LIMITS.nasLogsSize),
        hideSelf: binaryField(false)
    });
}

function parseNasSleepStatsQuery(query) {
    return parseExactQuery(query, {
        pages: integerField(QUERY_LIMITS.nasSleepPages)
    });
}

function parseDockerLogsQuery(query) {
    return parseExactQuery(query, {
        lines: integerField(QUERY_LIMITS.dockerLogLines)
    });
}

function parseNasAlertsQuery(query) {
    return parseExactQuery(query, {
        hours: integerField(QUERY_LIMITS.nasAlertHours)
    });
}

function parseReportLogQuery(query) {
    return parseExactQuery(query, {
        limit: integerField(QUERY_LIMITS.reportLimit)
    });
}

function parseAdGuardQueryLogQuery(query) {
    return parseExactQuery(query, {
        limit: integerField(QUERY_LIMITS.adGuardLimit),
        filtered: binaryField(false)
    });
}

function parseHeartbeatQuery(query) {
    exactQuery(query, { allowed: ['scope', 'focus', 'session'] });
    const rawScope = scalarQueryValue(query.scope, { field: 'scope', defaultValue: '' });
    if (CONTROL_OR_WHITESPACE.test(rawScope)) reject('scope must not contain whitespace or control characters', 'scope');
    const scopes = rawScope === '' ? [] : rawScope.split(',');
    if (new Set(scopes).size !== scopes.length || scopes.some(scope => !ACTIVITY_SCOPES.includes(scope))) {
        reject(`scope must contain unique values from: ${ACTIVITY_SCOPES.join(', ')}`, 'scope');
    }
    return {
        scope: scopes.join(','),
        scopes,
        focus: binaryFlagValue(query.focus, { field: 'focus', defaultValue: false }),
        session: query.session === undefined ? 'legacy' : safePathIdentifierValue(query.session, {
            field: 'session', max: 128
        })
    };
}

function parseWiimStatusQuery(query) {
    return parseExactQuery(query, {
        type: (value, field) => enumQueryValue(value, {
            field, allowed: ['all', 'play', 'status'], defaultValue: 'all'
        })
    });
}

function parseWiimArtQuery(query) {
    return parseExactQuery(query, {
        u: (value, field) => httpUrlQueryValue(value, { field, max: 2048 }),
        v: (value, field) => boundedQueryStringValue(value, { field, defaultValue: '', max: 256 })
    });
}

function parseUnifiTelemetryHistoryQuery(query) {
    return parseExactQuery(query, {
        hours: integerField(QUERY_LIMITS.historyHours),
        limit: integerField(QUERY_LIMITS.unifiTelemetryLimit),
        before: (value, field) => value === undefined ? null : canonicalDecimalValue(value, {
            field, min: 1, max: Number.MAX_SAFE_INTEGER
        })
    });
}

function parseHistoryHoursQuery(query, options = {}) {
    return parseExactQuery(query, {
        hours: integerField({ ...QUERY_LIMITS.historyHours, ...options })
    });
}

function parseHistoryDaysQuery(query, options = {}) {
    return parseExactQuery(query, {
        days: integerField({ ...QUERY_LIMITS.historyDays, ...options })
    });
}

module.exports = {
    ACTIVITY_SCOPES,
    CANONICAL_DECIMAL,
    QUERY_LIMITS,
    binaryFlagValue,
    boundedQueryStringValue,
    canonicalDecimalValue,
    enumQueryValue,
    exactQuery,
    httpUrlQueryValue,
    isPlainObject,
    parseAdGuardQueryLogQuery,
    parseDockerLogsQuery,
    parseExactQuery,
    parseHistoryDaysQuery,
    parseHistoryHoursQuery,
    parseHeartbeatQuery,
    parseNasAlertsQuery,
    parseNasLogsQuery,
    parseNasSleepStatsQuery,
    parseReportLogQuery,
    parseUnifiTelemetryHistoryQuery,
    parseWiimArtQuery,
    parseWiimStatusQuery,
    safePathIdentifierValue,
    scalarQueryValue
};

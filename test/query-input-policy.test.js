'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InputValidationError } = require('../server/policies/write-input-policy');
const {
    binaryFlagValue,
    boundedQueryStringValue,
    canonicalDecimalValue,
    enumQueryValue,
    exactQuery,
    httpUrlQueryValue,
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
    parseWiimArtQuery,
    parseWiimStatusQuery,
    safePathIdentifierValue
} = require('../server/policies/query-input-policy');

function validationError(fn, field = undefined) {
    assert.throws(fn, error => {
        assert.ok(error instanceof InputValidationError);
        assert.equal(error.name, 'InputValidationError');
        assert.equal(error.httpStatus, 400);
        assert.equal(error.code, 'API_VALIDATION_FAILED');
        if (field !== undefined) assert.equal(error.field, field);
        return true;
    });
}

test('exact query accepts plain and null-prototype objects only', () => {
    assert.deepEqual(exactQuery({}, { allowed: [] }), {});
    const nullPrototype = Object.assign(Object.create(null), { limit: '20' });
    assert.equal(exactQuery(nullPrototype, { allowed: ['limit'] }), nullPrototype);

    for (const value of [null, [], 'limit=20', 20, new URLSearchParams('limit=20')]) {
        validationError(() => exactQuery(value, { allowed: ['limit'] }));
    }
});

test('exact query rejects unknown, repeated, nested, and non-string values', () => {
    validationError(() => exactQuery({ surprise: '1' }, { allowed: ['limit'] }), 'surprise');
    for (const value of [['1', '2'], { nested: '1' }, 1, true, null, undefined]) {
        validationError(() => exactQuery({ limit: value }, { allowed: ['limit'] }), 'limit');
    }

    const symbolQuery = { limit: '1' };
    symbolQuery[Symbol('hidden')] = '1';
    validationError(() => exactQuery(symbolQuery, { allowed: ['limit'] }));
});

test('canonical decimal parser accepts defaults and exact integer boundaries', () => {
    assert.equal(canonicalDecimalValue(undefined, { field: 'limit', defaultValue: 20, min: 1, max: 50 }), 20);
    assert.equal(canonicalDecimalValue('0', { field: 'page', min: 0, max: 100 }), 0);
    assert.equal(canonicalDecimalValue('1', { field: 'limit', min: 1, max: 50 }), 1);
    assert.equal(canonicalDecimalValue('50', { field: 'limit', min: 1, max: 50 }), 50);
});

test('canonical decimal parser rejects ambiguous forms, coercion, and out-of-range values', () => {
    const invalidForms = [
        '', ' ', '01', '00', '+1', '-1', '1.0', '.5', '1e2', '0x10', '1_0',
        'NaN', 'Infinity', '１', '1\n', ['1', '2'], 1, true, null
    ];
    for (const value of invalidForms) {
        validationError(() => canonicalDecimalValue(value, { field: 'limit', min: 0, max: 200 }), 'limit');
    }
    for (const value of ['0', '51', String(Number.MAX_SAFE_INTEGER + 1), '9'.repeat(400)]) {
        validationError(() => canonicalDecimalValue(value, { field: 'limit', min: 1, max: 50 }), 'limit');
    }
});

test('enum and binary flag parsing accepts only exact scalar spellings', () => {
    assert.equal(enumQueryValue('active', { field: 'state', allowed: ['active', 'idle'] }), 'active');
    assert.equal(binaryFlagValue(undefined, { field: 'filtered' }), false);
    assert.equal(binaryFlagValue(undefined, { field: 'filtered', defaultValue: true }), true);
    assert.equal(binaryFlagValue('0', { field: 'filtered' }), false);
    assert.equal(binaryFlagValue('1', { field: 'filtered' }), true);

    for (const value of ['', 'true', 'false', '01', ' 1', '1 ', 0, 1, true, ['1', '0']]) {
        validationError(() => binaryFlagValue(value, { field: 'filtered' }), 'filtered');
    }
});

test('safe path identifiers preserve exact valid spelling and reject path ambiguity', () => {
    const valid = ['a', 'ABCdef_123-4.5:6', 'Container.Name-01', '0'.repeat(128)];
    for (const value of valid) assert.equal(safePathIdentifierValue(value), value);

    const invalid = [
        '', '.', '..', '.hidden', '../container', 'container/name', 'container\\name',
        '%2f', '%2Fetc', 'name?x=1', 'name#fragment', 'two words', ' two', 'two ',
        'tab\there', 'line\nhere', 'nul\0here', 'delete\u007fhere', '雪', 'a'.repeat(129),
        ['one', 'two'], 123
    ];
    for (const value of invalid) validationError(() => safePathIdentifierValue(value), 'id');

    assert.equal(safePathIdentifierValue('CaseSensitive-ID', { field: 'containerId', max: 32 }), 'CaseSensitive-ID');
    validationError(() => safePathIdentifierValue('x'.repeat(33), { field: 'containerId', max: 32 }), 'containerId');
});

test('exact schema composition applies defaults without accepting extra fields', () => {
    const schema = {
        page: (value, field) => canonicalDecimalValue(value, { field, defaultValue: 0, min: 0, max: 9 }),
        enabled: (value, field) => binaryFlagValue(value, { field, defaultValue: false })
    };
    assert.deepEqual(parseExactQuery({}, schema), { page: 0, enabled: false });
    assert.deepEqual(parseExactQuery({ page: '9', enabled: '1' }, schema), { page: 9, enabled: true });
    validationError(() => parseExactQuery({ extra: '1' }, schema), 'extra');
    validationError(() => parseExactQuery({ page: ['1', '2'] }, schema), 'page');
});

test('route query parsers return bounded defaults and boundary values', () => {
    const cases = [
        [parseNasLogsQuery, {}, { page: 0, size: 50, hideSelf: false }],
        [parseNasLogsQuery, { page: '1000000', size: '200', hideSelf: '1' }, { page: 1000000, size: 200, hideSelf: true }],
        [parseNasSleepStatsQuery, {}, { pages: 10 }],
        [parseNasSleepStatsQuery, { pages: '20' }, { pages: 20 }],
        [parseDockerLogsQuery, {}, { lines: 200 }],
        [parseDockerLogsQuery, { lines: '1000' }, { lines: 1000 }],
        [parseNasAlertsQuery, {}, { hours: 24 }],
        [parseNasAlertsQuery, { hours: '720' }, { hours: 720 }],
        [parseReportLogQuery, {}, { limit: 20 }],
        [parseReportLogQuery, { limit: '50' }, { limit: 50 }],
        [parseAdGuardQueryLogQuery, {}, { limit: 100, filtered: false }],
        [parseAdGuardQueryLogQuery, { limit: '200', filtered: '1' }, { limit: 200, filtered: true }],
        [parseHistoryHoursQuery, {}, { hours: 24 }],
        [parseHistoryHoursQuery, { hours: '8760' }, { hours: 8760 }],
        [parseHistoryDaysQuery, {}, { days: 30 }],
        [parseHistoryDaysQuery, { days: '365' }, { days: 365 }]
    ];
    for (const [parser, query, expected] of cases) assert.deepEqual(parser(query), expected);
});

test('route query parsers reject min-1, max+1, duplicates, and unknowns', () => {
    const invalid = [
        [parseNasLogsQuery, { page: '1000001' }, 'page'],
        [parseNasLogsQuery, { size: '0' }, 'size'],
        [parseNasLogsQuery, { size: '201' }, 'size'],
        [parseNasLogsQuery, { hideSelf: '2' }, 'hideSelf'],
        [parseNasSleepStatsQuery, { pages: '0' }, 'pages'],
        [parseNasSleepStatsQuery, { pages: '21' }, 'pages'],
        [parseDockerLogsQuery, { lines: '0' }, 'lines'],
        [parseDockerLogsQuery, { lines: '1001' }, 'lines'],
        [parseNasAlertsQuery, { hours: '0' }, 'hours'],
        [parseNasAlertsQuery, { hours: '721' }, 'hours'],
        [parseReportLogQuery, { limit: '0' }, 'limit'],
        [parseReportLogQuery, { limit: '51' }, 'limit'],
        [parseAdGuardQueryLogQuery, { limit: '201' }, 'limit'],
        [parseAdGuardQueryLogQuery, { filtered: ['0', '1'] }, 'filtered'],
        [parseHistoryHoursQuery, { hours: '1.5' }, 'hours'],
        [parseHistoryDaysQuery, { days: '366' }, 'days'],
        [parseReportLogQuery, { page: '1' }, 'page']
    ];
    for (const [parser, query, field] of invalid) validationError(() => parser(query), field);
});

test('generic history parsers support route-specific integer bounds and defaults', () => {
    assert.deepEqual(parseHistoryHoursQuery({}, { defaultValue: 720, min: 24, max: 8760 }), { hours: 720 });
    assert.deepEqual(parseHistoryHoursQuery({ hours: '24' }, { defaultValue: 720, min: 24, max: 8760 }), { hours: 24 });
    validationError(() => parseHistoryHoursQuery({ hours: '23' }, { defaultValue: 720, min: 24, max: 8760 }), 'hours');
    assert.deepEqual(parseHistoryDaysQuery({}, { defaultValue: 7, min: 1, max: 30 }), { days: 7 });
    validationError(() => parseHistoryDaysQuery({ days: '31' }, { defaultValue: 7, min: 1, max: 30 }), 'days');
});

test('heartbeat and WiiM status queries use exact bounded enums', () => {
    assert.deepEqual(parseHeartbeatQuery({}), { scope: '', scopes: [], focus: false, session: 'legacy' });
    assert.deepEqual(parseHeartbeatQuery({ scope: 'trend,nas,ups', focus: '1' }), {
        scope: 'trend,nas,ups', scopes: ['trend', 'nas', 'ups'], focus: true, session: 'legacy'
    });
    assert.deepEqual(parseHeartbeatQuery({ scope: 'ucg,unifi-device-telemetry', session: 'ucg-tab' }).scopes, [
        'ucg', 'unifi-device-telemetry'
    ]);
    assert.equal(parseHeartbeatQuery({ scope: 'general', session: 'tab-1' }).session, 'tab-1');
    assert.deepEqual(parseWiimStatusQuery({}), { type: 'all' });
    assert.deepEqual(parseWiimStatusQuery({ type: 'play' }), { type: 'play' });

    for (const scope of ['unknown', 'trend,trend', 'trend, nas', 'trend,', ',trend', ['trend', 'nas']]) {
        validationError(() => parseHeartbeatQuery({ scope }), 'scope');
    }
    validationError(() => parseHeartbeatQuery({ focus: 'true' }), 'focus');
    validationError(() => parseHeartbeatQuery({ scope: 'trend', extra: '1' }), 'extra');
    validationError(() => parseWiimStatusQuery({ type: 'ALL' }), 'type');
    validationError(() => parseWiimStatusQuery({ type: ['all', 'play'] }), 'type');
});

test('bounded query strings and HTTP URLs preserve safe values only', () => {
    assert.equal(boundedQueryStringValue(undefined, { field: 'v', defaultValue: '', max: 10 }), '');
    assert.equal(boundedQueryStringValue('Track name', { field: 'v', max: 20 }), 'Track name');
    assert.equal(httpUrlQueryValue('https://cdn.example/art.jpg?size=2'), 'https://cdn.example/art.jpg?size=2');
    assert.equal(httpUrlQueryValue('http://192.0.2.5/art'), 'http://192.0.2.5/art');

    for (const value of ['x\nheader', 'x\0y', 'x'.repeat(11), ['x']]) {
        validationError(() => boundedQueryStringValue(value, { field: 'v', max: 10 }), 'v');
    }
    for (const value of ['', '/relative', 'ftp://cdn.example/a', 'https://user:pass@cdn.example/a', 'https://', 'x'.repeat(2049)]) {
        validationError(() => httpUrlQueryValue(value, { field: 'u' }), 'u');
    }
});

test('WiiM art query requires an exact bounded URL and optional version key', () => {
    assert.deepEqual(parseWiimArtQuery({ u: 'https://cdn.example/art.jpg' }), {
        u: 'https://cdn.example/art.jpg', v: ''
    });
    assert.deepEqual(parseWiimArtQuery({ u: 'http://192.0.2.5/art', v: 'Song title' }), {
        u: 'http://192.0.2.5/art', v: 'Song title'
    });
    validationError(() => parseWiimArtQuery({}), 'u');
    validationError(() => parseWiimArtQuery({ u: 'file:///etc/passwd' }), 'u');
    validationError(() => parseWiimArtQuery({ u: 'https://cdn.example/a', extra: '1' }), 'extra');
});

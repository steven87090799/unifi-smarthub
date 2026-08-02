'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUpsSourceConfig, selectUpsSource } = require('../server/services/ups-source-selection');

test('auto mode does not mark a successful first candidate as fallback', async () => {
    const result = await selectUpsSource({
        configuredSource: 'auto',
        readers: {
            ppb: async () => ({ source: 'ppb', status: 'Normal' })
        }
    });

    assert.equal(result.data.actualSource, 'ppb');
    assert.equal(result.data.configuredSource, 'auto');
    assert.equal(result.data.fallbackUsed, false);
    assert.equal(result.data.fallbackReason, null);
});

test('auto mode records the first failed source before selecting a healthy fallback', async () => {
    const attempts = [];
    const result = await selectUpsSource({
        configuredSource: 'auto',
        readers: {
            ppb: async () => null,
            nut: async () => ({ source: 'nut', status: 'OL' })
        },
        onAttempt: attempt => attempts.push(attempt)
    });

    assert.equal(result.data.actualSource, 'nut');
    assert.equal(result.data.configuredSource, 'auto');
    assert.equal(result.data.fallbackAllowed, true);
    assert.equal(result.data.fallbackUsed, true);
    assert.equal(result.data.fallbackReason, 'ppb_unreachable');
    assert.deepEqual(attempts.map(attempt => [attempt.source, attempt.ok]), [['ppb', false], ['nut', true]]);
});

test('an explicit source is fail-closed unless fallback is explicitly enabled', async () => {
    const calls = [];
    const readers = {
        ppb: async () => { calls.push('ppb'); return null; },
        nut: async () => { calls.push('nut'); return { source: 'nut' }; }
    };

    const strict = await selectUpsSource({ configuredSource: 'ppb', readers });
    assert.deepEqual(calls, ['ppb']);
    assert.equal(strict.data, null);
    assert.equal(strict.actualSource, null);
    assert.equal(strict.fallbackAllowed, false);
    assert.equal(strict.fallbackUsed, false);

    calls.length = 0;
    const allowed = await selectUpsSource({ configuredSource: 'ppb', allowFallback: true, readers });
    assert.deepEqual(calls, ['ppb', 'nut']);
    assert.equal(allowed.data.actualSource, 'nut');
    assert.equal(allowed.fallbackAllowed, true);
    assert.equal(allowed.fallbackUsed, true);
    assert.equal(allowed.fallbackReason, 'ppb_unreachable');
});

test('source configuration validates the explicit boolean contract', () => {
    assert.deepEqual(resolveUpsSourceConfig({ source: 'ppb' }), {
        configuredSource: 'ppb', fallbackAllowed: false
    });
    assert.deepEqual(resolveUpsSourceConfig({ source: 'auto', allowFallback: 'false' }), {
        configuredSource: 'auto', fallbackAllowed: true
    });
    assert.throws(() => resolveUpsSourceConfig({ source: 'ppb', allowFallback: 'yes' }), /UPS_ALLOW_FALLBACK/u);
    assert.throws(() => resolveUpsSourceConfig({ source: 'unknown' }), /UPS_SOURCE/u);
});

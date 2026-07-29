'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackendSamplerRegistry } = require('../server/services/backend-sampler-registry');

function fakeSampler(name, calls) {
    return {
        rebuild(options) { calls.push([name, options]); },
        stop() { calls.push([name, 'stop']); },
        snapshot() { return { running: false, scheduled: true, stopped: false }; }
    };
}

test('prompt sampling rebuilds only samplers matching the activated scopes', () => {
    const calls = [];
    const registry = createBackendSamplerRegistry();
    registry.register({ name: 'trendHistory', scopes: ['trend'], sampler: fakeSampler('trendHistory', calls) });
    registry.register({ name: 'ucgHistory', scopes: ['ucg'], sampler: fakeSampler('ucgHistory', calls) });
    registry.register({ name: 'nasHistory', scopes: ['nas'], sampler: fakeSampler('nasHistory', calls) });
    registry.register({ name: 'wiimTemperature', scopes: ['wiim'], sampler: fakeSampler('wiimTemperature', calls) });
    registry.register({ name: 'linuxHistory', scopes: ['linux'], sampler: fakeSampler('linuxHistory', calls) });
    registry.register({ name: 'upsSample', scopes: ['ups'], sampler: fakeSampler('upsSample', calls) });
    registry.register({ name: 'ppbEventSync', scopes: ['ups'], sampler: fakeSampler('ppbEventSync', calls) });

    assert.deepEqual(registry.requestPromptSampling(['nas']), ['nasHistory']);
    assert.deepEqual(calls, [['nasHistory', { immediate: true }]]);
    calls.length = 0;
    assert.deepEqual(registry.requestPromptSampling(['ups']), ['upsSample', 'ppbEventSync']);
    assert.deepEqual(calls, [
        ['upsSample', { immediate: true }],
        ['ppbEventSync', { immediate: true }]
    ]);
    calls.length = 0;
    assert.deepEqual(registry.requestPromptSampling(['general']), []);
    assert.deepEqual(calls, []);
});

test('settings rebuild can reschedule all samplers and registry diagnostics expose no collectors', () => {
    const calls = [];
    const registry = createBackendSamplerRegistry();
    registry.register({ name: 'nasHistory', scopes: ['nas'], sampler: fakeSampler('nasHistory', calls) });
    registry.register({ name: 'upsSample', scopes: ['ups'], sampler: fakeSampler('upsSample', calls) });
    assert.deepEqual(registry.rebuildAll(), ['nasHistory', 'upsSample']);
    assert.deepEqual(calls, [
        ['nasHistory', { immediate: false }],
        ['upsSample', { immediate: false }]
    ]);
    assert.deepEqual(registry.snapshot().configuredScopes, ['nas', 'ups']);
    registry.stopAll();
});

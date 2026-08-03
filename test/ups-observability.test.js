'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpsObservability } = require('../server/services/ups-observability');

const failure = {
    configuredSource: 'ppb',
    fallbackAllowed: true,
    failureReason: 'ppb_timeout',
    failureMessage: '指定來源 ppb 失敗，已允許 fallback，但所有候選皆不可用。'
};

test('identical UPS failures stay bounded and log degraded/offline transitions plus cooldown summaries', () => {
    const observer = createUpsObservability({ cooldownMs: 1000 });
    const events = [];
    events.push(...observer.observe({ ...failure, fetchHealth: 'degraded', now: 0 }));
    for (let index = 0; index < 100; index += 1) {
        events.push(...observer.observe({ ...failure, fetchHealth: index < 1 ? 'degraded' : 'offline', now: 10 + index }));
    }
    assert.equal(events.filter(event => event.kind === 'degraded').length, 1);
    assert.equal(events.filter(event => event.kind === 'offline').length, 1);
    assert.equal(events.filter(event => event.kind === 'summary').length, 0);
    events.push(...observer.observe({ ...failure, fetchHealth: 'offline', now: 2000 }));
    assert.equal(events.filter(event => event.kind === 'summary').length, 1);
});

test('fallback entry, recovery, and a later fallback are each transition-bounded', () => {
    const observer = createUpsObservability({ cooldownMs: 1000 });
    const fallback = { configuredSource: 'auto', actualSource: 'nut', fallbackUsed: true, fallbackReason: 'ppb_unreachable' };
    const primary = { configuredSource: 'auto', actualSource: 'ppb', fallbackUsed: false, fallbackReason: null };
    const events = [
        ...observer.observe({ ok: true, selection: fallback, now: 0 }),
        ...observer.observe({ ok: true, selection: fallback, now: 1 }),
        ...observer.observe({ ok: true, selection: primary, now: 2 }),
        ...observer.observe({ ok: true, selection: fallback, now: 3 })
    ];
    assert.equal(events.filter(event => event.kind === 'fallback_entered').length, 2);
    assert.equal(events.filter(event => event.kind === 'fallback_ended').length, 1);
});

test('primary recovery emits one recovery and ends the fallback incident', () => {
    const observer = createUpsObservability({ cooldownMs: 1000 });
    observer.observe({ ...failure, fetchHealth: 'degraded', now: 0 });
    observer.observe({ ...failure, fetchHealth: 'offline', now: 1 });
    observer.observe({ ok: true, selection: { configuredSource: 'ppb', actualSource: 'nut', fallbackUsed: true }, now: 2 });
    const recovered = observer.observe({ ok: true, selection: { configuredSource: 'ppb', actualSource: 'ppb', fallbackUsed: false }, now: 3 });
    assert.deepEqual(recovered.map(event => event.kind), ['fallback_ended']);
});

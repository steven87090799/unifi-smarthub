'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAdaptiveSampler } = require('../server/services/adaptive-sampler');

const source = fs.readFileSync(path.join(process.env.P2_AUDIT_SOURCE_ROOT || path.join(__dirname, '..'), 'server.js'), 'utf8');
const lastAttempt = source.slice(source.indexOf('function lastUpsAttemptAt('), source.indexOf('function upsStatusPayload('));
const sampling = source.slice(source.indexOf('async function sampleUpsIfDue('), source.indexOf('let lastUpsHighLoadTs ='));
const registrationStart = source.indexOf("registerBackendSampler({\n    name: 'upsSample'");
const registration = source.slice(registrationStart, source.indexOf("registerBackendSampler({\n    name: 'ppbEventSync'", registrationStart));

function fixture({ failure = false } = {}) {
    let now = 1000;
    let interval = 5000;
    let state = failure ? { lastSuccessAt: 100, lastFailureAt: 1000 } : { lastSuccessAt: 1000, lastFailureAt: 0 };
    let calls = 0;
    let nextId = 0;
    let sampler;
    const timers = new Map();
    const context = {
        Date: { now: () => now },
        upsFetchState: { snapshot: () => state },
        upsSampleMs: () => interval,
        sampleUps: async () => { calls += 1; state = { lastSuccessAt: now, lastFailureAt: 0 }; return state; },
        registerBackendSampler(options) {
            sampler = createAdaptiveSampler({
                collect: options.collect, getDelayMs: options.getDelayMs,
                setTimeoutFn: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
                clearTimeoutFn: id => timers.delete(id)
            });
        }
    };
    vm.runInNewContext(`${lastAttempt}\n${sampling}\n${registration}`, context);
    return {
        sampler, calls: () => calls,
        clock(value) { now = value; },
        interval(value) { interval = value; },
        manualSample(value) { state = { lastSuccessAt: value, lastFailureAt: 0 }; },
        delay() { assert.equal(timers.size, 1); return [...timers.values()][0].delay; },
        async fire(value) {
            now = value;
            assert.equal(timers.size, 1);
            const [id, timer] = [...timers][0];
            timers.delete(id);
            timer.callback();
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

for (const failure of [false, true]) {
    test(`UPS ${failure ? 'failed' : 'successful'} attempt retries an early timer at its deadline, not one full interval later`, async () => {
        const h = fixture({ failure });
        h.sampler.start({ immediate: false });
        assert.equal(h.delay(), 5000);
        await h.fire(5999);
        assert.equal(h.calls(), 0, 'the original freshness guard must still prevent an early upstream read');
        assert.equal(h.delay(), 1, 'only the remaining millisecond is due, not another 5000 ms');
        await h.fire(6000);
        assert.equal(h.calls(), 1);
        assert.equal(h.delay(), 5000);
        h.sampler.stop();
    });
}

test('UPS deadline follows a concurrent manual sample and changing active/idle policy without duplicate reads', async () => {
    const h = fixture();
    h.sampler.start({ immediate: false });
    h.manualSample(4000);
    await h.fire(6000);
    assert.equal(h.calls(), 0);
    assert.equal(h.delay(), 3000);
    h.interval(1000);
    h.clock(6100);
    h.sampler.rebuild();
    assert.equal(h.delay(), 1);
    await h.fire(6101);
    assert.equal(h.calls(), 1);
    assert.equal(h.delay(), 1000);
    h.sampler.stop();
});

test('UPS backwards wall-clock changes retain a bounded positive retry instead of spinning or sleeping indefinitely', () => {
    const h = fixture();
    h.clock(500);
    h.sampler.start({ immediate: false });
    assert.equal(h.delay(), 5000);
    h.sampler.stop();
});

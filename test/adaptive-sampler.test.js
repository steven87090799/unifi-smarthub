'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdaptiveSampler } = require('../server/services/adaptive-sampler');

function fakeTimers() {
    let nextId = 0;
    const timers = new Map();
    return {
        set(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, delay });
            return id;
        },
        clear(id) { timers.delete(id); },
        pending() { return [...timers.entries()]; },
        fire(id) {
            const timer = timers.get(id);
            assert.ok(timer, `timer ${id} should still be pending`);
            timers.delete(id);
            timer.callback();
        }
    };
}

test('adaptive sampler switches Active/Idle delays and clears the replaced timer', () => {
    const clock = fakeTimers();
    let active = true;
    const sampler = createAdaptiveSampler({
        collect: async () => {},
        getDelayMs: () => active ? 5000 : 600000,
        setTimeoutFn: (callback, delay) => clock.set(callback, delay),
        clearTimeoutFn: id => clock.clear(id)
    });

    sampler.start({ immediate: false });
    const [[firstId, first]] = clock.pending();
    assert.equal(first.delay, 5000);

    active = false;
    sampler.rebuild({ immediate: false });
    const [[secondId, second]] = clock.pending();
    assert.notEqual(secondId, firstId);
    assert.equal(second.delay, 600000);
    assert.equal(clock.pending().length, 1);
});

test('adaptive sampler never overlaps a slow collector after repeated rebuilds', async () => {
    const clock = fakeTimers();
    let resolveCollection;
    let calls = 0;
    const sampler = createAdaptiveSampler({
        collect: () => {
            calls++;
            return new Promise(resolve => { resolveCollection = resolve; });
        },
        getDelayMs: () => 5000,
        setTimeoutFn: (callback, delay) => clock.set(callback, delay),
        clearTimeoutFn: id => clock.clear(id)
    });

    sampler.start();
    clock.fire(clock.pending()[0][0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);

    sampler.rebuild({ immediate: true });
    clock.fire(clock.pending()[0][0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);

    resolveCollection();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clock.pending().length, 1);
    assert.equal(clock.pending()[0][1].delay, 5000);
});

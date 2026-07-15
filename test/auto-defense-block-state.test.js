'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createAutoDefenseBlockState,
    isRecentAlarmTimestamp,
    normalizeMac
} = require('../server/services/auto-defense-block-state');

function macFor(index) {
    const hex = index.toString(16).padStart(12, '0');
    return hex.match(/../g).join(':');
}

test('successful block cooldown expires so a later infection can be isolated again', () => {
    const state = createAutoDefenseBlockState({ cooldownMs: 600_000 });
    const mac = 'aa:bb:cc:dd:ee:ff';
    assert.equal(state.shouldBlock(mac, 1_000), true);
    state.record(mac, 1_000);
    assert.equal(state.shouldBlock(mac, 600_999), false);
    assert.equal(state.shouldBlock(mac, 601_000), true);
    assert.equal(state.shouldBlock(mac, 601_001), true, 'checking does not suppress a block that never succeeded');
    state.record(mac, 601_001);
    assert.equal(state.shouldBlock(mac, 601_002), false);
});

test('MAC identity is canonical and failed upstream work is not recorded by observation', () => {
    const state = createAutoDefenseBlockState();
    assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(state.shouldBlock('AA-BB-CC-DD-EE-FF', 10), true);
    assert.equal(state.shouldBlock('aa:bb:cc:dd:ee:ff', 11), true);
    state.record('AA-BB-CC-DD-EE-FF', 12);
    assert.equal(state.shouldBlock('aa:bb:cc:dd:ee:ff', 13), false);
});

test('rotating MAC retention remains bounded and preserves the most recent identities', () => {
    const state = createAutoDefenseBlockState({ maxEntries: 2000 });
    for (let index = 0; index < 50_000; index += 1) state.record(macFor(index), 1000 + index);
    assert.equal(state.size(), 2000);
    assert.equal(state.shouldBlock(macFor(0), 51_000), true, 'oldest identity was evicted');
    assert.equal(state.shouldBlock(macFor(49_999), 51_000), false, 'newest identity retains cooldown');
    state.record(macFor(49_000), 52_000);
    assert.equal(state.size(), 2000);
});

test('ambiguous identity and time fail closed before state mutation', () => {
    const state = createAutoDefenseBlockState({ maxEntries: 2 });
    for (const value of [null, '', 'aa:bb', 'gg:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff\n']) {
        assert.throws(() => state.record(value, 1), /MAC/);
    }
    assert.throws(() => state.record('aa:bb:cc:dd:ee:ff', Number.NaN), /timestamp/);
    assert.throws(() => state.shouldBlock('aa:bb:cc:dd:ee:ff', -1), /timestamp/);
    assert.equal(state.size(), 0);
});

test('destructive auto-defense ignores invalid, expired, and future-dated alarms', () => {
    const now = Date.parse('2026-07-15T12:00:00.000Z');
    assert.equal(isRecentAlarmTimestamp('2026-07-15T11:59:59.000Z', now), true);
    assert.equal(isRecentAlarmTimestamp('2026-07-15T11:50:00.001Z', now), true);
    assert.equal(isRecentAlarmTimestamp('2026-07-15T11:50:00.000Z', now), false);
    assert.equal(isRecentAlarmTimestamp('2026-07-15T12:00:00.001Z', now), false);
    assert.equal(isRecentAlarmTimestamp('not-a-date', now), false);
});

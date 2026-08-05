'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_FAILURE_THRESHOLD,
    FETCH_HEALTH,
    TRANSITION_TYPES,
    createUpsState
} = require('../server/jobs/ups-state');

function createClock(start = 1_000) {
    let current = start;
    return {
        now: () => current,
        advance(ms) { current += ms; }
    };
}

function live(battery = 100) {
    return { actualSource: 'ppb', battery, onBattery: false };
}

test('starts unknown and a successful poll records fresh last-good data', () => {
    const clock = createClock();
    const ups = createUpsState({ now: clock.now });

    assert.deepEqual(ups.snapshot(), {
        fetchHealth: FETCH_HEALTH.UNKNOWN,
        consecutiveFailures: 0,
        failureThreshold: DEFAULT_FAILURE_THRESHOLD,
        lastGood: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        failureReason: null,
        offlineSince: null,
        configGeneration: 1,
        reconfiguring: false,
        staleAgeMs: null,
        dataIsStale: false
    });

    const outcome = ups.recordSuccess(live(96));
    assert.equal(outcome.snapshot.fetchHealth, FETCH_HEALTH.HEALTHY);
    assert.deepEqual(outcome.snapshot.lastGood, live(96));
    assert.equal(outcome.snapshot.lastSuccessAt, 1_000);
    assert.equal(outcome.snapshot.staleAgeMs, 0);
    assert.equal(outcome.snapshot.dataIsStale, false);
    assert.deepEqual(outcome.transitions, []);
});

test('one and two failures are degraded; the third confirms offline exactly once', () => {
    const clock = createClock();
    const ups = createUpsState({ now: clock.now });
    ups.recordSuccess(live(92));

    clock.advance(1_000);
    const first = ups.recordFailure('timeout-1');
    assert.equal(first.snapshot.fetchHealth, FETCH_HEALTH.DEGRADED);
    assert.equal(first.snapshot.consecutiveFailures, 1);
    assert.deepEqual(first.transitions, []);

    clock.advance(1_000);
    const second = ups.recordFailure('timeout-2');
    assert.equal(second.snapshot.fetchHealth, FETCH_HEALTH.DEGRADED);
    assert.equal(second.snapshot.consecutiveFailures, 2);
    assert.deepEqual(second.transitions, []);

    clock.advance(1_000);
    const third = ups.recordFailure('timeout-3');
    assert.equal(third.snapshot.fetchHealth, FETCH_HEALTH.OFFLINE);
    assert.equal(third.snapshot.consecutiveFailures, 3);
    assert.equal(third.snapshot.offlineSince, 4_000);
    assert.deepEqual(third.transitions, [{
        type: TRANSITION_TYPES.OFFLINE,
        at: 4_000,
        failureCount: 3,
        reason: 'timeout-3'
    }]);

    clock.advance(1_000);
    const fourth = ups.recordFailure('timeout-4');
    assert.equal(fourth.snapshot.fetchHealth, FETCH_HEALTH.OFFLINE);
    assert.equal(fourth.snapshot.consecutiveFailures, 4);
    assert.equal(fourth.snapshot.offlineSince, 4_000);
    assert.deepEqual(fourth.transitions, []);
});

test('success before the threshold resets failures without a recovery transition', () => {
    const clock = createClock();
    const ups = createUpsState({ now: clock.now });
    ups.recordSuccess(live(99));
    ups.recordFailure('timeout');
    ups.recordFailure('timeout');

    clock.advance(500);
    const outcome = ups.recordSuccess(live(98));
    assert.equal(outcome.snapshot.fetchHealth, FETCH_HEALTH.HEALTHY);
    assert.equal(outcome.snapshot.consecutiveFailures, 0);
    assert.equal(outcome.snapshot.failureReason, null);
    assert.equal(outcome.snapshot.offlineSince, null);
    assert.deepEqual(outcome.transitions, []);

    const nextFailure = ups.recordFailure('new timeout');
    assert.equal(nextFailure.snapshot.consecutiveFailures, 1);
    assert.equal(nextFailure.snapshot.fetchHealth, FETCH_HEALTH.DEGRADED);
});

test('confirmed offline recovery emits once and later successes are deduplicated', () => {
    const clock = createClock();
    const ups = createUpsState({ now: clock.now });
    ups.recordSuccess(live(90));
    ups.recordFailure('timeout');
    ups.recordFailure('timeout');
    const offline = ups.recordFailure('timeout');

    clock.advance(2_000);
    const recovered = ups.recordSuccess(live(89));
    assert.deepEqual(recovered.transitions, [{
        type: TRANSITION_TYPES.RECOVERED,
        at: 3_000,
        offlineSince: offline.snapshot.offlineSince
    }]);
    assert.equal(recovered.snapshot.fetchHealth, FETCH_HEALTH.HEALTHY);
    assert.equal(recovered.snapshot.consecutiveFailures, 0);

    clock.advance(1_000);
    assert.deepEqual(ups.recordSuccess(live(88)).transitions, []);
});

test('offline and recovery transition stream can drive notifications without storms', () => {
    const clock = createClock();
    const ups = createUpsState({ now: clock.now });
    const events = [];
    const observe = outcome => events.push(...outcome.transitions.map(event => event.type));

    observe(ups.recordSuccess(live()));
    for (let i = 0; i < 6; i += 1) observe(ups.recordFailure(new Error('unreachable')));
    observe(ups.recordSuccess(live()));
    observe(ups.recordSuccess(live()));

    assert.deepEqual(events, [TRANSITION_TYPES.OFFLINE, TRANSITION_TYPES.RECOVERED]);
});

test('failure threshold is configurable and validated', () => {
    const ups = createUpsState({ failureThreshold: 2, now: () => 10 });
    assert.equal(ups.recordFailure().snapshot.fetchHealth, FETCH_HEALTH.DEGRADED);
    assert.equal(ups.recordFailure().snapshot.fetchHealth, FETCH_HEALTH.OFFLINE);

    for (const failureThreshold of [0, -1, 1.5, '3']) {
        assert.throws(() => createUpsState({ failureThreshold }), /positive integer/);
    }
});

test('last-good data and timestamp remain available with deterministic stale age', () => {
    const clock = createClock(20_000);
    const ups = createUpsState({ now: clock.now });
    const payload = live(73);
    ups.recordPoll(payload);

    // Callers cannot mutate the retained snapshot after recording it.
    payload.battery = 1;
    clock.advance(2_500);
    const degraded = ups.recordPoll(null, { reason: 'temporary timeout' }).snapshot;
    assert.deepEqual(degraded.lastGood, live(73));
    assert.equal(degraded.lastSuccessAt, 20_000);
    assert.equal(degraded.staleAgeMs, 2_500);
    assert.equal(degraded.dataIsStale, true);

    clock.advance(7_500);
    const later = ups.snapshot();
    assert.deepEqual(later.lastGood, live(73));
    assert.equal(later.lastSuccessAt, 20_000);
    assert.equal(later.staleAgeMs, 10_000);
});

test('recordPoll treats a missing live result as failure and rejects invalid success input', () => {
    const ups = createUpsState({ now: () => 42 });
    assert.equal(ups.recordPoll(null, { reason: 'all sources failed' }).snapshot.failureReason, 'all sources failed');
    assert.equal(ups.recordPoll(undefined).snapshot.consecutiveFailures, 2);
    assert.throws(() => ups.recordSuccess(null), /must be an object/);
    assert.throws(() => createUpsState({ now: () => Number.NaN }).snapshot(), /finite timestamp/);
});

test('configuration changes preserve last-good data but fence old generations until a fresh sample', () => {
    const clock = createClock();
    const ups = createUpsState({ now: clock.now, configGeneration: 1 });
    ups.recordSuccess({ ...live(88), configGeneration: 1 });

    clock.advance(100);
    const changed = ups.reconfigure(2);
    assert.equal(changed.snapshot.fetchHealth, FETCH_HEALTH.DEGRADED);
    assert.equal(changed.snapshot.reconfiguring, true);
    assert.equal(changed.snapshot.dataIsStale, true);
    assert.equal(changed.snapshot.lastGood.configGeneration, 1);
    assert.throws(() => ups.recordSuccess({ ...live(87), configGeneration: 1 }), /stale configGeneration/u);

    const recovered = ups.recordSuccess({ ...live(87), configGeneration: 2 });
    assert.equal(recovered.snapshot.fetchHealth, FETCH_HEALTH.HEALTHY);
    assert.equal(recovered.snapshot.configGeneration, 2);
    assert.equal(recovered.snapshot.reconfiguring, false);
});

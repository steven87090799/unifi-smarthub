'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPORT_CLAIM_RETRY_AFTER_MS, createHistoryDb } = require('../db');
const { deriveDueReportSlot } = require('../server/jobs/report-schedule');
const {
    ClaimOwnershipLostError,
    ReportDeadlineError,
    createReportRunner
} = require('../server/jobs/report-runner');

const START_TS = Date.parse('2026-07-15T00:00:00.000Z');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function integrationDb(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const db = createHistoryDb(dir, { slowQueryMs: 10000 });
    t.after(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function waitFor(predicate, message = 'condition was not reached') {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(message);
}

function fakeIntervals() {
    let nextId = 1;
    const intervals = new Map();
    return {
        set(fn, delay) {
            const id = nextId++;
            intervals.set(id, { fn, delay });
            return id;
        },
        clear(id) {
            intervals.delete(id);
        },
        async fire(delay) {
            const due = [...intervals.values()].filter(interval => interval.delay === delay);
            for (const interval of due) interval.fn();
            await new Promise(resolve => setImmediate(resolve));
        },
        count() {
            return intervals.size;
        },
        delays() {
            return [...intervals.values()].map(interval => interval.delay).sort((a, b) => a - b);
        }
    };
}

function ownedClaim(overrides = {}) {
    return {
        claimed: true,
        id: 7,
        scheduleKey: 'scheduled:2026-07-15:08',
        title: '📊 Recovered report title',
        status: 'claimed',
        attemptCount: 2,
        claimToken: '11111111-1111-4111-8111-111111111111',
        recovered: true,
        ...overrides
    };
}

function createHarness(custom = {}) {
    const state = { now: START_TS };
    const timers = fakeIntervals();
    const logs = { error: [], warning: [] };
    const calls = {
        claimNext: [],
        claimScheduled: [],
        renew: [],
        complete: [],
        settings: 0,
        derive: [],
        build: [],
        deliver: [],
        sleep: []
    };
    const defaultClaim = ownedClaim({ attemptCount: 1, recovered: false, title: '📊 SmartHub 每日報表' });

    const db = {
        async claimNextScheduledReport(entry) {
            calls.claimNext.push(entry);
            return custom.claimNext ? custom.claimNext(entry, state, calls) : null;
        },
        async claimScheduledReport(entry) {
            calls.claimScheduled.push(entry);
            return custom.claimScheduled ? custom.claimScheduled(entry, state, calls) : defaultClaim;
        },
        async renewScheduledReportClaim(scheduleKey, entry) {
            calls.renew.push({ scheduleKey, entry });
            return custom.renew ? custom.renew(scheduleKey, entry, state, calls) : true;
        },
        async completeScheduledReport(scheduleKey, entry) {
            calls.complete.push({ scheduleKey, entry });
            return custom.complete ? custom.complete(scheduleKey, entry, state, calls) : true;
        }
    };

    const runner = createReportRunner({
        db,
        deriveDueReportSlot(settings, options) {
            calls.derive.push({ settings, options });
            if (custom.derive) return custom.derive(settings, options, state, calls);
            return {
                trigger: 'scheduled',
                frequency: 'daily',
                scheduleKey: 'scheduled:2026-07-15:08',
                scheduledAt: new Date(START_TS)
            };
        },
        async getSettings() {
            calls.settings++;
            return custom.getSettings ? custom.getSettings(state, calls) : {
                reportEnabled: true,
                reportFreq: 'daily',
                reportHour: 8
            };
        },
        async buildReport(options) {
            calls.build.push(options);
            return custom.buildReport ? custom.buildReport(options, state, calls) : 'report body';
        },
        async deliver(title, body, options) {
            calls.deliver.push({ title, body, options });
            return custom.deliver ? custom.deliver(title, body, options, state, calls) : { ok: true, channel: 'discord' };
        },
        clock: () => new Date(state.now),
        setIntervalFn: timers.set,
        clearIntervalFn: timers.clear,
        logger: {
            error(entry) { logs.error.push(entry); },
            warning(entry) { logs.warning.push(entry); }
        },
        sleep: async delayMs => {
            calls.sleep.push(delayMs);
            if (custom.sleep) await custom.sleep(delayMs, state, calls);
        },
        catchUpMs: custom.catchUpMs ?? 30 * 60 * 1000,
        leaseRenewMs: custom.leaseRenewMs ?? 50,
        deadlineMs: custom.deadlineMs ?? 100,
        pollIntervalMs: custom.pollIntervalMs ?? 1000,
        completionRetries: custom.completionRetries ?? 2,
        completionRetryMs: custom.completionRetryMs ?? 10
    });
    return { runner, state, timers, logs, calls, defaultClaim };
}

test('durable recovery still runs when current settings have no due schedule', async () => {
    const recovery = ownedClaim({ title: '📊 Original durable title' });
    const env = createHarness({
        claimNext: () => recovery,
        getSettings: () => ({ reportEnabled: false, reportFreq: 'weekly', reportHour: 23 }),
        derive: settings => settings.reportEnabled ? { scheduleKey: 'unexpected' } : null
    });

    const result = await env.runner.tick();

    assert.equal(result.status, 'completed');
    assert.equal(result.source, 'recovery');
    assert.equal(env.calls.settings, 1);
    assert.equal(env.calls.derive.length, 1);
    assert.equal(env.calls.claimScheduled.length, 0);
    assert.equal(env.calls.build.length, 1);
    assert.equal(env.calls.deliver.length, 1);
    assert.equal(env.calls.deliver[0].title, recovery.title);
    assert.equal(env.calls.complete[0].entry.claimToken, recovery.claimToken);
});

test('disabled schedules remain idle when there is no durable recovery', async () => {
    const env = createHarness({ derive: () => null });

    const result = await env.runner.tick();

    assert.deepEqual(result, { status: 'idle' });
    assert.equal(env.calls.claimNext.length, 1);
    assert.equal(env.calls.settings, 1);
    assert.equal(env.calls.claimScheduled.length, 0);
    assert.equal(env.calls.build.length, 0);
});

test('one durable slot is delivered once and a duplicate claim is not rerun', async () => {
    let claims = 0;
    const env = createHarness({
        claimScheduled: () => ++claims === 1
            ? ownedClaim({ attemptCount: 1, recovered: false, title: '📊 SmartHub 每日報表' })
            : { claimed: false, scheduleKey: 'scheduled:2026-07-15:08' }
    });

    const first = await env.runner.tick();
    const duplicate = await env.runner.tick();

    assert.equal(first.status, 'completed');
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(env.calls.deliver.length, 1);
    assert.equal(env.calls.complete.length, 1);
    assert.equal(env.timers.count(), 0);
});

test('fresh due slots are claimed before a recovery backlog can outlive catch-up', async () => {
    const backlog = Array.from({ length: 31 }, (_, index) => ownedClaim({
        id: 100 + index,
        scheduleKey: `scheduled:2026-07-${String(index + 1).padStart(2, '0')}:07`,
        title: `Recovered backlog ${index + 1}`,
        claimToken: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`
    }));
    let freshClaimed = false;
    const env = createHarness({
        derive: (_settings, _options, state) => state.now <= START_TS + 30 * 60 * 1000
            ? {
                trigger: 'scheduled', frequency: 'daily',
                scheduleKey: 'scheduled:2026-07-15:08', scheduledAt: new Date(START_TS)
            }
            : null,
        claimScheduled: () => {
            if (freshClaimed) return { claimed: false, scheduleKey: 'scheduled:2026-07-15:08' };
            freshClaimed = true;
            return ownedClaim({ attemptCount: 1, recovered: false, title: 'Fresh 08:00 report' });
        },
        claimNext: () => backlog.shift() || null
    });

    const first = await env.runner.tick();
    assert.equal(first.source, 'schedule');
    assert.equal(env.calls.deliver[0].title, 'Fresh 08:00 report');
    for (let minute = 1; minute <= 31; minute++) {
        env.state.now = START_TS + minute * 60 * 1000;
        await env.runner.tick();
    }

    assert.equal(freshClaimed, true);
    assert.equal(backlog.length, 0);
    assert.equal(env.calls.deliver.length, 32);
});

test('overlapping ticks are suppressed inside one process', async () => {
    const gate = deferred();
    const env = createHarness({ buildReport: () => gate.promise });

    const first = env.runner.tick();
    await waitFor(() => env.calls.build.length === 1);
    const overlap = await env.runner.tick();
    gate.resolve('eventual report');
    const completed = await first;

    assert.deepEqual(overlap, { status: 'overlap' });
    assert.equal(completed.status, 'completed');
    assert.equal(env.calls.build.length, 1);
    assert.equal(env.calls.deliver.length, 1);
});

test('periodic renewal is token-fenced and ownership is renewed again immediately before delivery', async () => {
    const gate = deferred();
    let renewals = 0;
    const env = createHarness({
        buildReport: () => gate.promise,
        renew: () => ++renewals === 1,
        complete: () => false
    });

    const running = env.runner.tick();
    await waitFor(() => env.calls.build.length === 1);
    await env.timers.fire(50);
    assert.equal(env.calls.renew.length, 1);
    gate.resolve('built after one lease renewal');
    const result = await running;

    assert.equal(env.calls.renew.length, 2);
    for (const renewal of env.calls.renew) {
        assert.equal(renewal.scheduleKey, env.defaultClaim.scheduleKey);
        assert.equal(renewal.entry.claimToken, env.defaultClaim.claimToken);
        assert.equal(renewal.entry.attemptCount, env.defaultClaim.attemptCount);
    }
    assert.equal(result.status, 'ownership-lost');
    assert.equal(result.completionRecorded, false);
    assert.ok(result.error instanceof ClaimOwnershipLostError);
    assert.equal(env.calls.deliver.length, 0);
    assert.equal(env.logs.warning.length, 1);
});

test('hard deadline aborts an uncooperative build and prevents a late delivery', async () => {
    const gate = deferred();
    let buildSignal;
    const env = createHarness({
        buildReport: options => {
            buildSignal = options.signal;
            return gate.promise;
        }
    });

    const running = env.runner.tick();
    await waitFor(() => env.calls.build.length === 1);
    await env.timers.fire(100);
    const result = await running;

    assert.equal(result.status, 'timed-out');
    assert.ok(result.error instanceof ReportDeadlineError);
    assert.equal(buildSignal.aborted, true);
    assert.equal(env.calls.deliver.length, 0);
    assert.equal(env.calls.complete[0].entry.deliveryStatus, 'failed');
    assert.deepEqual(await env.runner.tick(), { status: 'draining' });
    gate.resolve('too late');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.calls.deliver.length, 0);
    assert.equal(env.timers.count(), 0);
});

test('successful delivery uses AbortSignal and schedule key and records the actual completion time', async () => {
    const env = createHarness({
        buildReport: (options, state) => {
            state.now += 1000;
            return 'completed body';
        },
        deliver: (title, body, options, state) => {
            state.now += 2000;
            return { ok: true, channel: 'telegram' };
        }
    });

    const result = await env.runner.tick();
    const delivery = env.calls.deliver[0];
    const completion = env.calls.complete[0];

    assert.equal(result.status, 'completed');
    assert.equal(delivery.options.scheduleKey, env.defaultClaim.scheduleKey);
    assert.equal(delivery.options.signal instanceof AbortSignal, true);
    assert.equal(delivery.options.signal.aborted, false);
    assert.equal(completion.entry.ts, START_TS + 3000);
    assert.equal(completion.entry.deliveryStatus, 'sent');
    assert.equal(completion.entry.channel, 'telegram');
    assert.equal(completion.entry.body, 'completed body');
    assert.equal(completion.entry.claimToken, env.defaultClaim.claimToken);
});

test('delivery failure is finalized with a post-failure timestamp and owner token', async () => {
    const env = createHarness({
        deliver: (title, body, options, state) => {
            state.now += 4321;
            throw new Error('provider unavailable');
        }
    });

    const result = await env.runner.tick();
    const completion = env.calls.complete[0];

    assert.equal(result.status, 'failed');
    assert.equal(completion.entry.ts, START_TS + 4321);
    assert.equal(completion.entry.deliveryStatus, 'failed');
    assert.equal(completion.entry.deliveryError, 'provider unavailable');
    assert.equal(completion.entry.attemptCount, env.defaultClaim.attemptCount);
    assert.equal(completion.entry.claimToken, env.defaultClaim.claimToken);
});

test('partial multi-part delivery is terminal and records progress instead of auto-retrying', async () => {
    const env = createHarness({
        deliver: (_title, _body, options) => {
            options.onProgress({ channel: 'discord', sentParts: 1, totalParts: 3 });
            throw new Error('second chunk rejected');
        }
    });

    const result = await env.runner.tick();
    const completion = env.calls.complete[0].entry;

    assert.equal(result.status, 'partial');
    assert.equal(result.deliveryStatus, 'partial');
    assert.equal(result.deliveryAmbiguous, true);
    assert.deepEqual(result.deliveryProgress, { sentParts: 1, totalParts: 3 });
    assert.equal(completion.deliveryStatus, 'partial');
    assert.equal(completion.channel, 'discord');
    assert.match(completion.deliveryError, /partial delivery 1\/3/);
});

test('deadline after an accepted chunk records partial instead of retryable failure', async () => {
    const gate = deferred();
    const env = createHarness({
        deliver: (_title, _body, options) => {
            options.onProgress({ channel: 'telegram', sentParts: 1, totalParts: 2 });
            return gate.promise;
        }
    });

    const running = env.runner.tick();
    await waitFor(() => env.calls.deliver.length === 1);
    await env.timers.fire(100);
    const result = await running;

    assert.equal(result.status, 'partial');
    assert.equal(result.deliveryStatus, 'partial');
    assert.equal(env.calls.complete[0].entry.deliveryStatus, 'partial');
    assert.match(env.calls.complete[0].entry.deliveryError, /partial delivery 1\/2/);
    assert.deepEqual(await env.runner.tick(), { status: 'draining' });
    gate.resolve({ ok: true, channel: 'telegram' });
    await new Promise(resolve => setImmediate(resolve));
});

test('a false completion write is marked ambiguous and does not trigger an immediate resend', async () => {
    let claims = 0;
    const env = createHarness({
        claimScheduled: () => ++claims === 1
            ? ownedClaim({ attemptCount: 1, recovered: false, title: '📊 SmartHub 每日報表' })
            : { claimed: false, scheduleKey: 'scheduled:2026-07-15:08' },
        complete: () => false
    });

    const first = await env.runner.tick();
    const next = await env.runner.tick();

    assert.equal(first.status, 'completed');
    assert.equal(first.completionRecorded, false);
    assert.equal(first.deliveryAmbiguous, true);
    assert.equal(next.status, 'duplicate');
    assert.equal(env.calls.deliver.length, 1);
    assert.equal(env.calls.complete.length, 1);
    assert.equal(env.logs.warning.length, 1);
});

test('transient completion exceptions receive bounded retries before the lease is abandoned', async () => {
    let attempts = 0;
    const env = createHarness({
        complete: () => {
            attempts += 1;
            if (attempts < 3) {
                const error = new Error('database is locked');
                error.code = 'SQLITE_BUSY';
                throw error;
            }
            return true;
        }
    });

    const result = await env.runner.tick();

    assert.equal(result.completionRecorded, true);
    assert.equal(result.deliveryAmbiguous, false);
    assert.equal(env.calls.deliver.length, 1);
    assert.equal(env.calls.complete.length, 3);
    assert.deepEqual(env.calls.sleep, [10, 20]);
    assert.equal(env.logs.warning.length, 2);
});

test('start is idempotent and stop clears poll, lease, and deadline timers while aborting work', async () => {
    const gate = deferred();
    const env = createHarness({
        buildReport: () => gate.promise,
        leaseRenewMs: 20,
        deadlineMs: 80,
        pollIntervalMs: 1000
    });

    assert.equal(env.runner.start(), true);
    assert.equal(env.runner.start(), false);
    await waitFor(() => env.calls.build.length === 1);
    assert.deepEqual(env.timers.delays(), [20, 80, 1000]);

    let stopResolved = false;
    const stopping = env.runner.stop().then(() => { stopResolved = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopResolved, false, 'stop must wait for the underlying operation to settle');
    gate.resolve('after stop');
    await stopping;

    assert.equal(env.timers.count(), 0);
    assert.equal(env.calls.deliver.length, 0);
    assert.equal(env.calls.complete.length, 1);
    assert.equal(env.calls.complete[0].entry.deliveryStatus, 'failed');
});

test('actual SQLite runner claims, builds, delivers, completes, and deduplicates one slot', async t => {
    const db = integrationDb(t, 'smarthub-report-runner-integration-');
    const now = new Date(2026, 6, 15, 8, 5, 0, 0);
    let deliveries = 0;
    const runner = createReportRunner({
        db,
        deriveDueReportSlot,
        getSettings: () => ({ reportEnabled: true, reportFreq: 'daily', reportHour: 8, reportHour2: 20 }),
        buildReport: () => 'integrated report body',
        deliver: () => {
            deliveries += 1;
            return { ok: true, channel: 'discord' };
        },
        clock: () => new Date(now)
    });
    t.after(() => runner.stop());

    const first = await runner.tick();
    const duplicate = await runner.tick();
    const runs = db.listReportRuns();

    assert.equal(first.status, 'completed');
    assert.equal(first.source, 'schedule');
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(deliveries, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runStatus, 'completed');
    assert.equal(runs[0].deliveryStatus, 'sent');
    assert.equal(runs[0].body, 'integrated report body');
});

test('actual SQLite recovery survives a settings change and completes attempt two', async t => {
    const db = integrationDb(t, 'smarthub-report-runner-recovery-');
    let now = new Date(2026, 6, 15, 8, 5, 0, 0);
    let enabled = true;
    let deliveries = 0;
    const runner = createReportRunner({
        db,
        deriveDueReportSlot,
        getSettings: () => ({ reportEnabled: enabled, reportFreq: 'daily', reportHour: 8, reportHour2: 20 }),
        buildReport: () => `attempt ${deliveries + 1}`,
        deliver: () => {
            deliveries += 1;
            return deliveries === 1
                ? { ok: false, error: 'provider unavailable' }
                : { ok: true, channel: 'discord' };
        },
        clock: () => new Date(now)
    });
    t.after(() => runner.stop());

    const failed = await runner.tick();
    enabled = false;
    now = new Date(now.getTime() + REPORT_CLAIM_RETRY_AFTER_MS);
    const recovered = await runner.tick();
    const run = db.listReportRuns(1)[0];

    assert.equal(failed.status, 'failed');
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.source, 'recovery');
    assert.equal(deliveries, 2);
    assert.equal(run.attemptCount, 2);
    assert.equal(run.runStatus, 'completed');
    assert.equal(run.deliveryStatus, 'sent');
});

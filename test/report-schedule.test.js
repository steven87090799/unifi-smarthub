'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    DEFAULT_CATCH_UP_MS,
    buildScheduleKey,
    deriveDueReportSlot
} = require('../server/jobs/report-schedule');

function settings(overrides = {}) {
    return {
        reportEnabled: true,
        reportFreq: 'daily',
        reportHour: 8,
        reportHour2: 20,
        ...overrides
    };
}

function localDate(year, month, day, hour, minute = 0, second = 0, millisecond = 0) {
    return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

test('daily schedule uses local calendar fields and includes the catch-up boundary', () => {
    const before = deriveDueReportSlot(settings(), { now: localDate(2026, 7, 13, 7, 59, 59, 999) });
    assert.equal(before, null);

    const atBoundary = deriveDueReportSlot(settings(), { now: localDate(2026, 7, 13, 8) });
    assert.equal(atBoundary.scheduleKey, 'scheduled:2026-07-13:08');
    assert.deepEqual(atBoundary.scheduledAt, localDate(2026, 7, 13, 8));

    const lastIncluded = deriveDueReportSlot(settings(), {
        now: localDate(2026, 7, 13, 8, 15),
        catchUpMs: DEFAULT_CATCH_UP_MS
    });
    assert.equal(lastIncluded.scheduleKey, 'scheduled:2026-07-13:08');

    const firstExcluded = deriveDueReportSlot(settings(), {
        now: localDate(2026, 7, 13, 8, 15, 0, 1),
        catchUpMs: DEFAULT_CATCH_UP_MS
    });
    assert.equal(firstExcluded, null);
});

test('delayed ticks and startup catch-up do not depend on minute being zero', () => {
    const due = deriveDueReportSlot(settings(), {
        now: () => localDate(2026, 7, 13, 8, 7, 43),
        catchUpMs: 10 * 60 * 1000
    });
    assert.equal(due.scheduleKey, 'scheduled:2026-07-13:08');
    assert.equal(due.scheduledAt.getMinutes(), 0);

    const stale = deriveDueReportSlot(settings(), {
        now: localDate(2026, 7, 13, 8, 10, 0, 1),
        catchUpMs: 10 * 60 * 1000
    });
    assert.equal(stale, null);
});

test('restarts in one slot derive the same key and the next slot derives a new key', () => {
    const firstProcess = deriveDueReportSlot(settings(), { now: localDate(2026, 7, 13, 8, 2) });
    const restartedProcess = deriveDueReportSlot(settings(), { now: localDate(2026, 7, 13, 8, 14) });
    const nextSlot = deriveDueReportSlot(settings(), { now: localDate(2026, 7, 14, 8, 1) });

    assert.equal(firstProcess.scheduleKey, restartedProcess.scheduleKey);
    assert.equal(firstProcess.scheduledAt.getTime(), restartedProcess.scheduledAt.getTime());
    assert.equal(nextSlot.scheduleKey, 'scheduled:2026-07-14:08');
    assert.notEqual(nextSlot.scheduleKey, firstProcess.scheduleKey);
});

test('twice-daily schedule picks the most recent configured slot', () => {
    const morning = deriveDueReportSlot(settings({ reportFreq: 'twice' }), {
        now: localDate(2026, 7, 13, 8, 4)
    });
    const evening = deriveDueReportSlot(settings({ reportFreq: 'twice' }), {
        now: localDate(2026, 7, 13, 20, 4)
    });
    const between = deriveDueReportSlot(settings({ reportFreq: 'twice' }), {
        now: localDate(2026, 7, 13, 19, 59),
        catchUpMs: 30 * 60 * 1000
    });

    assert.equal(morning.scheduleKey, 'scheduled:2026-07-13:08');
    assert.equal(evening.scheduleKey, 'scheduled:2026-07-13:20');
    assert.equal(between, null);
});

test('every-six-hours preserves the existing reportHour modulo-six semantics', () => {
    const expectedHours = [2, 8, 14, 20];
    for (const hour of expectedHours) {
        const slot = deriveDueReportSlot(settings({ reportFreq: 'every6h', reportHour: 8 }), {
            now: localDate(2026, 7, 13, hour, 3)
        });
        assert.equal(slot.scheduleKey, `scheduled:2026-07-13:${String(hour).padStart(2, '0')}`);
    }

    const notDue = deriveDueReportSlot(settings({ reportFreq: 'every6h', reportHour: 8 }), {
        now: localDate(2026, 7, 13, 14, 16)
    });
    assert.equal(notDue, null);
});

test('weekly schedule is Monday-only and its key includes the local date and hour', () => {
    const monday = localDate(2026, 7, 13, 9, 5);
    assert.equal(monday.getDay(), 1);
    const due = deriveDueReportSlot(settings({ reportFreq: 'weekly', reportHour: 9 }), { now: monday });
    const tuesday = deriveDueReportSlot(settings({ reportFreq: 'weekly', reportHour: 9 }), {
        now: localDate(2026, 7, 14, 9, 5)
    });

    assert.equal(due.scheduleKey, 'scheduled:2026-07-13:09');
    assert.equal(tuesday, null);
});

test('schedule keys remain deterministic across month and year boundaries', () => {
    const january = deriveDueReportSlot(settings({ reportHour: 23 }), {
        now: localDate(2026, 1, 31, 23, 2)
    });
    const february = deriveDueReportSlot(settings({ reportHour: 0 }), {
        now: localDate(2026, 2, 1, 0, 2)
    });
    const newYear = deriveDueReportSlot(settings({ reportHour: 0 }), {
        now: localDate(2027, 1, 1, 0, 2)
    });

    assert.equal(january.scheduleKey, 'scheduled:2026-01-31:23');
    assert.equal(february.scheduleKey, 'scheduled:2026-02-01:00');
    assert.equal(newYear.scheduleKey, 'scheduled:2027-01-01:00');
});

test('manual and disabled reports are excluded from scheduled slot identity', () => {
    const now = localDate(2026, 7, 13, 8, 1);
    assert.equal(buildScheduleKey(now, 'manual'), null);
    assert.equal(deriveDueReportSlot(settings(), { now, trigger: 'manual' }), null);
    assert.equal(deriveDueReportSlot(settings({ reportEnabled: false }), { now }), null);
});

test('invalid settings and clock inputs return no due slot', () => {
    const now = localDate(2026, 7, 13, 8, 1);
    const invalidSettings = [
        null,
        {},
        settings({ reportEnabled: 'true' }),
        settings({ reportFreq: 'monthly' }),
        settings({ reportHour: -1 }),
        settings({ reportHour: 24 }),
        settings({ reportHour: 8.5 }),
        settings({ reportHour: '8' }),
        settings({ reportFreq: 'twice', reportHour2: undefined }),
        settings({ reportFreq: 'twice', reportHour2: 24 })
    ];
    for (const input of invalidSettings) assert.equal(deriveDueReportSlot(input, { now }), null);

    assert.equal(deriveDueReportSlot(settings(), { now: new Date('invalid') }), null);
    assert.equal(deriveDueReportSlot(settings(), { now: () => '2026-07-13' }), null);
    assert.equal(deriveDueReportSlot(settings(), { now, catchUpMs: -1 }), null);
    assert.equal(deriveDueReportSlot(settings(), { now, catchUpMs: Infinity }), null);
    assert.equal(buildScheduleKey(new Date('invalid')), null);
});

test('local slot construction is stable beside DST gaps and repeated hours', () => {
    const modulePath = path.resolve(__dirname, '../server/jobs/report-schedule.js');
    const script = `
        const { deriveDueReportSlot } = require(${JSON.stringify(modulePath)});
        const base = { reportEnabled: true, reportFreq: 'daily', reportHour2: 20 };
        const springGap = deriveDueReportSlot({ ...base, reportHour: 2 }, {
            now: new Date('2026-03-08T03:05:00-04:00')
        });
        const springValid = deriveDueReportSlot({ ...base, reportHour: 3 }, {
            now: new Date('2026-03-08T03:05:00-04:00')
        });
        const fallFirst = deriveDueReportSlot({ ...base, reportHour: 1 }, {
            now: new Date('2026-11-01T01:05:00-04:00')
        });
        const fallSecond = deriveDueReportSlot({ ...base, reportHour: 1 }, {
            now: new Date('2026-11-01T01:05:00-05:00'), catchUpMs: 2 * 60 * 60 * 1000
        });
        const fallSecondProductionWindow = deriveDueReportSlot({ ...base, reportHour: 1 }, {
            now: new Date('2026-11-01T01:05:00-05:00'), catchUpMs: 30 * 60 * 1000
        });
        process.stdout.write(JSON.stringify({
            springGap,
            springValid: springValid && springValid.scheduleKey,
            fallFirst: fallFirst && fallFirst.scheduleKey,
            fallSecond: fallSecond && fallSecond.scheduleKey,
            fallSecondProductionWindow
        }));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'America/New_York' }
    });

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
        springGap: null,
        springValid: 'scheduled:2026-03-08:03',
        fallFirst: 'scheduled:2026-11-01:01',
        fallSecond: 'scheduled:2026-11-01:01',
        // Production uses a 30-minute window: only the first repeated wall-clock
        // occurrence is eligible, and the durable key prevents a second send.
        fallSecondProductionWindow: null
    });
});

test('derivation does not mutate settings or the injected Date', () => {
    const inputSettings = settings({ reportFreq: 'twice' });
    const inputNow = localDate(2026, 7, 13, 20, 3);
    const settingsBefore = JSON.stringify(inputSettings);
    const nowBefore = inputNow.getTime();

    deriveDueReportSlot(inputSettings, { now: inputNow });

    assert.equal(JSON.stringify(inputSettings), settingsBefore);
    assert.equal(inputNow.getTime(), nowBefore);
});

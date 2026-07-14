'use strict';

const DEFAULT_CATCH_UP_MS = 15 * 60 * 1000;
const VALID_FREQUENCIES = new Set(['daily', 'twice', 'every6h', 'weekly']);
const WEEKLY_REPORT_DAY = 1; // Monday, matching Date#getDay() in the existing scheduler.

function isValidHour(value) {
    return Number.isInteger(value) && value >= 0 && value <= 23;
}

function resolveNow(now) {
    const value = typeof now === 'function' ? now() : now;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
    return new Date(value.getTime());
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

/**
 * Build the durable identity for a scheduled report slot.
 *
 * Local Date fields are intentional: reportHour is configured in the server's
 * local timezone. Manual reports do not belong to a scheduled slot and never
 * receive a schedule key.
 */
function buildScheduleKey(scheduledAt, trigger = 'scheduled') {
    if (trigger !== 'scheduled' || !(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
        return null;
    }
    return `scheduled:${scheduledAt.getFullYear()}-${pad2(scheduledAt.getMonth() + 1)}-${pad2(scheduledAt.getDate())}:${pad2(scheduledAt.getHours())}`;
}

function parseSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    if (settings.reportEnabled !== true || !VALID_FREQUENCIES.has(settings.reportFreq)) return null;
    if (!isValidHour(settings.reportHour)) return null;
    if (settings.reportFreq === 'twice' && !isValidHour(settings.reportHour2)) return null;

    let hours;
    if (settings.reportFreq === 'twice') {
        hours = [...new Set([settings.reportHour, settings.reportHour2])].sort((a, b) => a - b);
    } else if (settings.reportFreq === 'every6h') {
        const offset = settings.reportHour % 6;
        hours = [];
        for (let hour = offset; hour < 24; hour += 6) hours.push(hour);
    } else {
        hours = [settings.reportHour];
    }

    return { frequency: settings.reportFreq, hours };
}

function localDay(now, daysAgo) {
    // Noon is representable on ordinary DST transition days, so use it to move
    // by calendar date before constructing the requested local wall-clock hour.
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
    day.setDate(day.getDate() - daysAgo);
    return day;
}

function localSlot(day, hour) {
    const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
    // A DST spring-forward gap can normalize 02:00 to 03:00. That is not the
    // configured local slot, so skip it instead of assigning the wrong key.
    if (slot.getFullYear() !== day.getFullYear()
        || slot.getMonth() !== day.getMonth()
        || slot.getDate() !== day.getDate()
        || slot.getHours() !== hour) return null;
    // During a fall-back repeat, Date selects the first occurrence. SmartHub
    // intentionally has one durable identity per local wall-clock hour, so it
    // never treats the second occurrence as a distinct report slot.
    return slot;
}

/**
 * Return the most recent scheduled report slot that is due within catchUpMs.
 *
 * `now` may be a Date or a zero-argument clock function returning a Date. The
 * result is deterministic for a given local clock value and settings, making a
 * durable scheduleKey stable across process restarts in the same slot.
 */
function deriveDueReportSlot(settings, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
    const trigger = options.trigger === undefined ? 'scheduled' : options.trigger;
    if (trigger !== 'scheduled') return null;

    const catchUpMs = options.catchUpMs === undefined ? DEFAULT_CATCH_UP_MS : options.catchUpMs;
    if (!Number.isFinite(catchUpMs) || catchUpMs < 0) return null;

    const schedule = parseSettings(settings);
    const now = resolveNow(options.now === undefined ? new Date() : options.now);
    if (!schedule || !now) return null;

    let latest = null;
    // Daily schedules need at most one prior date; weekly schedules need seven.
    const lookbackDays = schedule.frequency === 'weekly' ? 7 : 1;
    for (let daysAgo = 0; daysAgo <= lookbackDays; daysAgo++) {
        const day = localDay(now, daysAgo);
        if (schedule.frequency === 'weekly' && day.getDay() !== WEEKLY_REPORT_DAY) continue;

        for (const hour of schedule.hours) {
            const candidate = localSlot(day, hour);
            if (!candidate || candidate.getTime() > now.getTime()) continue;
            if (!latest || candidate.getTime() > latest.getTime()) latest = candidate;
        }
    }

    if (!latest || now.getTime() - latest.getTime() > catchUpMs) return null;
    return {
        trigger: 'scheduled',
        frequency: schedule.frequency,
        scheduledAt: latest,
        scheduleKey: buildScheduleKey(latest)
    };
}

module.exports = {
    DEFAULT_CATCH_UP_MS,
    buildScheduleKey,
    deriveDueReportSlot
};

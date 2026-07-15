'use strict';

const net = require('node:net');
const {
    InputValidationError,
    exactObject,
    stringValue
} = require('./write-input-policy');

const DAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const REMOVE_CONFIRMATION = 'REMOVE_ADGUARD_SERVICE_POLICY';
const CATEGORY_SOURCE = 'https://github.com/AdguardTeam/HostlistsRegistry';
const CATEGORY_REVIEWED_AT = '2026-07-15';

const SERVICE_CATEGORIES = Object.freeze({
    youtube: Object.freeze({ label: 'YouTube', serviceIds: Object.freeze(['youtube']) }),
    tiktok: Object.freeze({ label: 'TikTok', serviceIds: Object.freeze(['tiktok']) }),
    gaming: Object.freeze({
        label: 'Gaming services',
        serviceIds: Object.freeze([
            'activision_blizzard', 'battle_net', 'blizzard_entertainment',
            'electronic_arts', 'epic_games', 'gog', 'io_interactive',
            'leagueoflegends', 'minecraft', 'nintendo', 'origin', 'playstation',
            'riot_games', 'roblox', 'rockstar_games', 'steam', 'ubisoft',
            'valorant', 'wargaming', 'warnerbrosgames', 'xboxlive'
        ])
    })
});

function reject(message, field) {
    throw new InputValidationError(message, { field });
}

function normalizeDeviceId(value) {
    const normalized = stringValue(value, { field: 'deviceId', min: 2, max: 64 });
    if (/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(normalized)) return normalized.toLowerCase();
    const ipVersion = net.isIP(normalized);
    if (ipVersion === 4) return normalized;
    if (ipVersion === 6) return new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    return reject('deviceId must be a canonical IP address or colon-delimited MAC address', 'deviceId');
}

function normalizeTimeZone(value) {
    const normalized = stringValue(value, {
        field: 'timeZone', min: 1, max: 64,
        pattern: /^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/u
    });
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0));
    } catch {
        return reject('timeZone must be a valid explicit IANA time zone', 'timeZone');
    }
    return normalized;
}

function parseClock(value, field, { allowEndOfDay = false } = {}) {
    const normalized = stringValue(value, {
        field, min: 5, max: 5, pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/u
    });
    if (allowEndOfDay && value === '24:00') return { value: '24:00', minutes: 1440 };
    const [hours, minutes] = normalized.split(':').map(Number);
    return { value: normalized, minutes: hours * 60 + minutes };
}

function normalizeAllowWindows(value) {
    const input = exactObject(value, { allowed: DAY_KEYS, required: [], field: 'allowWindows' });
    const windows = {};
    for (const day of DAY_KEYS) {
        if (!Object.hasOwn(input, day)) continue;
        const window = exactObject(input[day], {
            allowed: ['start', 'end'], required: ['start', 'end'], field: `allowWindows.${day}`
        });
        const start = parseClock(window.start, `allowWindows.${day}.start`);
        const end = window.end === '24:00'
            ? { value: '24:00', minutes: 1440 }
            : parseClock(window.end, `allowWindows.${day}.end`);
        if (end.minutes <= start.minutes) {
            reject(`allowWindows.${day}.end must be later than start on the same day`, `allowWindows.${day}`);
        }
        windows[day] = { start: start.value, end: end.value };
    }
    return windows;
}

function normalizeCategories(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > Object.keys(SERVICE_CATEGORIES).length) {
        reject('categories must contain between 1 and 3 supported category names', 'categories');
    }
    const categories = value.map((category, index) => stringValue(category, {
        field: `categories[${index}]`, min: 1, max: 32,
        pattern: /^[a-z][a-z0-9_]*$/u
    }));
    if (new Set(categories).size !== categories.length) reject('categories must not contain duplicates', 'categories');
    for (const category of categories) {
        if (!Object.hasOwn(SERVICE_CATEGORIES, category)) reject(`unsupported service category: ${category}`, 'categories');
    }
    return categories.sort();
}

function parsePolicyRequest(body) {
    const input = exactObject(body, {
        allowed: ['deviceId', 'categories', 'timeZone', 'allowWindows'],
        required: ['deviceId', 'categories', 'timeZone', 'allowWindows'],
        field: 'body'
    });
    return {
        deviceId: normalizeDeviceId(input.deviceId),
        categories: normalizeCategories(input.categories),
        timeZone: normalizeTimeZone(input.timeZone),
        allowWindows: normalizeAllowWindows(input.allowWindows)
    };
}

function parsePolicyRemoval(id, body) {
    const policyId = stringValue(id, {
        field: 'id', min: 36, max: 36,
        pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
    }).toLowerCase();
    const input = exactObject(body, {
        allowed: ['confirmation'], required: ['confirmation'], field: 'body'
    });
    if (input.confirmation !== REMOVE_CONFIRMATION) {
        reject(`confirmation must equal ${REMOVE_CONFIRMATION}`, 'confirmation');
    }
    return { id: policyId };
}

function expandCategories(categories) {
    const serviceIds = new Set();
    for (const category of normalizeCategories(categories)) {
        for (const serviceId of SERVICE_CATEGORIES[category].serviceIds) serviceIds.add(serviceId);
    }
    return [...serviceIds].sort();
}

function buildInactiveSchedule({ timeZone, allowWindows }) {
    const schedule = { time_zone: normalizeTimeZone(timeZone) };
    const windows = normalizeAllowWindows(allowWindows);
    for (const day of DAY_KEYS) {
        if (!windows[day]) continue;
        const start = parseClock(windows[day].start, `${day}.start`).minutes;
        const end = windows[day].end === '24:00'
            ? 1440
            : parseClock(windows[day].end, `${day}.end`).minutes;
        schedule[day] = { start: start * 60_000, end: end * 60_000 };
    }
    return schedule;
}

function blockingActiveAt(policy, instant) {
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new TypeError('instant must be a valid Date');
    const timeZone = normalizeTimeZone(policy.timeZone);
    const windows = normalizeAllowWindows(policy.allowWindows);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const day = parts.weekday.toLowerCase();
    const window = windows[day];
    if (!window) return true;
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const start = parseClock(window.start, `${day}.start`).minutes;
    const end = window.end === '24:00' ? 1440 : parseClock(window.end, `${day}.end`).minutes;
    return !(minute >= start && minute < end);
}

function publicCategoryDefinitions() {
    return {
        source: CATEGORY_SOURCE,
        reviewedAt: CATEGORY_REVIEWED_AT,
        scheduleSemantics: 'allow_windows_when_blocking_is_inactive',
        categories: Object.entries(SERVICE_CATEGORIES).map(([id, definition]) => ({
            id, label: definition.label, serviceIds: [...definition.serviceIds]
        }))
    };
}

module.exports = {
    CATEGORY_REVIEWED_AT,
    CATEGORY_SOURCE,
    DAY_KEYS,
    REMOVE_CONFIRMATION,
    SERVICE_CATEGORIES,
    blockingActiveAt,
    buildInactiveSchedule,
    expandCategories,
    normalizeAllowWindows,
    normalizeCategories,
    normalizeDeviceId,
    normalizeTimeZone,
    parsePolicyRemoval,
    parsePolicyRequest,
    publicCategoryDefinitions
};

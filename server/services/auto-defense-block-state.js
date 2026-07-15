'use strict';

const CANONICAL_MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeMac(value) {
    if (typeof value !== 'string') throw new TypeError('auto-defense MAC must be a string');
    const canonical = value.toLowerCase().replace(/-/g, ':');
    if (!CANONICAL_MAC.test(canonical)) throw new TypeError('auto-defense MAC must be canonical');
    return canonical;
}

function isRecentAlarmTimestamp(value, timestamp = Date.now(), maxAgeMs = 10 * 60 * 1000) {
    const now = timestampValue(timestamp);
    const maxAge = positiveInteger(maxAgeMs, 10 * 60 * 1000);
    const alarmTimestamp = new Date(value).getTime();
    return Number.isFinite(alarmTimestamp) && alarmTimestamp <= now && now - alarmTimestamp < maxAge;
}

function timestampValue(value) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError('auto-defense timestamp must be a non-negative finite number');
    return value;
}

function createAutoDefenseBlockState({ cooldownMs = 10 * 60 * 1000, maxEntries = 2000 } = {}) {
    const cooldown = positiveInteger(cooldownMs, 10 * 60 * 1000);
    const capacity = positiveInteger(maxEntries, 2000);
    const entries = new Map();

    function shouldBlock(macInput, timestamp = Date.now()) {
        const mac = normalizeMac(macInput);
        const now = timestampValue(timestamp);
        const blockedAt = entries.get(mac);
        if (blockedAt === undefined) return true;
        if (now - blockedAt < cooldown) return false;
        entries.delete(mac);
        return true;
    }

    function record(macInput, timestamp = Date.now()) {
        const mac = normalizeMac(macInput);
        const now = timestampValue(timestamp);
        entries.delete(mac);
        while (entries.size >= capacity) entries.delete(entries.keys().next().value);
        entries.set(mac, now);
        return mac;
    }

    return Object.freeze({
        capacity,
        cooldownMs: cooldown,
        normalizeMac,
        record,
        shouldBlock,
        size: () => entries.size
    });
}

module.exports = { CANONICAL_MAC, createAutoDefenseBlockState, isRecentAlarmTimestamp, normalizeMac };

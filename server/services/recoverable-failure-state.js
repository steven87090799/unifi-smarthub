'use strict';

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createRecoverableFailureState({ cooldownMs = 300000, maxEntries = 2000 } = {}) {
    const cooldown = positiveInteger(cooldownMs, 300000);
    const capacity = positiveInteger(maxEntries, 2000);
    const entries = new Map();

    function validateKey(key) {
        if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
            throw new TypeError('recoverable failure key must be a non-empty string of at most 256 characters');
        }
        return key;
    }

    function record(keyInput, timestamp = Date.now()) {
        const key = validateKey(keyInput);
        if (!Number.isFinite(timestamp)) throw new TypeError('recoverable failure timestamp must be finite');
        const existing = entries.get(key);
        const state = {
            occurrences: (existing?.occurrences || 0) + 1,
            lastLoggedAt: existing?.lastLoggedAt ?? null
        };
        const shouldLog = !existing || timestamp - state.lastLoggedAt >= cooldown;
        if (shouldLog) state.lastLoggedAt = timestamp;

        entries.delete(key);
        while (entries.size >= capacity) entries.delete(entries.keys().next().value);
        entries.set(key, state);
        return { occurrences: state.occurrences, lastLoggedAt: state.lastLoggedAt, shouldLog };
    }

    function remove(key) {
        return entries.delete(validateKey(key));
    }

    return Object.freeze({ capacity, cooldownMs: cooldown, record, remove, size: () => entries.size });
}

module.exports = { createRecoverableFailureState };

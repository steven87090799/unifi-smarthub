'use strict';

// Private sufficient statistics travel with persisted rollups, never with API
// payloads. A bucket's total sample count is not the valid count of each gauge:
// null/offline observations must not bias a later tier's weighted average.
const METADATA_KEY = '_smarthubRollup';
const MAX_DEPTH = 32;
const COUNTER = /bytes|errors|dropped|counter|total/i;

function aggregatePayload(rows, { persist = false } = {}) {
    const observations = rows.map(row => {
        let value;
        try { value = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; }
        catch { value = {}; }
        if (!value || typeof value !== 'object') value = {};
        const metadata = value[METADATA_KEY];
        return {
            value,
            fields: metadata?.version === 1 && metadata.fields && typeof metadata.fields === 'object'
                ? metadata.fields : {},
            weight: Math.max(1, Number(row.sample_count) || 1),
            at: Number(row.ts) || 0
        };
    });
    const fields = {};
    const put = (target, key, value) => Object.defineProperty(target, key, {
        value, enumerable: true, configurable: true, writable: true
    });

    function visit(items, path = [], depth = 0) {
        const present = items.filter(item => item.value !== undefined);
        if (!present.length) return undefined;
        const key = JSON.stringify(path);
        const at = item => Number(item.fields[key]?.at) || item.at;
        const newest = values => values.reduce((last, item) => !last || at(item) >= at(last) ? item : last, null);
        const numeric = present.filter(item => typeof item.value === 'number' && Number.isFinite(item.value));
        if (numeric.length) {
            const last = newest(numeric);
            if (COUNTER.test(String(path.at(-1) || ''))) {
                fields[key] = { at: at(last) };
                return last.value;
            }
            let sum = 0;
            let count = 0;
            for (const item of numeric) {
                const previous = item.fields[key];
                const hasStatistics = Number.isFinite(previous?.sum) && Number.isFinite(previous?.count) && previous.count > 0;
                const weight = hasStatistics ? previous.count : item.weight;
                sum += hasStatistics ? previous.sum : item.value * weight;
                count += weight;
            }
            fields[key] = { sum, count, at: at(last) };
            return Number((sum / count).toFixed(4));
        }
        const nonNull = present.filter(item => item.value !== null);
        if (!nonNull.length) return null;
        const last = newest(nonNull);
        if (depth >= MAX_DEPTH) return last.value;
        const arrays = nonNull.filter(item => Array.isArray(item.value));
        if (arrays.length) {
            const length = arrays.reduce((max, item) => Math.max(max, item.value.length), 0);
            return Array.from({ length }, (_, index) => visit(
                arrays.map(item => ({ ...item, value: item.value[index] })), [...path, String(index)], depth + 1
            ) ?? null);
        }
        const objects = nonNull.filter(item => typeof item.value === 'object');
        if (objects.length) {
            const result = {};
            const keys = new Set(objects.flatMap(item => Object.keys(item.value)));
            for (const field of keys) {
                if (depth === 0 && field === METADATA_KEY) continue;
                const value = visit(objects.map(item => ({
                    ...item, value: Object.hasOwn(item.value, field) ? item.value[field] : undefined
                })), [...path, field], depth + 1);
                if (value !== undefined) put(result, field, value);
            }
            return result;
        }
        fields[key] = { at: at(last) };
        return last.value;
    }

    const result = visit(observations) || {};
    if (persist) put(result, METADATA_KEY, { version: 1, fields });
    return result;
}

module.exports = { aggregatePayload };

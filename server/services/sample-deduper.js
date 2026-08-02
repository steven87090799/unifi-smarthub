'use strict';

function createSampleDeduper({ maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    const seen = new Set();

    function keyFor(sample) {
        if (sample === null || sample === undefined) return null;
        if (typeof sample === 'object') return sample.sampleId ?? sample.fetchedAt ?? null;
        return sample;
    }

    function has(sample) {
        const key = keyFor(sample);
        return key !== null && seen.has(key);
    }

    function add(sample) {
        const key = keyFor(sample);
        if (key === null) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        if (seen.size > maxEntries) {
            const keep = [...seen].slice(-Math.floor(maxEntries / 2));
            seen.clear();
            keep.forEach(item => seen.add(item));
        }
        return true;
    }

    return Object.freeze({ has, add, size: () => seen.size, clear: () => seen.clear() });
}

module.exports = { createSampleDeduper };

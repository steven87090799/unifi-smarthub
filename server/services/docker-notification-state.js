'use strict';

const METRICS = Object.freeze(['cpu', 'memory']);
const METRIC_SET = new Set(METRICS);

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createDockerMetricAlertState({ maxEntries = 2000 } = {}) {
    const capacity = positiveInteger(maxEntries, 2000);
    const entries = new Map();

    function key(metric, containerId) {
        if (!METRIC_SET.has(metric)) throw new TypeError(`unsupported Docker metric: ${metric}`);
        if (typeof containerId !== 'string' || containerId.length === 0) {
            throw new TypeError('containerId must be a non-empty string');
        }
        return `${metric}:${containerId}`;
    }

    function get(metric, containerId) {
        return entries.get(key(metric, containerId));
    }

    function record(metric, containerId, timestamp = Date.now()) {
        if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
        const entryKey = key(metric, containerId);
        entries.delete(entryKey);
        while (entries.size >= capacity) entries.delete(entries.keys().next().value);
        entries.set(entryKey, timestamp);
        return timestamp;
    }

    function removeContainer(containerId) {
        let removed = 0;
        for (const metric of METRICS) {
            if (entries.delete(key(metric, containerId))) removed += 1;
        }
        return removed;
    }

    return Object.freeze({
        capacity,
        get,
        record,
        removeContainer,
        size: () => entries.size
    });
}

module.exports = { METRICS, createDockerMetricAlertState };

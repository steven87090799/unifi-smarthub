'use strict';

const DEFAULT_FAILURE_THRESHOLD = 3;

const FETCH_HEALTH = Object.freeze({
    UNKNOWN: 'unknown',
    HEALTHY: 'healthy',
    DEGRADED: 'degraded',
    OFFLINE: 'offline'
});

const TRANSITION_TYPES = Object.freeze({
    OFFLINE: 'offline',
    RECOVERED: 'recovered'
});

function validateFailureThreshold(value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError('failureThreshold must be a positive integer');
    }
    return value;
}

function validateGeneration(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('configGeneration must be a positive integer');
    return value;
}

function clonePayload(value) {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(clonePayload);
    if (typeof value !== 'object') return value;

    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = clonePayload(child);
    return copy;
}

function normalizeFailureReason(reason) {
    if (reason === null || reason === undefined || reason === '') return null;
    return reason instanceof Error ? reason.message : String(reason);
}

/**
 * In-memory UPS fetch-health state machine. It intentionally performs no I/O;
 * callers own persistence, logging, and notification delivery for transitions.
 */
function createUpsState({ failureThreshold = DEFAULT_FAILURE_THRESHOLD, now = Date.now, configGeneration = 1 } = {}) {
    const threshold = validateFailureThreshold(failureThreshold);
    const initialGeneration = validateGeneration(configGeneration);
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    let state = {
        fetchHealth: FETCH_HEALTH.UNKNOWN,
        consecutiveFailures: 0,
        lastGood: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        failureReason: null,
        offlineSince: null,
        configGeneration: initialGeneration,
        reconfiguring: false
    };

    function readNow() {
        const timestamp = now();
        if (!Number.isFinite(timestamp)) throw new TypeError('now() must return a finite timestamp');
        return timestamp;
    }

    function snapshotAt(timestamp) {
        const staleAgeMs = state.lastSuccessAt === null
            ? null
            : Math.max(0, timestamp - state.lastSuccessAt);

        return {
            fetchHealth: state.fetchHealth,
            consecutiveFailures: state.consecutiveFailures,
            failureThreshold: threshold,
            lastGood: clonePayload(state.lastGood),
            lastSuccessAt: state.lastSuccessAt,
            lastFailureAt: state.lastFailureAt,
            failureReason: state.failureReason,
            offlineSince: state.offlineSince,
            configGeneration: state.configGeneration,
            reconfiguring: state.reconfiguring,
            staleAgeMs,
            dataIsStale: state.lastGood !== null
                && (state.fetchHealth !== FETCH_HEALTH.HEALTHY || state.reconfiguring)
        };
    }

    function result(timestamp, transitions = []) {
        return { snapshot: snapshotAt(timestamp), transitions };
    }

    function recordSuccess(data) {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            throw new TypeError('successful UPS data must be an object');
        }
        if (data.configGeneration !== undefined && data.configGeneration !== state.configGeneration) {
            throw new TypeError('successful UPS data belongs to a stale configGeneration');
        }

        const timestamp = readNow();
        const wasOffline = state.fetchHealth === FETCH_HEALTH.OFFLINE;
        const offlineSince = state.offlineSince;

        state = {
            fetchHealth: FETCH_HEALTH.HEALTHY,
            consecutiveFailures: 0,
            lastGood: clonePayload(data),
            lastSuccessAt: timestamp,
            lastFailureAt: state.lastFailureAt,
            failureReason: null,
            offlineSince: null,
            configGeneration: state.configGeneration,
            reconfiguring: false
        };

        const transitions = wasOffline ? [{
            type: TRANSITION_TYPES.RECOVERED,
            at: timestamp,
            offlineSince
        }] : [];

        return result(timestamp, transitions);
    }

    function recordFailure(reason = null) {
        const timestamp = readNow();
        const failures = state.consecutiveFailures + 1;
        const wasOffline = state.fetchHealth === FETCH_HEALTH.OFFLINE;
        const confirmedOffline = wasOffline || failures >= threshold;
        const transitions = [];

        state = {
            ...state,
            fetchHealth: confirmedOffline ? FETCH_HEALTH.OFFLINE : FETCH_HEALTH.DEGRADED,
            consecutiveFailures: failures,
            lastFailureAt: timestamp,
            failureReason: normalizeFailureReason(reason),
            offlineSince: wasOffline ? state.offlineSince : (confirmedOffline ? timestamp : null),
            reconfiguring: false
        };

        if (!wasOffline && confirmedOffline) {
            transitions.push({
                type: TRANSITION_TYPES.OFFLINE,
                at: timestamp,
                failureCount: failures,
                reason: state.failureReason
            });
        }

        return result(timestamp, transitions);
    }

    function reconfigure(configGeneration) {
        const nextGeneration = validateGeneration(configGeneration);
        const timestamp = readNow();
        state = {
            ...state,
            configGeneration: nextGeneration,
            reconfiguring: true,
            fetchHealth: state.lastGood ? FETCH_HEALTH.DEGRADED : FETCH_HEALTH.UNKNOWN,
            consecutiveFailures: 0,
            failureReason: 'configuration_changed',
            offlineSince: null,
            lastFailureAt: state.lastFailureAt
        };
        return result(timestamp);
    }

    function recordPoll(data, { reason = null } = {}) {
        return data === null || data === undefined
            ? recordFailure(reason)
            : recordSuccess(data);
    }

    return Object.freeze({
        recordSuccess,
        recordFailure,
        recordPoll,
        reconfigure,
        snapshot: () => snapshotAt(readNow())
    });
}

module.exports = {
    DEFAULT_FAILURE_THRESHOLD,
    FETCH_HEALTH,
    TRANSITION_TYPES,
    createUpsState
};

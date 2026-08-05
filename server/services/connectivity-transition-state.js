'use strict';

const STATES = Object.freeze({
    UNKNOWN: 'unknown',
    ONLINE: 'online',
    PENDING_OFFLINE: 'pending_offline',
    OFFLINE: 'offline',
    PENDING_RECOVERY: 'pending_recovery'
});

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeObservation(value) {
    if (value === true || value === 'success' || value === 'online') return 'success';
    if (value === false || value === 'failure' || value === 'offline') return 'failure';
    if (value === 'unknown' || value === 'stale' || value === null || value === undefined) return 'unknown';
    if (value && typeof value === 'object') return normalizeObservation(value.kind ?? value.status ?? value.state);
    throw new TypeError('connectivity observation must be success, failure, or unknown');
}

function createConnectivityTransitionState({
    offlineThreshold = 3,
    recoveryThreshold = 2,
    now = () => Date.now()
} = {}) {
    const offlineLimit = positiveInteger(offlineThreshold, 3);
    const recoveryLimit = positiveInteger(recoveryThreshold, 2);
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    let current = {
        state: STATES.UNKNOWN,
        failureCount: 0,
        successCount: 0,
        lastTransitionAt: null,
        lastObservedAt: null,
        lastNotification: null,
        offlineNotified: false,
        recoveryNotified: false
    };

    function snapshot() {
        return Object.freeze({ ...current });
    }

    function observe(value, { timestamp = now(), eligible = true } = {}) {
        if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
        const observation = normalizeObservation(value);
        const before = current.state;
        if (!eligible || observation === 'unknown') {
            current = { ...current, lastObservedAt: timestamp };
            return Object.freeze({
                observation: 'unknown', state: current.state, transition: null, notify: null,
                baseline: false, changed: false, snapshot: snapshot()
            });
        }

        let transition = null;
        let notify = null;
        let nextState = current.state;
        if (observation === 'success') {
            const successCount = current.successCount + 1;
            if (current.state === STATES.UNKNOWN) {
                nextState = STATES.ONLINE;
                current = {
                    ...current, state: nextState, failureCount: 0, successCount,
                    lastTransitionAt: timestamp, lastObservedAt: timestamp
                };
            } else if (current.state === STATES.OFFLINE || current.state === STATES.PENDING_RECOVERY) {
                nextState = successCount >= recoveryLimit ? STATES.ONLINE : STATES.PENDING_RECOVERY;
                const recovered = nextState === STATES.ONLINE
                    && [STATES.OFFLINE, STATES.PENDING_RECOVERY].includes(current.state);
                current = {
                    ...current, state: nextState, failureCount: 0, successCount,
                    lastTransitionAt: recovered ? timestamp : current.lastTransitionAt,
                    lastObservedAt: timestamp,
                    recoveryNotified: recovered ? true : current.recoveryNotified,
                    lastNotification: recovered ? 'recovered' : current.lastNotification
                };
                if (recovered) {
                    transition = 'recovered';
                    notify = 'recovered';
                }
            } else {
                current = { ...current, state: STATES.ONLINE, failureCount: 0, successCount, lastObservedAt: timestamp };
            }
        } else {
            const failureCount = current.failureCount + 1;
            if (current.state === STATES.UNKNOWN) nextState = failureCount >= offlineLimit ? STATES.OFFLINE : STATES.PENDING_OFFLINE;
            else if (current.state === STATES.ONLINE || current.state === STATES.PENDING_OFFLINE) {
                nextState = failureCount >= offlineLimit ? STATES.OFFLINE : STATES.PENDING_OFFLINE;
            } else nextState = STATES.OFFLINE;
            const confirmedOffline = nextState === STATES.OFFLINE
                && ![STATES.OFFLINE, STATES.PENDING_RECOVERY].includes(before);
            current = {
                ...current, state: nextState, failureCount, successCount: 0,
                lastTransitionAt: confirmedOffline ? timestamp : current.lastTransitionAt,
                lastObservedAt: timestamp,
                offlineNotified: confirmedOffline ? true : current.offlineNotified,
                lastNotification: confirmedOffline ? 'offline' : current.lastNotification
            };
            if (confirmedOffline) {
                transition = 'offline';
                notify = 'offline';
            }
        }

        // Notification eligibility is returned independently from the state
        // transition so callers can disable a channel without corrupting the
        // debounce baseline. The flags above indicate it has been notified.
        const shouldNotify = transition !== null;
        return Object.freeze({
            observation, state: current.state, transition,
            notify: shouldNotify ? notify : null,
            baseline: before === STATES.UNKNOWN && transition === null,
            changed: before !== current.state,
            snapshot: snapshot()
        });
    }

    function reset() {
        current = {
            state: STATES.UNKNOWN,
            failureCount: 0,
            successCount: 0,
            lastTransitionAt: null,
            lastObservedAt: null,
            lastNotification: null,
            offlineNotified: false,
            recoveryNotified: false
        };
        return snapshot();
    }

    return Object.freeze({
        offlineThreshold: offlineLimit,
        recoveryThreshold: recoveryLimit,
        observe,
        reset,
        snapshot
    });
}

function createBooleanTransitionState({ now = () => Date.now() } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    let current = {
        state: STATES.UNKNOWN,
        value: null,
        lastTransitionAt: null,
        lastObservedAt: null,
        notified: false
    };

    function snapshot() { return Object.freeze({ ...current }); }
    function observe(value, { timestamp = now(), eligible = true } = {}) {
        if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
        if (!eligible || typeof value !== 'boolean') {
            current = { ...current, lastObservedAt: timestamp };
            return Object.freeze({ transition: null, baseline: false, snapshot: snapshot() });
        }
        const baseline = current.value === null;
        const changed = !baseline && current.value !== value;
        current = {
            ...current,
            state: value ? STATES.ONLINE : STATES.OFFLINE,
            value,
            lastTransitionAt: changed ? timestamp : current.lastTransitionAt,
            lastObservedAt: timestamp,
            notified: changed
        };
        return Object.freeze({
            transition: changed ? (value ? 'recovered' : 'offline') : null,
            baseline,
            snapshot: snapshot()
        });
    }
    function reset() {
        current = { state: STATES.UNKNOWN, value: null, lastTransitionAt: null, lastObservedAt: null, notified: false };
        return snapshot();
    }
    return Object.freeze({ observe, reset, snapshot });
}

module.exports = { STATES, createBooleanTransitionState, createConnectivityTransitionState, normalizeObservation };

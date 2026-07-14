'use strict';

const DEFAULT_CATCH_UP_MS = 30 * 60 * 1000;
const DEFAULT_LEASE_RENEW_MS = 60 * 1000;
const DEFAULT_DEADLINE_MS = 4 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_COMPLETION_RETRIES = 2;
const DEFAULT_COMPLETION_RETRY_MS = 100;
const MAX_LEASE_WINDOW_MS = 5 * 60 * 1000;

class ReportDeadlineError extends Error {
    constructor(message = 'Scheduled report exceeded its execution deadline') {
        super(message);
        this.name = 'ReportDeadlineError';
        this.code = 'REPORT_DEADLINE_EXCEEDED';
    }
}

class ClaimOwnershipLostError extends Error {
    constructor(message = 'Scheduled report no longer owns its durable claim') {
        super(message);
        this.name = 'ClaimOwnershipLostError';
        this.code = 'REPORT_CLAIM_OWNERSHIP_LOST';
    }
}

class ReportRunnerStoppedError extends Error {
    constructor(message = 'Scheduled report runner stopped') {
        super(message);
        this.name = 'ReportRunnerStoppedError';
        this.code = 'REPORT_RUNNER_STOPPED';
    }
}

function requiredFunction(value, name) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    return value;
}

function boundedDuration(value, fallback, name, { allowZero = false, max = Infinity } = {}) {
    const duration = value === undefined ? fallback : value;
    const minimumValid = allowZero ? duration >= 0 : duration > 0;
    if (!Number.isFinite(duration) || !Number.isInteger(duration) || !minimumValid || duration >= max) {
        const minimum = allowZero ? 'a non-negative' : 'a positive';
        const maximum = Number.isFinite(max) ? ` below ${max}` : '';
        throw new TypeError(`${name} must be ${minimum} integer${maximum}`);
    }
    return duration;
}

function readClock(clock) {
    const value = clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock must return a valid Date or timestamp');
    return date;
}

function reportTitle(frequency) {
    const label = { weekly: '每週', twice: '每日兩次', every6h: '每 6 小時' }[frequency] || '每日';
    return `📊 SmartHub ${label}報表`;
}

function deliveryResult(result) {
    if (result?.ok) {
        return {
            status: 'sent',
            channel: result.channel == null ? null : String(result.channel),
            error: null
        };
    }
    if (result?.skipped) {
        return {
            status: `skipped:${String(result.skipped).slice(0, 80)}`,
            channel: null,
            error: result.error == null ? null : String(result.error)
        };
    }
    if (result?.partial || Number(result?.sentParts) > 0) {
        return {
            status: 'partial',
            channel: result.channel == null ? null : String(result.channel),
            error: result.error == null ? 'notification delivery was only partially accepted' : String(result.error),
            sentParts: Number(result.sentParts) || 0,
            totalParts: Number(result.totalParts) || null,
            ambiguous: true
        };
    }
    return {
        status: 'failed',
        channel: null,
        error: result?.error == null ? 'notification delivery failed' : String(result.error)
    };
}

function errorMessage(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error || 'scheduled report failed');
}

function abortReason(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'operation aborted'));
}

function abortableCall(signal, operation, trackOperation = value => value) {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const underlying = trackOperation(Promise.resolve().then(operation));
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        underlying.then(value => finish(resolve, value), error => finish(reject, error));
    });
}

function isOwnedClaim(claim) {
    return Boolean(claim
        && claim.claimed === true
        && typeof claim.scheduleKey === 'string'
        && claim.scheduleKey.length > 0
        && typeof claim.title === 'string'
        && claim.title.length > 0
        && Number.isInteger(claim.attemptCount)
        && claim.attemptCount > 0
        && typeof claim.claimToken === 'string'
        && claim.claimToken.length > 0);
}

function createReportRunner(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('report runner options must be an object');
    }

    const db = options.db;
    if (!db || typeof db !== 'object') throw new TypeError('db must be an object');
    for (const method of [
        'claimNextScheduledReport',
        'claimScheduledReport',
        'renewScheduledReportClaim',
        'completeScheduledReport'
    ]) requiredFunction(db[method], `db.${method}`);

    const deriveDueReportSlot = requiredFunction(options.deriveDueReportSlot, 'deriveDueReportSlot');
    const getSettings = requiredFunction(options.getSettings, 'getSettings');
    const buildReport = requiredFunction(options.buildReport, 'buildReport');
    const deliver = requiredFunction(options.deliver, 'deliver');
    const clock = options.clock === undefined ? () => new Date() : requiredFunction(options.clock, 'clock');
    const setIntervalFn = options.setIntervalFn === undefined ? setInterval : requiredFunction(options.setIntervalFn, 'setIntervalFn');
    const clearIntervalFn = options.clearIntervalFn === undefined ? clearInterval : requiredFunction(options.clearIntervalFn, 'clearIntervalFn');
    const logger = options.logger || console;
    const sleep = options.sleep || (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
    const catchUpMs = boundedDuration(options.catchUpMs, DEFAULT_CATCH_UP_MS, 'catchUpMs', { allowZero: true });
    const leaseRenewMs = boundedDuration(options.leaseRenewMs, DEFAULT_LEASE_RENEW_MS, 'leaseRenewMs', { max: MAX_LEASE_WINDOW_MS });
    const deadlineMs = boundedDuration(options.deadlineMs, DEFAULT_DEADLINE_MS, 'deadlineMs', { max: MAX_LEASE_WINDOW_MS });
    const pollIntervalMs = boundedDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
    const completionRetries = boundedDuration(options.completionRetries, DEFAULT_COMPLETION_RETRIES, 'completionRetries', {
        allowZero: true,
        max: 11
    });
    const completionRetryMs = boundedDuration(options.completionRetryMs, DEFAULT_COMPLETION_RETRY_MS, 'completionRetryMs', {
        allowZero: true,
        max: 10_000
    });

    let pollTimer = null;
    let started = false;
    let inFlight = null;
    let activeRun = null;
    const pendingOperations = new Set();

    function trackOperation(operation) {
        pendingOperations.add(operation);
        operation.then(
            () => pendingOperations.delete(operation),
            () => pendingOperations.delete(operation)
        );
        return operation;
    }

    function log(level, message, fields = {}, error = null) {
        const method = level === 'warning'
            ? (logger.warning || logger.warn)
            : logger[level];
        if (typeof method !== 'function') return;
        try {
            method.call(logger, {
                module: 'report.runner',
                function: 'scheduledReport',
                message,
                fields,
                ...(error ? { error } : {})
            });
        } catch {
            // Logging must never change delivery or durable-completion behavior.
        }
    }

    function clearRunTimer(state, key) {
        if (state[key] === null) return;
        clearIntervalFn(state[key]);
        state[key] = null;
    }

    function loseOwnership(state, cause) {
        if (state.ownershipLost) return;
        state.ownershipLost = true;
        const reason = cause instanceof ClaimOwnershipLostError
            ? cause
            : new ClaimOwnershipLostError(cause ? `Scheduled report lease renewal failed: ${errorMessage(cause)}` : undefined);
        state.ownershipError = reason;
        if (!state.controller.signal.aborted) state.controller.abort(reason);
    }

    function queueRenewal(state) {
        const renewal = state.renewalTail
            .catch(() => false)
            .then(async () => {
                if (state.finishing || state.ownershipLost) return false;
                let owned;
                try {
                    owned = await db.renewScheduledReportClaim(state.claim.scheduleKey, {
                        ts: readClock(clock).getTime(),
                        attemptCount: state.claim.attemptCount,
                        claimToken: state.claim.claimToken
                    });
                } catch (error) {
                    loseOwnership(state, error);
                    return false;
                }
                if (!owned) loseOwnership(state);
                return owned === true;
            });
        state.renewalTail = renewal;
        return renewal;
    }

    async function persistCompletion(claim, entry, outcome) {
        let lastError = null;
        for (let retry = 0; retry <= completionRetries; retry++) {
            try {
                const recorded = await db.completeScheduledReport(claim.scheduleKey, {
                    ...entry,
                    attemptCount: claim.attemptCount,
                    claimToken: claim.claimToken
                });
                if (recorded === true) return true;
                log('warning', 'Scheduled report completion lost durable ownership; delivery outcome is ambiguous and may be retried', {
                    schedule_key: claim.scheduleKey,
                    attempt_count: claim.attemptCount,
                    outcome
                });
                return false;
            } catch (error) {
                lastError = error;
                if (retry >= completionRetries) break;
                const delayMs = Math.min(completionRetryMs * (2 ** retry), 1000);
                log('warning', 'Scheduled report completion write failed; retrying within the active lease', {
                    schedule_key: claim.scheduleKey,
                    attempt_count: claim.attemptCount,
                    outcome,
                    retry: retry + 1,
                    delay_ms: delayMs
                }, error);
                await sleep(delayMs);
            }
        }
        log('error', 'Could not persist scheduled report completion after bounded retries; delivery outcome is ambiguous', {
            schedule_key: claim.scheduleKey,
            attempt_count: claim.attemptCount,
            outcome,
            retries: completionRetries
        }, lastError);
        return false;
    }

    async function runClaim(claim, source) {
        const state = {
            claim,
            source,
            controller: new AbortController(),
            renewTimer: null,
            deadlineTimer: null,
            renewalTail: Promise.resolve(true),
            ownershipLost: false,
            ownershipError: null,
            timedOut: false,
            finishing: false,
            deliveryProgress: null
        };
        activeRun = state;

        state.renewTimer = setIntervalFn(() => {
            void queueRenewal(state);
        }, leaseRenewMs);
        state.deadlineTimer = setIntervalFn(() => {
            clearRunTimer(state, 'deadlineTimer');
            state.timedOut = true;
            if (!state.controller.signal.aborted) state.controller.abort(new ReportDeadlineError());
        }, deadlineMs);

        let body = '';
        let delivery = null;
        let failure = null;
        let outcome = 'completed';
        try {
            body = await abortableCall(state.controller.signal, () => buildReport({
                signal: state.controller.signal,
                scheduleKey: claim.scheduleKey,
                title: claim.title
            }), trackOperation);
            if (typeof body !== 'string') body = String(body ?? '');

            const stillOwned = await abortableCall(state.controller.signal, () => queueRenewal(state));
            if (!stillOwned) throw state.ownershipError || new ClaimOwnershipLostError();

            delivery = await abortableCall(state.controller.signal, () => deliver(claim.title, body, {
                signal: state.controller.signal,
                scheduleKey: claim.scheduleKey,
                onProgress(progress) {
                    if (!progress || typeof progress !== 'object') return;
                    const sentParts = Number(progress.sentParts);
                    const totalParts = Number(progress.totalParts);
                    if (!Number.isInteger(sentParts) || sentParts < 0) return;
                    if (!Number.isInteger(totalParts) || totalParts < sentParts || totalParts < 1) return;
                    state.deliveryProgress = {
                        sentParts,
                        totalParts,
                        channel: progress.channel == null ? null : String(progress.channel)
                    };
                }
            }), trackOperation);
            const result = deliveryResult(delivery);
            if (result.status === 'partial') {
                outcome = 'partial';
            } else if (result.status === 'failed') {
                failure = new Error(result.error || 'notification delivery failed');
                outcome = 'failed';
            }
        } catch (error) {
            failure = error instanceof Error ? error : new Error(errorMessage(error));
            if (state.ownershipLost || failure instanceof ClaimOwnershipLostError) outcome = 'ownership-lost';
            else if (state.timedOut || failure instanceof ReportDeadlineError) outcome = 'timed-out';
            else if (failure instanceof ReportRunnerStoppedError) outcome = 'stopped';
            else outcome = 'failed';
        } finally {
            state.finishing = true;
            clearRunTimer(state, 'renewTimer');
            clearRunTimer(state, 'deadlineTimer');
            await state.renewalTail.catch(() => false);
        }

        const result = deliveryResult(delivery);
        const partialProgress = state.deliveryProgress?.sentParts > 0
            ? state.deliveryProgress
            : (result.status === 'partial' ? result : null);
        const completedAt = readClock(clock).getTime();
        const deliveryStatus = partialProgress ? 'partial' : failure ? 'failed' : result.status;
        if (partialProgress) outcome = 'partial';
        const completionRecorded = await persistCompletion(claim, {
            ts: completedAt,
            title: claim.title,
            deliveryStatus,
            channel: partialProgress?.channel || (failure ? null : result.channel),
            deliveryError: partialProgress
                ? `${failure ? `${errorMessage(failure)}; ` : ''}partial delivery ${partialProgress.sentParts}/${partialProgress.totalParts}`
                : failure ? errorMessage(failure) : result.error,
            body
        }, outcome);

        if (activeRun === state) activeRun = null;
        return {
            status: outcome,
            source,
            scheduleKey: claim.scheduleKey,
            attemptCount: claim.attemptCount,
            deliveryStatus,
            completionRecorded,
            deliveryAmbiguous: deliveryStatus === 'partial' || (deliveryStatus === 'sent' && !completionRecorded),
            ...(partialProgress ? {
                deliveryProgress: {
                    sentParts: partialProgress.sentParts,
                    totalParts: partialProgress.totalParts
                }
            } : {}),
            ...(failure ? { error: failure } : {}),
            delivery
        };
    }

    async function executeTick() {
        const now = readClock(clock);
        const settings = await getSettings();
        const due = deriveDueReportSlot(settings, { now, catchUpMs });
        let duplicateScheduleKey = null;
        if (due) {
            const claim = await db.claimScheduledReport({
                scheduleKey: due.scheduleKey,
                ts: now.getTime(),
                title: reportTitle(due.frequency)
            });
            if (isOwnedClaim(claim)) return runClaim(claim, 'schedule');
            duplicateScheduleKey = due.scheduleKey;
        }

        const recovered = await db.claimNextScheduledReport({ ts: now.getTime() });
        if (recovered !== null && recovered !== undefined) {
            if (!isOwnedClaim(recovered)) {
                log('warning', 'Recovery scan returned a claim that this process does not own');
                return { status: 'not-owner', source: 'recovery' };
            }
            return runClaim(recovered, 'recovery');
        }
        return duplicateScheduleKey
            ? { status: 'duplicate', source: 'schedule', scheduleKey: duplicateScheduleKey }
            : { status: 'idle' };
    }

    function tick() {
        if (inFlight) return Promise.resolve({ status: 'overlap' });
        if (pendingOperations.size > 0) return Promise.resolve({ status: 'draining' });
        const running = executeTick();
        inFlight = running.finally(() => {
            if (inFlight === wrapped) inFlight = null;
        });
        const wrapped = inFlight;
        return wrapped;
    }

    function handleBackgroundError(error) {
        log('error', 'Scheduled report tick failed before completion', {}, error);
    }

    function start() {
        if (started) return false;
        started = true;
        pollTimer = setIntervalFn(() => {
            void tick().catch(handleBackgroundError);
        }, pollIntervalMs);
        void tick().catch(handleBackgroundError);
        return true;
    }

    async function stop() {
        started = false;
        if (pollTimer !== null) {
            clearIntervalFn(pollTimer);
            pollTimer = null;
        }
        if (activeRun && !activeRun.controller.signal.aborted) {
            activeRun.controller.abort(new ReportRunnerStoppedError());
        }
        if (inFlight) await inFlight.catch(() => {});
        if (pendingOperations.size > 0) await Promise.allSettled([...pendingOperations]);
    }

    return { start, stop, tick };
}

module.exports = {
    ClaimOwnershipLostError,
    DEFAULT_CATCH_UP_MS,
    DEFAULT_COMPLETION_RETRIES,
    DEFAULT_COMPLETION_RETRY_MS,
    DEFAULT_DEADLINE_MS,
    DEFAULT_LEASE_RENEW_MS,
    DEFAULT_POLL_INTERVAL_MS,
    ReportDeadlineError,
    ReportRunnerStoppedError,
    createReportRunner
};

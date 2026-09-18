'use strict';

const { NasLoginSupersededError } = require('./nas-token-generation');

/**
 * Run one read-only NAS request with a bounded token retry contract.  The
 * request implementation, token lease, and response policy are injected so
 * production and behavior tests exercise the same loop.
 */
function createNasRequestRunner({
    getToken,
    getLease,
    getRequestGeneration = () => null,
    request,
    validateResponse,
    normalizeError = error => error,
    isTokenRejectedError,
    isSupersededError = () => false,
    clearTokenIfCurrent,
    recordSuccess,
    recordFailure,
    isFailureRecorded = error => error?.nasFailureRecorded === true
} = {}) {
    for (const [name, value] of Object.entries({
        getToken, getLease, getRequestGeneration, request, validateResponse, isTokenRejectedError,
        clearTokenIfCurrent, recordSuccess, recordFailure
    })) {
        if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }

    async function run(pathName, params = {}) {
        const MAX_ATTEMPTS = 2;
        let lastError = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            let lease = null;
            const requestGeneration = getRequestGeneration();
            const assertCurrent = () => {
                if (getRequestGeneration() !== requestGeneration) throw new NasLoginSupersededError();
            };
            try {
                const token = await getToken();
                assertCurrent();
                lease = getLease(token);
                const response = await request(pathName, {
                    params: { ...params, token: lease.token }
                });
                assertCurrent();
                const result = await validateResponse(response);
                assertCurrent();
                recordSuccess();
                return result;
            } catch (caughtError) {
                const error = getRequestGeneration() !== requestGeneration
                    ? new NasLoginSupersededError()
                    : normalizeError(caughtError);
                lastError = error;
                if (isSupersededError(error)) {
                    if (attempt + 1 < MAX_ATTEMPTS) continue;
                    break;
                }
                const canRetry = lease !== null
                    && attempt + 1 < MAX_ATTEMPTS
                    && isTokenRejectedError(error);
                if (!canRetry) break;
                if (lease) await clearTokenIfCurrent(lease);
            }
        }
        if (lastError && !isSupersededError(lastError) && !isFailureRecorded(lastError)) {
            recordFailure(lastError);
        }
        throw lastError;
    }

    return Object.freeze({ run });
}

module.exports = { createNasRequestRunner };

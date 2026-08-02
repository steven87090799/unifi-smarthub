'use strict';

/**
 * Coalesce the RSA login operation used by all NAS API requests.  The caller
 * owns token storage; this service only decides whether a valid token can be
 * reused and makes one login promise visible to every concurrent waiter.
 */
function createNasLoginSingleflight({
    getCachedToken,
    isTokenValid,
    login,
    isSupersededError = () => false,
    onFailure = null
} = {}) {
    if (typeof getCachedToken !== 'function') throw new TypeError('getCachedToken is required');
    if (typeof isTokenValid !== 'function') throw new TypeError('isTokenValid is required');
    if (typeof login !== 'function') throw new TypeError('login is required');

    let inFlight = null;

    async function getToken() {
        const cached = getCachedToken();
        if (isTokenValid(cached)) return cached;
        if (inFlight) return inFlight;

        const pending = Promise.resolve().then(login).catch(error => {
            if (!isSupersededError(error) && typeof onFailure === 'function') {
                try { onFailure(error); } catch { /* preserve the original login error */ }
            }
            throw error;
        });
        const wrapped = pending.finally(() => {
            if (inFlight === wrapped) inFlight = null;
        });
        inFlight = wrapped;
        return inFlight;
    }

    function reset() {
        // Do not cancel the old Promise.  Fence it by dropping ownership so a
        // rebuilt client can start a new login while old waiters still settle.
        inFlight = null;
    }

    return Object.freeze({
        getToken,
        reset,
        isInFlight: () => Boolean(inFlight)
    });
}

module.exports = { createNasLoginSingleflight };

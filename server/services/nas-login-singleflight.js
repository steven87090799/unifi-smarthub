'use strict';

/**
 * Coalesce the RSA login operation used by all NAS API requests.  The caller
 * owns token storage; this service only decides whether a valid token can be
 * reused and makes one login promise visible to every concurrent waiter.
 */
function createNasLoginSingleflight({ getCachedToken, isTokenValid, login } = {}) {
    if (typeof getCachedToken !== 'function') throw new TypeError('getCachedToken is required');
    if (typeof isTokenValid !== 'function') throw new TypeError('isTokenValid is required');
    if (typeof login !== 'function') throw new TypeError('login is required');

    let inFlight = null;

    async function getToken() {
        const cached = getCachedToken();
        if (isTokenValid(cached)) return cached;
        if (inFlight) return inFlight;

        const pending = Promise.resolve().then(login);
        const wrapped = pending.finally(() => {
            if (inFlight === wrapped) inFlight = null;
        });
        inFlight = wrapped;
        return inFlight;
    }

    return Object.freeze({
        getToken,
        isInFlight: () => Boolean(inFlight)
    });
}

module.exports = { createNasLoginSingleflight };

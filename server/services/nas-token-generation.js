'use strict';

class NasLoginSupersededError extends Error {
    constructor() {
        super('NAS login result was superseded by a newer client generation');
        this.name = 'NasLoginSupersededError';
        this.code = 'NAS_LOGIN_SUPERSEDED';
    }
}

function isNasLoginSupersededError(error) {
    return error?.code === 'NAS_LOGIN_SUPERSEDED';
}

/**
 * Generation-fenced NAS token storage.  A request may clear a token only if
 * the token and generation it used are still current; a delayed 401 from an
 * older request therefore cannot erase a newer login.
 */
function createNasTokenGeneration({ now = () => Date.now() } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    let token = '';
    let expiresAt = 0;
    let generation = 0;

    function set(nextToken, nextExpiresAt) {
        if (!nextToken) throw new TypeError('NAS token must be non-empty');
        token = String(nextToken);
        expiresAt = Number(nextExpiresAt) || 0;
        generation += 1;
        return { token, generation, expiresAt };
    }

    function setIfGeneration(expectedGeneration, nextToken, nextExpiresAt) {
        if (generation !== expectedGeneration) return false;
        set(nextToken, nextExpiresAt);
        return true;
    }

    function clearIfCurrent(requestToken, requestGeneration) {
        if (token !== requestToken || generation !== requestGeneration) return false;
        token = '';
        expiresAt = 0;
        generation += 1;
        return true;
    }

    function reset() {
        token = '';
        expiresAt = 0;
        generation += 1;
    }

    return Object.freeze({
        getToken: () => token,
        getGeneration: () => generation,
        isValid: () => Boolean(token && now() < expiresAt),
        set,
        setIfGeneration,
        clearIfCurrent,
        reset,
        snapshot: () => ({
            configured: Boolean(token),
            valid: Boolean(token && now() < expiresAt),
            generation,
            expiresAt
        })
    });
}

module.exports = {
    NasLoginSupersededError,
    createNasTokenGeneration,
    isNasLoginSupersededError
};

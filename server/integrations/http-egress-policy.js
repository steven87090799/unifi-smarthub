'use strict';

/**
 * Keep LAN routing decisions at the request boundary. Axios's default proxy
 * resolution remains available to public integrations through the Internet
 * helper; the LAN helper explicitly disables ambient proxy use.
 */
function validateConfig(config, label) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError(`${label} Axios config must be an object`);
    }
    return config;
}

function createLanAxiosConfig(config = {}) {
    return { ...validateConfig(config, 'LAN'), proxy: false };
}

function createInternetAxiosConfig(config = {}) {
    // Do not set proxy here. Axios will preserve HTTP(S)_PROXY/ALL_PROXY
    // resolution unless the caller explicitly supplies a different policy.
    return { ...validateConfig(config, 'Internet') };
}

module.exports = { createInternetAxiosConfig, createLanAxiosConfig };

'use strict';

const INTERNET_PROXY_MODES = Object.freeze(['disabled', 'environment']);
const AMBIENT_PROXY_ENV_KEYS = Object.freeze([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy'
]);

function validateConfig(config, label) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError(`${label} Axios config must be an object`);
    }
    return config;
}

function resolveInternetProxyMode(value = process.env.SMARTHUB_INTERNET_PROXY_MODE) {
    const mode = value === undefined || value === null || String(value).trim() === ''
        ? 'disabled'
        : String(value).trim().toLowerCase();
    if (!INTERNET_PROXY_MODES.includes(mode)) {
        throw new Error(`SMARTHUB_INTERNET_PROXY_MODE must be one of: ${INTERNET_PROXY_MODES.join(', ')}`);
    }
    return mode;
}

function hasAmbientProxyEnvironment(env = process.env) {
    return AMBIENT_PROXY_ENV_KEYS.some(key => typeof env?.[key] === 'string' && env[key].trim() !== '');
}

function describeInternetProxyPolicy({ proxyMode, env = process.env } = {}) {
    const mode = resolveInternetProxyMode(proxyMode);
    return Object.freeze({
        mode,
        ambientProxyConfigured: mode === 'environment' && hasAmbientProxyEnvironment(env)
    });
}

function createLanAxiosConfig(config = {}) {
    return { ...validateConfig(config, 'LAN'), proxy: false };
}

function createInternetAxiosConfig(config = {}, { proxyMode } = {}) {
    const validated = validateConfig(config, 'Internet');
    return resolveInternetProxyMode(proxyMode) === 'disabled'
        ? { ...validated, proxy: false }
        // Leaving `proxy` unset intentionally preserves Axios's documented
        // HTTP(S)_PROXY/ALL_PROXY resolution for the explicit environment mode.
        : { ...validated };
}

function createInternetAxiosClient(axios, options = {}) {
    if (!axios || typeof axios.create !== 'function') throw new TypeError('axios.create is required');
    return axios.create(createInternetAxiosConfig({}, options));
}

module.exports = {
    AMBIENT_PROXY_ENV_KEYS,
    INTERNET_PROXY_MODES,
    createInternetAxiosClient,
    createInternetAxiosConfig,
    createLanAxiosConfig,
    describeInternetProxyPolicy,
    hasAmbientProxyEnvironment,
    resolveInternetProxyMode
};

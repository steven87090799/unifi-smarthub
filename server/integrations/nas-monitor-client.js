'use strict';

const fs = require('node:fs');
const https = require('node:https');
const { createLanAxiosConfig } = require('./http-egress-policy');

const MIN_API_KEY_BYTES = 32;
const MAX_API_KEY_BYTES = 256;
const MAX_BASE_URL_LENGTH = 2048;
const MAX_CA_BYTES = 1024 * 1024;
// Broker actions allow a bounded 10-second Docker stop grace plus broker
// reconciliation; the caller deadline must remain longer than the broker's.
const DEFAULT_TIMEOUT_MS = 20_000;
const PLACEHOLDER_KEYS = new Set([
    'smarthub-local-monitor',
    'change-me',
    'changeme',
    'replace-me',
    'your_nas_monitor_api_key'
]);

class NasMonitorConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NasMonitorConfigurationError';
        this.code = 'NAS_MONITOR_CONFIG_INVALID';
    }
}

function configurationError(message) {
    throw new NasMonitorConfigurationError(message);
}

function strictBoolean(value, field, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    return configurationError(`${field} must be true or false`);
}

function normalizeApiKey(value) {
    if (typeof value !== 'string') configurationError('NAS Monitor API key is required');
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < MIN_API_KEY_BYTES || bytes > MAX_API_KEY_BYTES || !/^[\x21-\x7e]+$/.test(value)) {
        configurationError(`NAS Monitor API key must be ${MIN_API_KEY_BYTES}-${MAX_API_KEY_BYTES} printable ASCII bytes`);
    }
    if (PLACEHOLDER_KEYS.has(value.toLowerCase()) || /^(?:your|example|default)[-_]/i.test(value)
        || new Set(value).size < 10) {
        configurationError('NAS Monitor API key must not be a placeholder or default value');
    }
    return value;
}

function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeBaseUrl(value, { allowInsecureHttp = false } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE_URL_LENGTH
        || /[\u0000-\u001f\u007f]/.test(value)) {
        configurationError('NAS Monitor URL must be a bounded HTTP(S) URL');
    }
    let parsed;
    try { parsed = new URL(value); }
    catch { configurationError('NAS Monitor URL is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash) {
        configurationError('NAS Monitor URL must be HTTP(S) without credentials, query, or fragment');
    }
    if (parsed.protocol === 'http:'
        && parsed.hostname.toLowerCase() !== 'nas-monitor'
        && !isLoopbackHostname(parsed.hostname)
        && !allowInsecureHttp) {
        configurationError('Remote NAS Monitor HTTP requires explicit NAS_MONITOR_ALLOW_INSECURE_HTTP=true');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
}

function loadCertificateAuthority(file, fileSystem = fs) {
    if (!file) return undefined;
    if (typeof file !== 'string' || file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file)) {
        configurationError('NAS_MONITOR_CA_FILE is invalid');
    }
    let stat;
    try { stat = fileSystem.statSync(file); }
    catch { configurationError('NAS_MONITOR_CA_FILE cannot be read'); }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CA_BYTES) {
        configurationError(`NAS_MONITOR_CA_FILE must be a non-empty file at most ${MAX_CA_BYTES} bytes`);
    }
    try { return fileSystem.readFileSync(file); }
    catch { return configurationError('NAS_MONITOR_CA_FILE cannot be read'); }
}

function createNasMonitorConnection(options = {}) {
    const env = options.env || process.env;
    const axios = options.axios;
    if (!axios || typeof axios.create !== 'function') throw new TypeError('axios.create is required');
    const rawUrl = env.NAS_MONITOR_URL;
    if (!rawUrl) return { url: null, client: null, configured: false };

    const allowInsecureHttp = strictBoolean(env.NAS_MONITOR_ALLOW_INSECURE_HTTP, 'NAS_MONITOR_ALLOW_INSECURE_HTTP');
    const allowInsecureTls = strictBoolean(env.NAS_MONITOR_TLS_INSECURE, 'NAS_MONITOR_TLS_INSECURE');
    const url = normalizeBaseUrl(rawUrl, { allowInsecureHttp });
    const key = normalizeApiKey(env.NAS_MONITOR_API_KEY || '');
    const parsed = new URL(url);
    const agent = parsed.protocol === 'https:' ? new https.Agent({
        rejectUnauthorized: !allowInsecureTls,
        ca: loadCertificateAuthority(env.NAS_MONITOR_CA_FILE, options.fs || fs)
    }) : undefined;
    const timeout = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30_000) {
        throw new TypeError('timeoutMs must be an integer between 1000 and 30000');
    }
    const client = axios.create(createLanAxiosConfig({
        baseURL: url,
        headers: {
            Accept: 'application/json',
            'X-API-Key': key
        },
        ...(agent ? { httpsAgent: agent } : {}),
        timeout,
        maxContentLength: 4 * 1024 * 1024,
        maxBodyLength: 64 * 1024,
        validateStatus: status => status >= 200 && status < 300
    }));
    return { url, client, configured: true, tlsVerified: parsed.protocol !== 'https:' || !allowInsecureTls };
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    MAX_API_KEY_BYTES,
    MIN_API_KEY_BYTES,
    NasMonitorConfigurationError,
    createNasMonitorConnection,
    isLoopbackHostname,
    loadCertificateAuthority,
    normalizeApiKey,
    normalizeBaseUrl,
    strictBoolean
};

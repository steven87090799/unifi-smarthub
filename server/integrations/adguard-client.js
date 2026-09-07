'use strict';

const fs = require('node:fs');
const { isLoopbackHostname } = require('./nas-monitor-client');
const { createLanAxiosConfig } = require('./http-egress-policy');
const { createHttpsAgent, readCaFile } = require('./tls-policy');
const {
    resolveIntegrationTlsPolicy,
    resolveTrustedLanTransportInputs,
    strictBoolean: trustedLanBoolean
} = require('./trusted-lan-policy');

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_CA_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const PLACEHOLDER_CREDENTIALS = /^(?:change-?me|changeme|example|password|your[_-].*)$/iu;

class AdGuardConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AdGuardConfigurationError';
        this.code = 'ADGUARD_CONFIG_INVALID';
    }
}

function configurationError(message) {
    throw new AdGuardConfigurationError(message);
}

function wrapConfigurationError(error) {
    if (error instanceof AdGuardConfigurationError) throw error;
    throw new AdGuardConfigurationError(error?.message || 'AdGuard configuration is invalid');
}

function exactBoolean(value, field, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return configurationError(`${field} must be true or false`);
}

function boundedCredential(value, field, { min = 1, max = 256, username = false } = {}) {
    if (typeof value !== 'string') configurationError(`${field} is required`);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < min || bytes > max || /[\u0000-\u001f\u007f]/u.test(value)
        || (username && value.includes(':'))) {
        configurationError(`${field} must be ${min}-${max} bytes without control characters`);
    }
    if (PLACEHOLDER_CREDENTIALS.test(value.trim())) {
        configurationError(`${field} must not be a placeholder value`);
    }
    return value;
}

function canonicalPort(value) {
    const raw = value === undefined || value === null || value === '' ? '80' : String(value);
    if (!/^[1-9]\d{0,4}$/u.test(raw)) configurationError('ADGUARD_PORT must be a canonical integer from 1 through 65535');
    const port = Number(raw);
    if (port > 65_535) configurationError('ADGUARD_PORT must be a canonical integer from 1 through 65535');
    return raw;
}

function legacyBaseUrl(env) {
    const host = env.ADGUARD_HOST;
    if (!host) return '';
    if (typeof host !== 'string' || host.length > 253 || /[\u0000-\u0020\u007f/@?#]/u.test(host)) {
        configurationError('ADGUARD_HOST must be a bounded hostname or IP address');
    }
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${bracketed}:${canonicalPort(env.ADGUARD_PORT)}`;
}

function normalizeBaseUrl(value, { allowInsecureHttp = false } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE_URL_LENGTH
        || /[\u0000-\u001f\u007f]/u.test(value)) {
        configurationError('ADGUARD_URL must be a bounded HTTP(S) URL');
    }
    let parsed;
    try { parsed = new URL(value); }
    catch { configurationError('ADGUARD_URL is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash || !parsed.hostname || !['', '/'].includes(parsed.pathname)) {
        configurationError('ADGUARD_URL must be an origin-only HTTP(S) URL without credentials, path, query, or fragment');
    }
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname) && !allowInsecureHttp) {
        configurationError('Remote AdGuard HTTP requires explicit ADGUARD_ALLOW_INSECURE_HTTP=true');
    }
    return parsed.origin;
}

function loadCertificateAuthority(file, fileSystem = fs) {
    if (!file) return undefined;
    try {
        return readCaFile(file, { fileSystem, field: 'ADGUARD_CA_FILE' });
    } catch (error) {
        if (error?.message?.includes('must not be a symlink')) configurationError('ADGUARD_CA_FILE must not be a symlink');
        if (error?.message?.includes('invalid')) configurationError('ADGUARD_CA_FILE is invalid');
        if (error?.message?.includes('regular file')) {
            configurationError(`ADGUARD_CA_FILE must be a non-empty file at most ${MAX_CA_BYTES} bytes`);
        }
        configurationError('ADGUARD_CA_FILE cannot be read');
    }
}

function normalizeControlPath(value) {
    if (typeof value !== 'string' || value.length > 256
        || !/^\/control\/[a-z0-9_/-]+$/u.test(value)) {
        throw new TypeError('AdGuard request path must be an exact /control path');
    }
    return value;
}

function createAdGuardConnection(options = {}) {
    const env = options.env || process.env;
    const axios = options.axios;
    if (!axios || typeof axios.create !== 'function') throw new TypeError('axios.create is required');
    const rawUrl = env.ADGUARD_URL || legacyBaseUrl(env);
    if (!rawUrl) return { url: null, client: null, configured: false, tlsVerified: false };

    let transportInputs;
    try {
        transportInputs = resolveTrustedLanTransportInputs({
            url: rawUrl,
            integration: 'adguard',
            env,
            implicitInsecureWhenVerifyFalse: true,
            fields: {
                verify: 'ADGUARD_TLS_VERIFY', ca: 'ADGUARD_CA_FILE',
                allowHttp: 'ADGUARD_ALLOW_INSECURE_HTTP'
            }
        });
    } catch (error) { wrapConfigurationError(error); }
    let allowInsecureHttp;
    try {
        allowInsecureHttp = trustedLanBoolean(
            transportInputs.allowInsecureHttp, 'ADGUARD_ALLOW_INSECURE_HTTP', false
        );
    } catch (error) { wrapConfigurationError(error); }
    const url = normalizeBaseUrl(rawUrl, { allowInsecureHttp });
    const username = boundedCredential(env.ADGUARD_USER, 'ADGUARD_USER', { max: 128, username: true });
    const password = boundedCredential(env.ADGUARD_PASSWORD, 'ADGUARD_PASSWORD', { max: 256 });
    const parsed = new URL(url);
    let tls;
    try {
        tls = resolveIntegrationTlsPolicy({
            url,
            integration: 'adguard',
            env,
            implicitInsecureWhenVerifyFalse: true,
            fields: {
                verify: 'ADGUARD_TLS_VERIFY', ca: 'ADGUARD_CA_FILE',
                allowHttp: 'ADGUARD_ALLOW_INSECURE_HTTP'
            },
            fileSystem: options.fs || fs
        });
    } catch (error) { wrapConfigurationError(error); }
    const agent = createHttpsAgent(tls);
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000) {
        throw new TypeError('timeoutMs must be an integer between 1000 and 30000');
    }
    const transport = axios.create(createLanAxiosConfig({
        baseURL: url,
        auth: { username, password },
        headers: { Accept: 'application/json' },
        ...(agent ? { httpsAgent: agent } : {}),
        timeout,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_REQUEST_BYTES,
        validateStatus: status => status >= 200 && status < 300
    }));
    const client = Object.freeze({
        async request(path, { method = 'get', data, params } = {}) {
            const normalizedMethod = String(method).toLowerCase();
            if (!['get', 'post', 'put'].includes(normalizedMethod)) throw new TypeError('AdGuard request method is invalid');
            const response = await transport.request({
                url: normalizeControlPath(path),
                method: normalizedMethod,
                ...(data === undefined ? {} : { data }),
                ...(params === undefined ? {} : { params })
            });
            return response.data;
        }
    });
    return {
        url,
        client,
        configured: true,
        tlsVerified: parsed.protocol === 'https:' && tls.verify === true,
        transportMode: tls.mode,
        trustedLan: tls.trustedLan === true,
        insecureHttp: parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)
    };
}

module.exports = {
    AdGuardConfigurationError,
    DEFAULT_TIMEOUT_MS,
    MAX_CA_BYTES,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    boundedCredential,
    canonicalPort,
    createAdGuardConnection,
    exactBoolean,
    legacyBaseUrl,
    loadCertificateAuthority,
    normalizeBaseUrl,
    normalizeControlPath
};

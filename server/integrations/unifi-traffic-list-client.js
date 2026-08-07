'use strict';

const net = require('node:net');
const {
    resolveIntegrationTlsPolicy,
    resolveTrustedLanTransportInputs
} = require('./trusted-lan-policy');

const DEFAULT_LIST_NAME = 'SmartHub Threat Blocks';
const EMPTY_LIST_SENTINEL = '192.0.2.1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').replace(/^\[|\]$/gu, '').toLowerCase();
    return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

class UniFiTrafficListError extends Error {
    constructor(message, { code = 'unifi_traffic_list_error', status = null, retryable = false } = {}) {
        super(message);
        this.name = 'UniFiTrafficListError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function configuredValue(value) {
    return typeof value === 'string' && value.trim() !== '' && !/your_/iu.test(value);
}

function normalizeBaseUrl(value, { allowInsecureHttp = false } = {}) {
    let parsed;
    try { parsed = new URL(value); }
    catch { throw new UniFiTrafficListError('UniFi Network API URL is invalid', { code: 'invalid_api_url' }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new UniFiTrafficListError('UniFi Network API URL must be HTTP(S) without credentials', { code: 'invalid_api_url' });
    }
    if (parsed.search || parsed.hash) {
        throw new UniFiTrafficListError('UniFi Network API URL must not contain query or fragment data', { code: 'invalid_api_url' });
    }
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname) && !allowInsecureHttp) {
        throw new UniFiTrafficListError('UniFi Network API URL must use HTTPS outside loopback', { code: 'insecure_api_url' });
    }
    return parsed.toString().replace(/\/$/u, '');
}

function parseTlsVerify(value) {
    if (value === undefined || value === null || value === '') return true;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

function parseStrictBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

function readConfiguration(environment = process.env) {
    const apiKey = environment.UNIFI_NETWORK_API_KEY || '';
    const siteId = environment.UNIFI_NETWORK_SITE_ID || '';
    const listId = environment.UNIFI_THREAT_BLOCK_LIST_ID || '';
    const listName = environment.UNIFI_THREAT_BLOCK_LIST_NAME || DEFAULT_LIST_NAME;
    const explicitUrl = environment.UNIFI_NETWORK_API_URL || '';
    const controllerUrl = environment.UNIFI_CONTROLLER_URL || '';
    const missing = [];
    if (!configuredValue(apiKey)) missing.push('UNIFI_NETWORK_API_KEY');
    if (!UUID.test(siteId)) missing.push('UNIFI_NETWORK_SITE_ID');
    if (!UUID.test(listId)) missing.push('UNIFI_THREAT_BLOCK_LIST_ID');
    if (!configuredValue(explicitUrl) && !configuredValue(controllerUrl)) missing.push('UNIFI_NETWORK_API_URL');
    if (typeof listName !== 'string' || listName.trim().length < 1 || listName.trim().length > 128) {
        missing.push('UNIFI_THREAT_BLOCK_LIST_NAME');
    }
    const trustedInputs = (() => {
        try {
            return resolveTrustedLanTransportInputs({
                url: explicitUrl || `${controllerUrl.replace(/\/$/u, '')}/proxy/network/integration`,
                integration: 'unifi_network',
                env: environment,
                fields: {
                    verify: 'UNIFI_NETWORK_TLS_VERIFY', insecure: 'UNIFI_NETWORK_TLS_INSECURE',
                    ca: 'UNIFI_NETWORK_CA_FILE', allowHttp: 'UNIFI_NETWORK_ALLOW_INSECURE_HTTP'
                }
            });
        } catch (error) {
            missing.push(error.field || 'TRUSTED_LAN_MODE');
            return null;
        }
    })();
    const tlsVerify = trustedInputs
        ? parseTlsVerify(trustedInputs.verify)
        : parseTlsVerify(environment.UNIFI_NETWORK_TLS_VERIFY);
    const tlsInsecure = trustedInputs
        ? parseStrictBoolean(trustedInputs.insecure, false)
        : parseStrictBoolean(environment.UNIFI_NETWORK_TLS_INSECURE, false);
    const allowInsecureHttp = trustedInputs
        ? parseStrictBoolean(trustedInputs.allowInsecureHttp, false)
        : parseStrictBoolean(environment.UNIFI_NETWORK_ALLOW_INSECURE_HTTP, false);
    if (tlsVerify === null) missing.push('UNIFI_NETWORK_TLS_VERIFY');
    if (tlsInsecure === null) missing.push('UNIFI_NETWORK_TLS_INSECURE');
    if (allowInsecureHttp === null) missing.push('UNIFI_NETWORK_ALLOW_INSECURE_HTTP');
    if (tlsVerify === false && tlsInsecure !== true) missing.push('UNIFI_NETWORK_TLS_INSECURE');
    let baseUrl = null;
    let tlsPolicy = null;
    if (missing.length === 0) {
        const source = explicitUrl || `${controllerUrl.replace(/\/$/u, '')}/proxy/network/integration`;
        try {
            baseUrl = normalizeBaseUrl(source, { allowInsecureHttp });
            const resolvedTlsPolicy = resolveIntegrationTlsPolicy({
                url: baseUrl,
                integration: 'unifi_network',
                env: environment,
                fields: {
                    url: 'UNIFI_NETWORK_API_URL', verify: 'UNIFI_NETWORK_TLS_VERIFY',
                    insecure: 'UNIFI_NETWORK_TLS_INSECURE', ca: 'UNIFI_NETWORK_CA_FILE',
                    allowHttp: 'UNIFI_NETWORK_ALLOW_INSECURE_HTTP'
                }
            });
            // Keep the established configuration contract small. Target
            // classification is an internal policy decision, not an API or
            // diagnostic field; transport mode remains available to callers.
            const {
                trustedLan: _trustedLan,
                trustedLanApplied: _trustedLanApplied,
                trustedLanTarget: _trustedLanTarget,
                ...safeTlsPolicy
            } = resolvedTlsPolicy;
            tlsPolicy = safeTlsPolicy;
        } catch (error) { missing.push(error.field || 'UNIFI_NETWORK_API_URL'); }
    }
    return {
        configured: missing.length === 0,
        missing: [...new Set(missing)],
        baseUrl,
        apiKey,
        siteId,
        listId,
        listName: typeof listName === 'string' ? listName.trim() : '',
        tlsVerify: tlsPolicy ? tlsPolicy.verify : true,
        tlsInsecure: tlsPolicy?.insecure === true,
        caFile: environment.UNIFI_NETWORK_CA_FILE || '',
        tlsPolicy,
        allowInsecureHttp: allowInsecureHttp === true
    };
}

function responseBody(response) {
    return response && Object.hasOwn(response, 'data') ? response.data : response;
}

function validateList(value, configuration) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UniFiTrafficListError('UniFi traffic list response is malformed', { code: 'malformed_response' });
    }
    if (value.id !== configuration.listId || value.type !== 'IPV4_ADDRESSES' || value.name !== configuration.listName) {
        throw new UniFiTrafficListError('UniFi traffic list identity does not match the dedicated SmartHub list', {
            code: 'list_identity_mismatch'
        });
    }
    if (!Array.isArray(value.items) || value.items.length < 1) {
        throw new UniFiTrafficListError('UniFi traffic list must contain at least one item', { code: 'malformed_response' });
    }
    const addresses = value.items.map(item => {
        if (!item || item.type !== 'IP_ADDRESS' || net.isIP(item.value) !== 4) {
            throw new UniFiTrafficListError('Dedicated SmartHub list contains a non-address IPv4 matcher', {
                code: 'unsafe_list_contents'
            });
        }
        return item.value;
    });
    if (new Set(addresses).size !== addresses.length) {
        throw new UniFiTrafficListError('Dedicated SmartHub list contains duplicate addresses', {
            code: 'unsafe_list_contents'
        });
    }
    return addresses.sort();
}

function transportError(error) {
    if (error instanceof UniFiTrafficListError) return error;
    const status = Number(error?.response?.status) || null;
    const retryable = status === null || status === 408 || status === 429 || status >= 500;
    return new UniFiTrafficListError('UniFi traffic list request failed', {
        code: status ? `upstream_http_${status}` : 'upstream_unavailable',
        status,
        retryable
    });
}

function createUniFiTrafficListClient({ transport, getEnvironment = () => process.env, timeoutMs = 4000 } = {}) {
    if (typeof transport !== 'function') throw new TypeError('transport is required');

    function configuration() {
        return readConfiguration(getEnvironment());
    }

    async function request(config, method, data) {
        const endpoint = `/v1/sites/${encodeURIComponent(config.siteId)}/traffic-matching-lists/${encodeURIComponent(config.listId)}`;
        try {
            return await transport({
                method,
                url: `${config.baseUrl}${endpoint}`,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-API-Key': config.apiKey
                },
                tls: config.tlsPolicy,
                allowInsecureHttp: config.allowInsecureHttp,
                timeout: timeoutMs,
                ...(data ? { data } : {})
            });
        } catch (error) { throw transportError(error); }
    }

    async function replace(addresses) {
        const config = configuration();
        if (!config.configured) {
            throw new UniFiTrafficListError('UniFi threat blocking is not configured', {
                code: 'not_configured'
            });
        }
        const desired = [...new Set([EMPTY_LIST_SENTINEL, ...addresses])].sort();
        if (desired.some(address => net.isIP(address) !== 4)) {
            throw new TypeError('addresses must contain only canonical IPv4 values');
        }
        const before = validateList(responseBody(await request(config, 'GET')), config);
        if (before.length === desired.length && before.every((address, index) => address === desired[index])) {
            return { changed: false, addresses: desired };
        }
        const body = {
            type: 'IPV4_ADDRESSES',
            name: config.listName,
            items: desired.map(value => ({ type: 'IP_ADDRESS', value }))
        };
        const after = validateList(responseBody(await request(config, 'PUT', body)), config);
        if (after.length !== desired.length || after.some((address, index) => address !== desired[index])) {
            throw new UniFiTrafficListError('UniFi traffic list update did not converge', {
                code: 'update_not_converged', retryable: true
            });
        }
        return { changed: true, addresses: desired };
    }

    return { configuration, replace };
}

module.exports = {
    DEFAULT_LIST_NAME,
    EMPTY_LIST_SENTINEL,
    UniFiTrafficListError,
    createUniFiTrafficListClient,
    readConfiguration,
    isLoopbackHostname,
    validateList
};

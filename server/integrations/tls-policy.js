'use strict';

const fs = require('node:fs');
const https = require('node:https');

const MAX_CA_BYTES = 1024 * 1024;

class TlsConfigurationError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'TlsConfigurationError';
        this.code = options.code || 'TLS_CONFIG_INVALID';
        this.field = options.field;
    }
}

function strictBoolean(value, field, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new TlsConfigurationError(`${field} must be exactly true or false`, { field });
}

function isLoopbackHostname(hostname) {
    const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
    return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(value);
}

function readCaFile(file, { fileSystem = fs, field = 'CA_FILE' } = {}) {
    if (!file) return undefined;
    if (typeof file !== 'string' || file.length > 4096 || /[\u0000-\u001f\u007f]/u.test(file)) {
        throw new TlsConfigurationError(`${field} is invalid`, { field });
    }
    let stat;
    try { stat = fileSystem.statSync(file); }
    catch { throw new TlsConfigurationError(`${field} cannot be read`, { field }); }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CA_BYTES) {
        throw new TlsConfigurationError(`${field} must be a non-empty regular file no larger than ${MAX_CA_BYTES} bytes`, { field });
    }
    try { return fileSystem.readFileSync(file); }
    catch { throw new TlsConfigurationError(`${field} cannot be read`, { field }); }
}

function resolveTlsPolicy({
    url,
    verify,
    insecure,
    caFile,
    allowInsecureHttp = false,
    fields = {},
    fileSystem = fs
} = {}) {
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new TlsConfigurationError('endpoint URL is invalid', { field: fields.url }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash) {
        throw new TlsConfigurationError('endpoint URL must be HTTP(S) without credentials, query, or fragment', { field: fields.url });
    }
    const verifyProvided = verify !== undefined && verify !== null && verify !== '';
    const tlsVerify = strictBoolean(verify, fields.verify || 'TLS_VERIFY', true);
    const tlsInsecure = strictBoolean(insecure, fields.insecure || 'TLS_INSECURE', false);
    const allowHttp = strictBoolean(allowInsecureHttp, fields.allowHttp || 'ALLOW_INSECURE_HTTP', false);
    if (tlsVerify === false && tlsInsecure !== true) {
        throw new TlsConfigurationError(`${fields.verify || 'TLS_VERIFY'}=false requires explicit ${fields.insecure || 'TLS_INSECURE'}=true`, { field: fields.verify });
    }
    if (verifyProvided && tlsVerify === true && tlsInsecure === true) {
        throw new TlsConfigurationError(`${fields.verify || 'TLS_VERIFY'}=true conflicts with explicit insecure mode`, { field: fields.insecure });
    }
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname) && !allowHttp) {
        throw new TlsConfigurationError(`non-loopback HTTP requires explicit ${fields.allowHttp || 'ALLOW_INSECURE_HTTP'}=true`, { field: fields.allowHttp });
    }
    const ca = parsed.protocol === 'https:' && tlsInsecure === false
        ? readCaFile(caFile, { fileSystem, field: fields.ca || 'CA_FILE' })
        : undefined;
    const mode = parsed.protocol === 'http:'
        ? (isLoopbackHostname(parsed.hostname) ? 'loopback-http' : 'explicit-insecure-http')
        : tlsInsecure ? 'explicitly-insecure' : ca ? 'private-ca' : 'verified';
    return {
        url: parsed.toString().replace(/\/$/u, ''),
        protocol: parsed.protocol,
        verify: parsed.protocol !== 'https:' || (tlsVerify === true && tlsInsecure === false),
        insecure: parsed.protocol === 'https:' && tlsInsecure === true,
        allowInsecureHttp: allowHttp,
        ca,
        mode,
        warning: mode === 'explicitly-insecure' || mode === 'explicit-insecure-http'
    };
}

function createHttpsAgent(policy) {
    if (!policy || policy.protocol !== 'https:') return null;
    return new https.Agent({
        keepAlive: true,
        maxSockets: 16,
        maxFreeSockets: 4,
        rejectUnauthorized: policy.verify,
        ...(policy.ca ? { ca: policy.ca } : {})
    });
}

function destroyAgent(agent) {
    try { agent?.destroy(); } catch { }
}

module.exports = {
    MAX_CA_BYTES,
    TlsConfigurationError,
    createHttpsAgent,
    destroyAgent,
    isLoopbackHostname,
    readCaFile,
    resolveTlsPolicy,
    strictBoolean
};

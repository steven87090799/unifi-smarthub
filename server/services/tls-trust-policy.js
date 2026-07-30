'use strict';

const fs = require('node:fs');
const https = require('node:https');

const MAX_CA_BYTES = 1024 * 1024;

function exactBoolean(value, field, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new TypeError(`${field} must be true or false`);
}

function readPrivateCa(value, field, fileSystem = fs) {
    if (!value) return undefined;
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${field} must be an absolute CA file path`);
    }
    const stat = fileSystem.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CA_BYTES) {
        throw new TypeError(`${field} must be a regular CA file at most ${MAX_CA_BYTES} bytes`);
    }
    return fileSystem.readFileSync(value);
}

function createTlsAgent(environment, prefix, { fileSystem = fs, httpsModule = https } = {}) {
    const env = environment || {};
    const insecure = exactBoolean(env[`${prefix}_TLS_INSECURE`], `${prefix}_TLS_INSECURE`, false);
    const ca = readPrivateCa(env[`${prefix}_CA_FILE`], `${prefix}_CA_FILE`, fileSystem);
    return {
        insecure,
        verified: !insecure,
        agent: new httpsModule.Agent({ rejectUnauthorized: !insecure, ...(ca ? { ca } : {}) })
    };
}

module.exports = { MAX_CA_BYTES, createTlsAgent, exactBoolean, readPrivateCa };

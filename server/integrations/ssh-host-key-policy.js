'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { isTrustedLanEndpoint } = require('./trusted-lan-policy');

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/u;

function normalizeFingerprint(value, field = 'SSH_HOST_KEY') {
    if (typeof value !== 'string' || !FINGERPRINT.test(value.trim())) {
        throw new Error(`${field} must be a SHA256 SSH host fingerprint`);
    }
    return value.trim().replace(/=+$/u, '');
}

function fingerprintFromKey(key) {
    const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '');
    return `SHA256:${digest}`;
}

function hostVerifier(expected) {
    const normalized = normalizeFingerprint(expected);
    const expectedBytes = Buffer.from(normalized, 'utf8');
    return key => {
        const actualBytes = Buffer.from(fingerprintFromKey(key), 'utf8');
        return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
    };
}

function resolveHostKeyPolicy({
    fingerprint,
    allowUnpinned = false,
    field = 'SSH_HOST_KEY',
    host,
    trustedLanMode = false,
    trustedLanHosts
} = {}) {
    if (![undefined, true, false, 'true', 'false'].includes(allowUnpinned)) {
        throw new Error(`${field.replace(/HOST_KEY$/u, 'ALLOW_UNPINNED')} must be exactly true or false`);
    }
    const requestedAllow = allowUnpinned === true || allowUnpinned === 'true';
    const trustedTarget = trustedLanMode === true || trustedLanMode === 'true'
        ? isTrustedLanEndpoint(host, { enabled: true, trustedHosts: trustedLanHosts })
        : false;
    // In Trusted LAN mode an unpinned key is a compatibility fallback only
    // for a classified private target. A configured fingerprint always wins.
    if (requestedAllow && trustedLanMode && !trustedTarget) {
        return { configured: false, fingerprint: null, verifier: null, insecure: false, error: 'trusted_lan_target_required' };
    }
    const allow = requestedAllow || trustedTarget;
    if (fingerprint) return { configured: true, fingerprint: normalizeFingerprint(fingerprint, field), verifier: hostVerifier(fingerprint), insecure: false };
    if (allow) return { configured: false, fingerprint: null, verifier: () => true, insecure: true, warning: true };
    return { configured: false, fingerprint: null, verifier: null, insecure: false, error: 'host_key_not_configured' };
}

module.exports = { FINGERPRINT, fingerprintFromKey, hostVerifier, normalizeFingerprint, resolveHostKeyPolicy };

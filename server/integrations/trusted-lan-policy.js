'use strict';

const net = require('node:net');
const { resolveTlsPolicy } = require('./tls-policy');

const TRUSTED_LAN_INTEGRATIONS = Object.freeze([
    'unifi_controller',
    'unifi_network',
    'nas',
    'ppb',
    'adguard',
    'wiim',
    'nas_monitor'
]);

const IPV4_RANGES = Object.freeze([
    ['127.0.0.0', 8],
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['169.254.0.0', 16]
]);

const IPV6_RANGES = Object.freeze([
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10]
]);

class TrustedLanConfigurationError extends Error {
    constructor(message, field = 'TRUSTED_LAN_MODE') {
        super(message);
        this.name = 'TrustedLanConfigurationError';
        this.code = 'TRUSTED_LAN_CONFIG_INVALID';
        this.field = field;
    }
}

function strictBoolean(value, field = 'TRUSTED_LAN_MODE', fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new TrustedLanConfigurationError(`${field} must be exactly true or false`, field);
}

function stripBrackets(value) {
    return String(value || '').trim().replace(/^\[|\]$/gu, '').toLowerCase();
}

function ipv4ToInteger(value) {
    const candidate = stripBrackets(value);
    if (net.isIP(candidate) !== 4) return null;
    const parts = candidate.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0;
}

function ipv6ToBigInt(value) {
    const candidate = stripBrackets(value);
    if (net.isIP(candidate) !== 6 || candidate.includes('%')) return null;
    const halves = candidate.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
    const parts = [...left, ...Array(missing).fill('0'), ...right];
    if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
    return parts.reduce((result, part) => (result << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function inIpv4Range(value, start, prefixBits) {
    const base = ipv4ToInteger(start);
    if (value === null || base === null) return false;
    const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
    return (value & mask) === (base & mask);
}

function inIpv6Range(value, start, prefixBits) {
    const base = ipv6ToBigInt(start);
    if (value === null || base === null) return false;
    const shift = 128n - BigInt(prefixBits);
    return (value >> shift) === (base >> shift);
}

function mappedIpv4(value) {
    const numeric = ipv6ToBigInt(value);
    if (numeric === null) return null;
    const prefix = numeric >> 32n;
    // Only IPv4-mapped IPv6 (::ffff/96) is equivalent to an IPv4 target.
    // Treating every IPv4-compatible ::/96 address as IPv4 would misclassify
    // ::1 as the public IPv4 address 0.0.0.1 and skip the IPv6 allowlist.
    if (prefix !== 0xffffn) return null;
    return Number(numeric & 0xffffffffn) >>> 0;
}

function isTrustedPrivateIp(value) {
    const candidate = stripBrackets(value);
    const ipv4 = ipv4ToInteger(candidate);
    if (ipv4 !== null) return IPV4_RANGES.some(([start, bits]) => inIpv4Range(ipv4, start, bits));

    const mapped = mappedIpv4(candidate);
    if (mapped !== null) return IPV4_RANGES.some(([start, bits]) => inIpv4Range(mapped, start, bits));

    const ipv6 = ipv6ToBigInt(candidate);
    return ipv6 !== null && IPV6_RANGES.some(([start, bits]) => inIpv6Range(ipv6, start, bits));
}

function normalizeHostname(value, field = 'TRUSTED_LAN_HOSTS') {
    const candidate = stripBrackets(value).replace(/\.$/u, '');
    if (!candidate || candidate.length > 253 || /[\u0000-\u0020\u007f]/u.test(candidate)
        || candidate.includes('*') || net.isIP(candidate) !== 0
        || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(candidate)) {
        throw new TrustedLanConfigurationError(`${field} must contain exact hostnames without wildcard or whitespace`, field);
    }
    return candidate;
}

function parseTrustedLanHosts(value) {
    if (value === undefined || value === null || String(value).trim() === '') return [];
    if (typeof value !== 'string') throw new TrustedLanConfigurationError('TRUSTED_LAN_HOSTS must be a comma-separated hostname allowlist', 'TRUSTED_LAN_HOSTS');
    const entries = value.split(',').map(item => item.trim()).filter(Boolean);
    if (entries.length > 256) throw new TrustedLanConfigurationError('TRUSTED_LAN_HOSTS supports at most 256 hostnames', 'TRUSTED_LAN_HOSTS');
    return [...new Set(entries.map(entry => normalizeHostname(entry)))];
}

function endpointHostname(endpoint) {
    if (endpoint instanceof URL) return stripBrackets(endpoint.hostname);
    const raw = String(endpoint ?? '').trim();
    if (!raw) return '';
    const direct = stripBrackets(raw);
    if (net.isIP(direct) !== 0 || direct === 'localhost' || direct === 'host.docker.internal') return direct;
    try {
        const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
        return stripBrackets(parsed.hostname);
    } catch {
        return direct;
    }
}

function resolveTrustedLanTarget({ endpoint, enabled = false, trustedHosts } = {}) {
    // Trusted LAN can retain legacy private-device compatibility, but it must
    // never be implicit when a caller omits the master switch.
    const trustedLanMode = strictBoolean(enabled, 'TRUSTED_LAN_MODE', false);
    const hostname = endpointHostname(endpoint);
    if (!trustedLanMode || !hostname) {
        return Object.freeze({ enabled: trustedLanMode, trusted: false, hostname, source: null });
    }
    if (isTrustedPrivateIp(hostname)) {
        return Object.freeze({ enabled: true, trusted: true, hostname, source: 'private-ip' });
    }
    if (hostname === 'localhost' || hostname === 'host.docker.internal') {
        return Object.freeze({ enabled: true, trusted: true, hostname, source: 'special-hostname' });
    }
    const allowlist = parseTrustedLanHosts(trustedHosts);
    let normalizedHost = null;
    try { normalizedHost = normalizeHostname(hostname); } catch { normalizedHost = null; }
    if (normalizedHost && allowlist.includes(normalizedHost)) {
        return Object.freeze({ enabled: true, trusted: true, hostname, source: 'hostname-allowlist' });
    }
    return Object.freeze({ enabled: true, trusted: false, hostname, source: null });
}

function isTrustedLanEndpoint(endpoint, options = {}) {
    return resolveTrustedLanTarget({ endpoint, ...options }).trusted;
}

function valueProvided(value) {
    return value !== undefined && value !== null && value !== '';
}

function isSafeTransportDefault(value, expected) {
    return !valueProvided(value) || value === expected || value === String(expected);
}

function effectiveValue(env, field, fallback) {
    if (!field) return fallback;
    return env?.[field] === undefined ? fallback : env[field];
}

function resolveTrustedLanTransportInputs({
    url,
    integration,
    env = process.env,
    fields = {},
    implicitInsecureWhenVerifyFalse = false
} = {}) {
    if (!TRUSTED_LAN_INTEGRATIONS.includes(integration)) {
        throw new TrustedLanConfigurationError(`Unsupported Trusted LAN integration: ${integration}`, 'integration');
    }
    const target = resolveTrustedLanTarget({
        endpoint: url,
        enabled: effectiveValue(env, 'TRUSTED_LAN_MODE', false),
        trustedHosts: effectiveValue(env, 'TRUSTED_LAN_HOSTS', '')
    });
    let verify = effectiveValue(env, fields.verify);
    let insecure = effectiveValue(env, fields.insecure);
    let allowInsecureHttp = effectiveValue(env, fields.allowHttp);
    const caFile = effectiveValue(env, fields.ca, '');
    const hasCa = valueProvided(caFile);
    const insecureWasProvided = valueProvided(insecure);
    let trustedLanApplied = false;

    // The example/config baseline is deliberately safe (verify=true,
    // insecure=false, HTTP=false). Trusted LAN is the compatibility master
    // switch, so that baseline must still become an effective LAN transport;
    // only an actual insecure opt-in or a configured CA takes precedence.
    const safeTransportDefaults = isSafeTransportDefault(verify, true)
        && isSafeTransportDefault(insecure, false)
        && isSafeTransportDefault(allowInsecureHttp, false);
    if (target.trusted && !hasCa && safeTransportDefaults) {
        verify = 'false';
        insecure = 'true';
        allowInsecureHttp = 'true';
        trustedLanApplied = true;
    }
    if (implicitInsecureWhenVerifyFalse && verify === 'false' && !insecureWasProvided) insecure = 'true';

    return Object.freeze({
        verify,
        insecure,
        caFile,
        allowInsecureHttp,
        trustedLan: target.trusted,
        trustedLanApplied,
        trustedLanTarget: target
    });
}

function resolveIntegrationTlsPolicy(options = {}) {
    const inputs = resolveTrustedLanTransportInputs(options);
    const policy = resolveTlsPolicy({
        url: options.url,
        verify: inputs.verify,
        insecure: inputs.insecure,
        caFile: inputs.caFile,
        allowInsecureHttp: inputs.allowInsecureHttp,
        fields: options.fields,
        fileSystem: options.fileSystem
    });
    const mode = inputs.trustedLanApplied
        ? 'trusted-lan-insecure'
        : policy.mode;
    return Object.freeze({
        ...policy,
        mode,
        trustedLan: inputs.trustedLan,
        trustedLanApplied: inputs.trustedLanApplied,
        trustedLanTarget: inputs.trustedLanTarget
    });
}

module.exports = {
    IPV4_RANGES,
    IPV6_RANGES,
    TRUSTED_LAN_INTEGRATIONS,
    TrustedLanConfigurationError,
    effectiveValue,
    isTrustedLanEndpoint,
    isTrustedPrivateIp,
    normalizeHostname,
    parseTrustedLanHosts,
    resolveIntegrationTlsPolicy,
    resolveTrustedLanTarget,
    resolveTrustedLanTransportInputs,
    strictBoolean
};

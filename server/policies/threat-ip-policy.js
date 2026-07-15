'use strict';

const net = require('node:net');
const {
    InputValidationError,
    exactObject,
    numberValue,
    stringValue
} = require('./write-input-policy');

const BLOCK_CONFIRMATION = 'BLOCK_EXTERNAL_IP';
const REMOVE_CONFIRMATION = 'REMOVE_EXTERNAL_IP_BLOCK';
const MIN_EXPIRY_MINUTES = 15;
const MAX_EXPIRY_MINUTES = 30 * 24 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function ipv4Number(ip) {
    return ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inCidr(value, base, bits) {
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4Number(base) & mask);
}

// Public source blocks deliberately reject every IANA special-purpose range
// that may identify this host, its gateways, private clients, documentation,
// benchmarking, multicast, broadcast, or future-reserved space.
const DISALLOWED_IPV4_RANGES = Object.freeze([
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
]);

function canonicalPublicIpv4(value, { protectedAddresses = [] } = {}) {
    const ip = stringValue(value, { field: 'ip', min: 7, max: 45 });
    const family = net.isIP(ip);
    if (family === 6) {
        throw new InputValidationError('IPv6 threat blocking is not supported by this IPv4 list', { field: 'ip' });
    }
    if (family !== 4) {
        throw new InputValidationError('ip must be a canonical IPv4 address', { field: 'ip' });
    }
    const numeric = ipv4Number(ip);
    if (DISALLOWED_IPV4_RANGES.some(([base, bits]) => inCidr(numeric, base, bits))) {
        throw new InputValidationError('ip must be a public unicast IPv4 address', { field: 'ip' });
    }
    const protectedSet = new Set(protectedAddresses.filter(address => net.isIP(address) === 4));
    if (protectedSet.has(ip)) {
        throw new InputValidationError('ip is a protected management address', { field: 'ip' });
    }
    return ip;
}

function parseCreateThreatIpBlock(body, options = {}) {
    exactObject(body, {
        allowed: ['ip', 'expiresInMinutes', 'confirmation'],
        required: ['ip', 'expiresInMinutes', 'confirmation']
    });
    const confirmation = stringValue(body.confirmation, {
        field: 'confirmation', min: BLOCK_CONFIRMATION.length, max: BLOCK_CONFIRMATION.length
    });
    if (confirmation !== BLOCK_CONFIRMATION) {
        throw new InputValidationError(`confirmation must equal ${BLOCK_CONFIRMATION}`, { field: 'confirmation' });
    }
    return {
        ip: canonicalPublicIpv4(body.ip, options),
        expiresInMinutes: numberValue(body.expiresInMinutes, {
            field: 'expiresInMinutes', integer: true,
            min: MIN_EXPIRY_MINUTES, max: MAX_EXPIRY_MINUTES
        })
    };
}

function parseRemoveThreatIpBlock(id, body) {
    const blockId = stringValue(id, { field: 'id', min: 36, max: 36 });
    if (!UUID.test(blockId)) {
        throw new InputValidationError('id must be a UUID', { field: 'id' });
    }
    exactObject(body, { allowed: ['confirmation'], required: ['confirmation'] });
    const confirmation = stringValue(body.confirmation, {
        field: 'confirmation', min: REMOVE_CONFIRMATION.length, max: REMOVE_CONFIRMATION.length
    });
    if (confirmation !== REMOVE_CONFIRMATION) {
        throw new InputValidationError(`confirmation must equal ${REMOVE_CONFIRMATION}`, { field: 'confirmation' });
    }
    return { id: blockId };
}

module.exports = {
    BLOCK_CONFIRMATION,
    DISALLOWED_IPV4_RANGES,
    MAX_EXPIRY_MINUTES,
    MIN_EXPIRY_MINUTES,
    REMOVE_CONFIRMATION,
    canonicalPublicIpv4,
    parseCreateThreatIpBlock,
    parseRemoveThreatIpBlock
};

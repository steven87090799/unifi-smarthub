'use strict';

const net = require('node:net');

function normalizeWiimIp(value) {
    const candidate = String(value ?? '').trim().replace(/^\[|\]$/gu, '');
    if (!candidate || net.isIP(candidate) === 0) return null;
    return candidate;
}

function formatWiimHost(value) {
    const address = normalizeWiimIp(value);
    if (!address) return null;
    return net.isIP(address) === 6 ? `[${address}]` : address;
}

module.exports = { formatWiimHost, normalizeWiimIp };

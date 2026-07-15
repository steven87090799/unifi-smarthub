'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { InputValidationError } = require('../server/policies/write-input-policy');
const {
    BLOCK_CONFIRMATION,
    REMOVE_CONFIRMATION,
    canonicalPublicIpv4,
    parseCreateThreatIpBlock,
    parseRemoveThreatIpBlock
} = require('../server/policies/threat-ip-policy');

function invalid(fn, field = null) {
    assert.throws(fn, error => error instanceof InputValidationError && (!field || error.field === field));
}

test('threat block policy accepts only public canonical IPv4 with bounded mandatory expiry and confirmation', () => {
    assert.deepEqual(parseCreateThreatIpBlock({
        ip: '8.8.8.8',
        expiresInMinutes: 15,
        confirmation: BLOCK_CONFIRMATION
    }), { ip: '8.8.8.8', expiresInMinutes: 15 });
    assert.equal(canonicalPublicIpv4('1.1.1.1'), '1.1.1.1');

    for (const ip of [
        '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
        '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
        '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255'
    ]) invalid(() => canonicalPublicIpv4(ip), 'ip');
    invalid(() => canonicalPublicIpv4('2001:4860:4860::8888'), 'ip');
    invalid(() => canonicalPublicIpv4('008.008.008.008'), 'ip');
    invalid(() => canonicalPublicIpv4('8.8.8.8', { protectedAddresses: ['8.8.8.8'] }), 'ip');

    for (const expiresInMinutes of [14, 43201, 15.5, '15', null]) {
        invalid(() => parseCreateThreatIpBlock({
            ip: '8.8.8.8', expiresInMinutes, confirmation: BLOCK_CONFIRMATION
        }), 'expiresInMinutes');
    }
    invalid(() => parseCreateThreatIpBlock({
        ip: '8.8.8.8', expiresInMinutes: 15, confirmation: 'yes'
    }), 'confirmation');
    invalid(() => parseCreateThreatIpBlock({
        ip: '8.8.8.8', expiresInMinutes: 15, confirmation: BLOCK_CONFIRMATION, surprise: true
    }), 'surprise');
});

test('threat block removal requires a UUID and its distinct confirmation contract', () => {
    const id = randomUUID();
    assert.deepEqual(parseRemoveThreatIpBlock(id, { confirmation: REMOVE_CONFIRMATION }), { id });
    invalid(() => parseRemoveThreatIpBlock('not-an-id', { confirmation: REMOVE_CONFIRMATION }), 'id');
    invalid(() => parseRemoveThreatIpBlock(id, { confirmation: BLOCK_CONFIRMATION }), 'confirmation');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWiimHost, normalizeWiimIp } = require('../server/services/wiim-config');

test('WiiM configuration is empty-disabled and accepts only literal IPv4/IPv6 addresses', () => {
    assert.equal(normalizeWiimIp(''), null);
    assert.equal(normalizeWiimIp('   '), null);
    assert.equal(normalizeWiimIp('wiim.local'), null);
    assert.equal(normalizeWiimIp('192.168.0.170'), '192.168.0.170');
    assert.equal(normalizeWiimIp('[fd00::170]'), 'fd00::170');
    assert.equal(formatWiimHost('fd00::170'), '[fd00::170]');
});

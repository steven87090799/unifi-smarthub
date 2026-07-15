'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InputValidationError, parseWifiQrRequest } = require('../server/policies/write-input-policy');
const { escapeWifiQrField, renderWifiQrSvg, wifiQrPayload } = require('../server/services/wifi-qr');

test('WiFi QR validation enforces SSID bytes and canonical WPA credentials', () => {
    assert.deepEqual(parseWifiQrRequest({ ssid: 'Guest;Net', password: 'safe passphrase' }), {
        ssid: 'Guest;Net', password: 'safe passphrase'
    });
    for (const value of [
        { ssid: '', password: 'safe passphrase' },
        { ssid: '你'.repeat(11), password: 'safe passphrase' },
        { ssid: 'Guest', password: 'short' },
        { ssid: 'Guest', password: 'x'.repeat(64) },
        { ssid: 'Guest', password: 'safe passphrase', extra: true }
    ]) assert.throws(() => parseWifiQrRequest(value), InputValidationError);
});

test('WiFi QR payload escapes delimiters and SVG contains no plaintext credential metadata', async () => {
    assert.equal(escapeWifiQrField('a;b,c:d\\e"f'), 'a\\;b\\,c\\:d\\\\e\\"f');
    assert.equal(escapeWifiQrField("Guest's WiFi"), "Guest's WiFi");
    const input = { ssid: 'Guest;Net', password: 'correct horse battery' };
    assert.equal(wifiQrPayload(input), 'WIFI:T:WPA;S:Guest\\;Net;P:correct horse battery;H:false;;');
    const svg = await renderWifiQrSvg(input);
    assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    assert.doesNotMatch(svg, /Guest|correct horse battery/u);
});

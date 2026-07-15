'use strict';

const QRCode = require('qrcode');

function escapeWifiQrField(value) {
    return String(value).replace(/[\\;,:"]/gu, character => `\\${character}`);
}

function wifiQrPayload({ ssid, password }) {
    return `WIFI:T:WPA;S:${escapeWifiQrField(ssid)};P:${escapeWifiQrField(password)};H:false;;`;
}

async function renderWifiQrSvg(input) {
    return QRCode.toString(wifiQrPayload(input), {
        type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 240
    });
}

module.exports = { escapeWifiQrField, renderWifiQrSvg, wifiQrPayload };

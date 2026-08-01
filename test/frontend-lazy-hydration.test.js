'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('initial boot is essentials-only and page hydration is once-per-page with retry state', () => {
    assert.match(source, /const PAGE_HYDRATION = \{/u);
    assert.match(source, /const loadedPages = new Set\(\)/u);
    assert.match(source, /const hydrationInFlight = new Map\(\)/u);
    assert.match(source, /function hydratePage\(page, \{ force = false \} = \{\}\)/u);
    const loadBlock = source.slice(source.indexOf("window.addEventListener('load'"), source.indexOf('/* ==================== 前端輪詢管理'));
    assert.doesNotMatch(loadBlock, /fetchConnections\(\)|fetchNasAdvanced\(\)|fetchWiFiNetworks\(\)|fetchLinux\(\)|fetchAdguard\(\)|fetchWiimDeviceInfo\(\)/u);
    assert.match(loadBlock, /fetchAppSettings\(\)/u);
    assert.match(loadBlock, /hydratePage\('overview'\)/u);
});

test('NAS SSE is page-scoped and pinned mirrors are change-driven', () => {
    assert.match(source, /nasAlertConfig: \{ fn: async \(\) =>/u);
    assert.match(source, /if \(page !== 'nas'\) disconnectNasSse\(\)/u);
    assert.match(source, /new MutationObserver\(\(\) => updatePinnedMirror\(holder\)\)/u);
    assert.doesNotMatch(source, /setInterval\(syncPinned/u);
    assert.doesNotMatch(source, /mirror\.innerHTML\s*=/u);
});

test('NAS alert rows use text nodes and delegated safe data attributes', () => {
    const block = source.slice(source.indexOf('async function fetchAlertConfig'), source.indexOf('async function saveAlertConfig'));
    assert.match(block, /metric\.textContent\s*=/u);
    assert.match(block, /remove\.dataset\.action\s*=\s*'nas-alert-delete'/u);
    assert.match(block, /list\.replaceChildren\(\)/u);
    assert.doesNotMatch(block, /innerHTML/u);
    assert.doesNotMatch(block, /onclick\s*=/iu);
});

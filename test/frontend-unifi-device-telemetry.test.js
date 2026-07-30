'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mock = fs.readFileSync(path.join(ROOT, 'server-mock.js'), 'utf8');

test('telemetry UI is external-script driven, scope-aware, and renders truth and freshness semantics', () => {
    assert.match(html, /id="unifi-telemetry-devices"/u);
    assert.match(html, /id="unifi-telemetry-state"/u);
    assert.match(html, /id="unifi-telemetry-last-success"/u);
    assert.match(app, /fetch\('\/api\/network\/devices\/telemetry'\)/u);
    assert.match(app, /fetch\('\/api\/network\/devices\/telemetry\/history\?hours=24&limit=200'/u);
    assert.match(app, /let unifiTelemetryHistoryLoaded = false/u);
    assert.doesNotMatch(app, /Promise\.all\(\[\s*fetch\('\/api\/network\/devices\/telemetry'[,\s\S]*telemetry\/history/u);
    assert.match(app, /unifi-device-telemetry/u);
    assert.match(app, /unsupported: '不支援'/u);
    assert.match(app, /STALE · 保留最後成功資料/u);
    assert.doesNotMatch(html, /<script(?!\s+src=)[^>]*>/iu);
    assert.doesNotMatch(html, /\son(?:click|change|input)\s*=/iu);
});

test('remote telemetry strings are escaped before dynamic HTML and readonly cannot expose or submit SSH settings', () => {
    assert.match(app, /escapeHtml\(device\?\.name/u);
    assert.match(app, /escapeHtml\(device\?\.model/u);
    assert.match(app, /escapeHtml\(row\.name \|\| row\.deviceId\)/u);
    assert.match(app, /telemetrySettings\.classList\.toggle\('hidden', security\.role !== 'admin'\)/u);
    assert.match(app, /dataset\.panelRole !== 'admin'\) return showToast\('僅管理員可變更連線設定'/u);
});

test('production and mock expose the same read-only telemetry API while production routes read retained state', () => {
    for (const source of [server, mock]) {
        assert.match(source, /app\.get\('\/api\/network\/devices\/telemetry'/u);
        assert.match(source, /app\.get\('\/api\/network\/devices\/telemetry\/history'/u);
    }
    assert.match(server, /app\.get\('\/api\/network\/devices\/telemetry',[\s\S]{0,200}unifiDeviceTelemetrySnapshot\.read\(\)/u);
    assert.match(server, /historyDb\.listUnifiTelemetrySince\(cutoff, \{ limit: query\.limit, before: query\.before \}\)/u);
    assert.match(server, /name: 'unifiDeviceTelemetry'[\s\S]{0,240}collect: sampleUnifiDeviceTelemetry/u);
});

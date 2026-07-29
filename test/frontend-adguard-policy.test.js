'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const source = `${html}\n${app}`;

test('AdGuard policy UI exposes explicit identity, categories, timezone, and per-day allow windows', () => {
    for (const token of [
        'id="adg-policy-card"',
        'id="adg-policy-device"',
        'id="adg-policy-timezone"',
        'value="youtube"',
        'value="tiktok"',
        'value="gaming"',
        'data-day="mon"',
        'data-day="sun"',
        '允許時段',
        '未勾選＝全天封鎖'
    ]) assert.ok(source.includes(token), `missing ${token}`);
});

test('policy mutations are admin-gated and use the exact production API and removal confirmation', () => {
    assert.match(source, /dataset\.panelRole !== 'admin'[\s\S]*僅管理員可變更 AdGuard 政策/u);
    assert.match(source, /fetch\('\/api\/adguard\/service-policies'/u);
    assert.match(source, /method: 'POST'[\s\S]*JSON\.stringify\(body\)/u);
    assert.match(source, /method: 'DELETE'[\s\S]*REMOVE_ADGUARD_SERVICE_POLICY/u);
    assert.match(source, /encodeURIComponent\(id\)/u);
});

test('remote policy fields are escaped before rendering and readonly users receive no policy card', () => {
    for (const expression of [
        'escapeHtml(policy.deviceId)',
        'escapeHtml(policy.timeZone)',
        'escapeHtml(policy.lastError)',
        "card.classList.add('hidden')"
    ]) assert.ok(source.includes(expression), `missing ${expression}`);
});

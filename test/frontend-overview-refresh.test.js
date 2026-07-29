'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const source = `${html}\n${app}`;

test('overview uses backend-provided visible-tab polling and all displayed backend scopes', () => {
    assert.match(source, /overview:\s*\['trend', 'ucg', 'nas', 'wiim', 'ups'\]/);
    assert.match(source, /deviceActiveFrontendPollSec/);
    assert.match(source, /document\.visibilityState !== 'visible'/);
    assert.doesNotMatch(source, /FOCUSED_POLL_SEC/);
    assert.doesNotMatch(source, /FOCUSED_DEVICE_PAGES/);
});

test('UPS live polling is real-time while heavy history and PPB event reads stay bounded', () => {
    assert.match(app, /ups:\s*\{ fn: \(\) => fetchUps\(\{ includeHistory: false \}\) \}/);
    assert.match(app, /upsHistory:\s*\{ fn: \(\) => fetchUps\(\) \}/);
    assert.match(app, /ppbEvents:\s*\{ fn: \(\) => fetchPpbEvents\(\) \}/);
    assert.match(app, /ups:\s*\['ups', 'upsHistory', 'ppbEvents'\]/);
    assert.match(app, /upsFrontendPollSec/);
    assert.match(app, /upsHistoryFrontendPollSec/);
});

test('overview flip animation is installed without the refresh badge', () => {
    assert.match(app, /function initOverviewFlipNumbers\(\)/);
    assert.match(html, /@keyframes metricFlipUp/);
    assert.doesNotMatch(html, /focused-refresh-badge|LIVE · 3 秒更新/);
});

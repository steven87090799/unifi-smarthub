'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('overview uses backend-provided visible-tab polling and all displayed backend scopes', () => {
    assert.match(html, /overview:\s*\['trend', 'ucg', 'nas', 'wiim', 'ups'\]/);
    assert.match(html, /deviceActiveFrontendPollSec/);
    assert.match(html, /document\.visibilityState !== 'visible'/);
    assert.doesNotMatch(html, /FOCUSED_POLL_SEC/);
    assert.doesNotMatch(html, /FOCUSED_DEVICE_PAGES/);
});

test('UPS live polling is real-time while heavy history and PPB event reads stay bounded', () => {
    assert.match(html, /ups:\s*\{ fn: \(\) => fetchUps\(\{ includeHistory: false \}\) \}/);
    assert.match(html, /upsHistory:\s*\{ fn: \(\) => fetchUps\(\) \}/);
    assert.match(html, /ppbEvents:\s*\{ fn: \(\) => fetchPpbEvents\(\) \}/);
    assert.match(html, /ups:\s*\['ups', 'upsHistory', 'ppbEvents'\]/);
    assert.match(html, /upsFrontendPollSec/);
    assert.match(html, /upsHistoryFrontendPollSec/);
});

test('overview flip animation is installed without the refresh badge', () => {
    assert.match(html, /function initOverviewFlipNumbers\(\)/);
    assert.match(html, /@keyframes metricFlipUp/);
    assert.doesNotMatch(html, /focused-refresh-badge|LIVE · 3 秒更新/);
});

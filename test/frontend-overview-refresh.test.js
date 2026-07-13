'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('overview uses three-second focused polling and all displayed backend scopes', () => {
    assert.match(html, /overview:\s*\['trend', 'ucg', 'nas', 'wiim'\]/);
    assert.match(html, /FOCUSED_DEVICE_PAGES = new Set\(\['overview', 'ucg', 'nas', 'wiim', 'ups', 'adguard', 'linuxhost'\]\)/);
    assert.match(html, /const FOCUSED_POLL_SEC = 3;/);
});

test('overview flip animation is installed without the refresh badge', () => {
    assert.match(html, /function initOverviewFlipNumbers\(\)/);
    assert.match(html, /@keyframes metricFlipUp/);
    assert.doesNotMatch(html, /focused-refresh-badge|LIVE · 3 秒更新/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('WiiM playback timestamps are normalized before local progress ticking', () => {
    assert.match(html, /function normalizeWiimPlayer\(raw\)/);
    assert.match(html, /curpos: toNonNegativeNumber\(raw\.curpos\)/);
    assert.match(html, /totlen: toNonNegativeNumber\(raw\.totlen\)/);
    assert.match(html, /const dev = normalizeWiimPlayer\(data\.player\);/);
});

test('WiiM local progress adds milliseconds numerically instead of concatenating API strings', () => {
    assert.match(html, /const currentMs = Number\(wiimPlayerState\?\.curpos\);/);
    assert.match(html, /const totalMs = Number\(wiimPlayerState\?\.totlen\);/);
    assert.match(html, /Math\.min\(totalMs, currentMs \+ 1000\)/);
    assert.doesNotMatch(html, /wiimPlayerState\.curpos \+ 1000/);
});

test('WiiM stale status is visibly non-live and cannot advance local progress or seek', () => {
    assert.match(html, /wiimPlaybackStale = data\.stale === true \|\| data\.source === 'stale_cache'/u);
    assert.match(html, /wiimPlaybackStale \|\| wiimSeekDragging/u);
    assert.match(html, /wiimPlaybackStale \? `⚠️ 最後已知：/u);
});

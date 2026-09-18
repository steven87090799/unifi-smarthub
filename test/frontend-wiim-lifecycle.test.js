'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressHarness } = require('./helpers/wiim-progress-harness');

test('WiiM progress timer stops on hidden or unrelated pages and ignores already queued callbacks', () => {
    const h = createProgressHarness();
    assert.equal(h.timers.size, 1);
    h.tick();
    assert.equal(h.updates(), 1);
    const queued = [...h.timers.values()][0];
    h.context.document.visibilityState = 'hidden';
    h.context.sync();
    assert.equal(h.timers.size, 0);
    queued();
    assert.equal(h.updates(), 1);
    h.context.document.visibilityState = 'visible';
    h.context.currentPage = 'settings';
    h.context.navigationGeneration += 1;
    h.context.sync();
    assert.equal(h.timers.size, 0);
});

test('100 repeated navigation/visibility/pagehide cycles retain at most one timer and no extra reads', () => {
    const h = createProgressHarness();
    const requests = h.requests();
    for (let cycle = 0; cycle < 100; cycle += 1) {
        h.context.currentPage = cycle % 2 ? 'overview' : 'wiim';
        h.context.navigationGeneration += 1;
        h.context.sync();
        h.context.sync();
        assert.equal(h.timers.size, 1);
        h.tick();
        h.context.stop();
        assert.equal(h.timers.size, 0);
        h.context.sync();
        assert.equal(h.timers.size, 1);
        h.context.document.visibilityState = 'hidden';
        h.context.sync();
        assert.equal(h.timers.size, 0);
        h.context.document.visibilityState = 'visible';
    }
    assert.equal(h.updates(), 100);
    assert.equal(h.requests(), requests);
});

test('timer ownership is wired into polling, pagehide and bfcache pageshow', () => {
    const { source } = createProgressHarness();
    assert.match(source, /function applyPolling\(runNow = false\) \{\s*syncWiimProgressTicker\(\)/);
    const hide = source.slice(source.indexOf("window.addEventListener('pagehide'"), source.indexOf("window.addEventListener('pageshow'"));
    assert.match(hide, /wiimProgressTicker\.disconnect\(\)/);
    const showStart = source.indexOf("window.addEventListener('pageshow'");
    const show = source.slice(showStart, source.indexOf("});", showStart));
    assert.match(show, /syncWiimProgressTicker\(\)/);
    assert.doesNotMatch(source, /setInterval\(tickWiimProg, 1000\)/);
});

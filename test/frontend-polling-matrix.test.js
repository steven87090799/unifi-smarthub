'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontendLifecycle = require('../public/js/frontend-lifecycle');

const source = fs.readFileSync(path.join(process.env.P2_AUDIT_SOURCE_ROOT || path.join(__dirname, '..'), 'public/js/app.js'), 'utf8');
const maps = source.slice(source.indexOf('const combineHydrationResults ='), source.indexOf('let wiimPageInitialized ='));
const polling = source.slice(source.indexOf('function getEffectivePollSec('), source.indexOf('const heartbeatSessionId ='));

function fixture() {
    let sequence = 0;
    let reads = 0;
    let hydrationPending = false;
    const timers = new Map();
    const starts = new Map();
    const context = {
        frontendLifecycle,
        frontendPollingSettings: { deviceActiveFrontendPollSec: 5, heartbeatSec: 10, upsFrontendPollSec: 3, upsHistoryFrontendPollSec: 30, upsPpbEventsFrontendPollSec: 60 },
        SAFE_FRONTEND_DEFAULTS: {},
        navigationGeneration: 1, currentPage: 'overview',
        document: { visibilityState: 'visible' },
        hydrationInFlight: { has: () => hydrationPending },
        setInterval(fn) { const id = ++sequence; timers.set(id, fn); return id; },
        clearInterval(id) { timers.delete(id); },
        setTimeout(fn) { const id = ++sequence; starts.set(id, fn); return id; },
        clearTimeout(id) { starts.delete(id); },
        dbg() {}, syncPinned() {}, syncWiimProgressTicker() {}, connectNasSse() {}, disconnectNasSse() {},
        sendHeartbeat: async () => { reads += 1; return { ok: true }; }
    };
    for (const [name] of maps.matchAll(/\bfetch[A-Za-z]+(?=\()/g)) {
        context[name] = async () => { reads += 1; return { ok: true }; };
    }
    vm.createContext(context);
    vm.runInContext(`let pollTimers = {}, pollStartTimers = {}; const pollRunning = new Set(); let pollingGeneration = 0;\n${maps}\n${polling}\nglobalThis.pages = Object.keys(PAGE_POLL_JOBS);\nglobalThis.expected = page => [...new Set([...COMMON_POLL_JOBS, ...PAGE_POLL_JOBS[page]])].sort();\nglobalThis.keys = () => Object.keys(pollTimers).sort();`, context);
    return { context, timers, starts, reads: () => reads, pending: value => { hydrationPending = value; } };
}

test('all fourteen actual page polling maps honor visibility, hydration and teardown', async t => {
    const h = fixture();
    assert.equal(h.context.pages.length, 14);
    for (const page of h.context.pages) {
        await t.test(page, () => {
            h.context.currentPage = page;
            h.context.document.visibilityState = 'visible';
            h.pending(false);
            h.context.applyPolling(true);
            assert.deepEqual([...h.context.keys()], [...h.context.expected(page)]);
            assert.equal(h.timers.size, h.context.expected(page).length);
            assert.equal(h.starts.size, h.timers.size);
            h.pending(true);
            h.context.applyPolling();
            assert.deepEqual([...h.context.keys()], ['critAlerts', 'heartbeat']);
            assert.equal(h.starts.size, 0);
            h.context.document.visibilityState = 'hidden';
            h.context.applyPolling();
            assert.equal(h.timers.size, 0);
            assert.equal(h.starts.size, 0);
        });
    }
});

test('already queued polling callbacks cannot start reads after hide, navigation or timer rebuild', async () => {
    const h = fixture();
    h.context.applyPolling(true);
    const queued = [...h.timers.values(), ...h.starts.values()];
    h.context.document.visibilityState = 'hidden';
    h.context.applyPolling();
    await Promise.all(queued.map(callback => callback()));
    assert.equal(h.reads(), 0, 'clearing a timer alone does not fence an already queued callback');
    h.context.document.visibilityState = 'visible';
    h.context.currentPage = 'settings';
    h.context.navigationGeneration += 1;
    h.context.applyPolling();
    await Promise.all(queued.map(callback => callback()));
    assert.equal(h.reads(), 0, 'old generation cannot poll again after becoming visible');
    const prior = [...h.timers.values()];
    h.context.applyPolling();
    await Promise.all(prior.map(callback => callback()));
    assert.equal(h.reads(), 0, 'same-page settings refresh also replaces timer ownership');
    await Promise.all([...h.timers.values()].map(callback => callback()));
    assert.ok(h.reads() > 0, 'current generation still executes normal work');
});

test('independent tab instances and one hundred fast switches do not accumulate timers', () => {
    const tabs = [fixture(), fixture(), fixture()];
    for (const h of tabs) {
        for (let i = 0; i < 100; i += 1) {
            const page = h.context.pages[i % h.context.pages.length];
            h.context.currentPage = page;
            h.context.applyPolling(true);
            assert.equal(h.timers.size, h.context.expected(page).length);
            assert.equal(h.starts.size, h.timers.size);
        }
    }
    tabs[0].context.document.visibilityState = 'hidden';
    tabs[0].context.applyPolling();
    assert.equal(tabs[0].timers.size, 0);
    assert.ok(tabs[1].timers.size > 0 && tabs[2].timers.size > 0);
});

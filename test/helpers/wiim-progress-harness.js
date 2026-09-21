'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lifecycle = require('../../public/js/frontend-lifecycle');

function createProgressHarness(root = process.env.P2_AUDIT_SOURCE_ROOT || path.resolve(__dirname, '../..')) {
    const source = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    const timers = new Map();
    let nextId = 0;
    let updates = 0;
    let requests = 0;
    const noop = () => { requests += 1; };
    const context = {
        frontendLifecycle: lifecycle,
        wiimPageInitialized: true,
        navigationGeneration: 1,
        currentPage: 'wiim',
        document: { visibilityState: 'visible', getElementById: () => null },
        setInterval: callback => { const id = ++nextId; timers.set(id, callback); return id; },
        clearInterval: id => timers.delete(id),
        wiimIsLive: false, wiimPlaybackStale: false, wiimSeekDragging: false,
        wiimPlayerState: { status: 'play', curpos: 0, totlen: 1000000 },
        updateWiimProgUI: () => { updates += 1; },
        fetchWiimPlayback: noop, fetchWiimSystem: noop, wiimLoadPresetNames: noop, wiimCheckEqStat: noop
    };
    const timerCode = source.includes('const wiimProgressTicker =')
        ? block('const wiimProgressTicker =', 'const hydrationCoordinator =') : '';
    vm.createContext(context);
    vm.runInContext(`${timerCode}\n${block('function initWiimPage()', 'async function fetchWiimPlayback()')}\n${block('function tickWiimProg()', 'function formatSec(')}\ninitWiimPage();\nglobalThis.sync = typeof syncWiimProgressTicker === 'function' ? syncWiimProgressTicker : () => {};\nglobalThis.stop = () => { if (typeof wiimProgressTicker !== 'undefined') wiimProgressTicker.disconnect(); };`, context);
    return { source, context, timers, tick: () => [...timers.values()].forEach(fn => fn()), updates: () => updates, requests: () => requests };
}

module.exports = { createProgressHarness };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function functionSource(name, nextName) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start);
    assert.ok(start >= 0 && end > start, `${name} source must be present`);
    return source.slice(start, end);
}

function lazyContext(calls, visibility = 'visible') {
    const names = ['fetchHardware', 'fetchClients', 'fetchThreats', 'fetchTrends', 'fetchCritAlerts', 'fetchBlockHistory',
        'fetchSecuritySettings', 'fetchWiFiNetworks', 'fetchSwitchMatrix', 'fetchCloudSites', 'fetchCloudDevices',
        'fetchCloudHosts', 'fetchCloudSdwan', 'fetchIspMetrics', 'fetchUcgHist', 'fetchUcgSpikes', 'fetchNas',
        'fetchNasAdvanced', 'fetchNasCharts', 'fetchNasSleepStats', 'fetchNasDocker', 'fetchNasAlerts', 'fetchAlertConfig',
        'fetchWiimDeviceInfo', 'fetchWiimSystem', 'fetchWiimPlayback', 'fetchUps', 'fetchPpbEvents', 'fetchAdguard',
        'fetchAdgLog', 'fetchAdguardServicePolicies', 'fetchLinux', 'fetchLnxChart', 'fetchNotifSettings', 'fetchWebPushState',
        'fetchNotifLog', 'fetchAppSettings', 'fetchReportLog', 'fetchSystemStatus', 'fetchConnections', 'fetchConfigBackupStatus'];
    const context = { Promise, Set, loadedPages: new Set(), console: { debug() {} }, document: { visibilityState: visibility } };
    names.forEach(name => { context[name] = async () => { calls.push(name); return name === 'fetchAlertConfig' ? false : undefined; }; });
    context.connectNasSse = () => calls.push('connectNasSse');
    context.initWiimPage = () => calls.push('initWiimPage');
    context.initWiimSrcDrag = () => calls.push('initWiimSrcDrag');
    return context;
}

test('first page loader defers device requests until the relevant page is opened', async () => {
    const calls = [];
    const context = lazyContext(calls);
    vm.runInNewContext(`${functionSource('loadPageData', 'navigate')} globalThis.loadPageData = loadPageData;`, context);
    await context.loadPageData('settings');
    assert.deepEqual(calls.sort(), ['fetchAppSettings', 'fetchConfigBackupStatus', 'fetchConnections', 'fetchReportLog', 'fetchSystemStatus'].sort());
    assert.equal(calls.some(name => /Nas|Wiim|Cloud|Adguard|Linux|Ups|Docker/.test(name)), false);
    calls.length = 0;
    await context.loadPageData('nas');
    assert.ok(calls.includes('fetchNas'));
    assert.ok(calls.includes('fetchNasDocker'));
    const firstNasCount = calls.filter(name => name === 'fetchNas').length;
    await context.loadPageData('nas');
    assert.equal(calls.filter(name => name === 'fetchNas').length, firstNasCount);
});

test('hidden pages never start a deferred device load', async () => {
    const calls = [];
    const context = lazyContext(calls, 'hidden');
    vm.runInNewContext(`${functionSource('loadPageData', 'navigate')} globalThis.loadPageData = loadPageData;`, context);
    await context.loadPageData('nas');
    assert.deepEqual(calls, []);
});

class FakeElement {
    constructor() { this.children = []; this.classList = { add() {}, remove() {} }; this.listeners = new Map(); this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
}

test('external alert strings render as text nodes without inline handlers', async () => {
    const list = new FakeElement();
    const card = new FakeElement();
    const payloads = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '</script><script>alert(1)</script>'];
    const context = {
        document: { getElementById: id => id === 'nas-alert-config-list' ? list : card, createElement: () => new FakeElement() },
        fetch: async () => ({ json: async () => ({ source: 'nas_monitor', config: payloads.map(metric => ({ metric, condition: 'above', threshold: 1, enabled: true })) }) }),
        deleteAlertConfig() {}
    };
    const start = source.indexOf('async function fetchAlertConfig');
    const end = source.indexOf('\n        async function saveAlertConfig', start);
    vm.runInNewContext(`${source.slice(start, end)}; globalThis.fetchAlertConfig = fetchAlertConfig;`, context);
    await context.fetchAlertConfig();
    const renderedMetrics = list.children.map(row => row.children[0]?.textContent);
    assert.deepEqual(renderedMetrics, payloads);
    assert.equal(list.children.some(row => row.innerHTML), false);
    assert.equal(list.children.some(row => row.children.some(child => child.onclick)), false);
});

test('pinned cards use observers rather than a periodic DOM or canvas clone timer', () => {
    const pinned = source.slice(source.indexOf('/* ========== 釘選區塊'), source.indexOf('/* ==================== 共用 UI'));
    assert.doesNotMatch(pinned, /setInterval\(syncPinned/);
    assert.doesNotMatch(pinned, /drawImage\(/);
    assert.match(pinned, /new MutationObserver/);
});

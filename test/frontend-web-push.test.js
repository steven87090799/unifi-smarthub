'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderPwaServiceWorker } = require('../server/services/pwa-service-worker');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'web-push.js'), 'utf8');

test('Web Push UI requires an explicit admin user gesture and never receives private VAPID material', () => {
    for (const token of [
        'id="web-push-card"',
        'id="notif-webpush-enabled"',
        'id="web-push-subscribe"',
        'id="web-push-unsubscribe"',
        '<script src="/js/web-push.js"></script>'
    ]) assert.ok(html.includes(token), `missing ${token}`);
    for (const token of [
        "Notification.requestPermission()",
        'userVisibleOnly: true',
        "fetch('/api/web-push/subscriptions'",
        'applicationServerKey: base64UrlToUint8Array(webPushConfig.publicKey)',
        "dataset.panelRole !== 'admin'",
        'window.fetchWebPushState = fetchWebPushState'
    ]) assert.ok(source.includes(token), `missing ${token}`);
    assert.doesNotMatch(`${html}\n${source}`, /WEB_PUSH_PRIVATE_KEY|privateKey/u);
});

test('an existing browser subscription remains re-registerable after server persistence loss', () => {
    assert.match(source, /subscribeButton\.disabled = !isAdmin \|\| !!browserError \|\| !!configuration;/u);
    assert.match(source, /subscribeButton\.textContent = localSubscription \? '同步\/更新此瀏覽器訂閱'/u);
    assert.doesNotMatch(source, /subscribeButton\.disabled[^;]+\|\| !!localSubscription/u);
});

test('classic frontend module exposes only the three explicit Web Push UI entry points', () => {
    const window = {};
    new vm.Script(source).runInContext(vm.createContext({ window }));
    assert.deepEqual(Object.keys(window).sort(), [
        'fetchWebPushState', 'subscribeWebPush', 'unsubscribeWebPush'
    ]);
    for (const value of Object.values(window)) assert.equal(typeof value, 'function');
});

test('rendered service worker shows visible notifications and confines click navigation to same-origin paths', async () => {
    const listeners = new Map();
    const shown = [];
    const opened = [];
    const self = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        registration: { async showNotification(...args) { shown.push(args); } },
        clients: {
            claim() {},
            async matchAll() { return []; },
            async openWindow(url) { opened.push(url); }
        },
        location: { origin: 'https://smarthub.example.test' }
    };
    const context = vm.createContext({
        self,
        URL,
        fetch: async () => ({ clone() { return this; } }),
        caches: {
            async open() { return { addAll: async () => {}, put: async () => {} }; },
            async keys() { return []; },
            async delete() {},
            async match() { return null; }
        }
    });
    const script = renderPwaServiceWorker('smarthub-shell-test');
    new vm.Script(script).runInContext(context);
    assert.ok(listeners.has('push'));
    assert.ok(listeners.has('notificationclick'));

    let pushWork;
    listeners.get('push')({
        data: { json: () => ({ title: 'Alert', body: 'Body', url: 'https://evil.example/', tag: 'event_1' }) },
        waitUntil(promise) { pushWork = promise; }
    });
    await pushWork;
    assert.equal(shown[0][0], 'Alert');
    assert.equal(shown[0][1].body, 'Body');
    assert.equal(shown[0][1].tag, 'event_1');
    assert.equal(shown[0][1].data.url, '/');

    let clickWork;
    listeners.get('notificationclick')({
        notification: { data: { url: 'https://evil.example/' }, close() {} },
        waitUntil(promise) { clickWork = promise; }
    });
    await clickWork;
    assert.deepEqual(opened, ['https://smarthub.example.test/']);
});

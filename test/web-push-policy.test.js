'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const webPush = require('web-push');
const {
    endpointHash,
    normalizeNotificationPayload,
    parseSubscriptionRequest,
    parseUnsubscribeRequest,
    readVapidConfiguration
} = require('../server/policies/web-push-policy');

const vapid = webPush.generateVAPIDKeys();
const auth = Buffer.alloc(16, 7).toString('base64url');
const endpoint = 'https://push.example.test/subscriptions/device-1';

test('subscription input is exact, canonical, bounded, and hashes no secret material', () => {
    const parsed = parseSubscriptionRequest({
        subscription: {
            endpoint,
            expirationTime: null,
            keys: { p256dh: vapid.publicKey, auth }
        }
    });
    assert.equal(parsed.endpoint, endpoint);
    assert.equal(parsed.expirationTime, null);
    assert.equal(parsed.keys.p256dh, vapid.publicKey);
    assert.match(endpointHash(endpoint), /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(endpointHash(endpoint), /device-1/u);
    assert.deepEqual(parseUnsubscribeRequest({ endpoint }), { endpoint });
});

test('subscription input rejects unsafe endpoints, malformed keys, expiry, and unknown fields', () => {
    const base = { endpoint, expirationTime: null, keys: { p256dh: vapid.publicKey, auth } };
    for (const subscription of [
        { ...base, endpoint: 'http://push.example.test/device' },
        { ...base, endpoint: 'https://user:pass@push.example.test/device' },
        { ...base, expirationTime: -1 },
        { ...base, keys: { ...base.keys, p256dh: 'bad' } },
        { ...base, keys: { ...base.keys, auth: 'bad' } },
        { ...base, extra: true }
    ]) assert.throws(() => parseSubscriptionRequest({ subscription }));
    assert.throws(() => parseSubscriptionRequest({ subscription: base, extra: true }));
});

test('VAPID configuration requires a complete valid environment tuple without exposing private material', () => {
    assert.deepEqual(readVapidConfiguration({}), {
        configured: false, error: null, subject: null, publicKey: null, privateKey: null
    });
    assert.equal(readVapidConfiguration({ WEB_PUSH_PUBLIC_KEY: vapid.publicKey }).error, 'partial_vapid_configuration');
    const configured = readVapidConfiguration({
        WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
        WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
        WEB_PUSH_PRIVATE_KEY: vapid.privateKey
    });
    assert.equal(configured.configured, true);
    assert.equal(configured.publicKey, vapid.publicKey);
    assert.equal(configured.privateKey, vapid.privateKey);
    const other = webPush.generateVAPIDKeys();
    assert.equal(readVapidConfiguration({
        WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
        WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
        WEB_PUSH_PRIVATE_KEY: other.privateKey
    }).error, 'invalid_vapid_configuration');
    assert.equal(readVapidConfiguration({
        WEB_PUSH_SUBJECT: 'https://user:pass@example.test/contact',
        WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
        WEB_PUSH_PRIVATE_KEY: vapid.privateKey
    }).error, 'invalid_vapid_configuration');
});

test('notification payloads are visible, same-origin, and bounded', () => {
    assert.deepEqual(normalizeNotificationPayload('Alert', 'Body', { url: '/?page=notify', tag: 'event_1' }), {
        title: 'Alert', body: 'Body', url: '/?page=notify', tag: 'event_1'
    });
    assert.throws(() => normalizeNotificationPayload('Alert', 'Body', { url: 'https://evil.example/' }));
    assert.throws(() => normalizeNotificationPayload('x'.repeat(121), 'Body'));
    assert.throws(() => normalizeNotificationPayload('Alert', 'x'.repeat(2001)));
});

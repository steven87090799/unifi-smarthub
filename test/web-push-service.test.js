'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webPush = require('web-push');
const { createHistoryDb } = require('../db');
const {
    BASE_BACKOFF_MS,
    WebPushServiceError,
    createWebPushService
} = require('../server/services/web-push');

const vapid = webPush.generateVAPIDKeys();
const env = {
    WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
    WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
    WEB_PUSH_PRIVATE_KEY: vapid.privateKey
};

function subscription(index, expirationTime = null) {
    return {
        endpoint: `https://push.example.test/subscriptions/device-${index}`,
        expirationTime,
        keys: {
            p256dh: vapid.publicKey,
            auth: Buffer.alloc(16, index).toString('base64url')
        }
    };
}

function fixture(t, { logger = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-web-push-'));
    let db = createHistoryDb(dir);
    let timestamp = Date.parse('2026-07-15T00:00:00.000Z');
    let handler = async () => ({ statusCode: 201 });
    const calls = [];
    const sleeps = [];
    const sender = {
        async sendNotification(...args) {
            calls.push(args);
            return handler(...args);
        }
    };
    const makeService = () => createWebPushService({
        repository: db,
        webPush: sender,
        env,
        logger,
        now: () => timestamp,
        sleep: async ms => { sleeps.push(ms); }
    });
    let service = makeService();
    t.after(() => {
        try { db.close(); } catch { }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return {
        calls,
        sleeps,
        get db() { return db; },
        get service() { return service; },
        advance(ms) { timestamp += ms; },
        setHandler(next) { handler = next; },
        reopen() {
            db.close();
            db = createHistoryDb(dir);
            service = makeService();
        }
    };
}

test('duplicate subscriptions persist once across restart without exposing private VAPID material', t => {
    const f = fixture(t);
    assert.deepEqual(f.service.subscribe(subscription(1)), { ok: true, created: true, subscriptionCount: 1 });
    assert.deepEqual(f.service.subscribe(subscription(1)), { ok: true, created: false, subscriptionCount: 1 });
    f.reopen();
    const snapshot = f.service.snapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.publicKey, vapid.publicKey);
    assert.equal(snapshot.subscriptionCount, 1);
    assert.equal(Object.hasOwn(snapshot, 'privateKey'), false);
});

test('subscription storage rejects the twenty-first distinct browser without evicting an existing subscription', t => {
    const f = fixture(t);
    for (let index = 1; index <= 20; index += 1) {
        assert.equal(f.service.subscribe(subscription(index)).created, true);
    }
    assert.equal(f.service.snapshot().subscriptionCount, 20);
    assert.throws(() => f.service.subscribe(subscription(21)), error => (
        error instanceof WebPushServiceError
        && error.httpStatus === 409
        && error.code === 'subscription_capacity'
    ));
    assert.equal(f.service.snapshot().subscriptionCount, 20);
});

test('expired subscriptions release capacity before a new browser is admitted', t => {
    const f = fixture(t);
    const expiresAt = Date.parse('2026-07-15T00:00:01.000Z');
    for (let index = 1; index <= 20; index += 1) {
        f.service.subscribe(subscription(index, expiresAt));
    }
    f.advance(1_000);
    assert.deepEqual(f.service.subscribe(subscription(21)), {
        ok: true, created: true, subscriptionCount: 1
    });
});

test('delivery is durably deduplicated and a clear 503 rejection retries once within a bounded delay', async t => {
    const f = fixture(t);
    f.service.subscribe(subscription(1));
    let attempt = 0;
    f.setHandler(async (_subscription, payload, options) => {
        const parsed = JSON.parse(payload);
        assert.equal(parsed.title, 'Alert');
        assert.equal(parsed.url, '/');
        assert.equal(options.vapidDetails.privateKey, vapid.privateKey);
        assert.equal(options.timeout, 8000);
        attempt += 1;
        if (attempt === 1) {
            const error = new Error('temporarily rejected');
            error.statusCode = 503;
            throw error;
        }
        return { statusCode: 201 };
    });
    const first = await f.service.send('Alert', 'Body', { dedupeKey: 'event-1' });
    assert.equal(first.sent, 1);
    assert.equal(first.failed, 0);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.sleeps, [250]);

    const duplicate = await f.service.send('Alert', 'Body', { dedupeKey: 'event-1' });
    assert.equal(duplicate.duplicate, 1);
    assert.equal(f.calls.length, 2);
    f.reopen();
    const afterRestart = await f.service.send('Alert', 'Body', { dedupeKey: 'event-1' });
    assert.equal(afterRestart.duplicate, 1);
    assert.equal(f.calls.length, 2);
});

test('410 responses and browser expiry remove subscriptions while other devices continue', async t => {
    const f = fixture(t);
    f.service.subscribe(subscription(1));
    f.service.subscribe(subscription(2));
    f.service.subscribe(subscription(3, Date.parse('2026-07-15T00:00:01.000Z')));
    f.advance(1_000);
    f.setHandler(async pushSubscription => {
        if (pushSubscription.endpoint.endsWith('device-1')) {
            const error = new Error('gone');
            error.statusCode = 410;
            throw error;
        }
        return { statusCode: 201 };
    });
    const result = await f.service.send('Alert', 'Body', { dedupeKey: 'event-expiry' });
    assert.equal(result.sent, 1);
    assert.equal(result.expired, 2);
    assert.equal(result.failed, 0);
    assert.equal(f.service.snapshot().subscriptionCount, 1);
});

test('ambiguous network failure is not retried and persistent backoff survives restart', async t => {
    const records = [];
    const f = fixture(t, { logger: { warning(record) { records.push(record); } } });
    f.service.subscribe(subscription(1));
    f.setHandler(async () => {
        const error = new Error('socket reset after write at https://push.example.test/subscriptions/device-1');
        error.code = 'ECONNRESET';
        throw error;
    });
    const failed = await f.service.send('Alert', 'Body', { dedupeKey: 'event-2' });
    assert.equal(failed.failed, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.db.listWebPushSubscriptions()[0].nextRetryTs, Date.parse('2026-07-15T00:00:00.000Z') + BASE_BACKOFF_MS);
    assert.equal(records.length, 1);
    assert.equal(Object.hasOwn(records[0], 'error'), false);
    assert.doesNotMatch(JSON.stringify(records), /push\.example\.test|device-1/u);

    f.reopen();
    const backoff = await f.service.send('Different alert', 'Body', { dedupeKey: 'event-3' });
    assert.equal(backoff.backoff, 1);
    assert.equal(f.calls.length, 1);
    f.advance(BASE_BACKOFF_MS);
    f.setHandler(async () => ({ statusCode: 201 }));
    const recovered = await f.service.send('Different alert', 'Body', { dedupeKey: 'event-4' });
    assert.equal(recovered.sent, 1);
    assert.equal(f.db.listWebPushSubscriptions()[0].failureCount, 0);
});

test('missing or invalid VAPID configuration fails subscription closed without affecting storage', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-web-push-invalid-'));
    const db = createHistoryDb(dir);
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const service = createWebPushService({
        repository: db,
        webPush: { sendNotification: async () => ({}) },
        env: { WEB_PUSH_PUBLIC_KEY: vapid.publicKey }
    });
    assert.equal(service.snapshot().error, 'partial_vapid_configuration');
    assert.throws(() => service.subscribe(subscription(1)), error => (
        error instanceof WebPushServiceError && error.httpStatus === 503
    ));
    assert.equal(db.countWebPushSubscriptions(), 0);
});

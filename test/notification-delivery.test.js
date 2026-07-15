'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PartialNotificationDeliveryError,
    chunkText,
    createNotificationDispatcher,
    dispatchNotificationFanout
} = require('../server/integrations/notification-delivery');

function fakeHttp(steps = []) {
    const calls = [];
    return {
        calls,
        async post(...args) {
            calls.push(args);
            const step = steps.shift();
            if (step instanceof Error) throw step;
            if (typeof step === 'function') return step(...args);
            return step || { status: 200 };
        }
    };
}

test('chunking enforces hard platform bounds even for one unbroken line', () => {
    assert.deepEqual(chunkText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
    assert.deepEqual(chunkText('abc\ndefg\nh', 5), ['abc', 'defg', 'h']);
    const emojiChunks = chunkText(`abc${'😀'}def`, 4);
    assert.equal(emojiChunks.join(''), 'abc😀def');
    assert.ok(emojiChunks.every(chunk => chunk.length <= 4));
    assert.throws(() => chunkText('x', 0), /positive safe integer/);
});

test('Discord delivery reports deterministic progress for every accepted chunk', async () => {
    const http = fakeHttp();
    const dispatch = createNotificationDispatcher({ httpClient: http });
    const progress = [];
    await dispatch('title', 'x'.repeat(4000), {
        channel: 'discord', webhookUrl: 'https://discord.example/hook'
    }, { onProgress: entry => progress.push(entry) });

    assert.equal(http.calls.length, 3);
    assert.deepEqual(progress, [
        { channel: 'discord', sentParts: 1, totalParts: 3 },
        { channel: 'discord', sentParts: 2, totalParts: 3 },
        { channel: 'discord', sentParts: 3, totalParts: 3 }
    ]);
    assert.ok(http.calls.every(call => call[1].content.length <= 1900));
});

test('failure after an accepted chunk raises explicit partial metadata', async () => {
    const http = fakeHttp([{ status: 200 }, new Error('second chunk rejected')]);
    const dispatch = createNotificationDispatcher({ httpClient: http });

    await assert.rejects(
        dispatch('title', 'x'.repeat(2200), {
            channel: 'discord', webhookUrl: 'https://discord.example/hook'
        }),
        error => {
            assert.ok(error instanceof PartialNotificationDeliveryError);
            assert.equal(error.code, 'NOTIFICATION_PARTIAL_DELIVERY');
            assert.equal(error.channel, 'discord');
            assert.equal(error.sentParts, 1);
            assert.equal(error.totalParts, 2);
            return true;
        }
    );
});

test('Telegram maps a first-part API rejection without claiming partial success', async () => {
    const rejected = new Error('request failed');
    rejected.response = { status: 400, data: { description: 'chat not found' } };
    const http = fakeHttp([rejected]);
    const dispatch = createNotificationDispatcher({ httpClient: http });

    await assert.rejects(
        dispatch('title', 'body', { channel: 'telegram', botToken: 'token', chatId: '123' }),
        error => !(error instanceof PartialNotificationDeliveryError) && /找不到聊天室/.test(error.message)
    );
});

test('generic webhooks receive the durable schedule key as idempotency metadata', async () => {
    const http = fakeHttp();
    const dispatch = createNotificationDispatcher({ httpClient: http });
    const scheduleKey = 'scheduled:2026-07-15:08';
    await dispatch('title', 'body', {
        channel: 'webhook', webhookUrl: 'https://hooks.example/report'
    }, { scheduleKey });

    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0][1].schedule_key, scheduleKey);
    assert.deepEqual(http.calls[0][2].headers, {
        'Idempotency-Key': scheduleKey,
        'X-SmartHub-Schedule-Key': scheduleKey
    });
});

test('an already-aborted delivery performs no external request', async () => {
    const http = fakeHttp();
    const dispatch = createNotificationDispatcher({ httpClient: http });
    const controller = new AbortController();
    controller.abort(new Error('deadline'));

    await assert.rejects(
        dispatch('title', 'body', {
            channel: 'discord', webhookUrl: 'https://discord.example/hook'
        }, { signal: controller.signal }),
        /deadline/
    );
    assert.equal(http.calls.length, 0);
});

test('Web Push fanout never prevents a healthy primary Discord or Telegram delivery', async () => {
    const result = await dispatchNotificationFanout({
        dispatchPrimary: async () => undefined,
        dispatchWebPush: async () => ({ attempted: 1, sent: 0, failed: 1 }),
        title: 'Alert', body: 'Body', settings: { webPushEnabled: true }
    });
    assert.equal(result.ok, true);
    assert.equal(result.primary, true);
    assert.equal(result.partial, true);
});

test('Web Push provides a fallback only when at least one subscription accepted the notification', async () => {
    const primaryFailure = new Error('Discord unavailable');
    const fallback = await dispatchNotificationFanout({
        dispatchPrimary: async () => { throw primaryFailure; },
        dispatchWebPush: async () => ({ attempted: 2, sent: 1, failed: 1 }),
        title: 'Alert', body: 'Body', settings: { webPushEnabled: true }
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.fallback, 'web_push');
    assert.equal(fallback.primaryError, primaryFailure);

    await assert.rejects(dispatchNotificationFanout({
        dispatchPrimary: async () => { throw primaryFailure; },
        dispatchWebPush: async () => ({ skipped: 'no_subscriptions', attempted: 0, sent: 0, failed: 0 }),
        title: 'Alert', body: 'Body', settings: { webPushEnabled: true }
    }), /Discord unavailable/);
});

test('Web Push success cannot erase an ambiguous partial primary delivery', async () => {
    const partial = new PartialNotificationDeliveryError('second part failed', {
        channel: 'telegram', sentParts: 1, totalParts: 2
    });
    await assert.rejects(dispatchNotificationFanout({
        dispatchPrimary: async () => { throw partial; },
        dispatchWebPush: async () => ({ attempted: 1, sent: 1, failed: 0 }),
        title: 'Alert', body: 'Body', settings: { webPushEnabled: true }
    }), error => error === partial);
});

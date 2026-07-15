'use strict';

const { createHash } = require('node:crypto');
const {
    endpointHash,
    normalizeEndpoint,
    normalizeNotificationPayload,
    normalizeSubscription,
    readVapidConfiguration
} = require('../policies/web-push-policy');

const DELIVERY_CONCURRENCY = 4;
const DELIVERY_TIMEOUT_MS = 8000;
const DELIVERY_TTL_SECONDS = 300;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 2;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TERMINAL_STATUS = new Set([404, 410]);

class WebPushServiceError extends Error {
    constructor(message, { code = 'web_push_error', httpStatus = 500 } = {}) {
        super(message);
        this.name = 'WebPushServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function deliveryKey(title, body, options, timestamp) {
    const explicit = options?.dedupeKey || options?.scheduleKey;
    const source = explicit
        ? `explicit\0${String(explicit).slice(0, 512)}`
        : `minute\0${Math.floor(timestamp / 60000)}\0${title}\0${body}`;
    return sha256(source);
}

function retryDelay(error, attempt) {
    const retryAfter = error?.headers?.['retry-after'];
    const seconds = typeof retryAfter === 'string' && /^\d{1,4}$/u.test(retryAfter) ? Number(retryAfter) : null;
    if (seconds != null) return Math.min(Math.max(seconds * 1000, 250), 2000);
    return Math.min(250 * (2 ** attempt), 2000);
}

function safeErrorCode(error) {
    const status = Number(error?.statusCode);
    if (Number.isInteger(status)) return `http_${status}`;
    const code = String(error?.code || 'delivery_failed').toLowerCase().replace(/[^a-z0-9_-]+/gu, '_');
    return code.slice(0, 80) || 'delivery_failed';
}

function createWebPushService({
    repository,
    webPush,
    env = process.env,
    logger = null,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    const requiredRepositoryMethods = [
        'upsertWebPushSubscription', 'deleteWebPushSubscription', 'listWebPushSubscriptions',
        'countWebPushSubscriptions', 'markWebPushSuccess', 'markWebPushFailure',
        'claimWebPushDelivery', 'pruneExpiredWebPushSubscriptions'
    ];
    for (const method of requiredRepositoryMethods) {
        if (typeof repository?.[method] !== 'function') throw new TypeError(`repository.${method} is required`);
    }
    if (!webPush || typeof webPush.sendNotification !== 'function') {
        throw new TypeError('webPush.sendNotification is required');
    }

    const vapid = readVapidConfiguration(env);

    function snapshot() {
        return {
            configured: vapid.configured,
            publicKey: vapid.configured ? vapid.publicKey : null,
            subject: vapid.configured ? vapid.subject : null,
            error: vapid.error,
            subscriptionCount: repository.countWebPushSubscriptions(),
            maxSubscriptions: 20
        };
    }

    function requireConfigured() {
        if (!vapid.configured) {
            throw new WebPushServiceError('Web Push VAPID configuration is unavailable', {
                code: vapid.error || 'web_push_not_configured', httpStatus: 503
            });
        }
    }

    function subscribe(input) {
        requireConfigured();
        const subscription = normalizeSubscription(input);
        const timestamp = now();
        if (subscription.expirationTime != null && subscription.expirationTime <= timestamp) {
            throw new WebPushServiceError('Web Push subscription is already expired', {
                code: 'subscription_expired', httpStatus: 400
            });
        }
        repository.pruneExpiredWebPushSubscriptions(timestamp);
        try {
            const result = repository.upsertWebPushSubscription({
                endpointHash: endpointHash(subscription.endpoint),
                ...subscription,
                timestamp
            });
            return { ok: true, created: result.created, subscriptionCount: repository.countWebPushSubscriptions() };
        } catch (error) {
            if (error instanceof RangeError) {
                throw new WebPushServiceError('Web Push subscription capacity reached', {
                    code: 'subscription_capacity', httpStatus: 409
                });
            }
            throw error;
        }
    }

    function unsubscribe(endpoint) {
        const normalized = normalizeEndpoint(endpoint);
        const removed = repository.deleteWebPushSubscription(endpointHash(normalized));
        return { ok: true, removed, subscriptionCount: repository.countWebPushSubscriptions() };
    }

    async function sendOne(row, payload, notificationKey) {
        const timestamp = now();
        if (row.nextRetryTs != null && row.nextRetryTs > timestamp) return { outcome: 'backoff' };
        if (!repository.claimWebPushDelivery(row.endpointHash, notificationKey, timestamp)) {
            return { outcome: 'duplicate' };
        }
        for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
            try {
                await webPush.sendNotification({
                    endpoint: row.endpoint,
                    expirationTime: row.expirationTime,
                    keys: row.keys
                }, payload, {
                    vapidDetails: {
                        subject: vapid.subject,
                        publicKey: vapid.publicKey,
                        privateKey: vapid.privateKey
                    },
                    TTL: DELIVERY_TTL_SECONDS,
                    urgency: 'high',
                    topic: notificationKey.slice(0, 32),
                    timeout: DELIVERY_TIMEOUT_MS
                });
                repository.markWebPushSuccess(row.endpointHash, now());
                return { outcome: 'sent' };
            } catch (error) {
                const status = Number(error?.statusCode);
                if (TERMINAL_STATUS.has(status)) {
                    repository.deleteWebPushSubscription(row.endpointHash);
                    return { outcome: 'expired' };
                }
                if (attempt + 1 < MAX_DELIVERY_ATTEMPTS && RETRYABLE_STATUS.has(status)) {
                    await sleep(retryDelay(error, attempt));
                    continue;
                }
                const failedAt = now();
                const failureCount = Math.max(1, Number(row.failureCount || 0) + 1);
                const backoff = Math.min(BASE_BACKOFF_MS * (2 ** Math.min(failureCount - 1, 16)), MAX_BACKOFF_MS);
                const code = safeErrorCode(error);
                repository.markWebPushFailure(row.endpointHash, failedAt, code, failedAt + backoff);
                logger?.warning?.({
                    module: 'notification.webPush', function: 'send', code: 'EXT-WEB-PUSH-001',
                    message: 'Web Push delivery failed',
                    fields: { endpoint_hash: row.endpointHash, error_code: code, retry_ms: backoff }
                });
                return { outcome: 'failed', code };
            }
        }
        return { outcome: 'failed', code: 'delivery_attempts_exhausted' };
    }

    async function send(title, body, options = {}) {
        if (!vapid.configured) {
            return { skipped: vapid.error || 'not_configured', attempted: 0, sent: 0, failed: 0 };
        }
        const timestamp = now();
        const safeTitle = String(title || '').slice(0, 120) || 'SmartHub';
        const safeBody = String(body || '').slice(0, 2000) || 'SmartHub notification';
        const key = deliveryKey(safeTitle, safeBody, options, timestamp);
        const notification = normalizeNotificationPayload(safeTitle, safeBody, {
            url: '/', tag: key.slice(0, 32)
        });
        const payload = JSON.stringify(notification);
        const expired = repository.pruneExpiredWebPushSubscriptions(timestamp);
        const rows = repository.listWebPushSubscriptions();
        if (rows.length === 0) {
            return { skipped: 'no_subscriptions', attempted: 0, sent: 0, failed: 0, expired };
        }

        const results = new Array(rows.length);
        let cursor = 0;
        async function worker() {
            for (;;) {
                const index = cursor;
                cursor += 1;
                if (index >= rows.length) return;
                results[index] = await sendOne(rows[index], payload, key);
            }
        }
        await Promise.all(Array.from({ length: Math.min(DELIVERY_CONCURRENCY, rows.length) }, worker));
        const counts = { sent: 0, failed: 0, expired, duplicate: 0, backoff: 0 };
        for (const result of results) counts[result.outcome] = (counts[result.outcome] || 0) + 1;
        return {
            attempted: rows.length - counts.duplicate - counts.backoff,
            ...counts,
            ok: counts.sent > 0 && counts.failed === 0
        };
    }

    return { send, snapshot, subscribe, unsubscribe };
}

module.exports = {
    BASE_BACKOFF_MS,
    DELIVERY_CONCURRENCY,
    DELIVERY_TIMEOUT_MS,
    DELIVERY_TTL_SECONDS,
    MAX_BACKOFF_MS,
    MAX_DELIVERY_ATTEMPTS,
    WebPushServiceError,
    createWebPushService,
    deliveryKey,
    retryDelay,
    safeErrorCode
};

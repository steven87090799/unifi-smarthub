'use strict';

const { createECDH, createHash } = require('node:crypto');
const {
    InputValidationError,
    exactObject,
    stringValue
} = require('./write-input-policy');

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_NOTIFICATION_TITLE = 120;
const MAX_NOTIFICATION_BODY = 2000;
const VAPID_PUBLIC_KEY_BYTES = 65;
const VAPID_PRIVATE_KEY_BYTES = 32;
const SUBSCRIPTION_AUTH_MIN_BYTES = 16;
const SUBSCRIPTION_AUTH_MAX_BYTES = 32;

function reject(message, field) {
    throw new InputValidationError(message, { field });
}

function canonicalBase64Url(value, { field, minBytes, maxBytes, exactBytes = null }) {
    const normalized = stringValue(value, {
        field,
        min: 1,
        max: 256,
        pattern: /^[A-Za-z0-9_-]+$/u
    });
    let decoded;
    try { decoded = Buffer.from(normalized, 'base64url'); }
    catch { return reject(`${field} must be canonical URL-safe base64`, field); }
    if (decoded.toString('base64url') !== normalized) {
        return reject(`${field} must be canonical URL-safe base64 without padding`, field);
    }
    if (exactBytes != null && decoded.length !== exactBytes) {
        return reject(`${field} must decode to exactly ${exactBytes} bytes`, field);
    }
    if (minBytes != null && decoded.length < minBytes) {
        return reject(`${field} is shorter than the required key material`, field);
    }
    if (maxBytes != null && decoded.length > maxBytes) {
        return reject(`${field} exceeds the key material boundary`, field);
    }
    return normalized;
}

function normalizeEndpoint(value) {
    const normalized = stringValue(value, {
        field: 'endpoint', min: 1, max: MAX_ENDPOINT_LENGTH,
        pattern: /^https:\/\//u
    });
    let parsed;
    try { parsed = new URL(normalized); }
    catch { return reject('endpoint must be an absolute HTTPS URL', 'endpoint'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
        return reject('endpoint must be an absolute HTTPS URL without credentials', 'endpoint');
    }
    return parsed.toString();
}

function normalizeExpirationTime(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value <= 0) {
        return reject('expirationTime must be null or a positive epoch-millisecond integer', 'expirationTime');
    }
    return value;
}

function normalizeSubscription(value) {
    const input = exactObject(value, {
        allowed: ['endpoint', 'expirationTime', 'keys'],
        required: ['endpoint', 'keys'],
        field: 'subscription'
    });
    const keys = exactObject(input.keys, {
        allowed: ['p256dh', 'auth'], required: ['p256dh', 'auth'], field: 'subscription.keys'
    });
    const p256dh = canonicalBase64Url(keys.p256dh, {
        field: 'subscription.keys.p256dh', exactBytes: VAPID_PUBLIC_KEY_BYTES
    });
    if (Buffer.from(p256dh, 'base64url')[0] !== 4) {
        reject('subscription.keys.p256dh must be an uncompressed P-256 public key', 'subscription.keys.p256dh');
    }
    return {
        endpoint: normalizeEndpoint(input.endpoint),
        expirationTime: normalizeExpirationTime(input.expirationTime),
        keys: {
            p256dh,
            auth: canonicalBase64Url(keys.auth, {
                field: 'subscription.keys.auth',
                minBytes: SUBSCRIPTION_AUTH_MIN_BYTES,
                maxBytes: SUBSCRIPTION_AUTH_MAX_BYTES
            })
        }
    };
}

function parseSubscriptionRequest(body) {
    const input = exactObject(body, {
        allowed: ['subscription'], required: ['subscription'], field: 'body'
    });
    return normalizeSubscription(input.subscription);
}

function parseUnsubscribeRequest(body) {
    const input = exactObject(body, {
        allowed: ['endpoint'], required: ['endpoint'], field: 'body'
    });
    return { endpoint: normalizeEndpoint(input.endpoint) };
}

function endpointHash(endpoint) {
    return createHash('sha256').update(normalizeEndpoint(endpoint)).digest('hex');
}

function normalizeVapidSubject(value) {
    const normalized = stringValue(value, { field: 'WEB_PUSH_SUBJECT', min: 8, max: 320 });
    if (normalized.startsWith('mailto:')) {
        const address = normalized.slice(7);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(address)) {
            reject('WEB_PUSH_SUBJECT mailto URI is invalid', 'WEB_PUSH_SUBJECT');
        }
        return normalized;
    }
    let parsed;
    try { parsed = new URL(normalized); }
    catch { return reject('WEB_PUSH_SUBJECT must be a mailto or HTTPS URI', 'WEB_PUSH_SUBJECT'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
        return reject('WEB_PUSH_SUBJECT must be a mailto or HTTPS URI without credentials', 'WEB_PUSH_SUBJECT');
    }
    return parsed.toString();
}

function readVapidConfiguration(env = {}) {
    const raw = {
        subject: String(env.WEB_PUSH_SUBJECT || '').trim(),
        publicKey: String(env.WEB_PUSH_PUBLIC_KEY || '').trim(),
        privateKey: String(env.WEB_PUSH_PRIVATE_KEY || '').trim()
    };
    const present = Object.values(raw).filter(Boolean).length;
    if (present === 0) return { configured: false, error: null, subject: null, publicKey: null, privateKey: null };
    if (present !== 3) {
        return {
            configured: false,
            error: 'partial_vapid_configuration',
            subject: null,
            publicKey: null,
            privateKey: null
        };
    }
    try {
        const publicKey = canonicalBase64Url(raw.publicKey, {
            field: 'WEB_PUSH_PUBLIC_KEY', exactBytes: VAPID_PUBLIC_KEY_BYTES
        });
        if (Buffer.from(publicKey, 'base64url')[0] !== 4) {
            reject('WEB_PUSH_PUBLIC_KEY must be an uncompressed P-256 public key', 'WEB_PUSH_PUBLIC_KEY');
        }
        const privateKey = canonicalBase64Url(raw.privateKey, {
            field: 'WEB_PUSH_PRIVATE_KEY', exactBytes: VAPID_PRIVATE_KEY_BYTES
        });
        const ecdh = createECDH('prime256v1');
        ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
        if (ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url') !== publicKey) {
            reject('WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY must be one VAPID key pair', 'WEB_PUSH_PUBLIC_KEY');
        }
        return {
            configured: true,
            error: null,
            subject: normalizeVapidSubject(raw.subject),
            publicKey,
            privateKey
        };
    } catch (error) {
        return {
            configured: false,
            error: 'invalid_vapid_configuration',
            subject: null,
            publicKey: null,
            privateKey: null
        };
    }
}

function normalizeNotificationPayload(title, body, { url = '/', tag = null } = {}) {
    const normalizedTitle = stringValue(title, {
        field: 'title', min: 1, max: MAX_NOTIFICATION_TITLE
    });
    const normalizedBody = stringValue(body, {
        field: 'body', min: 1, max: MAX_NOTIFICATION_BODY
    });
    const normalizedUrl = stringValue(url, {
        field: 'url', min: 1, max: 512,
        pattern: /^\/(?!\/)[^\u0000-\u001f\u007f]*$/u
    });
    const normalizedTag = tag == null ? null : stringValue(tag, {
        field: 'tag', min: 1, max: 32,
        pattern: /^[A-Za-z0-9_-]+$/u
    });
    return { title: normalizedTitle, body: normalizedBody, url: normalizedUrl, tag: normalizedTag };
}

module.exports = {
    MAX_ENDPOINT_LENGTH,
    MAX_NOTIFICATION_BODY,
    MAX_NOTIFICATION_TITLE,
    VAPID_PRIVATE_KEY_BYTES,
    VAPID_PUBLIC_KEY_BYTES,
    endpointHash,
    normalizeEndpoint,
    normalizeNotificationPayload,
    normalizeSubscription,
    parseSubscriptionRequest,
    parseUnsubscribeRequest,
    readVapidConfiguration
};

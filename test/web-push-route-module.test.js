'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const webPush = require('web-push');
const { registerWebPushRoutes } = require('../server/routes/web-push-routes');

function response() {
    return {
        statusCode: 200,
        body: null,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; }
    };
}

function fixture() {
    const routes = new Map();
    const app = {};
    for (const method of ['get', 'post', 'delete']) {
        app[method] = (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers);
    }
    const subscriptions = new Map();
    const requireAdmin = () => {};
    registerWebPushRoutes(app, {
        requireAdmin,
        getState: () => ({ configured: true, subscriptionCount: subscriptions.size }),
        subscribe(input) {
            const created = !subscriptions.has(input.endpoint);
            subscriptions.set(input.endpoint, input);
            return { ok: true, created, subscriptionCount: subscriptions.size };
        },
        unsubscribe(endpoint) {
            return { ok: true, removed: subscriptions.delete(endpoint), subscriptionCount: subscriptions.size };
        }
    });
    return { routes, requireAdmin };
}

test('shared Web Push registrar owns the exact production and mock HTTP contract', () => {
    const f = fixture();
    assert.deepEqual([...f.routes.keys()].sort(), [
        'DELETE /api/web-push/subscriptions',
        'GET /api/web-push/config',
        'POST /api/web-push/subscriptions'
    ]);
    assert.equal(f.routes.get('POST /api/web-push/subscriptions')[0], f.requireAdmin);
    assert.equal(f.routes.get('DELETE /api/web-push/subscriptions')[0], f.requireAdmin);

    const getResponse = response();
    f.routes.get('GET /api/web-push/config').at(-1)({}, getResponse);
    assert.deepEqual(getResponse.body, { configured: true, subscriptionCount: 0 });

    const vapid = webPush.generateVAPIDKeys();
    const endpoint = 'https://push.example.test/subscriptions/route-module';
    const request = {
        body: {
            subscription: {
                endpoint,
                expirationTime: null,
                keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 4).toString('base64url') }
            }
        }
    };
    const created = response();
    f.routes.get('POST /api/web-push/subscriptions').at(-1)(request, created);
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.body, { ok: true, created: true, subscriptionCount: 1 });

    const duplicate = response();
    f.routes.get('POST /api/web-push/subscriptions').at(-1)(request, duplicate);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.created, false);

    const removed = response();
    f.routes.get('DELETE /api/web-push/subscriptions').at(-1)({ body: { endpoint } }, removed);
    assert.deepEqual(removed.body, { ok: true, removed: true, subscriptionCount: 0 });
});

test('shared registrar rejects invalid input before invoking service operations', () => {
    const f = fixture();
    const invalid = response();
    f.routes.get('POST /api/web-push/subscriptions').at(-1)({
        body: { subscription: { endpoint: 'http://unsafe.example.test', keys: {} } }
    }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body.error, /required|invalid|endpoint/u);
});

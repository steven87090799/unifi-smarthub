'use strict';

const {
    parseSubscriptionRequest,
    parseUnsubscribeRequest
} = require('../policies/web-push-policy');

function defaultValidationError(error, { res }) {
    return res.status(400).json({ error: error?.message || 'Web Push request is invalid' });
}

function defaultOperationError(_error, { res }) {
    return res.status(500).json({ error: 'Web Push operation failed' });
}

function registerWebPushRoutes(app, options = {}) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
        throw new TypeError('Express app is required');
    }
    if (typeof options.requireAdmin !== 'function') throw new TypeError('requireAdmin middleware is required');
    if (typeof options.getState !== 'function') throw new TypeError('getState is required');
    if (typeof options.subscribe !== 'function') throw new TypeError('subscribe is required');
    if (typeof options.unsubscribe !== 'function') throw new TypeError('unsubscribe is required');

    const onValidationError = options.onValidationError || defaultValidationError;
    const onOperationError = options.onOperationError || defaultOperationError;

    function parse(res, operation, parser, body) {
        try { return parser(body); }
        catch (error) {
            onValidationError(error, { operation, res });
            return null;
        }
    }

    app.get('/api/web-push/config', (_req, res) => res.json(options.getState()));

    app.post('/api/web-push/subscriptions', options.requireAdmin, (req, res) => {
        const input = parse(res, 'subscribe', parseSubscriptionRequest, req.body);
        if (!input) return;
        try {
            const result = options.subscribe(input);
            return res.status(result.created ? 201 : 200).json(result);
        } catch (error) {
            return onOperationError(error, { operation: 'subscribe', req, res });
        }
    });

    app.delete('/api/web-push/subscriptions', options.requireAdmin, (req, res) => {
        const input = parse(res, 'unsubscribe', parseUnsubscribeRequest, req.body);
        if (!input) return;
        try { return res.json(options.unsubscribe(input.endpoint)); }
        catch (error) { return onOperationError(error, { operation: 'unsubscribe', req, res }); }
    });
}

module.exports = { registerWebPushRoutes };

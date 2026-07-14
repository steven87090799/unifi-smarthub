'use strict';

const {
    ERROR_CODES,
    WiimCommandPolicyError,
    validateWiimCommand
} = require('../policies/wiim-command-policy');

const ROUTE_CODES = Object.freeze({
    METHOD_NOT_ALLOWED: 'WIIM_COMMAND_METHOD_NOT_ALLOWED',
    CONFIRMATION_REQUIRED: 'WIIM_COMMAND_CONFIRMATION_REQUIRED',
    INVALID_REQUEST: 'WIIM_COMMAND_INVALID_REQUEST',
    TRANSPORT_FAILED: 'WIIM_COMMAND_TRANSPORT_FAILED'
});

function sendError(res, status, code, message) {
    return res.status(status).json({ error: message, code });
}

function policyDecision(input, res) {
    try { return validateWiimCommand(input); }
    catch (error) {
        if (error instanceof WiimCommandPolicyError) {
            sendError(res, error.httpStatus, error.code, error.message);
            return null;
        }
        throw error;
    }
}

function registerWiimCommandRoutes(app, options = {}) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
        throw new TypeError('Express app is required');
    }
    if (typeof options.execute !== 'function') throw new TypeError('WiiM command executor is required');
    const execute = options.execute;
    const onUnexpectedError = typeof options.onUnexpectedError === 'function' ? options.onUnexpectedError : null;

    async function run(req, res, decision) {
        try {
            const raw = await execute(decision.command, decision, req);
            if (raw == null) throw new Error('WiiM command returned no response');
            return res.json({ result: raw === '' ? 'OK' : raw });
        } catch (error) {
            if (onUnexpectedError) return onUnexpectedError(error, req, res);
            return sendError(res, 502, ROUTE_CODES.TRANSPORT_FAILED, 'WiiM command transport failed');
        }
    }

    app.get('/api/wiim/cmd', async (req, res) => {
        const queryKeys = Object.keys(req.query || {});
        if (queryKeys.length !== 1 || queryKeys[0] !== 'command') {
            return sendError(res, 400, ROUTE_CODES.INVALID_REQUEST, 'Exactly one command query parameter is required');
        }
        const decision = policyDecision(req.query.command, res);
        if (!decision) return;
        if (decision.kind !== 'read') {
            res.set('Allow', 'POST');
            return sendError(res, 405, ROUTE_CODES.METHOD_NOT_ALLOWED, 'Mutating WiiM commands require POST');
        }
        return run(req, res, decision);
    });

    app.post('/api/wiim/cmd', async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['command', 'confirmation'].includes(key))) {
            return sendError(res, 400, ROUTE_CODES.INVALID_REQUEST, 'Invalid WiiM command request body');
        }
        const decision = policyDecision(body.command, res);
        if (!decision) return;
        if (decision.kind !== 'write') {
            res.set('Allow', 'GET');
            return sendError(res, 405, ROUTE_CODES.METHOD_NOT_ALLOWED, 'Read-only WiiM commands require GET');
        }
        if (decision.confirmationRequired && body.confirmation !== decision.command) {
            return sendError(res, 409, ROUTE_CODES.CONFIRMATION_REQUIRED, 'Exact confirmation is required for this WiiM operation');
        }
        return run(req, res, decision);
    });
}

module.exports = { ERROR_CODES, ROUTE_CODES, registerWiimCommandRoutes };

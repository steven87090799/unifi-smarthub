'use strict';

const { Client } = require('ssh2');
const { executeSshCommand } = require('./ssh-command-stream');

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function stableConfigKey(config) {
    return JSON.stringify([
        config.host || '', Number(config.port) || 22, config.username || '',
        config.password || '', config.privateKey || '', config.tryKeyboard === true,
        config.hostKeyFingerprint || ''
    ]);
}

function createSshConnectionPool({
    getConfig,
    createConnection = () => new Client(),
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    execute = executeSshCommand,
    onKeyboardInteractive = null
} = {}) {
    if (typeof getConfig !== 'function') throw new TypeError('getConfig is required');
    if (typeof createConnection !== 'function') throw new TypeError('createConnection must be a function');
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) throw new TypeError('readyTimeoutMs must be positive');
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) throw new TypeError('idleTimeoutMs must be positive');

    let connection = null;
    let connectionKey = null;
    let connecting = null;
    let connectingCandidate = null;
    let cancelConnecting = null;
    let idleTimer = null;
    let operationTail = Promise.resolve();
    let closed = false;

    function clearIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    function safelyEnd(target) {
        if (!target) return;
        // A connection that is being torn down can still report a late error.
        // Keep a one-shot listener so EventEmitter never turns that into an
        // unhandled exception after the pool has deliberately detached it.
        target.once?.('error', () => {});
        try { target.end(); } catch { }
    }

    function invalidate(target = connection) {
        if (!target || target !== connection) return;
        connection = null;
        connectionKey = null;
        clearIdleTimer();
        safelyEnd(target);
    }

    function scheduleIdleClose(target) {
        clearIdleTimer();
        idleTimer = setTimeout(() => invalidate(target), idleTimeoutMs);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }

    function connect(config, key) {
        if (closed) return Promise.reject(new Error('SSH connection pool is closed'));
        if (connection && connectionKey === key) return Promise.resolve(connection);
        if (connection && connectionKey !== key) invalidate(connection);
        if (connecting) return connecting;

        const candidate = createConnection();
        connectingCandidate = candidate;
        const attempt = new Promise((resolve, reject) => {
            let settled = false;
            let keyboardHandler = null;
            const removeAttemptListeners = () => {
                candidate.removeListener?.('ready', ready);
                candidate.removeListener?.('error', fail);
                candidate.removeListener?.('close', closedBeforeReady);
                candidate.removeListener?.('end', closedBeforeReady);
                if (keyboardHandler) candidate.removeListener?.('keyboard-interactive', keyboardHandler);
            };
            const finish = (callback, value, endCandidate = false) => {
                if (settled) return;
                settled = true;
                removeAttemptListeners();
                if (connectingCandidate === candidate) connectingCandidate = null;
                if (endCandidate) safelyEnd(candidate);
                callback(value);
            };
            const fail = error => finish(reject, error, true);
            const closedBeforeReady = () => fail(new Error('SSH connection closed before ready'));
            const ready = () => {
                if (closed) return fail(new Error('SSH connection pool is closed'));
                if (settled) return;
                connection = candidate;
                connectionKey = key;
                candidate.on('error', () => invalidate(candidate));
                candidate.on('close', () => invalidate(candidate));
                candidate.on('end', () => invalidate(candidate));
                scheduleIdleClose(candidate);
                finish(resolve, candidate);
            };
            candidate.once('error', fail);
            candidate.once('ready', ready);
            candidate.once('close', closedBeforeReady);
            candidate.once('end', closedBeforeReady);
            if (typeof onKeyboardInteractive === 'function') {
                keyboardHandler = onKeyboardInteractive;
                candidate.on('keyboard-interactive', keyboardHandler);
            }
            cancelConnecting = error => fail(error || new Error('SSH connection pool is closed'));
            try {
                const { hostKeyFingerprint: _hostKeyFingerprint, ...sshConfig } = config;
                candidate.connect({ ...sshConfig, readyTimeout: readyTimeoutMs });
            }
            catch (error) { fail(error); }
        });
        connecting = attempt.finally(() => {
            if (connectingCandidate === candidate) connectingCandidate = null;
            if (cancelConnecting) cancelConnecting = null;
            if (connecting === wrapped) connecting = null;
        });
        const wrapped = connecting;
        return connecting;
    }

    function run(command, options) {
        if (closed) throw new Error('SSH connection pool is closed');
        const config = getConfig();
        const key = stableConfigKey(config);
        return connect(config, key).then(async target => {
            clearIdleTimer();
            try {
                const output = await execute(target, command, options);
                scheduleIdleClose(target);
                return output;
            } catch (error) {
                invalidate(target);
                throw error;
            }
        });
    }

    function executeSerial(command, options = {}) {
        const current = operationTail.then(() => run(command, options), () => run(command, options));
        operationTail = current.catch(() => undefined);
        return current;
    }

    function close() {
        closed = true;
        clearIdleTimer();
        if (connectingCandidate) cancelConnecting?.(new Error('SSH connection pool is closed'));
        if (connection) invalidate(connection);
    }

    return Object.freeze({ execute: executeSerial, close });
}

module.exports = {
    DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_READY_TIMEOUT_MS,
    createSshConnectionPool,
    stableConfigKey
};

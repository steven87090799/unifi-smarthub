'use strict';

const { Client } = require('ssh2');
const { executeSshCommand } = require('./ssh-command-stream');

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function stableConfigKey(config) {
    return JSON.stringify([
        config.host || '', Number(config.port) || 22, config.username || '',
        config.password || '', config.privateKey || '', config.tryKeyboard === true
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
    let idleTimer = null;
    let operationTail = Promise.resolve();
    let closed = false;

    function clearIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    function detachAndEnd(target) {
        if (!target) return;
        target.removeAllListeners('ready');
        target.removeAllListeners('error');
        target.removeAllListeners('close');
        target.removeAllListeners('end');
        target.removeAllListeners('keyboard-interactive');
        try { target.end(); } catch { }
    }

    function invalidate(target = connection) {
        if (!target || target !== connection) return;
        connection = null;
        connectionKey = null;
        clearIdleTimer();
        detachAndEnd(target);
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
        connecting = new Promise((resolve, reject) => {
            let settled = false;
            const fail = error => {
                if (settled) return;
                settled = true;
                detachAndEnd(candidate);
                reject(error);
            };
            candidate.once('ready', () => {
                if (settled) return;
                settled = true;
                connection = candidate;
                connectionKey = key;
                candidate.on('error', () => invalidate(candidate));
                candidate.on('close', () => invalidate(candidate));
                candidate.on('end', () => invalidate(candidate));
                scheduleIdleClose(candidate);
                resolve(candidate);
            });
            candidate.once('error', fail);
            if (typeof onKeyboardInteractive === 'function') {
                candidate.on('keyboard-interactive', onKeyboardInteractive);
            }
            try { candidate.connect({ ...config, readyTimeout: readyTimeoutMs }); }
            catch (error) { fail(error); }
        }).finally(() => { connecting = null; });
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

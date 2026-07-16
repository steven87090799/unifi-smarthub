'use strict';

const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

class SshCommandStreamError extends Error {
    constructor(code, message, options = {}) {
        super(`${code}: ${message}`, options.cause ? { cause: options.cause } : undefined);
        this.name = 'SshCommandStreamError';
        this.code = code;
    }
}

function positiveInteger(value, fallback, name) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
    return value;
}

function collectSshCommandOutput(stream, options = {}) {
    if (!stream || typeof stream.on !== 'function' || typeof stream.removeListener !== 'function') {
        throw new TypeError('SSH command stream must be an EventEmitter');
    }
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'SSH command timeout');
    const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'SSH command output limit');
    const stderr = stream.stderr
        && typeof stream.stderr.on === 'function'
        && typeof stream.stderr.removeListener === 'function'
        ? stream.stderr
        : null;

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let totalBytes = 0;
        const stdout = [];

        const cleanup = () => {
            clearTimeout(timer);
            stream.removeListener('data', onStdout);
            stream.removeListener('close', onClose);
            stream.removeListener('error', onError);
            stderr?.removeListener('data', onStderr);
            stderr?.removeListener('error', onError);
        };
        const abort = () => {
            try {
                if (typeof stream.close === 'function') stream.close();
                else if (typeof stream.destroy === 'function') stream.destroy();
            } catch { }
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) {
                abort();
                reject(error);
                return;
            }
            resolve(Buffer.concat(stdout).toString('utf8'));
        };
        const consume = (chunk, retain) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.length;
            if (totalBytes > maxOutputBytes) {
                finish(new SshCommandStreamError(
                    'SSH_COMMAND_OUTPUT_LIMIT',
                    `SSH command output exceeded ${maxOutputBytes} bytes`
                ));
                return;
            }
            if (retain) stdout.push(bytes);
        };
        function onStdout(chunk) { consume(chunk, true); }
        function onStderr(chunk) { consume(chunk, false); }
        function onClose() { finish(); }
        function onError(error) {
            finish(new SshCommandStreamError('SSH_COMMAND_STREAM_FAILED', 'SSH command stream failed', { cause: error }));
        }

        stream.on('data', onStdout);
        stream.on('close', onClose);
        stream.on('error', onError);
        stderr?.on('data', onStderr);
        stderr?.on('error', onError);
        timer = setTimeout(() => finish(new SshCommandStreamError(
            'SSH_COMMAND_TIMEOUT',
            `SSH command did not close within ${timeoutMs} ms`
        )), timeoutMs);
    });
}

function executeSshCommand(connection, command, options = {}) {
    if (!connection || typeof connection.exec !== 'function') throw new TypeError('SSH connection.exec is required');
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('SSH command must be a non-empty string');
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'SSH command timeout');
    const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'SSH command output limit');
    const startedAt = process.hrtime.bigint();

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, output) => {
            if (settled) return;
            settled = true;
            clearTimeout(openTimer);
            if (error) reject(error);
            else resolve(output);
        };
        const openTimer = setTimeout(() => finish(new SshCommandStreamError(
            'SSH_COMMAND_TIMEOUT',
            `SSH command channel did not open within ${timeoutMs} ms`
        )), timeoutMs);

        try {
            connection.exec(command, (error, stream) => {
                if (settled) {
                    try {
                        if (typeof stream?.close === 'function') stream.close();
                        else if (typeof stream?.destroy === 'function') stream.destroy();
                    } catch { }
                    return;
                }
                if (error) {
                    finish(new SshCommandStreamError('SSH_COMMAND_START_FAILED', 'SSH command could not start', { cause: error }));
                    return;
                }
                clearTimeout(openTimer);
                const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
                const remainingMs = Math.max(1, Math.ceil(timeoutMs - elapsedMs));
                let collection;
                try {
                    collection = collectSshCommandOutput(stream, { timeoutMs: remainingMs, maxOutputBytes });
                } catch (streamError) {
                    finish(new SshCommandStreamError(
                        'SSH_COMMAND_STREAM_INVALID',
                        'SSH command returned an invalid stream',
                        { cause: streamError }
                    ));
                    return;
                }
                collection.then(
                    output => finish(null, output),
                    streamError => finish(streamError)
                );
            });
        } catch (error) {
            finish(new SshCommandStreamError('SSH_COMMAND_START_FAILED', 'SSH command could not start', { cause: error }));
        }
    });
}

module.exports = {
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_BYTES,
    SshCommandStreamError,
    collectSshCommandOutput,
    executeSshCommand
};

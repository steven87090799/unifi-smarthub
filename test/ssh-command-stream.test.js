'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
    SshCommandStreamError,
    collectSshCommandOutput,
    executeSshCommand
} = require('../server/integrations/ssh-command-stream');

function commandStream() {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.aborted = 0;
    stream.close = () => { stream.aborted += 1; };
    return stream;
}

function assertReleased(stream) {
    assert.equal(stream.listenerCount('data'), 0);
    assert.equal(stream.listenerCount('close'), 0);
    assert.equal(stream.listenerCount('error'), 0);
    assert.equal(stream.stderr.listenerCount('data'), 0);
    assert.equal(stream.stderr.listenerCount('error'), 0);
}

test('bounded SSH collector returns stdout and releases every listener on close', async () => {
    const stream = commandStream();
    const result = collectSshCommandOutput(stream, { timeoutMs: 1000, maxOutputBytes: 64 });
    stream.emit('data', Buffer.from('hello '));
    stream.stderr.emit('data', Buffer.from('diagnostic'));
    stream.emit('data', 'world');
    stream.emit('close', 0);
    assert.equal(await result, 'hello world');
    assert.equal(stream.aborted, 0);
    assertReleased(stream);
});

test('stalled SSH command aborts at its deadline and releases ownership', async () => {
    const stream = commandStream();
    await assert.rejects(
        collectSshCommandOutput(stream, { timeoutMs: 15, maxOutputBytes: 64 }),
        error => error instanceof SshCommandStreamError && error.code === 'SSH_COMMAND_TIMEOUT'
    );
    assert.equal(stream.aborted, 1);
    assertReleased(stream);
});

test('combined stdout and stderr cannot exceed the command byte budget', async () => {
    const stream = commandStream();
    const result = collectSshCommandOutput(stream, { timeoutMs: 1000, maxOutputBytes: 8 });
    stream.emit('data', Buffer.from('12345'));
    stream.stderr.emit('data', Buffer.from('6789'));
    await assert.rejects(result, error => error.code === 'SSH_COMMAND_OUTPUT_LIMIT');
    assert.equal(stream.aborted, 1);
    assertReleased(stream);
});

test('SSH stream errors settle once, preserve the cause, and release listeners', async () => {
    const stream = commandStream();
    const cause = new Error('transport reset');
    const result = collectSshCommandOutput(stream, { timeoutMs: 1000, maxOutputBytes: 64 });
    stream.emit('error', cause);
    await assert.rejects(result, error => error.code === 'SSH_COMMAND_STREAM_FAILED' && error.cause === cause);
    assert.equal(stream.aborted, 1);
    assertReleased(stream);
});

test('SSH command channel open is covered by the same finite deadline', async () => {
    const connection = { exec() {} };
    await assert.rejects(
        executeSshCommand(connection, 'bounded-command', { timeoutMs: 15, maxOutputBytes: 64 }),
        error => error.code === 'SSH_COMMAND_TIMEOUT' && /channel/u.test(error.message)
    );
});

test('late command channel is aborted after the caller has timed out', async () => {
    let callback;
    const connection = { exec(_command, next) { callback = next; } };
    const result = executeSshCommand(connection, 'bounded-command', { timeoutMs: 15, maxOutputBytes: 64 });
    await assert.rejects(result, error => error.code === 'SSH_COMMAND_TIMEOUT');
    const stream = commandStream();
    callback(null, stream);
    assert.equal(stream.aborted, 1);
});

test('command start and invalid asynchronous stream callbacks reject without escaping', async () => {
    const startCause = new Error('channel rejected');
    await assert.rejects(
        executeSshCommand({ exec(_command, callback) { callback(startCause); } }, 'bounded-command'),
        error => error.code === 'SSH_COMMAND_START_FAILED' && error.cause === startCause
    );
    await assert.rejects(
        executeSshCommand({ exec(_command, callback) { queueMicrotask(() => callback(null, null)); } }, 'bounded-command'),
        error => error.code === 'SSH_COMMAND_STREAM_INVALID' && error.cause instanceof TypeError
    );
});

test('end-to-end SSH command execution returns bounded stream output', async () => {
    const stream = commandStream();
    const connection = {
        exec(command, callback) {
            assert.equal(command, 'bounded-command');
            callback(null, stream);
        }
    };
    const result = executeSshCommand(connection, 'bounded-command', { timeoutMs: 1000, maxOutputBytes: 64 });
    stream.emit('data', 'complete');
    stream.emit('close', 0);
    assert.equal(await result, 'complete');
    assertReleased(stream);
});

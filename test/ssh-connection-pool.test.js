'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
    DEFAULT_READY_TIMEOUT_MS,
    createSshConnectionPool
} = require('../server/integrations/ssh-connection-pool');

class FakeConnection extends EventEmitter {
    constructor() {
        super();
        this.connectOptions = null;
        this.endCalls = 0;
    }

    connect(options) {
        this.connectOptions = options;
        queueMicrotask(() => this.emit('ready'));
    }

    end() { this.endCalls += 1; }
}

class ManualConnection extends FakeConnection {
    connect(options) { this.connectOptions = options; }
}

test('reuses one ready SSH connection, serializes commands, and applies a ten second ready timeout', async () => {
    const connections = [];
    let active = 0;
    let peak = 0;
    const pool = createSshConnectionPool({
        getConfig: () => ({ host: 'device.test', port: 22, username: 'user', password: 'secret' }),
        createConnection: () => {
            const connection = new FakeConnection();
            connections.push(connection);
            return connection;
        },
        execute: async (_connection, command) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(resolve => setImmediate(resolve));
            active -= 1;
            return command.toUpperCase();
        }
    });

    assert.deepEqual(await Promise.all([pool.execute('one'), pool.execute('two')]), ['ONE', 'TWO']);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].connectOptions.readyTimeout, DEFAULT_READY_TIMEOUT_MS);
    assert.equal(peak, 1);
    pool.close();
    assert.equal(connections[0].endCalls, 1);
});

test('rotates the connection after configuration changes and reconnects after command failure', async () => {
    const connections = [];
    let host = 'one.test';
    let fail = false;
    const pool = createSshConnectionPool({
        getConfig: () => ({ host, username: 'user', password: 'secret' }),
        createConnection: () => {
            const connection = new FakeConnection();
            connections.push(connection);
            return connection;
        },
        execute: async () => {
            if (fail) throw new Error('stream failed');
            return 'ok';
        }
    });

    assert.equal(await pool.execute('first'), 'ok');
    host = 'two.test';
    assert.equal(await pool.execute('second'), 'ok');
    assert.equal(connections.length, 2);
    assert.equal(connections[0].endCalls, 1);

    fail = true;
    await assert.rejects(pool.execute('third'), /stream failed/);
    assert.equal(connections[1].endCalls, 1);
    fail = false;
    assert.equal(await pool.execute('fourth'), 'ok');
    assert.equal(connections.length, 3);
    pool.close();
});

test('close before ready rejects pending and queued commands and ends the candidate exactly once', async () => {
    const connection = new ManualConnection();
    const pool = createSshConnectionPool({
        getConfig: () => ({ host: 'device.test', username: 'user' }),
        createConnection: () => connection,
        execute: async () => 'ok'
    });
    const first = pool.execute('first');
    const second = pool.execute('second');
    await new Promise(resolve => setImmediate(resolve));
    pool.close();
    pool.close();

    await assert.rejects(first, /closed/i);
    await assert.rejects(second, /closed/i);
    assert.equal(connection.endCalls, 1);
    await assert.rejects(pool.execute('after-close'), /closed/i);
});

test('late ready and error events cannot resurrect a closed SSH pool', async () => {
    const connections = [];
    const pool = createSshConnectionPool({
        getConfig: () => ({ host: 'device.test', username: 'user' }),
        createConnection: () => {
            const connection = new ManualConnection();
            connections.push(connection);
            return connection;
        },
        execute: async () => 'unexpected'
    });
    const pending = pool.execute('first');
    await new Promise(resolve => setImmediate(resolve));
    pool.close();
    connections[0].emit('ready');
    connections[0].emit('error', new Error('late error'));
    await assert.rejects(pending, /closed/i);
    assert.equal(connections[0].endCalls, 1);
    await assert.rejects(pool.execute('second'), /closed/i);
    assert.equal(connections.length, 1);
});

test('host fingerprint rotates pool identity but internal metadata is never passed to ssh2', async () => {
    const connections = [];
    let fingerprint = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const verifier = () => true;
    const pool = createSshConnectionPool({
        getConfig: () => ({ host: 'device.test', username: 'user', password: 'secret', hostKeyFingerprint: fingerprint, hostVerifier: verifier }),
        createConnection: () => {
            const connection = new FakeConnection();
            connections.push(connection);
            return connection;
        },
        execute: async () => 'ok'
    });
    assert.equal(await pool.execute('first'), 'ok');
    assert.equal(connections[0].connectOptions.hostKeyFingerprint, undefined);
    assert.equal(connections[0].connectOptions.hostVerifier, verifier);
    fingerprint = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    assert.equal(await pool.execute('second'), 'ok');
    assert.equal(connections.length, 2);
    assert.equal(connections[0].endCalls, 1);
    pool.close();
});

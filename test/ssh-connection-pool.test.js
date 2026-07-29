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

class DeferredConnection extends FakeConnection {
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

test('closing during CONNECTING cancels the candidate and late ready never executes a command', async () => {
    const connections = [];
    let executions = 0;
    const pool = createSshConnectionPool({
        getConfig: () => ({ host: 'device.test', username: 'user', password: 'secret' }),
        createConnection: () => {
            const connection = new DeferredConnection();
            connections.push(connection);
            return connection;
        },
        execute: async () => { executions += 1; return 'unexpected'; }
    });

    const pending = pool.execute('thermal');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connections.length, 1);
    pool.close();
    await assert.rejects(pending, /pool is closed/);
    assert.equal(connections[0].endCalls, 1);
    connections[0].emit('ready');
    connections[0].emit('error', new Error('late connection error'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 0);
    await assert.rejects(pool.execute('again'), /pool is closed/);
});

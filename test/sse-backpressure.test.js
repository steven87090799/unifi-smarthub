'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSseBackpressure } = require('../server/services/sse-backpressure');

class SlowClient extends EventEmitter {
    constructor({ accepted = false, writableLength = 0 } = {}) {
        super(); this.accepted = accepted; this.writableLength = writableLength; this.writableEnded = false; this.destroyed = false;
    }
    write() { return this.accepted; }
    end() { this.writableEnded = true; }
}

test('slow SSE clients are removed when their socket buffer exceeds the cap', () => {
    const removed = [];
    const broadcaster = createSseBackpressure({ maxWritableLength: 16, onRemove: client => removed.push(client) });
    const client = new SlowClient({ writableLength: 17 });
    assert.equal(broadcaster.write(client, Buffer.from('event')), false);
    assert.equal(client.writableEnded, true);
    assert.deepEqual(removed, [client]);
});

test('an undrained SSE client is closed without blocking another client', () => {
    let timer;
    const removed = [];
    const broadcaster = createSseBackpressure({
        drainTimeoutMs: 1,
        setTimeoutFn: callback => { timer = callback; return 1; },
        clearTimeoutFn: () => {},
        onRemove: client => removed.push(client)
    });
    const slow = new SlowClient({ accepted: false });
    const healthy = new SlowClient({ accepted: true });
    assert.equal(broadcaster.write(slow, Buffer.from('event')), true);
    assert.equal(broadcaster.write(healthy, Buffer.from('event')), true);
    timer();
    assert.equal(slow.writableEnded, true);
    assert.equal(healthy.writableEnded, false);
    assert.deepEqual(removed, [slow]);
});

test('a drained SSE client remains subscribed', () => {
    const removed = [];
    const broadcaster = createSseBackpressure({ onRemove: client => removed.push(client) });
    const client = new SlowClient({ accepted: false });
    broadcaster.write(client, Buffer.from('event'));
    client.emit('drain');
    assert.equal(client.writableEnded, false);
    assert.deepEqual(removed, []);
});

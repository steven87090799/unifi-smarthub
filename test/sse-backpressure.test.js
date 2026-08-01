'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSseBackpressureManager } = require('../server/services/sse-backpressure');

class FakeResponse extends EventEmitter {
    constructor({ accepted = true, writableLength = 0 } = {}) {
        super();
        this.accepted = accepted;
        this.writableLength = writableLength;
        this.writableEnded = false;
        this.destroyed = false;
        this.endCalls = 0;
    }

    write() { return this.accepted; }

    end() { this.endCalls += 1; this.writableEnded = true; }
}

test('SSE manager bounds clients, evicts slow writers, and cleans timers/listeners', async () => {
    const evictions = [];
    const manager = createSseBackpressureManager({ maxClients: 2, maxWritableLength: 10, drainTimeoutMs: 20, onEvict: (_res, reason) => evictions.push(reason) });
    const slow = new FakeResponse({ accepted: false });
    const healthy = new FakeResponse();
    const excess = new FakeResponse();
    assert.equal(manager.add(slow), true);
    assert.equal(manager.add(healthy), true);
    assert.equal(manager.add(excess), false);
    manager.broadcast('event\n\n');
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(manager.has(slow), false);
    assert.equal(manager.size, 1);
    assert.ok(evictions.includes('drain_timeout'));
    manager.remove(healthy);
    assert.equal(healthy.endCalls, 1);
    manager.closeAll();
    assert.equal(manager.size, 0);
    assert.equal(slow.listenerCount('drain'), 0);
    assert.equal(slow.listenerCount('close'), 0);
    assert.equal(slow.listenerCount('error'), 0);
});

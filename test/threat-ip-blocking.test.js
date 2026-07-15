'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryDb } = require('../db');
const {
    ThreatIpBlockingError,
    createThreatIpBlockingService
} = require('../server/services/threat-ip-blocking');

function createFixture(t, { timestamp = Date.parse('2026-07-15T00:00:00.000Z') } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-threat-block-'));
    let db = createHistoryDb(dir);
    let now = timestamp;
    const calls = [];
    let failure = null;
    let delay = null;
    const client = {
        configuration: () => ({ configured: true, missing: [], listName: 'SmartHub Threat Blocks' }),
        replace: async addresses => {
            calls.push([...addresses]);
            if (delay) await delay;
            if (failure) throw failure;
            return { changed: true, addresses };
        }
    };
    let service = createThreatIpBlockingService({ repository: db, client, now: () => now });
    t.after(() => {
        try { db.close(); } catch { }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return {
        get db() { return db; },
        get service() { return service; },
        calls,
        advance(ms) { now += ms; },
        failWith(error) { failure = error; },
        setDelay(promise) { delay = promise; },
        reopen() {
            db.close();
            db = createHistoryDb(dir);
            service = createThreatIpBlockingService({ repository: db, client, now: () => now });
        }
    };
}

test('add, duplicate extension, removal, expiry, and audit are durable and idempotent', async t => {
    const fixture = createFixture(t);
    const first = await fixture.service.add({ ip: '8.8.8.8', expiresInMinutes: 15 });
    assert.equal(first.applied, true);
    assert.equal(first.duplicate, false);
    assert.deepEqual(fixture.calls.at(-1), ['8.8.8.8']);

    const duplicate = await fixture.service.add({ ip: '8.8.8.8', expiresInMinutes: 15 });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.extended, false);
    assert.equal(fixture.db.listThreatIpBlocks().length, 1);

    const extended = await fixture.service.add({ ip: '8.8.8.8', expiresInMinutes: 60 });
    assert.equal(extended.extended, true);
    const block = fixture.db.listThreatIpBlocks()[0];
    assert.equal(block.syncState, 'applied');
    assert.ok(fixture.db.listThreatIpBlockAudit().some(entry => entry.action === 'extend'));

    const removed = await fixture.service.remove(block.id);
    assert.equal(removed.applied, true);
    assert.equal(fixture.db.listThreatIpBlocks().length, 0);
    assert.deepEqual(fixture.calls.at(-1), []);

    await fixture.service.add({ ip: '9.9.9.9', expiresInMinutes: 15 });
    fixture.advance(16 * 60 * 1000);
    await fixture.service.reconcile({ force: true });
    assert.equal(fixture.db.listThreatIpBlocks().length, 0);
    assert.ok(fixture.db.listThreatIpBlockAudit().some(entry => entry.action === 'expire'));
});

test('upstream failure persists pending intent and bounded retry metadata across restart', async t => {
    const fixture = createFixture(t);
    const failure = new Error('controller offline');
    failure.code = 'upstream_unavailable';
    failure.retryable = true;
    fixture.failWith(failure);
    const pending = await fixture.service.add({ ip: '8.8.4.4', expiresInMinutes: 60 });
    assert.equal(pending.applied, false);
    let block = fixture.db.listThreatIpBlocks()[0];
    assert.equal(block.syncState, 'error');
    assert.equal(block.attemptCount, 1);
    assert.ok(block.nextRetryTs > block.createdTs);

    fixture.reopen();
    fixture.failWith(null);
    const recovered = await fixture.service.reconcile({ force: true });
    assert.equal(recovered.applied, true);
    block = fixture.db.listThreatIpBlocks()[0];
    assert.equal(block.syncState, 'applied');
    assert.equal(block.attemptCount, 0);
    assert.equal(block.lastError, null);
});

test('mutations serialize with reconciliation so concurrent adds cannot be falsely marked applied', async t => {
    const fixture = createFixture(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fixture.setDelay(gate);
    const first = fixture.service.add({ ip: '8.8.8.8', expiresInMinutes: 60 });
    await new Promise(resolve => setImmediate(resolve));
    const second = fixture.service.add({ ip: '9.9.9.9', expiresInMinutes: 60 });
    release();
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.applied));
    assert.deepEqual(fixture.calls, [['8.8.8.8'], ['8.8.8.8', '9.9.9.9']]);
    assert.ok(fixture.db.listThreatIpBlocks().every(block => block.syncState === 'applied'));
});

test('add fails closed before persistence when Integration API identity is not configured', async t => {
    const fixture = createFixture(t);
    const service = createThreatIpBlockingService({
        repository: fixture.db,
        client: {
            configuration: () => ({ configured: false, missing: ['UNIFI_NETWORK_API_KEY'], listName: 'SmartHub Threat Blocks' }),
            replace: async () => { throw new Error('must not run'); }
        }
    });
    await assert.rejects(service.add({ ip: '8.8.8.8', expiresInMinutes: 15 }), error => (
        error instanceof ThreatIpBlockingError && error.httpStatus === 503
    ));
    assert.equal(fixture.db.listThreatIpBlocks().length, 0);
});

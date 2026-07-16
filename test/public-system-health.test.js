'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
    createPublicSystemHealthService,
    normalizeSnapshot
} = require('../server/services/public-system-health');

test('public health service aggregates anonymous node states into a minimal fixed snapshot', () => {
    const service = createPublicSystemHealthService();
    const snapshot = service.update([
        { online: true, critical: true, name: 'must-not-leak', ip: '192.0.2.10' },
        { online: true },
        { online: false },
        { included: false, online: false }
    ], Date.parse('2026-07-16T06:32:18.000Z'));

    assert.deepEqual(snapshot, {
        status: 'degraded',
        total: 3,
        online: 2,
        offline: 1,
        snapshotAt: '2026-07-16T06:32:18.000Z'
    });
    assert.deepEqual(Object.keys(snapshot), ['status', 'total', 'online', 'offline', 'snapshotAt']);
    assert.doesNotMatch(JSON.stringify(snapshot), /name|ip|host|port|error|version|container/i);
});

test('critical core failures and unknown startup state use the bounded public vocabulary', () => {
    const service = createPublicSystemHealthService();
    assert.deepEqual(service.read(), {
        status: 'unknown',
        total: 0,
        online: 0,
        offline: 0,
        snapshotAt: null
    });
    assert.equal(service.update([
        { online: true, critical: true },
        { online: false, critical: true },
        { online: true }
    ], 1000).status, 'critical');
});

test('snapshot validation rejects inconsistent counts and non-public fields are discarded', () => {
    assert.throws(() => normalizeSnapshot({
        status: 'operational', total: 3, online: 2, offline: 0, snapshotAt: new Date().toISOString()
    }), /internally consistent/);
    assert.deepEqual(normalizeSnapshot({
        status: 'operational',
        total: 1,
        online: 1,
        offline: 0,
        snapshotAt: '2026-07-16T06:32:18.000Z',
        hostname: 'private-host',
        error: 'private-error'
    }), {
        status: 'operational',
        total: 1,
        online: 1,
        offline: 0,
        snapshotAt: '2026-07-16T06:32:18.000Z'
    });
});

test('public endpoint only reads the retained snapshot and applies a bounded per-client rate limit', async t => {
    let clock = 10_000;
    const service = createPublicSystemHealthService({
        now: () => clock,
        maxRequests: 2,
        windowMs: 1000,
        maxClients: 2
    });
    const retained = service.update([{ online: true }], clock);
    const app = express();
    app.get('/api/public/system-health', service.handle);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const first = await fetch(`${base}/api/public/system-health`);
    const second = await fetch(`${base}/api/public/system-health`);
    const limited = await fetch(`${base}/api/public/system-health`);
    assert.deepEqual(await first.json(), retained);
    assert.deepEqual(await second.json(), retained);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal(first.headers.get('cache-control'), 'private, max-age=0, no-store');
    assert.deepEqual(service.read(), retained);

    clock += 1001;
    assert.equal((await fetch(`${base}/api/public/system-health`)).status, 200);
});

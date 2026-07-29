'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityLease } = require('../activity-lease');

test('device activity leases are scoped, server-timed, and expire without renewal', () => {
    let now = 1000;
    const lease = createActivityLease({ now: () => now, maxLeaseMs: 45000 });
    const first = lease.mark('nas,unknown', 30000);
    assert.deepEqual(first.accepted, ['nas']);
    assert.deepEqual(first.activated, ['nas']);
    assert.equal(lease.isActive('nas'), true);
    assert.equal(lease.isActive('wiim'), false);

    now += 5000;
    assert.deepEqual(lease.mark('nas', 30000).activated, []);

    now += 30000;
    assert.equal(lease.isActive('nas'), false);
    assert.deepEqual(lease.mark('nas', 30000).activated, ['nas']);
});

test('activity lease has a hard 3 minute maximum even for an excessive request', () => {
    let now = 1000;
    const lease = createActivityLease({ now: () => now, maxLeaseMs: 180000 });
    const mark = lease.mark('wiim', 3600 * 1000);
    assert.equal(mark.expiresAt, 181000);
    now = 180999;
    assert.equal(lease.isActive('wiim'), true);
    now = 181000;
    assert.equal(lease.isActive('wiim'), false);
});

test('focus replacement immediately releases the previous device scope', () => {
    let now = 1000;
    const lease = createActivityLease({ now: () => now });
    lease.mark('nas', 30000);
    assert.equal(lease.isActive('nas'), true);

    const focused = lease.mark('ucg', 30000, { replace: true });
    assert.deepEqual(focused.accepted, ['ucg']);
    assert.equal(lease.isActive('nas'), false);
    assert.equal(lease.isActive('ucg'), true);
});

test('one hidden session does not release another visible session, and expiry is cleaned', () => {
    let now = 1000;
    const lease = createActivityLease({ now: () => now, maxLeaseMs: 45000 });
    lease.mark('general,nas', 30000, { sessionId: 'visible-tab' });
    lease.mark('general,ups', 30000, { sessionId: 'ups-tab' });
    lease.mark('', 30000, { sessionId: 'visible-tab', replace: true });

    assert.equal(lease.isActive('general'), true);
    assert.equal(lease.isActive('nas'), false);
    assert.equal(lease.isActive('ups'), true);
    assert.equal(lease.sessionCount(), 1);

    now += 30000;
    assert.deepEqual(lease.activeScopes(), []);
    assert.equal(lease.sessionCount(), 0);
});

test('activity lease bounds sessions, evicts least recently used, and keeps diagnostics private', () => {
    let now = 1000;
    const lease = createActivityLease({
        now: () => now,
        maxLeaseMs: 45000,
        maxSessions: 2,
        maxScopesPerSession: 2
    });
    lease.mark('nas', 30000, { sessionId: 'tab-a' });
    now += 1;
    lease.mark('ups', 30000, { sessionId: 'tab-b' });
    now += 1;
    lease.mark('nas', 30000, { sessionId: 'tab-a' });
    now += 1;
    lease.mark('wiim', 30000, { sessionId: 'tab-c' });

    assert.equal(lease.sessionCount(), 2);
    assert.equal(lease.isActive('nas'), true);
    assert.equal(lease.isActive('ups'), false);
    assert.equal(lease.isActive('wiim'), true);
    assert.deepEqual(lease.snapshot(), {
        sessionCount: 2,
        activeScopes: ['nas', 'wiim'],
        evictions: 1,
        maxSessions: 2,
        expiredSessionsRemoved: 0
    });
    assert.doesNotMatch(JSON.stringify(lease.snapshot()), /tab-[abc]/u);
});

test('activity lease prunes expired sessions before eviction and bounds scopes per session', () => {
    let now = 1000;
    const lease = createActivityLease({
        now: () => now,
        maxLeaseMs: 2000,
        maxSessions: 2,
        maxScopesPerSession: 2
    });
    lease.mark('nas,ups,wiim', 1000, { sessionId: 'old' });
    assert.deepEqual(lease.activeScopes(), ['nas', 'ups']);
    now = 2000;
    lease.mark('linux', 1000, { sessionId: 'new' });
    assert.equal(lease.sessionCount(), 1);
    assert.equal(lease.snapshot().evictions, 0);
    assert.equal(lease.snapshot().expiredSessionsRemoved, 1);

    const before = lease.sessionCount();
    lease.mark('unknown', 1000, { sessionId: 'attacker' });
    assert.equal(lease.sessionCount(), before);
    lease.mark('', 1000, { replace: true, sessionId: 'new' });
    assert.equal(lease.sessionCount(), 0);
});

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

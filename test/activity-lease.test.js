'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityLease } = require('../activity-lease');

test('device activity leases are scoped, server-timed, and expire without renewal', () => {
    let now = 1000;
    const lease = createActivityLease({ now: () => now, maxLeaseMs: 45000 });
    assert.deepEqual(lease.mark('nas,unknown', 30000).accepted, ['nas']);
    assert.equal(lease.isActive('nas'), true);
    assert.equal(lease.isActive('wiim'), false);

    now += 30000;
    assert.equal(lease.isActive('nas'), false);
});

test('activity lease has a hard 45 second maximum even for an excessive request', () => {
    let now = 1000;
    const lease = createActivityLease({ now: () => now, maxLeaseMs: 45000 });
    const mark = lease.mark('wiim', 3600 * 1000);
    assert.equal(mark.expiresAt, 46000);
    now = 45999;
    assert.equal(lease.isActive('wiim'), true);
    now = 46000;
    assert.equal(lease.isActive('wiim'), false);
});

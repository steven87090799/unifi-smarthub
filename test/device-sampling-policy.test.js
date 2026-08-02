'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeviceSamplingPolicy } = require('../server/services/device-sampling-policy');

test('general device sampling uses central Active 5s and Idle 600s settings', () => {
    let active = true;
    const policy = createDeviceSamplingPolicy({
        getSettings: () => ({ deviceActiveBackendSampleSec: 5, deviceIdleBackendSampleSec: 600 }),
        isActive: () => active
    });
    assert.equal(policy.deviceMs('nas'), 5_000);
    active = false;
    assert.equal(policy.deviceMs('nas'), 600_000);
});

test('PPB event sampling stays on its independent UPS Active/Idle settings', () => {
    let upsActive = true;
    const policy = createDeviceSamplingPolicy({
        getSettings: () => ({
            deviceActiveBackendSampleSec: 5,
            deviceIdleBackendSampleSec: 600,
            upsActiveBackendSampleSec: 3,
            upsIdleBackendSampleSec: 10,
            upsPpbEventActiveBackendSampleSec: 10,
            upsPpbEventIdleBackendSampleSec: 60
        }),
        isActive: scope => scope === 'ups' && upsActive
    });
    assert.equal(policy.ppbEventMs(), 10_000);
    assert.equal(policy.upsMs(), 3_000);
    upsActive = false;
    assert.equal(policy.ppbEventMs(), 60_000);
    assert.equal(policy.upsMs(), 10_000);
    assert.equal(policy.deviceMs('nas'), 600_000);
});

test('history metadata exposes the effective Active/Idle interval and mode', () => {
    let active = true;
    const policy = createDeviceSamplingPolicy({
        getSettings: () => ({ deviceActiveBackendSampleSec: 5, deviceIdleBackendSampleSec: 600 }),
        isActive: scope => scope === 'wiim' && active
    });
    assert.deepEqual(policy.deviceIntervals('wiim'), {
        activeMs: 5_000, idleMs: 600_000, currentMs: 5_000, currentMode: 'active'
    });
    active = false;
    assert.deepEqual(policy.deviceIntervals('wiim'), {
        activeMs: 5_000, idleMs: 600_000, currentMs: 600_000, currentMode: 'idle'
    });
});

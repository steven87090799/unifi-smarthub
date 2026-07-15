'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    REMOVE_CONFIRMATION,
    blockingActiveAt,
    buildInactiveSchedule,
    expandCategories,
    parsePolicyRemoval,
    parsePolicyRequest,
    publicCategoryDefinitions
} = require('../server/policies/adguard-service-policy');

const POLICY = {
    deviceId: '192.168.1.50',
    categories: ['youtube', 'tiktok'],
    timeZone: 'Asia/Taipei',
    allowWindows: {
        mon: { start: '18:00', end: '20:30' },
        sat: { start: '00:00', end: '24:00' }
    }
};

test('policy input canonicalizes identity and categories with exact per-day allow windows', () => {
    assert.deepEqual(parsePolicyRequest({
        ...POLICY,
        deviceId: 'AA:BB:CC:DD:EE:FF',
        categories: ['tiktok', 'youtube']
    }), {
        ...POLICY,
        deviceId: 'aa:bb:cc:dd:ee:ff',
        categories: ['tiktok', 'youtube']
    });
    assert.equal(parsePolicyRequest({ ...POLICY, deviceId: '2001:0db8::1' }).deviceId, '2001:db8::1');
    assert.deepEqual(buildInactiveSchedule(POLICY), {
        time_zone: 'Asia/Taipei',
        mon: { start: 18 * 60 * 60_000, end: (20 * 60 + 30) * 60_000 },
        sat: { start: 0, end: 24 * 60 * 60_000 }
    });
});

test('policy validation rejects ambiguous identity, service, timezone, and schedule boundaries', () => {
    const invalid = [
        { ...POLICY, deviceId: 'living-room' },
        { ...POLICY, categories: [] },
        { ...POLICY, categories: ['youtube', 'youtube'] },
        { ...POLICY, categories: ['unknown'] },
        { ...POLICY, timeZone: 'Local' },
        { ...POLICY, timeZone: 'Mars/Olympus' },
        { ...POLICY, allowWindows: { mon: { start: '20:00', end: '18:00' } } },
        { ...POLICY, allowWindows: { mon: { start: '18:00', end: '18:00' } } },
        { ...POLICY, allowWindows: { mon: { start: '18:00', end: '24:01' } } },
        { ...POLICY, allowWindows: { holiday: { start: '18:00', end: '20:00' } } }
    ];
    for (const candidate of invalid) assert.throws(() => parsePolicyRequest(candidate));
    assert.throws(() => parsePolicyRequest({ ...POLICY, extra: true }));
});

test('allow windows are deterministic half-open inactivity periods in the selected timezone', () => {
    const weekday = { ...POLICY, allowWindows: { mon: { start: '18:00', end: '20:30' } } };
    assert.equal(blockingActiveAt(weekday, new Date('2026-07-13T09:59:00Z')), true);  // 17:59 Taipei
    assert.equal(blockingActiveAt(weekday, new Date('2026-07-13T10:00:00Z')), false); // 18:00 Taipei
    assert.equal(blockingActiveAt(weekday, new Date('2026-07-13T12:29:00Z')), false); // 20:29 Taipei
    assert.equal(blockingActiveAt(weekday, new Date('2026-07-13T12:30:00Z')), true);  // 20:30 Taipei
    assert.equal(blockingActiveAt(weekday, new Date('2026-07-14T10:00:00Z')), true);  // no Tuesday window
});

test('controlled definitions expand category isolation and removal requires exact confirmation', () => {
    assert.deepEqual(expandCategories(['youtube']), ['youtube']);
    const gaming = expandCategories(['gaming']);
    assert.ok(gaming.includes('steam'));
    assert.ok(gaming.includes('xboxlive'));
    assert.equal(gaming.includes('youtube'), false);
    const definitions = publicCategoryDefinitions();
    assert.equal(definitions.scheduleSemantics, 'allow_windows_when_blocking_is_inactive');
    assert.ok(definitions.source.startsWith('https://github.com/AdguardTeam/'));
    assert.deepEqual(parsePolicyRemoval('11111111-1111-4111-8111-111111111111', {
        confirmation: REMOVE_CONFIRMATION
    }), { id: '11111111-1111-4111-8111-111111111111' });
    assert.throws(() => parsePolicyRemoval('11111111-1111-4111-8111-111111111111', { confirmation: 'yes' }));
});

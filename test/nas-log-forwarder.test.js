'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { forwardNasLogs, forwardNasAlerts } = require('../nas-log-forwarder');

test('NAS log baseline is recorded without flooding the phone', async () => {
    const knownIds = new Set();
    const messages = [];
    const count = await forwardNasLogs([
        { log_id: 'old-1', level: 'info', module: 'system', content: 'existing event' }
    ], { knownIds, bootstrapped: false, notify: async (...args) => messages.push(args) });
    assert.equal(count, 0);
    assert.equal(knownIds.has('old-1'), true);
    assert.deepEqual(messages, []);
});

test('every newly received NAS log is immediately forwarded once', async () => {
    const knownIds = new Set(['old-1']);
    const messages = [];
    const notify = async (...args) => messages.push(args);
    const logs = [
        { log_id: 'new-1', level: 'warning', module: 'storage', content: 'disk warning' },
        { log_id: 'new-2', level: 'critical', module: 'system', content: 'critical event' }
    ];
    assert.equal(await forwardNasLogs(logs, { knownIds, bootstrapped: true, notify }), 2);
    assert.equal(messages.length, 2);
    assert.match(messages[0][0], /NAS 日誌/);
    assert.match(messages[0][1], /disk warning/);
    assert.equal(await forwardNasLogs(logs, { knownIds, bootstrapped: true, notify }), 0);
    assert.equal(messages.length, 2);
});

test('new NAS alerts are immediately forwarded while info and acknowledged events stay quiet', async () => {
    const knownIds = new Set();
    const messages = [];
    const events = [
        { id: 'alert-1', level: 'critical', message: 'volume degraded' },
        { id: 'alert-2', level: 'info', message: 'routine event' },
        { id: 'alert-3', level: 'warning', acknowledged: true, message: 'already handled' }
    ];
    assert.equal(await forwardNasAlerts(events, {
        knownIds, bootstrapped: true, notify: async (...args) => messages.push(args)
    }), 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /NAS 警報/);
    assert.match(messages[0][1], /volume degraded/);
    assert.equal(await forwardNasAlerts(events, {
        knownIds, bootstrapped: true, notify: async (...args) => messages.push(args)
    }), 0);
});

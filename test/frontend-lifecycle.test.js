'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createHydrationCoordinator,
    createObserverRegistry,
    createScopedResource,
    shouldSchedulePollJob
} = require('../public/js/frontend-lifecycle');

const deferred = () => {
    let resolve;
    const promise = new Promise(next => { resolve = next; });
    return { promise, resolve };
};

test('hydration is structured, safe while pending, and retries only failed jobs', async () => {
    const pending = deferred();
    const calls = [];
    let attempts = 0;
    const coordinator = createHydrationCoordinator({
        pages: { nas: ['heartbeat', 'nasAlerts'] },
        runJob: async key => {
            calls.push(key);
            if (key === 'heartbeat') return { ok: true };
            attempts += 1;
            if (attempts === 1) {
                await pending.promise;
                throw new Error('NAS unavailable');
            }
            return { ok: true };
        }
    });

    const first = coordinator.hydratePage('nas', { generation: 1 });
    assert.equal(coordinator.isInFlight('nas'), true);
    assert.equal(shouldSchedulePollJob({ isVisible: true, configured: true, hydrationPending: true, common: true, key: 'heartbeat' }), true);
    assert.equal(shouldSchedulePollJob({ isVisible: true, configured: true, hydrationPending: true, common: false, pageJobs: ['nasAlerts'], key: 'nasAlerts' }), false);
    pending.resolve();
    const firstResult = await first;
    assert.equal(firstResult.loaded, false);
    assert.deepEqual(firstResult.failures.map(item => item.key), ['nasAlerts']);
    assert.deepEqual(coordinator.completedJobs('nas'), new Set(['heartbeat']));

    const secondResult = await coordinator.hydratePage('nas', { generation: 2 });
    assert.equal(secondResult.loaded, true);
    assert.deepEqual(calls, ['heartbeat', 'nasAlerts', 'nasAlerts']);
    assert.equal(coordinator.isLoaded('nas'), true);
    await assert.doesNotReject(() => coordinator.hydratePage('nas', { generation: 3 }));
    assert.deepEqual(calls, ['heartbeat', 'nasAlerts', 'nasAlerts']);
});

test('scoped resource lifecycle prevents duplicate and stale-generation connections', () => {
    let visible = true;
    let page = 'nas';
    let generation = 1;
    const closed = [];
    const resource = createScopedResource({
        canStart: candidate => visible && page === 'nas' && candidate === generation,
        close: value => closed.push(value)
    });
    const first = { id: 1 };
    assert.equal(resource.connect(1, () => first), true);
    assert.equal(resource.connect(1, () => ({ id: 2 })), false);
    assert.equal(resource.isCurrent(first, 1), true);
    visible = false;
    assert.equal(resource.isCurrent(first, 1), false);
    resource.disconnect();
    assert.deepEqual(closed, [first]);
    visible = true;
    generation = 2;
    assert.equal(resource.connect(1, () => ({ id: 3 })), false);
    const second = { id: 4 };
    assert.equal(resource.connect(2, () => second), true);
    assert.equal(resource.isCurrent(second, 2), true);
    page = 'overview';
    assert.equal(resource.isCurrent(second, 2), false);
});

test('observer registry is change-driven and fully tears down', () => {
    const observers = [];
    const registry = createObserverRegistry({
        createObserver: callback => {
            const entry = { callback, observed: null, disconnected: false };
            entry.observe = source => { entry.observed = source; };
            entry.disconnect = () => { entry.disconnected = true; };
            observers.push(entry);
            return entry;
        }
    });
    const sourceA = {};
    const sourceB = {};
    const holder = {};
    registry.observe(holder, sourceA, () => {}, { subtree: true });
    registry.observe(holder, sourceA, () => {}, { subtree: true });
    assert.equal(registry.size(), 1);
    assert.equal(observers.length, 1);
    registry.observe(holder, sourceB, () => {}, { subtree: true });
    assert.equal(observers[0].disconnected, true);
    assert.equal(registry.size(), 1);
    registry.disconnectAll();
    assert.equal(observers[1].disconnected, true);
    assert.equal(registry.size(), 0);
});

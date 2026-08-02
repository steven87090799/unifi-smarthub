'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeviceCollectorCache } = require('../server/services/device-collector-cache');
const { createDockerLogSnapshot } = require('../server/services/docker-log-snapshot');

const deferred = () => {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
};

test('Docker inventory may refresh at 5s but logs stay at least 30s between upstream calls', async () => {
    let now = 0;
    let calls = 0;
    const cache = createDeviceCollectorCache({ now: () => now, cacheAgeMs: () => 5_000 });
    const logs = createDockerLogSnapshot({
        cache,
        getMinIntervalMs: () => 5_000,
        fetch: async id => ({ logs: `error ${id}`, call: ++calls })
    });
    await logs.readInventory([{ id: 'container-a' }]);
    now = 5_001;
    await logs.readInventory([{ id: 'container-a' }]);
    assert.equal(calls, 1);
    now = 30_001;
    await logs.readInventory([{ id: 'container-a' }]);
    assert.equal(calls, 2);
});

test('disabled Docker log notifications do not read logs', async () => {
    let calls = 0;
    const cache = createDeviceCollectorCache();
    const logs = createDockerLogSnapshot({ cache, fetch: async () => { calls += 1; return 'error'; } });
    await logs.readInventory([{ id: 'container-a' }], { enabled: false });
    assert.equal(calls, 0);
    assert.equal(cache.names().length, 0);
});

test('watcher and API log callers share one per-container singleflight', async () => {
    const gate = deferred();
    let calls = 0;
    const cache = createDeviceCollectorCache();
    const logs = createDockerLogSnapshot({
        cache,
        fetch: async id => {
            calls += 1;
            await gate.promise;
            return { id, logs: 'error' };
        }
    });
    const first = logs.read('container-a');
    const second = logs.read('container-a', { lines: 1000 });
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), [
        { id: 'container-a', logs: 'error' },
        { id: 'container-a', logs: 'error' }
    ]);
});

test('removed containers invalidate their Docker log snapshots', async () => {
    const cache = createDeviceCollectorCache();
    const logs = createDockerLogSnapshot({ cache, fetch: async id => ({ id }) });
    await logs.read('container-a');
    await logs.read('container-b');
    assert.equal(logs.reconcile(['container-a']), 1);
    assert.equal(cache.has('nasMonitor.dockerLog.container-a'), true);
    assert.equal(cache.has('nasMonitor.dockerLog.container-b'), false);
});

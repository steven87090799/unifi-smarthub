'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeviceCollectorCache } = require('../server/services/device-collector-cache');
const {
    DOCKER_LOG_CANONICAL_LINES,
    createDockerLogSnapshot,
    dockerLogNotificationsEnabled,
    selectTailText
} = require('../server/services/docker-log-snapshot');

const deferred = () => {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
};

test('text tails remove only the terminal newline delimiter', () => {
    assert.equal(selectTailText('line-1\nline-2\n', 1), 'line-2');
    assert.equal(selectTailText('line-1\nline-2', 1), 'line-2');
    assert.equal(selectTailText('line-1\r\nline-2\r\n', 2), 'line-1\nline-2');
    assert.equal(selectTailText('line-1\n\nline-3\n', 3), 'line-1\n\nline-3');
});

test('different requested lines share one canonical upstream and return caller-local tails', async () => {
    const upstreamLines = Array.from({ length: 1_000 }, (_, index) => `line-${index + 1}`);
    const gate = deferred();
    let calls = 0;
    let requestedLines = null;
    const cache = createDeviceCollectorCache();
    const logs = createDockerLogSnapshot({
        cache,
        fetch: async (_id, options) => {
            calls += 1;
            requestedLines = options.lines;
            await gate.promise;
            return upstreamLines.join('\n');
        }
    });

    const result120Promise = logs.read('container-a', { lines: 120 });
    const result1000Promise = logs.read('container-a', { lines: 1000 });
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(requestedLines, DOCKER_LOG_CANONICAL_LINES);
    gate.resolve();
    const [result120, result1000] = await Promise.all([result120Promise, result1000Promise]);
    const lines120 = result120.split('\n');
    const lines1000 = result1000.split('\n');
    assert.equal(lines120.length, 120);
    assert.equal(lines1000.length, 1000);
    assert.equal(lines120[0], 'line-881');
    assert.equal(lines1000[0], 'line-1');
});

test('Docker log snapshots respect the minimum refresh interval', async () => {
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

test('background Docker log collection requires global and trigger notification settings', async () => {
    let calls = 0;
    const cache = createDeviceCollectorCache();
    const logs = createDockerLogSnapshot({ cache, fetch: async () => { calls += 1; return 'error'; } });
    const disabled = { enabled: false, triggerDockerCriticalLog: true, triggerDockerErrorLog: true };
    assert.equal(dockerLogNotificationsEnabled(disabled), false);
    await logs.readInventory([{ id: 'container-a' }], { enabled: dockerLogNotificationsEnabled(disabled) });
    assert.equal(calls, 0);
    assert.equal(cache.names().length, 0);

    const enabled = { enabled: true, triggerDockerCriticalLog: true, triggerDockerErrorLog: false };
    assert.equal(dockerLogNotificationsEnabled(enabled), true);
    await logs.readInventory([{ id: 'container-a' }], { enabled: dockerLogNotificationsEnabled(enabled) });
    assert.equal(calls, 1);
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

test('reconcile accepts Set and other iterable-compatible inputs', async () => {
    const cache = createDeviceCollectorCache();
    const logs = createDockerLogSnapshot({ cache, fetch: async id => ({ id }) });
    await logs.read('container-a');
    await logs.read('container-b');

    assert.doesNotThrow(() => logs.reconcile(new Set(['container-a'])));
    assert.equal(cache.has('nasMonitor.dockerLog.container-a'), true);
    assert.equal(cache.has('nasMonitor.dockerLog.container-b'), false);

    function* currentIds() {
        yield 'container-a';
        yield '';
        yield 'container-a';
    }
    for (const input of [undefined, null, [], new Set(), currentIds()]) {
        assert.doesNotThrow(() => logs.reconcile(input));
    }
});

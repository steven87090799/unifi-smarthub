'use strict';

// Local lifecycle soak. It deliberately injects upstream failures and
// recoveries; no real device is contacted or reported as healthy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createActivityLease } = require('../activity-lease');
const { createAdaptiveSampler } = require('../server/services/adaptive-sampler');
const { createDeviceCollectorCache } = require('../server/services/device-collector-cache');
const { createNasLoginSingleflight } = require('../server/services/nas-login-singleflight');
const { createNasTokenGeneration } = require('../server/services/nas-token-generation');
const { createSseBackpressureManager } = require('../server/services/sse-backpressure');
const { createArtworkCache } = require('../server/services/wiim-art-proxy');
const { createWiimClient } = require('../server/services/wiim-client');
const { createHistoryDb } = require('../db');

const testDurationMs = Number(process.env.SOAK_TEST_DURATION_MS);
const testTickMs = Number(process.env.SOAK_TEST_TICK_MS);
const isTestRun = Number.isFinite(testDurationMs) && testDurationMs > 0;
const durationMs = isTestRun ? testDurationMs : 30 * 60 * 1000;
const tickMs = isTestRun && Number.isFinite(testTickMs) && testTickMs >= 20 ? testTickMs : 5000;
const activeSampleDelayMs = isTestRun ? tickMs : 5000;
const CLEANUP_TIMEOUT_MS = 5000;

function memory() { return process.memoryUsage(); }

function createTimerTracker() {
    const timers = new Set();
    return {
        sleep(ms) {
            return new Promise(resolve => {
                const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
                timers.add(timer);
            });
        },
        interval(fn, ms) {
            const timer = setInterval(fn, ms);
            timers.add(timer);
            return timer;
        },
        clear(timer) { clearTimeout(timer); clearInterval(timer); timers.delete(timer); },
        add: timer => timers.add(timer),
        delete: timer => timers.delete(timer),
        count: () => timers.size
    };
}

function withTimeout(label, promise, timeoutMs, timers) {
    let timeout;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            timers.add(timeout);
        })
    ]).finally(() => {
        if (timeout) { clearTimeout(timeout); timers.delete(timeout); }
    });
}

async function waitFor(predicate, timeoutMs, timers, label) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`);
        await timers.sleep(20);
    }
}

function activeDiagnostics(baselineHandles, baselineRequests) {
    const handles = process._getActiveHandles(); // test-only diagnostics
    const requests = process._getActiveRequests(); // test-only diagnostics
    const knownStdIo = new Set([process.stdin, process.stdout, process.stderr]);
    return {
        handleCount: handles.length,
        requestCount: requests.length,
        unexpectedHandles: handles.filter(handle => !baselineHandles.has(handle) && !knownStdIo.has(handle)
            && !(handle.constructor?.name === 'Server' && handle.listening === false))
            .map(handle => handle.constructor?.name || 'Unknown'),
        unexpectedRequests: requests.filter(request => !baselineRequests.has(request))
            .map(request => request.constructor?.name || 'Unknown')
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
}

async function runCachePressureChecks() {
    let now = 0;
    const cache = createDeviceCollectorCache({
        now: () => now,
        cacheAgeMs: () => 1_000,
        maxEntries: 64,
        entryTtlMs: 60_000,
        maxEstimatedBytes: 64 * 1024
    });
    let peakEntries = 0;
    let peakBytes = 0;
    const observe = () => {
        const diagnostics = cache.diagnostics();
        peakEntries = Math.max(peakEntries, diagnostics.entryCount);
        peakBytes = Math.max(peakBytes, diagnostics.estimatedBytes);
        assert.ok(diagnostics.entryCount <= 64, 'collector cache exceeded entry bound');
        assert.ok(diagnostics.estimatedBytes <= 64 * 1024, 'collector cache exceeded byte bound');
    };

    // Dynamic NAS page and Docker container keys must remain bounded.
    for (let i = 0; i < 500; i += 1) {
        await cache.read(`nas.logs.page.${i}.120`, async () => ({ page: i, message: 'bounded' }));
        await cache.read(`nasMonitor.dockerLog.container-${i}`, async () => ({ id: i, logs: 'bounded' }));
        observe();
    }
    assert.ok(cache.invalidatePrefix('nas.logs.page.') > 0, 'NAS page prefix invalidation did not remove entries');
    assert.ok(cache.invalidatePrefix('nasMonitor.dockerLog.') > 0, 'Docker log prefix invalidation did not remove entries');
    for (let i = 0; i < 20; i += 1) {
        ['unifi.', 'cloud.', 'nas.', 'nasMonitor.', 'adguard.', 'linux.']
            .forEach(prefix => cache.invalidatePrefix(prefix));
    }

    // Both stale and strict callers share one failed upstream, but only the
    // stale caller receives the retained payload.
    await cache.read('mixed.stale.strict', async () => ({ value: 'old' }), { freshnessMs: 1 });
    now = 10;
    const failureGate = deferred();
    let failureCalls = 0;
    const failing = async () => {
        failureCalls += 1;
        await failureGate.promise;
        throw new Error('injected mixed caller failure');
    };
    const stale = cache.read('mixed.stale.strict', failing, { freshnessMs: 1, allowStale: true });
    const strict = cache.read('mixed.stale.strict', failing, { freshnessMs: 1, allowStale: false });
    await Promise.resolve();
    assert.equal(failureCalls, 1, 'mixed callers did not singleflight');
    failureGate.resolve();
    assert.deepEqual(await stale, { value: 'old' });
    await assert.rejects(strict, /injected mixed caller failure/u);
    assert.equal(cache.snapshot('mixed.stale.strict').healthy, false);

    // A delayed old NAS token failure must not erase a newer login.
    const tokenState = createNasTokenGeneration();
    tokenState.set('T1', Date.now() + 60_000);
    const oldToken = tokenState.getToken();
    const oldGeneration = tokenState.getGeneration();
    assert.equal(tokenState.clearIfCurrent(oldToken, oldGeneration), true);
    let loginCalls = 0;
    const login = createNasLoginSingleflight({
        getCachedToken: tokenState.getToken,
        isTokenValid: token => token === tokenState.getToken() && tokenState.isValid(),
        login: async () => {
            loginCalls += 1;
            tokenState.set('T2', Date.now() + 60_000);
            return 'T2';
        }
    });
    assert.equal(await login.getToken(), 'T2');
    assert.equal(tokenState.clearIfCurrent(oldToken, oldGeneration), false);
    assert.equal(tokenState.getToken(), 'T2');
    assert.equal(loginCalls, 1);

    // A reset fences a late WiiM response from the new IP cache.
    const oldWiim = deferred();
    let ip = '192.0.2.10';
    const wiim = createWiimClient({
        getIp: () => ip,
        request: async request => {
            if (request.host === '192.0.2.10') {
                await oldWiim.promise;
                return { ip: 'old' };
            }
            return { ip: 'new' };
        }
    });
    const oldRequest = wiim.get('getStatusEx');
    await Promise.resolve();
    ip = '192.0.2.11';
    wiim.reset();
    const newResult = await wiim.get('getStatusEx');
    oldWiim.resolve();
    await oldRequest;
    assert.equal(wiim.peek('getStatusEx').data, newResult.data);

    const final = cache.diagnostics();
    cache.invalidate();
    const cleared = cache.diagnostics();
    assert.equal(cleared.entryCount, 0, 'pressure cache did not clear');
    assert.equal(cleared.inflightCount, 0, 'pressure cache retained an in-flight request');
    return { peakEntries, peakBytes, final, cleared };
}

async function openSoakServer(sseClients, sse) {
    const server = http.createServer((req, res) => {
        if (req.url === '/events') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            sseClients.add(res);
            sse.add(res);
            res.write(': connected\n\n');
            req.once('close', () => { sse.remove(res); sseClients.delete(res); });
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const connection = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/events`, response => resolve({ request, response }));
        request.once('error', reject);
    });
    await waitFor(() => sseClients.size === 1, 1000, { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }, 'SSE client connection');
    [...sseClients][0].write('data: connected\n\n');
    return { server, ...connection };
}

function formatBytes(value) { return `${(value / 1048576).toFixed(1)} MiB`; }

function printSummary(summary) {
    console.log(summary.ok ? 'Runtime soak passed' : 'Runtime soak failed');
    console.log(`Duration: ${summary.durationMs} ms`);
    console.log(`RSS start: ${formatBytes(summary.rssStart)}`);
    console.log(`RSS peak: ${formatBytes(summary.rssPeak)}`);
    console.log(`RSS end: ${formatBytes(summary.rssEnd)}`);
    console.log(`Heap start: ${formatBytes(summary.heapStart)}`);
    console.log(`Heap peak: ${formatBytes(summary.heapPeak)}`);
    console.log(`Heap end: ${formatBytes(summary.heapEnd)}`);
    console.log(`Timer final: ${summary.timerFinal}`);
    console.log(`SSE clients final: ${summary.sseClientsFinal}`);
    console.log(`Browser sessions final: ${summary.sessionsFinal}`);
    console.log(`Collectors running final: ${summary.collectorsFinal}`);
    console.log(`Collector cache peak entries: ${summary.cachePressure.peakEntries}`);
    console.log(`Collector cache peak bytes: ${summary.cachePressure.peakBytes}`);
    console.log(`Collector cache final entries: ${summary.cachePressure.cleared.entryCount}`);
    console.log(`Collector cache final bytes: ${summary.cachePressure.cleared.estimatedBytes}`);
    console.log(`Unexpected active handles final: ${summary.unexpectedHandles.length}`);
    console.log(`Unexpected active requests final: ${summary.unexpectedRequests.length}`);
    console.log(`Unhandled rejections: ${summary.unhandled}`);
    console.log(`Uncaught exceptions: ${summary.uncaught}`);
    if (summary.failureMessages.length) console.log(`Failures: ${summary.failureMessages.join(' | ')}`);
    console.log(`Exit code: ${summary.exitCode}`);
}

async function main() {
    const timers = createTimerTracker();
    const startedAt = Date.now();
    const initialMemory = memory();
    const heapSamples = [initialMemory.heapUsed];
    const rssSamples = [initialMemory.rss];
    const baselineHandles = new Set(process._getActiveHandles());
    const baselineRequests = new Set(process._getActiveRequests());
    const failures = [];
    const unhandled = [];
    const uncaught = [];
    const onUnhandled = error => unhandled.push(error);
    const onUncaught = error => uncaught.push(error);
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUncaught);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-runtime-soak-'));
    const history = createHistoryDb(tempDir, { slowQueryMs: 10_000, maxPendingPoints: 10_000 });
    const lease = createActivityLease({ scopes: ['general', 'ups'], maxLeaseMs: 5_000 });
    const cache = createDeviceCollectorCache({ cacheAgeMs: () => 5000 });
    const artwork = createArtworkCache({ maxEntries: 20, maxItemBytes: 1024, maxBytes: 8 * 1024, ttlMs: 60_000 });
    const sseClients = new Set();
    let tick = 0, inFlight = 0, maxInFlight = 0, upstreamAttempts = 0, offlineFailures = 0, recoveries = 0, sseRemoved = 0;
    const sse = createSseBackpressureManager({
        maxWritableLength: 32, drainTimeoutMs: 25,
        onEvict: client => { sseRemoved += 1; sseClients.delete(client); }
    });
    const sampler = createAdaptiveSampler({
        getDelayMs: () => lease.isActive('general') ? activeSampleDelayMs : 600_000,
        collect: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await cache.read('nas', async () => {
                    upstreamAttempts += 1;
                    if (upstreamAttempts % 11 === 0) {
                        offlineFailures += 1;
                        throw new Error('injected NAS offline');
                    }
                    if (offlineFailures) recoveries += 1;
                    await timers.sleep(upstreamAttempts % 7 === 0 ? 70 : 5);
                    return { cpu: upstreamAttempts, online: true };
                }, { refresh: true, allowStale: true }).catch(() => undefined);
            } finally { inFlight -= 1; }
        }
    });
    let schedulerTimer = null;
    let server, sseRequest, sseResponse;
    let cleanupRuns = 0;
    let cachePressure = { peakEntries: 0, peakBytes: 0, final: { entryCount: 0, estimatedBytes: 0 }, cleared: { entryCount: 0, estimatedBytes: 0, inflightCount: 0 } };

    try {
        cachePressure = await runCachePressureChecks();
        const old = Date.now() - 26 * 60 * 60 * 1000;
        for (let i = 0; i < 2_000; i += 1) history.insertPoint('trend', { t: new Date(old + i * 5000).toISOString(), clients: i % 100 });
        const cleanup = history.cleanup(30, 100_000, { batchSize: 100 });
        assert.strictEqual(history.cleanup(30, 100_000), cleanup, 'cleanup must coalesce concurrent runs');
        cleanupRuns += 1;
        await cleanup;
        ({ server, request: sseRequest, response: sseResponse } = await openSoakServer(sseClients, sse));
        schedulerTimer = timers.interval(() => {}, 1000);
        sampler.start({ immediate: true });

        const slowClient = {
            get writableLength() { return tick % 10 === 0 ? 64 : 0; },
            writableEnded: false, destroyed: false,
            write: () => tick % 9 !== 0,
            once() {}, off() {}, end() { this.writableEnded = true; }
        };
        assert.equal(sse.add(slowClient), true, 'slow SSE client was not registered');

        while (Date.now() - startedAt < durationMs) {
            tick += 1;
            // Three browser tabs cycle through visible, hidden, close, and lease expiry states.
            const mode = tick % 12;
            if (mode < 7) lease.mark('general,ups', 30_000, { sessionId: 'tab-a', replace: mode === 0 });
            if (mode >= 2 && mode < 9) lease.mark('general', 30_000, { sessionId: 'tab-b', replace: mode === 2 });
            if (mode === 9) lease.mark('ups', 30_000, { sessionId: 'tab-c', replace: true });
            if (mode === 10) lease.mark('', 1, { sessionId: 'tab-a', replace: true });
            if (mode === 11) lease.mark('', 1, { sessionId: 'tab-b', replace: true });
            lease.prune();
            await Promise.all([
                cache.read('nas', async () => ({ cpu: -1 }), { allowStale: true }),
                cache.read('nas', async () => ({ cpu: -2 }), { allowStale: true })
            ]);
            if (tick % 4 === 0) sampler.rebuild({ immediate: false });
            artwork.set(`art-${tick % 24}`, { type: 'image/png', buffer: Buffer.alloc(512, tick % 255) });
            sse.broadcast('data: heartbeat\n\n');
            assert.ok(lease.sessionCount() <= 3, 'expired browser sessions must be removed');
            assert.ok(sampler.snapshot().scheduled || sampler.snapshot().running, 'sampler must retain one next run');
            if (tick % 6 === 0) {
                const sample = memory();
                heapSamples.push(sample.heapUsed);
                rssSamples.push(sample.rss);
            }
            await timers.sleep(tickMs);
        }
        assert.equal(maxInFlight, 1, 'slow collectors overlapped');
        assert.ok(offlineFailures > 0 && recoveries > 0, 'offline/recovery injection did not run');
        assert.ok(sseRemoved > 0, 'slow SSE clients were not removed');
        assert.ok(artwork.size() <= 20 && artwork.totalBytes() <= 8 * 1024, 'artwork cache exceeded bounds');
        assert.equal(cleanupRuns, 1, 'cleanup ran more than once');
        assert.ok(cachePressure.peakEntries <= 64, 'cache pressure entry bound failed');
        assert.ok(cachePressure.peakBytes <= 64 * 1024, 'cache pressure byte bound failed');
        assert.equal(cachePressure.cleared.entryCount, 0, 'cache pressure entries remained');
    } catch (error) {
        failures.push(error);
    } finally {
        try {
            sampler.stop();
            if (schedulerTimer) timers.clear(schedulerTimer);
            ['tab-a', 'tab-b', 'tab-c'].forEach(sessionId => lease.mark('', 1, { sessionId, replace: true }));
            lease.prune();
            sse.closeAll();
            sseResponse?.destroy();
            sseRequest?.destroy();
            await withTimeout('SSE client cleanup', waitFor(() => sseClients.size === 0, 1000, timers, 'SSE clients'), CLEANUP_TIMEOUT_MS, timers);
            if (server?.listening) {
                const closeServer = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                server.closeAllConnections?.();
                await withTimeout('HTTP server close', closeServer, CLEANUP_TIMEOUT_MS, timers);
            }
            server?.unref?.();
            await withTimeout('collector stop', waitFor(() => inFlight === 0, 1000, timers, 'collector'), CLEANUP_TIMEOUT_MS, timers);
            await withTimeout('socket handle drain', waitFor(
                () => activeDiagnostics(baselineHandles, baselineRequests).unexpectedHandles.length === 0,
                1000, timers, 'socket handles'
            ), CLEANUP_TIMEOUT_MS, timers);
            history.close();
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            failures.push(error);
        }
    }

    if (typeof global.gc === 'function') { global.gc(); global.gc(); }
    await timers.sleep(25);
    const finalMemory = memory();
    const diagnostics = activeDiagnostics(baselineHandles, baselineRequests);
    try {
        assert.equal(lease.sessionCount(), 0, 'browser sessions remained after cleanup');
        assert.equal(sseClients.size, 0, 'SSE clients remained after cleanup');
        assert.equal(inFlight, 0, 'collector remained running after cleanup');
        assert.equal(sampler.snapshot().scheduled, false, 'collector timer remained scheduled');
        assert.equal(timers.count(), 0, 'timer count remained after cleanup');
        assert.equal(unhandled.length, 0, `unhandled rejection: ${unhandled[0]?.message || ''}`);
        assert.equal(uncaught.length, 0, `uncaught exception: ${uncaught[0]?.message || ''}`);
        assert.equal(diagnostics.unexpectedHandles.length, 0, `unexpected handles: ${diagnostics.unexpectedHandles.join(', ')}`);
        assert.equal(diagnostics.unexpectedRequests.length, 0, `unexpected requests: ${diagnostics.unexpectedRequests.join(', ')}`);
        assert.ok(finalMemory.heapUsed <= Math.max(...heapSamples) + 4 * 1048576, 'heap did not return to a reasonable range');
        assert.ok(finalMemory.rss <= initialMemory.rss + 128 * 1048576, 'RSS grew without a bounded limit');
    } catch (error) {
        failures.push(error);
    }
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUncaught);

    const summary = {
        ok: failures.length === 0,
        durationMs: Date.now() - startedAt,
        rssStart: initialMemory.rss, rssPeak: Math.max(...rssSamples), rssEnd: finalMemory.rss,
        heapStart: initialMemory.heapUsed, heapPeak: Math.max(...heapSamples), heapEnd: finalMemory.heapUsed,
        timerFinal: timers.count(), sseClientsFinal: sseClients.size,
        sessionsFinal: lease.sessionCount(), collectorsFinal: inFlight,
        cachePressure,
        unhandled: unhandled.length, uncaught: uncaught.length,
        unexpectedHandles: diagnostics.unexpectedHandles,
        unexpectedRequests: diagnostics.unexpectedRequests,
        exitCode: failures.length === 0 ? 0 : 1,
        failureMessages: failures.map(error => error.message || String(error))
    };
    printSummary(summary);
    if (!summary.ok) throw new AggregateError(failures, 'Runtime soak assertions failed');
}

main().then(() => { process.exitCode = 0; }).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});

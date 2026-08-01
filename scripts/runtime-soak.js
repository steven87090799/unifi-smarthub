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
const { createSseBackpressureManager } = require('../server/services/sse-backpressure');
const { createArtworkCache } = require('../server/services/wiim-art-proxy');
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

    try {
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

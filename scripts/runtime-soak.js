'use strict';

// Local, dependency-free lifecycle soak. It deliberately injects upstream
// failures and recoveries; no real device is contacted or reported as healthy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActivityLease } = require('../activity-lease');
const { createAdaptiveSampler } = require('../server/services/adaptive-sampler');
const { createDeviceCollectorCache } = require('../server/services/device-collector-cache');
const { createSseBackpressure } = require('../server/services/sse-backpressure');
const { createArtworkCache } = require('../server/services/wiim-art-proxy');
const { createHistoryDb } = require('../db');

const durationMs = Math.max(30 * 60 * 1000, Number(process.env.SOAK_DURATION_MS) || 30 * 60 * 1000);
const tickMs = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const memory = () => process.memoryUsage();

async function main() {
    const startedAt = Date.now();
    const initialMemory = memory();
    const heapSamples = [initialMemory.heapUsed];
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-runtime-soak-'));
    const history = createHistoryDb(tempDir, { slowQueryMs: 10_000, maxPendingPoints: 10_000 });
    const lease = createActivityLease({ scopes: ['general', 'ups'], maxLeaseMs: 5_000 });
    const cache = createDeviceCollectorCache({ cacheAgeMs: () => 5000 });
    const artwork = createArtworkCache({ maxEntries: 20, maxItemBytes: 1024, maxBytes: 8 * 1024, ttlMs: 60_000 });
    let tick = 0, inFlight = 0, maxInFlight = 0, upstreamAttempts = 0, failures = 0, recoveries = 0;
    let sseRemoved = 0;
    const sse = createSseBackpressure({ maxWritableLength: 32, drainTimeoutMs: 25, onRemove: () => { sseRemoved += 1; } });
    const sampler = createAdaptiveSampler({
        getDelayMs: () => lease.isActive('general') ? 5000 : 600_000,
        collect: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await cache.read('nas', async () => {
                    upstreamAttempts += 1;
                    if (upstreamAttempts % 11 === 0) {
                        failures += 1;
                        throw new Error('injected NAS offline');
                    }
                    if (failures) recoveries += 1;
                    await sleep(upstreamAttempts % 7 === 0 ? 70 : 5);
                    return { cpu: upstreamAttempts, online: true };
                }, { refresh: true, allowStale: true }).catch(() => undefined);
            } finally { inFlight -= 1; }
        }
    });
    try {
        const old = Date.now() - 26 * 60 * 60 * 1000;
        for (let i = 0; i < 2_000; i += 1) history.insertPoint('trend', { t: new Date(old + i * 5000).toISOString(), clients: i % 100 });
        await history.cleanupYielding(30, 100_000, { batchSize: 100 });
        sampler.start({ immediate: true });
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
            // Simulated page switching must reuse the same collector cache promise.
            await Promise.all([
                cache.read('nas', async () => ({ cpu: -1 }), { allowStale: true }),
                cache.read('nas', async () => ({ cpu: -2 }), { allowStale: true })
            ]);
            if (tick % 4 === 0) sampler.rebuild({ immediate: false }); // repeated settings saves
            artwork.set(`art-${tick % 24}`, { type: 'image/png', buffer: Buffer.alloc(512, tick % 255) });
            const slowClient = {
                writableEnded: false, destroyed: false, writableLength: tick % 10 === 0 ? 64 : 0,
                write: () => tick % 9 !== 0,
                once() {}, off() {}, end() { this.writableEnded = true; }
            };
            sse.write(slowClient, 'data: heartbeat\n\n');
            assert.ok(lease.sessionCount() <= 3, 'expired browser sessions must be removed');
            assert.ok(sampler.snapshot().scheduled || sampler.snapshot().running, 'sampler must retain at most one next run');
            if (tick % 6 === 0) heapSamples.push(memory().heapUsed);
            if (tick % 60 === 0) {
                const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
                console.log(`soak ${elapsedMin}m: attempts=${upstreamAttempts} sessions=${lease.sessionCount()} heap=${Math.round(memory().heapUsed / 1048576)}MiB`);
            }
            await sleep(tickMs);
        }
        sampler.stop();
        await sleep(100);
        const finalMemory = memory();
        assert.equal(maxInFlight, 1, 'slow collectors overlapped');
        assert.ok(failures > 0 && recoveries > 0, 'offline/recovery injection did not run');
        assert.ok(sseRemoved > 0, 'slow SSE clients were not removed');
        assert.ok(artwork.size() <= 20 && artwork.totalBytes() <= 8 * 1024, 'artwork cache exceeded bounds');
        assert.equal(unhandled.length, 0, `unhandled rejection: ${unhandled[0]?.message || ''}`);
        console.log(JSON.stringify({
            duration_ms: Date.now() - startedAt,
            heap_used_start: initialMemory.heapUsed,
            heap_used_end: finalMemory.heapUsed,
            heap_used_peak: Math.max(...heapSamples),
            rss_start: initialMemory.rss,
            rss_end: finalMemory.rss,
            collector_max_concurrency: maxInFlight,
            upstream_failures: failures,
            upstream_recoveries: recoveries,
            sse_removed: sseRemoved,
            artwork_items: artwork.size(),
            artwork_bytes: artwork.totalBytes(),
            active_sessions: lease.sessionCount(),
            unhandled_rejections: unhandled.length
        }));
    } finally {
        sampler.stop();
        process.off('unhandledRejection', onUnhandled);
        history.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});

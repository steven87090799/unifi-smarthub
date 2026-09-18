'use strict';

// Isolated, reproducible synthetic history measurement. Never accepts a data
// directory: every run owns a newly created temporary SQLite database.
// Example: node --expose-gc scripts/p1-reliability-evidence.js --days=30,90,180,365
// P1_AUDIT_SOURCE_ROOT may select an independent source worktree for comparison.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const root = path.resolve(process.env.P1_AUDIT_SOURCE_ROOT || path.join(__dirname, '..'));
const { createHistoryDb } = require(path.join(root, 'db.js'));
const Database = require(path.join(root, 'node_modules/better-sqlite3'));
const daysArg = process.argv.find(arg => arg.startsWith('--days=')) || '--days=30,90,180,365';
const daysList = daysArg.slice(7).split(',').map(Number);
if (!daysList.length || daysList.some(days => !Number.isInteger(days) || days < 1 || days > 365)) {
    throw new Error('--days requires integers from 1 to 365');
}
const NOW = Date.parse('2026-09-18T00:00:00.000Z');
const CADENCE_MS = 60000;
const immediate = () => new Promise(resolve => setImmediate(resolve));
const round = n => Number(n.toFixed(3));
function size(file) { try { return fs.statSync(file).size; } catch { return 0; } }
function memory() { return { ...process.memoryUsage(), handles: process._getActiveHandles().length, requests: process._getActiveRequests().length }; }

async function measure(days) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-p1-synthetic-'));
    let history;
    const delay = monitorEventLoopDelay({ resolution: 10 });
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    const snapshots = { startup: memory() };
    let peakRss = snapshots.startup.rss;
    let peakHeap = snapshots.startup.heapUsed;
    let peakWal = 0;
    const observe = () => {
        const current = memory();
        peakRss = Math.max(peakRss, current.rss);
        peakHeap = Math.max(peakHeap, current.heapUsed);
        if (history) peakWal = Math.max(peakWal, size(`${history.file}-wal`));
        return current;
    };
    const timer = setInterval(observe, 20);
    timer.unref(); delay.enable();
    try {
        history = createHistoryDb(directory, { now: () => NOW });
        const points = days * 1440;
        const start = NOW - days * 86400000;
        const loadStarted = performance.now();
        for (let i = 0; i < points; i += 1) {
            history.insertPoint('trend', {
                t: new Date(start + i * CADENCE_MS).toISOString(),
                temperature: i % 7 === 0 ? null : 30 + i % 41,
                clients: i % 101, rxBytes: i * 4096,
                cores: [i % 100, (i + 11) % 100], disks: { disk1: 35, sleeping: null }
            });
            if (i % 1000 === 999) {
                if (i === 999) snapshots.warmup = observe();
                observe(); await immediate();
            }
        }
        history.flush();
        const loadMs = performance.now() - loadStarted;
        snapshots.loaded = observe();
        const sizeBefore = { database: size(history.file), wal: size(`${history.file}-wal`) };
        const cleanupStarted = performance.now();
        const cleanup = await history.cleanup(365, 1000000, { now: NOW });
        const cleanupMs = performance.now() - cleanupStarted;
        snapshots.cleaned = observe();
        const read = new Database(history.file, { readonly: true });
        let counts; let quickCheck;
        try {
            counts = {
                raw: read.prepare("SELECT COUNT(*) AS n FROM history WHERE series='trend'").get().n,
                rollupSamples: read.prepare("SELECT COALESCE(SUM(sample_count),0) AS n FROM history_rollups WHERE series='trend'").get().n,
                rollupRows: read.prepare("SELECT COUNT(*) AS n FROM history_rollups WHERE series='trend'").get().n
            };
            quickCheck = read.pragma('quick_check', { simple: true });
        } finally { read.close(); }
        const latencies = [];
        let result;
        for (let i = 0; i < 5; i += 1) {
            const queryStart = performance.now();
            result = history.getHistory('trend', start, { pointBudget: 240 });
            latencies.push(round(performance.now() - queryStart));
            observe(); await immediate();
        }
        const conservation = counts.raw + counts.rollupSamples === points;
        const checkpoint = history.checkpoint();
        const sizeAfter = { database: size(history.file), wal: size(`${history.file}-wal`) };
        history.close(); history = createHistoryDb(directory, { now: () => NOW });
        const restartResult = history.getHistory('trend', start, { pointBudget: 240 });
        const restartEqual = JSON.stringify(restartResult) === JSON.stringify(result);
        const repeated = await history.cleanup(365, 1000000, { now: NOW });
        snapshots.recovered = observe();
        history.close(); history = null;
        if (global.gc) { global.gc(); snapshots.postGc = memory(); }
        delay.disable();
        const cpu = process.cpuUsage(cpuStart);
        return {
            scenario: `${days} days equivalent synthetic data, one point per minute, one series`,
            days, cadenceMs: CADENCE_MS, inputPoints: points, counts,
            sampleConservation: conservation, sqliteQuickCheck: quickCheck,
            restartEqual, repeatedCleanupRollups: repeated.rollups_created,
            loadMs: round(loadMs), cleanupMs: round(cleanupMs), queryLatenciesMs: latencies,
            queryMedianMs: [...latencies].sort((a, b) => a - b)[2], returnedPoints: result.data.length,
            nestedDataPreserved: result.data.every(row => Array.isArray(row.cores) && row.disks?.disk1 === 35),
            sizeBefore, sizeAfter, peakWalBytes: peakWal, checkpoint,
            cpuMicroseconds: cpu, elapsedMs: round(performance.now() - started),
            eventLoopDelayMs: { mean: round(delay.mean / 1e6), p99: round(delay.percentile(99) / 1e6), max: round(delay.max / 1e6) },
            peakRss, peakHeapUsed: peakHeap, snapshots, cleanup
        };
    } finally {
        clearInterval(timer); delay.disable();
        if (history) history.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

(async () => {
    const results = [];
    for (const days of daysList) {
        results.push(await measure(days));
        console.error(`measured ${days} synthetic days`);
    }
    console.log(JSON.stringify({
        kind: 'synthetic-data-not-elapsed-soak', createdAt: new Date().toISOString(),
        node: process.version, platform: `${process.platform}/${process.arch}`,
        dbSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'db.js'))).digest('hex'),
        results
    }, null, 2));
    if (!process.argv.includes('--observe-only') && results.some(result => !result.sampleConservation || !result.restartEqual || !result.nestedDataPreserved)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });

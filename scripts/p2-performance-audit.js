'use strict';

// Isolated synthetic audit, never the deployment DATA_DIR. Run with:
// node --expose-gc scripts/p2-performance-audit.js <source-root> <output.json>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const Database = require('better-sqlite3');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const output = process.argv[3];
const NOW = Date.parse('2026-09-18T00:00:00.000Z');
const DAY = 86400000;
const round = n => Number(n.toFixed(3));
const immediate = () => new Promise(resolve => setImmediate(resolve));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const fileSize = file => { try { return fs.statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };

function capture(directory) {
    const statements = [];
    const original = Database.prototype.prepare;
    Database.prototype.prepare = function (sql) {
        if (/SELECT DISTINCT/.test(sql) && /AS bucket_ts/.test(sql)) statements.push(sql);
        return original.call(this, sql);
    };
    let history;
    try { history = require(path.join(root, 'db')).createHistoryDb(directory, { now: () => NOW }); }
    finally { Database.prototype.prepare = original; }
    return { history, statements };
}

function params(sql, start, limit = 100) {
    if (/FROM history_rollups/.test(sql)) return ['trend', '1m', start, NOW, limit];
    if (/FROM history WHERE/.test(sql)) return ['trend', start, NOW, limit];
    if (/FROM unifi_device_telemetry_rollups/.test(sql)) return ['1m', start, NOW, limit];
    return [start, NOW, limit];
}

async function measured(fn) {
    if (global.gc) global.gc();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    // Arm the monitor; this is measurement setup, not a race-hiding test sleep.
    await new Promise(resolve => setTimeout(resolve, 3));
    const before = process.memoryUsage();
    const cpu = process.cpuUsage();
    const started = performance.now();
    let peakRss = before.rss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1);
    try {
        const result = await fn();
        await immediate();
        const elapsed = performance.now() - started;
        const used = process.cpuUsage(cpu);
        const after = process.memoryUsage();
        peakRss = Math.max(peakRss, after.rss);
        return {
            duration_ms: round(elapsed), cpu_ms: round((used.user + used.system) / 1000),
            cpu_percent: round((used.user + used.system) / 1000 / elapsed * 100),
            rss_before_bytes: before.rss, rss_after_bytes: after.rss, sampled_peak_rss_bytes: peakRss,
            heap_before_bytes: before.heapUsed, heap_after_bytes: after.heapUsed,
            event_loop_max_ms: round(delay.max / 1e6), event_loop_p99_ms: round(delay.percentile(99) / 1e6),
            active_handles: process._getActiveHandles().length, result
        };
    } finally { clearInterval(sampler); delay.disable(); }
}

async function historyScenario(days) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-p2-benchmark-'));
    const { history, statements } = capture(directory);
    const db = new Database(history.file);
    try {
        const start = NOW - days * DAY;
        const historyInsert = db.prepare('INSERT INTO history(series,ts,data) VALUES(?,?,?)');
        const rollupInsert = db.prepare('INSERT INTO history_rollups(series,resolution,bucket_ts,data,sample_count) VALUES(?,?,?,?,?)');
        const telemetryInsert = db.prepare('INSERT INTO unifi_device_telemetry(sampled_ts,device_id,data) VALUES(?,?,?)');
        const telemetryRollup = db.prepare('INSERT INTO unifi_device_telemetry_rollups(device_id,resolution,bucket_ts,data,sample_count) VALUES(?,?,?,?,?)');
        let points = 0;
        db.transaction(() => {
            for (let ts = start; ts < NOW; ts += 600000) {
                const value = (points % 100) + 20;
                historyInsert.run('trend', ts, JSON.stringify({ t: new Date(ts).toISOString(), clients: value, temperature: 42 }));
                rollupInsert.run('trend', '1m', ts, JSON.stringify({ clients: value, temperature: 42 }), 1);
                for (const device of ['device-a', 'device-b']) {
                    const data = JSON.stringify({ deviceId: device, temperature: device === 'device-a' ? 42 : null, rxBytes: ts, cpu: value });
                    telemetryInsert.run(ts, device, data);
                    telemetryRollup.run(device, '1m', ts, data, 1);
                }
                points += 1;
            }
        })();
        db.pragma('wal_checkpoint(TRUNCATE)');
        const sizes = { db_bytes: fileSize(history.file), wal_bytes: fileSize(`${history.file}-wal`), raw_points_per_series: points, raw_device_points: points * 2 };
        const queryResults = [];
        for (const [index, sql] of statements.entries()) {
            const statement = db.prepare(sql);
            const args = params(sql, start);
            statement.all(...args);
            const samples = [];
            const metrics = await measured(async () => {
                for (let iteration = 0; iteration < 20; iteration += 1) {
                    const began = performance.now();
                    statement.all(...args);
                    samples.push(performance.now() - began);
                    await immediate();
                }
            });
            delete metrics.result;
            queryResults.push({
                candidate: index + 1, table: sql.match(/FROM (\w+)/)[1], window_ms: Number(sql.match(/\/ (\d+)/)[1]),
                median_ms: round(percentile(samples, 0.5)), p95_ms: round(percentile(samples, 0.95)),
                query_plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail), ...metrics
            });
        }
        const query = await measured(() => history.getHistory('trend', start, { pointBudget: 240 }));
        query.result = { points: query.result.data.length, resolution: query.result.resolution };
        const telemetry = await measured(() => history.listUnifiTelemetryHistory(start, { pointBudget: 240 }));
        telemetry.result = { points: telemetry.result.data.length, resolution: telemetry.result.resolution };
        const backup = await measured(() => history.backup(path.join(directory, 'audit-backup.db')));
        backup.result = { bytes: fileSize(path.join(directory, 'audit-backup.db')) };
        const cleanup = days === 30
            ? await measured(() => history.cleanup(days + 1, 1000000, { batchSize: 100 }))
            : { status: 'NOT RUN', reason: 'Full cleanup comparison is limited to the 30-day fixture; all four sizes measure real candidate queries, reads and backup.' };
        return { days, synthetic: true, cadence_seconds: 600, devices: 2, ...sizes, candidate_queries: queryResults, history_read: query, telemetry_read: telemetry, backup, cleanup, final_db_bytes: fileSize(history.file), final_wal_bytes: fileSize(`${history.file}-wal`) };
    } finally { db.close(); history.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

async function pollingScenario() {
    const { createDeviceCollectorCache } = require(path.join(root, 'server/services/device-collector-cache'));
    let upstream = 0;
    let offline = false;
    let clock = 1000;
    const cache = createDeviceCollectorCache({ now: () => clock, cacheAgeMs: () => 100 });
    const server = http.createServer(async (_request, response) => {
        try {
            const result = await cache.read('fixture', async () => {
                upstream += 1;
                await immediate();
                if (offline) throw new Error('fixture offline');
                return { value: 42 };
            }, { allowStale: true });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
        } catch { response.writeHead(503); response.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const batch = async count => {
        const latencies = [];
        const previous = upstream;
        const metrics = await measured(async () => Promise.all(Array.from({ length: count }, async () => {
            const started = performance.now();
            const response = await fetch(url);
            await response.arrayBuffer();
            latencies.push(performance.now() - started);
        })));
        delete metrics.result;
        return { clients: count, upstream_requests: upstream - previous, request_median_ms: round(percentile(latencies, 0.5)), request_p95_ms: round(percentile(latencies, 0.95)), ...metrics };
    };
    try {
        const one = await batch(1);
        clock += 1000;
        const tabs = await batch(20);
        clock += 1000;
        offline = true;
        const outage = await batch(20);
        clock += 1000;
        offline = false;
        const recovery = await batch(20);
        return { type: 'isolated HTTP fixture using real collector cache; not production API', one, tabs, outage, recovery };
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

(async () => {
    const probe = new Database(':memory:');
    const sqliteVersion = probe.prepare('select sqlite_version() version').get().version;
    probe.close();
    const evidence = { source_root: root, node: process.version, sqlite: sqliteVersion, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, created_at: new Date().toISOString(), synthetic_not_operational_days: true, scenarios: [] };
    for (const days of [30, 90, 180, 365]) {
        evidence.scenarios.push(await historyScenario(days));
        if (output) fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
        process.stderr.write(`completed ${days}-day synthetic fixture\n`);
    }
    evidence.polling = await pollingScenario();
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    if (output) fs.writeFileSync(output, text);
    else process.stdout.write(text);
})().catch(error => { console.error(error); process.exitCode = 1; });

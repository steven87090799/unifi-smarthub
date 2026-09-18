'use strict';

// Opt-in measurement preload, not part of production startup. For example:
// P1_RESOURCE_FILE=/tmp/resource.json node --expose-gc --require ./scripts/p1-resource-probe.js scripts/runtime-soak.js
if (process.env.P1_RESOURCE_FILE) {
    const fs = require('node:fs');
    const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
    const started = performance.now();
    const delay = monitorEventLoopDelay({ resolution: 10 });
    const frames = [];
    let peak = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
    const capture = phase => {
        const memory = process.memoryUsage();
        for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], memory[key]);
        const frame = {
            phase, elapsedMs: Number((performance.now() - started).toFixed(2)), ...memory,
            cpuMicroseconds: process.cpuUsage(), activeHandles: process._getActiveHandles().length,
            activeRequests: process._getActiveRequests().length
        };
        if (frames.length === 3600) frames.splice(1, 1);
        frames.push(frame);
        return frame;
    };
    capture('startup'); delay.enable();
    const interval = setInterval(() => capture('sample'), 1000);
    interval.unref();
    process.once('exit', code => {
        clearInterval(interval); delay.disable(); capture('recovery');
        if (global.gc) { global.gc(); capture('post-gc'); }
        fs.writeFileSync(process.env.P1_RESOURCE_FILE, JSON.stringify({
            node: process.version, exitCode: code, elapsedMs: Number((performance.now() - started).toFixed(2)),
            peak, eventLoopDelayMs: { mean: delay.mean / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
            frames
        }, null, 2) + '\n', { mode: 0o600 });
    });
}

'use strict';

const { ERROR_CODES } = require('./error-codes');

function registerHealthRoutes(app, { monitor, db, taskTracker, version, buildIdentity }) {
    const liveness = (_req, res) => res.json({
        status: 'healthy',
        code: ERROR_CODES.API_HEALTH_OK,
        uptime_seconds: Math.floor(process.uptime()),
        version,
        build: buildIdentity || {
            version: 'unknown', revision: 'unknown', created: 'unknown', dirty: null,
            status: 'incomplete', complete: false
        },
        timestamp: new Date().toISOString()
    });
    app.get('/health', liveness);
    app.get('/healthz', liveness); // 向後相容既有部署與反向代理

    app.get('/health/ready', (_req, res) => {
        const database = db.diagnostics();
        const worker = taskTracker.getStatus();
        const ready = database.ok && worker.status !== 'critical';
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            code: ready ? ERROR_CODES.API_READY_OK : ERROR_CODES.API_NOT_READY,
            build: buildIdentity || undefined,
            checks: {
                database: { status: database.ok ? 'healthy' : 'critical', latency_ms: database.latency_ms },
                worker: { status: worker.status, active_tasks: worker.active_tasks, stuck_tasks: worker.stuck_tasks }
            },
            note: 'External device integrations are optional and do not gate readiness.'
        });
    });

    app.get('/api/system/status', async (_req, res, next) => {
        try { res.json(await monitor.ensureSample()); }
        catch (error) { next(error); }
    });
}

module.exports = { registerHealthRoutes };

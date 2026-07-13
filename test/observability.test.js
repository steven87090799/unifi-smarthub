'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ERROR_CODES } = require('../observability/error-codes');
const { createLogger, maskSensitive } = require('../observability/logger');
const { IssueTracker } = require('../observability/issue-tracker');
const { TaskTracker } = require('../observability/task-tracker');
const { evaluateThreshold } = require('../observability/system-monitor');
const { registerHealthRoutes } = require('../observability/health-routes');
const { createHistoryDb } = require('../db');

test('central error codes are unique and follow the documented format', () => {
    const codes = Object.values(ERROR_CODES);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[A-Z]+(?:-[A-Z]+)*-(?:[A-Z]+-)?\d{3}$/);
});

test('sensitive data masking redacts keys, headers, query values, JWTs and known secrets', () => {
    const secret = 'super-secret-password';
    const masked = maskSensitive({
        password: secret,
        authorization: 'Bearer abcdefghijklmnop',
        note: `token=abcdefghijk ${secret}`,
        jwt: 'eyJabcdefghijk.abcdefghijk.abcdefghijk'
    }, { knownSecrets: [secret] });
    const output = JSON.stringify(masked);
    assert.doesNotMatch(output, /super-secret-password/);
    assert.doesNotMatch(output, /abcdefghijklmnop/);
    assert.doesNotMatch(output, /token=abcdefghijk/);
    assert.match(output, /\*{4,}|REDACTED/);

    const circular = [];
    circular.push(circular);
    assert.deepEqual(maskSensitive(circular), ['[Circular]']);
});

test('structured log fields cannot override canonical metadata', () => {
    const lines = [];
    const logger = createLogger({ level: 'DEBUG', format: 'json', sink: line => lines.push(JSON.parse(line)), env: {} });
    logger.error({
        module: 'test.logger', function: 'canonicalFields', code: ERROR_CODES.API_INTERNAL_ERROR,
        message: 'canonical message', fields: { level: 'DEBUG', message: 'forged message', status_code: 'FAKE-001' }
    });
    assert.equal(lines[0].level, 'ERROR');
    assert.equal(lines[0].message, 'canonical message');
    assert.equal(lines[0].status_code, ERROR_CODES.API_INTERNAL_ERROR);
});

test('issue tracker deduplicates, applies cooldown, and records resolution', () => {
    const tracker = new IssueTracker({ cooldownSeconds: 5 });
    const first = tracker.report({ id: 'memory:warning', code: ERROR_CODES.SYS_MEMORY_WARNING, severity: 'warning', message: 'Memory high' }, 1000);
    const duplicate = tracker.report({ id: 'memory:warning', code: ERROR_CODES.SYS_MEMORY_WARNING, severity: 'warning', message: 'Memory high' }, 2000);
    const afterCooldown = tracker.report({ id: 'memory:warning', code: ERROR_CODES.SYS_MEMORY_WARNING, severity: 'warning', message: 'Memory high' }, 7000);
    assert.equal(first.shouldLog, true);
    assert.equal(duplicate.shouldLog, false);
    assert.equal(afterCooldown.shouldLog, true);
    assert.equal(afterCooldown.issue.occurrences, 3);
    const resolved = tracker.resolve('memory:warning', 9000);
    assert.equal(tracker.listActive().length, 0);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.duration_seconds, 8);
    assert.equal(tracker.listResolved().length, 1);
});

test('resource threshold evaluation distinguishes healthy, warning, critical and unknown', () => {
    assert.equal(evaluateThreshold(25, 80, 95), 'healthy');
    assert.equal(evaluateThreshold(80, 80, 95), 'warning');
    assert.equal(evaluateThreshold(95, 80, 95), 'critical');
    assert.equal(evaluateThreshold(null, 80, 95), 'unknown');
});

test('task trace keeps one task_id through lifecycle and detects stale heartbeat', async () => {
    const lines = [];
    const logger = createLogger({ level: 'DEBUG', format: 'json', sink: line => lines.push(JSON.parse(line)), env: {} });
    const tracker = new TaskTracker({ logger, stuckSeconds: 30 });
    await tracker.run('sampleJob', async ({ heartbeat }) => {
        heartbeat('processing', { progress: 50 });
        logger.debug({ module: 'test.worker', function: 'sampleJob', message: 'midpoint' });
    }, { taskId: 'task-test-1' });
    const taskLines = lines.filter(line => line.task_id === 'task-test-1');
    assert.ok(taskLines.length >= 3);
    assert.ok(taskLines.every(line => line.task_id === 'task-test-1'));
    assert.equal(tracker.getStatus().completed_tasks, 1);

    tracker.create('staleJob', { taskId: 'stale-1', now: 1000, stuckSeconds: 30 });
    assert.equal(tracker.getStuck(32000).length, 1);
});

test('SQLite diagnostics reports connection, latency and single-connection semantics', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-db-test-'));
    const db = createHistoryDb(dir, { slowQueryMs: 10000 });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    assert.equal(db.insertPoint('trend', { t: new Date().toISOString(), clients: 2 }), true);
    const diagnostics = db.diagnostics();
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.pool.type, 'single_connection');
    assert.equal(diagnostics.pool.size, 1);
    assert.ok(diagnostics.latency_ms >= 0);
});

test('report run log persists delivery outcomes and keeps the newest entries first', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-report-test-'));
    const db = createHistoryDb(dir, { slowQueryMs: 10000 });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    db.insertReportRun({
        ts: '2026-07-13T00:00:00.000Z', trigger: 'scheduled', title: 'Scheduled report',
        deliveryStatus: 'sent', channel: 'discord', body: 'first report'
    });
    db.insertReportRun({
        ts: '2026-07-13T01:00:00.000Z', trigger: 'manual', title: 'Manual report',
        deliveryStatus: 'skipped:disabled', body: 'second report'
    });
    const runs = db.listReportRuns();
    assert.equal(runs.length, 2);
    assert.equal(runs[0].trigger, 'manual');
    assert.equal(runs[0].deliveryStatus, 'skipped:disabled');
    assert.equal(runs[1].channel, 'discord');
});

test('health, readiness and diagnostics APIs return expected status without secrets', async t => {
    const app = express();
    const systemStatus = {
        status: 'healthy', app_version: 'test', uptime_seconds: 1,
        database: { status: 'healthy', latency_ms: 1 }, worker: { status: 'healthy' }, active_issues: [], trend_data: []
    };
    const db = { diagnostics: () => ({ ok: true, latency_ms: 1 }) };
    const taskTracker = { getStatus: () => ({ status: 'healthy', active_tasks: 0, stuck_tasks: 0 }) };
    const monitor = { ensureSample: async () => systemStatus };
    registerHealthRoutes(app, { monitor, db, taskTracker, version: 'test' });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, 'healthy');
    assert.equal(health.code, ERROR_CODES.API_HEALTH_OK);

    const readyResponse = await fetch(`${base}/health/ready`);
    const ready = await readyResponse.json();
    assert.equal(readyResponse.status, 200);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.checks.database.status, 'healthy');

    const diagnostics = await (await fetch(`${base}/api/system/status`)).json();
    assert.deepEqual(diagnostics, systemStatus);
    assert.doesNotMatch(JSON.stringify(diagnostics), /password|api_key|token|secret/i);
});

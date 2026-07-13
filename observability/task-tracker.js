'use strict';

const { randomUUID } = require('crypto');
const { ERROR_CODES } = require('./error-codes');

class TaskTracker {
    constructor({ logger, stuckSeconds = 1800 } = {}) {
        this.logger = logger;
        this.defaultStuckSeconds = Math.max(Number(stuckSeconds) || 1800, 30);
        this.active = new Map();
        this.totals = { completed: 0, failed: 0, retries: 0, skipped: 0 };
        this.recent = [];
    }

    create(name, options = {}) {
        const now = options.now || Date.now();
        const task = {
            task_id: options.taskId || randomUUID().slice(0, 8),
            name,
            stage: options.stage || 'started',
            created_at: new Date(options.createdAt || now).toISOString(),
            queued_at: new Date(options.queuedAt || now).toISOString(),
            started_at: new Date(now).toISOString(),
            heartbeat_at: new Date(now).toISOString(),
            completed_at: null,
            failed_at: null,
            retries: options.retries || 0,
            stuck_seconds: Math.max(Number(options.stuckSeconds) || this.defaultStuckSeconds, 30)
        };
        this.active.set(task.task_id, task);
        return task;
    }

    heartbeat(taskId, stage, details = {}, now = Date.now()) {
        const task = this.active.get(taskId);
        if (!task) return null;
        task.heartbeat_at = new Date(now).toISOString();
        if (stage) task.stage = stage;
        task.details = details;
        return { ...task };
    }

    finish(taskId, failed = false, now = Date.now()) {
        const task = this.active.get(taskId);
        if (!task) return null;
        this.active.delete(taskId);
        if (failed) {
            task.failed_at = new Date(now).toISOString();
            task.stage = 'failed';
            this.totals.failed += 1;
        } else {
            task.completed_at = new Date(now).toISOString();
            task.stage = 'completed';
            this.totals.completed += 1;
        }
        task.duration_ms = Math.max(0, now - Date.parse(task.started_at));
        this.recent.unshift({ ...task });
        this.recent = this.recent.slice(0, 30);
        return { ...task };
    }

    skip(name) {
        this.totals.skipped += 1;
        if (this.logger) this.logger.debug({
            module: 'scheduler', function: 'runSerialJob', code: ERROR_CODES.WORKER_TASK_SKIPPED,
            message: 'Background job skipped because its previous run is still active', fields: { job: name }
        });
    }

    retry(taskId) {
        const task = this.active.get(taskId);
        this.totals.retries += 1;
        if (task) task.retries += 1;
    }

    getStuck(now = Date.now()) {
        return [...this.active.values()].filter(task => now - Date.parse(task.heartbeat_at) > task.stuck_seconds * 1000).map(task => ({ ...task }));
    }

    getStatus() {
        return {
            status: this.getStuck().length ? 'critical' : 'healthy',
            active_tasks: this.active.size,
            queued_tasks: 0,
            failed_tasks: this.totals.failed,
            completed_tasks: this.totals.completed,
            retry_tasks: this.totals.retries,
            skipped_tasks: this.totals.skipped,
            long_running_tasks: [...this.active.values()].filter(task => Date.now() - Date.parse(task.started_at) > 5 * 60 * 1000).length,
            stuck_tasks: this.getStuck().length,
            active: [...this.active.values()].map(task => ({ ...task })),
            recent: this.recent.slice(0, 10).map(task => ({ ...task }))
        };
    }

    async run(name, fn, options = {}) {
        const task = this.create(name, options);
        const execute = async () => {
            this.logger?.debug({
                module: 'scheduler', function: name, code: ERROR_CODES.WORKER_TASK_START,
                message: 'Background task started', fields: { job: name }
            });
            try {
                const result = await fn({
                    taskId: task.task_id,
                    heartbeat: (stage, details) => this.heartbeat(task.task_id, stage, details)
                });
                const completed = this.finish(task.task_id, false);
                this.logger?.debug({
                    module: 'scheduler', function: name, code: ERROR_CODES.WORKER_TASK_SUCCESS,
                    message: 'Background task completed', fields: { job: name, duration_ms: completed.duration_ms }
                });
                return result;
            } catch (error) {
                const failed = this.finish(task.task_id, true);
                this.logger?.error({
                    module: 'scheduler', function: name, code: ERROR_CODES.WORKER_TASK_FAILED,
                    message: 'Background task failed', error, fields: { job: name, duration_ms: failed.duration_ms }
                });
                throw error;
            }
        };
        return this.logger ? this.logger.runWithContext({ task_id: task.task_id }, execute) : execute();
    }
}

module.exports = { TaskTracker };

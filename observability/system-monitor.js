'use strict';

const fs = require('fs');
const os = require('os');
const { ERROR_CODES } = require('./error-codes');

const MB = 1024 * 1024;
const GB = 1024 * MB;

function envNumber(name, fallback, env = process.env) {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function evaluateThreshold(value, warning, critical) {
    if (!Number.isFinite(value)) return 'unknown';
    if (value >= critical) return 'critical';
    if (value >= warning) return 'warning';
    return 'healthy';
}

function cpuTotals() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        idle += cpu.times.idle;
        total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    }
    return { idle, total };
}

class SystemMonitor {
    constructor({ dataDir, db, taskTracker, issueTracker, logger, version, env = process.env } = {}) {
        this.dataDir = dataDir;
        this.db = db;
        this.taskTracker = taskTracker;
        this.issueTracker = issueTracker;
        this.logger = logger;
        this.version = version || 'unknown';
        this.env = env;
        this.intervalSeconds = Math.max(envNumber('MONITOR_INTERVAL_SECONDS', 30, env), 5);
        this.enabled = String(env.MONITOR_ENABLED || 'true').toLowerCase() !== 'false';
        this.thresholds = {
            cpu: { warning: envNumber('CPU_WARNING_PERCENT', 80, env), critical: envNumber('CPU_CRITICAL_PERCENT', 95, env) },
            memory: { warning: envNumber('MEMORY_WARNING_PERCENT', 80, env), critical: envNumber('MEMORY_CRITICAL_PERCENT', 90, env) },
            disk: { warning: envNumber('DISK_WARNING_PERCENT', 80, env), critical: envNumber('DISK_CRITICAL_PERCENT', 90, env) },
            db_latency: { warning: envNumber('DB_LATENCY_WARNING_MS', 500, env), critical: envNumber('DB_LATENCY_CRITICAL_MS', 2000, env) }
        };
        this.samples = [];
        this.timer = null;
        this.sampleInFlight = null;
        this.previousCpu = cpuTotals();
        this.previousProcessCpu = process.cpuUsage();
        this.previousSampleAt = Date.now();
        this.latest = null;
    }

    async diskStats() {
        const stat = await fs.promises.statfs(this.dataDir);
        const total = Number(stat.blocks) * Number(stat.bsize);
        const free = Number(stat.bavail) * Number(stat.bsize);
        const used = Math.max(0, total - free);
        return {
            status: evaluateThreshold(total ? used / total * 100 : NaN, this.thresholds.disk.warning, this.thresholds.disk.critical),
            usage_percent: total ? Number((used / total * 100).toFixed(1)) : null,
            used_bytes: used,
            free_bytes: free,
            total_bytes: total,
            path: this.dataDir
        };
    }

    async memoryStats() {
        const readNumber = async files => {
            for (const file of files) {
                try {
                    const raw = (await fs.promises.readFile(file, 'utf8')).trim();
                    if (raw === 'max') return null;
                    const value = Number(raw);
                    if (Number.isFinite(value) && value > 0) return value;
                } catch { /* 非 Docker 或不同 cgroup 版本時改讀下一個位置。 */ }
            }
            return null;
        };
        const [cgroupUsed, cgroupLimit] = await Promise.all([
            readNumber(['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']),
            readNumber(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'])
        ]);
        // 極大的 v1 limit 代表未限制，不應誤當可用記憶體總量。
        if (cgroupUsed != null && cgroupLimit != null && cgroupLimit < os.totalmem() * 2) {
            return { total: cgroupLimit, used: Math.min(cgroupUsed, cgroupLimit), available: Math.max(0, cgroupLimit - cgroupUsed), source: 'cgroup' };
        }
        const total = os.totalmem();
        // Node 20 的 availableMemory() 會把 OS cache / memory pressure 納入，比
        // macOS 上幾乎永遠很低的 os.freemem() 更適合告警。
        const reportedAvailable = typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem();
        const available = Math.min(total, Math.max(0, reportedAvailable));
        return { total, used: total - available, available, source: 'host' };
    }

    metricIssue(metric, status, value, codes, message) {
        const warningId = `${metric}:warning`;
        const criticalId = `${metric}:critical`;
        if (status === 'critical') {
            this.resolveIssue(warningId);
            this.reportIssue({ id: criticalId, severity: 'critical', code: codes.critical, message: `${message} critical`, details: { usage_percent: value } });
        } else if (status === 'warning') {
            this.resolveIssue(criticalId);
            this.reportIssue({ id: warningId, severity: 'warning', code: codes.warning, message: `${message} high`, details: { usage_percent: value } });
        } else if (status === 'healthy') {
            this.resolveIssue(warningId);
            this.resolveIssue(criticalId);
        }
    }

    reportIssue(input) {
        const result = this.issueTracker.report(input);
        if (!result.shouldLog) return;
        const event = {
            module: 'health.monitor', function: 'evaluateThresholds', code: input.code,
            message: input.message, fields: { ...input.details, first_seen: result.issue.first_seen, occurrences: result.issue.occurrences }
        };
        if (input.severity === 'critical') this.logger.critical(event);
        else this.logger.warning(event);
    }

    resolveIssue(id) {
        const resolved = this.issueTracker.resolve(id);
        if (!resolved) return;
        this.logger.info({
            module: 'health.monitor', function: 'resolveIssue', code: ERROR_CODES.SYS_RESOURCE_RECOVERED,
            message: 'System issue resolved', fields: { resolved_code: resolved.code, duration_seconds: resolved.duration_seconds }
        });
    }

    evaluateMemoryGrowth() {
        const recent = this.samples.slice(-10).map(sample => sample.process_rss_bytes).filter(Number.isFinite);
        if (recent.length < 10) return this.resolveIssue('memory:growth');
        let increases = 0;
        for (let i = 1; i < recent.length; i += 1) if (recent[i] > recent[i - 1]) increases += 1;
        const growth = recent[recent.length - 1] - recent[0];
        const suspicious = increases >= 8 && growth > Math.max(20 * MB, recent[0] * 0.2);
        if (suspicious) this.reportIssue({
            id: 'memory:growth', severity: 'warning', code: ERROR_CODES.SYS_MEMORY_GROWTH,
            message: 'Possible memory growth detected', details: { samples: recent.length, growth_mb: Number((growth / MB).toFixed(1)) }
        });
        else this.resolveIssue('memory:growth');
    }

    async sample() {
        if (this.sampleInFlight) return this.sampleInFlight;
        this.sampleInFlight = this._sample().finally(() => { this.sampleInFlight = null; });
        return this.sampleInFlight;
    }

    async _sample() {
        let now = Date.now();
        let currentCpu = cpuTotals();
        let totalDelta = currentCpu.total - this.previousCpu.total;
        let idleDelta = currentCpu.idle - this.previousCpu.idle;
        if (totalDelta <= 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            now = Date.now();
            currentCpu = cpuTotals();
            totalDelta = currentCpu.total - this.previousCpu.total;
            idleDelta = currentCpu.idle - this.previousCpu.idle;
        }
        const systemCpu = totalDelta > 0 ? Number(((1 - idleDelta / totalDelta) * 100).toFixed(1)) : null;
        const currentProcessCpu = process.cpuUsage();
        const elapsedMs = Math.max(now - this.previousSampleAt, 1);
        const processMicros = (currentProcessCpu.user - this.previousProcessCpu.user) + (currentProcessCpu.system - this.previousProcessCpu.system);
        const processCpu = Number(Math.max(0, processMicros / (elapsedMs * 1000) * 100).toFixed(1));
        this.previousCpu = currentCpu;
        this.previousProcessCpu = currentProcessCpu;
        this.previousSampleAt = now;

        const memory = process.memoryUsage();
        const systemMemory = await this.memoryStats();
        const totalMemory = systemMemory.total;
        const availableMemory = systemMemory.available;
        const systemMemoryPct = totalMemory ? Number((systemMemory.used / totalMemory * 100).toFixed(1)) : null;
        let disk;
        try { disk = await this.diskStats(); }
        catch (error) {
            disk = { status: 'unknown', usage_percent: null, free_bytes: null, path: this.dataDir };
            this.logger.error({ module: 'health.monitor', function: 'diskStats', code: ERROR_CODES.SYS_MONITOR_FAILED, message: 'Disk monitoring failed', error });
        }
        const database = this.db.diagnostics();
        const worker = this.taskTracker.getStatus();
        const cpuStatus = evaluateThreshold(systemCpu, this.thresholds.cpu.warning, this.thresholds.cpu.critical);
        const memoryStatus = evaluateThreshold(systemMemoryPct, this.thresholds.memory.warning, this.thresholds.memory.critical);

        this.metricIssue('cpu', cpuStatus, systemCpu,
            { warning: ERROR_CODES.SYS_CPU_WARNING, critical: ERROR_CODES.SYS_CPU_CRITICAL }, 'CPU usage');
        this.metricIssue('memory', memoryStatus, systemMemoryPct,
            { warning: ERROR_CODES.SYS_MEMORY_WARNING, critical: ERROR_CODES.SYS_MEMORY_CRITICAL }, 'Memory usage');
        this.metricIssue('disk', disk.status, disk.usage_percent,
            { warning: ERROR_CODES.SYS_DISK_WARNING, critical: ERROR_CODES.SYS_DISK_CRITICAL }, 'Disk usage');

        if (!database.ok) this.reportIssue({
            id: 'database:health', severity: 'critical', code: ERROR_CODES.DB_HEALTH_FAILED,
            message: 'SQLite database unavailable', details: { error: database.error }
        });
        else this.resolveIssue('database:health');

        const dbLatencyStatus = evaluateThreshold(database.latency_ms, this.thresholds.db_latency.warning, this.thresholds.db_latency.critical);
        if (dbLatencyStatus === 'critical') {
            this.resolveIssue('database:latency:warning');
            this.reportIssue({
                id: 'database:latency:critical', severity: 'critical', code: ERROR_CODES.DB_QUERY_SLOW,
                message: 'SQLite query latency critical', details: { latency_ms: database.latency_ms }
            });
        } else if (dbLatencyStatus === 'warning') {
            this.resolveIssue('database:latency:critical');
            this.reportIssue({
                id: 'database:latency:warning', severity: 'warning', code: ERROR_CODES.DB_QUERY_SLOW,
                message: 'SQLite query latency high', details: { latency_ms: database.latency_ms }
            });
        } else {
            this.resolveIssue('database:latency:warning');
            this.resolveIssue('database:latency:critical');
        }

        const stuck = this.taskTracker.getStuck(now);
        const stuckIds = new Set(stuck.map(task => `worker:stuck:${task.task_id}`));
        for (const task of stuck) this.reportIssue({
            id: `worker:stuck:${task.task_id}`, severity: 'critical', code: ERROR_CODES.WORKER_STUCK,
            message: 'Task heartbeat timeout', details: { task_id: task.task_id, job: task.name, heartbeat_at: task.heartbeat_at }
        });
        for (const issue of this.issueTracker.listActive()) {
            if (issue.id.startsWith('worker:stuck:') && !stuckIds.has(issue.id)) this.resolveIssue(issue.id);
        }

        const sample = {
            timestamp: new Date(now).toISOString(),
            process_cpu_percent: processCpu,
            system_cpu_percent: systemCpu,
            process_rss_bytes: memory.rss,
            system_memory_percent: systemMemoryPct,
            db_active_connections: database.pool.active,
            active_tasks: worker.active_tasks
        };
        this.samples.push(sample);
        this.samples = this.samples.slice(-60);
        this.evaluateMemoryGrowth();

        const activeIssues = this.issueTracker.listActive();
        const overall = activeIssues.some(issue => issue.severity === 'critical') ? 'critical'
            : activeIssues.some(issue => issue.severity === 'warning') ? 'warning' : 'healthy';
        this.latest = {
            status: overall,
            sampled_at: sample.timestamp,
            uptime_seconds: Math.floor(process.uptime()),
            app_version: this.version,
            cpu: { status: cpuStatus, usage_percent: systemCpu, process_usage_percent: processCpu, load_average: os.loadavg() },
            memory: {
                status: memoryStatus, usage_percent: systemMemoryPct, process_mb: Number((memory.rss / MB).toFixed(1)),
                process_percent: totalMemory ? Number((memory.rss / totalMemory * 100).toFixed(2)) : null,
                system_used_bytes: systemMemory.used, system_available_bytes: availableMemory, system_total_bytes: totalMemory,
                source: systemMemory.source
            },
            disk,
            database: {
                status: database.ok ? (dbLatencyStatus === 'unknown' ? 'healthy' : dbLatencyStatus) : 'critical',
                type: 'sqlite', latency_ms: database.latency_ms, file: database.file_name,
                active_connections: database.pool.active, pool: database.pool,
                slow_queries: database.slow_queries, failed_queries: database.failed_queries,
                write_buffer: database.write_buffer
            },
            worker,
            active_issues: activeIssues,
            resolved_issues: this.issueTracker.listResolved(),
            trend_data: [...this.samples]
        };
        return this.latest;
    }

    async ensureSample() { return this.latest || this.sample(); }
    getStatus() { return this.latest; }

    start() {
        if (!this.enabled || this.timer) return;
        this.logger.info({
            module: 'health.monitor', function: 'start', code: ERROR_CODES.WORKER_START,
            message: 'System health monitor started', fields: { interval_seconds: this.intervalSeconds, ring_buffer_samples: 60 }
        });
        this.sample().catch(error => this.logger.error({
            module: 'health.monitor', function: 'sample', code: ERROR_CODES.SYS_MONITOR_FAILED,
            message: 'Initial system monitoring sample failed', error
        }));
        this.timer = setInterval(() => this.sample().catch(error => this.logger.error({
            module: 'health.monitor', function: 'sample', code: ERROR_CODES.SYS_MONITOR_FAILED,
            message: 'System monitoring sample failed', error
        })), this.intervalSeconds * 1000);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = { SystemMonitor, evaluateThreshold, envNumber };

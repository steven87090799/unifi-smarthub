const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { performance } = require('perf_hooks');
const { ERROR_CODES } = require('./observability/error-codes');

const HISTORY_SERIES = ['trend', 'ucg', 'nas', 'ups', 'wiim', 'linux'];
const REPORT_CLAIM_RETRY_AFTER_MS = 60 * 1000;
const REPORT_CLAIM_STALE_MS = 5 * 60 * 1000;
const REPORT_MAX_ATTEMPTS = 3;
const REPORT_RUN_RETENTION = 50;
// Durable terminal identities are deliberately finite. At the highest supported
// cadence (every six hours), 512 keys cover roughly 128 days. Active/retryable
// work is excluded so retention cannot reopen an in-flight schedule slot.
const REPORT_SCHEDULE_KEY_RETENTION = 512;
const SQLITE_STARTUP_LOCK_RETRY_MS = 5000;
const SQLITE_STARTUP_LOCK_POLL_MS = 25;
const STARTUP_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const MIN_REPORT_TIMESTAMP = Date.UTC(2000, 0, 1);
const MAX_REPORT_TIMESTAMP = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const JSON_HISTORY_FILES = {
    trend: 'trend-history.json',
    ucg: 'ucg-history.json',
    nas: 'nas-history.json',
    ups: 'ups-history.json',
    wiim: 'wiim-history.json',
    linux: 'linux-history.json'
};

function pointTimestamp(point, series) {
    if (series === 'wiim') {
        const seconds = Number(point.ts);
        return Number.isFinite(seconds) ? Math.round(seconds * 1000) : NaN;
    }
    const timestamp = Date.parse(point.t);
    return Number.isFinite(timestamp) ? timestamp : NaN;
}

function eventTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : NaN;
}

function reportTimestamp(value) {
    const timestamp = value instanceof Date
        ? value.getTime()
        : (typeof value === 'number' ? value : Date.parse(value));
    if (!Number.isFinite(timestamp)) return NaN;
    const normalized = Math.trunc(timestamp);
    return normalized >= MIN_REPORT_TIMESTAMP && normalized <= MAX_REPORT_TIMESTAMP ? normalized : NaN;
}

function reportTimestampIso(value) {
    const timestamp = reportTimestamp(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeScheduleKey(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    const match = /^scheduled:(\d{4})-(\d{2})-(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    if (year < 2000 || year > 9999 || month < 1 || month > 12 || hour < 0 || hour > 23) return null;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day >= 1 && day <= daysInMonth ? value : null;
}

function boundedRequiredString(value, maxLength, field) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
        throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value;
}

function isSqliteLockError(error) {
    return error?.code === 'SQLITE_BUSY'
        || error?.code === 'SQLITE_LOCKED'
        || /database (?:is )?locked/i.test(error?.message || '');
}

function pragmaWithBusyRetry(db, statement) {
    const deadline = Date.now() + SQLITE_STARTUP_LOCK_RETRY_MS;
    for (;;) {
        try { return db.pragma(statement); }
        catch (error) {
            if (!isSqliteLockError(error) || Date.now() >= deadline) throw error;
            Atomics.wait(STARTUP_WAIT_BUFFER, 0, 0, Math.min(SQLITE_STARTUP_LOCK_POLL_MS, deadline - Date.now()));
        }
    }
}

function normalizeClaimToken(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? value
        : null;
}

function createHistoryDb(dataDir, options = {}) {
    const logger = typeof options === 'function' ? null : options.logger;
    const legacyLogger = typeof options === 'function' ? options : null;
    const slowQueryMs = Math.max(Number(options.slowQueryMs || process.env.DB_SLOW_QUERY_MS) || 1000, 1);
    const maxPendingPoints = Math.max(Number(options.maxPendingPoints) || 1000, 1);
    const maxPendingBytes = Math.max(Number(options.maxPendingBytes) || 1024 * 1024, 1024);
    const emit = (level, event) => {
        if (logger && typeof logger[level] === 'function') logger[level](event);
        else if (legacyLogger) legacyLogger(`[${event.code}] ${event.message}${event.error ? `: ${event.error.message}` : ''}`);
    };
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'smarthub.db');
    emit('info', {
        module: 'database.sqlite', function: 'createHistoryDb', code: ERROR_CODES.DB_CONNECT_START,
        message: 'Opening SQLite database', fields: { file: path.basename(file) }
    });
    let db;
    try { db = new Database(file); }
    catch (error) {
        emit('critical', {
            module: 'database.sqlite', function: 'createHistoryDb', code: ERROR_CODES.DB_CONNECT_FAILED,
            message: 'Failed to open SQLite database', error, fields: { file: path.basename(file) }
        });
        throw error;
    }
    // Configure lock waiting before any pragma that may itself need a database
    // lock. Concurrent container starts/migrations must wait instead of failing
    // immediately at journal_mode or auto_vacuum negotiation.
    db.pragma('busy_timeout = 5000');

    // auto_vacuum must be configured before tables are created. Existing DBs keep
    // their current mode, which is safe; new databases use incremental vacuum.
    try { db.pragma('auto_vacuum = INCREMENTAL'); } catch { }
    pragmaWithBusyRetry(db, 'journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY,
            series TEXT NOT NULL,
            ts INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_series_ts ON history(series, ts);
        CREATE INDEX IF NOT EXISTS idx_history_series_ts_id ON history(series, ts, id);
        CREATE TABLE IF NOT EXISTS unifi_device_telemetry (
            id INTEGER PRIMARY KEY,
            sampled_ts INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            data TEXT NOT NULL,
            UNIQUE(sampled_ts, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_device_telemetry_time
            ON unifi_device_telemetry(sampled_ts, device_id, id);
        CREATE TABLE IF NOT EXISTS ups_events (
            id INTEGER PRIMARY KEY,
            start_ts INTEGER NOT NULL,
            end_ts INTEGER,
            duration_sec INTEGER,
            min_battery REAL,
            start_voltage REAL
        );
        CREATE INDEX IF NOT EXISTS idx_ups_events_start ON ups_events(start_ts);
        CREATE TABLE IF NOT EXISTS ups_power_events (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_ts INTEGER,
            observed_ts INTEGER NOT NULL,
            input_v REAL,
            severity TEXT NOT NULL,
            description TEXT NOT NULL,
            UNIQUE(source, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ups_power_events_time
            ON ups_power_events(COALESCE(event_ts, observed_ts) DESC, id DESC);
        CREATE TABLE IF NOT EXISTS integration_sync_state (
            source TEXT PRIMARY KEY,
            initialized_at INTEGER,
            last_success_at INTEGER,
            last_external_id TEXT,
            last_event_ts INTEGER,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS block_history (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            mac TEXT,
            name TEXT,
            action TEXT,
            source TEXT,
            reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_block_history_ts ON block_history(ts);
        CREATE TABLE IF NOT EXISTS report_runs (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            trigger TEXT NOT NULL,
            title TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            channel TEXT,
            delivery_error TEXT,
            body TEXT NOT NULL,
            schedule_key TEXT,
            run_status TEXT NOT NULL DEFAULT 'completed',
            claimed_ts INTEGER,
            completed_ts INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 1,
            claim_token TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_report_runs_ts ON report_runs(ts DESC);
        CREATE TABLE IF NOT EXISTS threat_ip_blocks (
            id TEXT PRIMARY KEY,
            ip TEXT NOT NULL UNIQUE,
            created_ts INTEGER NOT NULL,
            expires_ts INTEGER NOT NULL,
            desired_state TEXT NOT NULL CHECK(desired_state IN ('active', 'removed')),
            sync_state TEXT NOT NULL CHECK(sync_state IN ('pending', 'applied', 'error')),
            updated_ts INTEGER NOT NULL,
            last_attempt_ts INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_retry_ts INTEGER,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_threat_ip_blocks_expiry
            ON threat_ip_blocks(desired_state, expires_ts);
        CREATE TABLE IF NOT EXISTS threat_ip_block_audit (
            id INTEGER PRIMARY KEY,
            block_id TEXT NOT NULL,
            ts INTEGER NOT NULL,
            ip TEXT NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_threat_ip_block_audit_ts
            ON threat_ip_block_audit(ts DESC, id DESC);
        CREATE TABLE IF NOT EXISTS adguard_service_policies (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL UNIQUE,
            categories_json TEXT NOT NULL,
            time_zone TEXT NOT NULL,
            allow_windows_json TEXT NOT NULL,
            baseline_json TEXT,
            desired_state TEXT NOT NULL CHECK(desired_state IN ('active', 'removed')),
            sync_state TEXT NOT NULL CHECK(sync_state IN ('pending', 'applied', 'error')),
            created_ts INTEGER NOT NULL,
            updated_ts INTEGER NOT NULL,
            last_attempt_ts INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_retry_ts INTEGER,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_adguard_service_policies_retry
            ON adguard_service_policies(desired_state, sync_state, next_retry_ts);
        CREATE TABLE IF NOT EXISTS adguard_service_policy_audit (
            id INTEGER PRIMARY KEY,
            policy_id TEXT NOT NULL,
            ts INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_adguard_service_policy_audit_ts
            ON adguard_service_policy_audit(ts DESC, id DESC);
        CREATE TABLE IF NOT EXISTS web_push_subscriptions (
            endpoint_hash TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            expiration_ts INTEGER,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_ts INTEGER NOT NULL,
            updated_ts INTEGER NOT NULL,
            last_success_ts INTEGER,
            failure_count INTEGER NOT NULL DEFAULT 0,
            next_retry_ts INTEGER,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_retry
            ON web_push_subscriptions(next_retry_ts, expiration_ts);
        CREATE TABLE IF NOT EXISTS web_push_delivery_claims (
            endpoint_hash TEXT NOT NULL,
            notification_key TEXT NOT NULL,
            created_ts INTEGER NOT NULL,
            PRIMARY KEY (endpoint_hash, notification_key)
        );
        CREATE INDEX IF NOT EXISTS idx_web_push_delivery_claims_created
            ON web_push_delivery_claims(created_ts, endpoint_hash, notification_key);
    `);

    // report_runs predates durable scheduler claims. ALTER only missing columns
    // so an existing installation upgrades in place without rebuilding history.
    const reportRunMigrations = [
        ['schedule_key', 'ALTER TABLE report_runs ADD COLUMN schedule_key TEXT'],
        ['run_status', "ALTER TABLE report_runs ADD COLUMN run_status TEXT NOT NULL DEFAULT 'completed'"],
        ['claimed_ts', 'ALTER TABLE report_runs ADD COLUMN claimed_ts INTEGER'],
        ['completed_ts', 'ALTER TABLE report_runs ADD COLUMN completed_ts INTEGER'],
        ['attempt_count', 'ALTER TABLE report_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1'],
        ['claim_token', 'ALTER TABLE report_runs ADD COLUMN claim_token TEXT']
    ];
    const migrateReportRuns = db.transaction(() => {
        const migrationTimestamp = Date.now();
        const reportRunColumns = new Set(db.pragma('table_info(report_runs)').map(column => column.name));
        for (const [column, statement] of reportRunMigrations) {
            if (!reportRunColumns.has(column)) db.exec(statement);
        }
        db.exec(`
            UPDATE report_runs
            SET ts = ${migrationTimestamp}
            WHERE typeof(ts) <> 'integer'
               OR ts < ${MIN_REPORT_TIMESTAMP}
               OR ts > ${MAX_REPORT_TIMESTAMP};
            UPDATE report_runs
            SET attempt_count = CASE
                WHEN typeof(attempt_count) = 'integer'
                 AND attempt_count BETWEEN 1 AND ${REPORT_MAX_ATTEMPTS}
                THEN attempt_count
                ELSE 1
            END;
            UPDATE report_runs
            SET run_status = CASE
                WHEN delivery_status = 'claimed' THEN 'claimed'
                WHEN delivery_status = 'failed' AND attempt_count >= ${REPORT_MAX_ATTEMPTS} THEN 'exhausted'
                WHEN delivery_status = 'failed' THEN 'failed'
                WHEN run_status = 'claimed' THEN 'claimed'
                WHEN run_status IN ('failed', 'exhausted') AND attempt_count >= ${REPORT_MAX_ATTEMPTS} THEN 'exhausted'
                WHEN run_status IN ('failed', 'exhausted') THEN 'failed'
                ELSE 'completed'
            END;
            UPDATE report_runs
            SET completed_ts = ts
            WHERE run_status IN ('completed', 'failed', 'exhausted')
              AND (
                  typeof(completed_ts) <> 'integer'
                  OR completed_ts < ${MIN_REPORT_TIMESTAMP}
                  OR completed_ts > ${MAX_REPORT_TIMESTAMP}
              );
            UPDATE report_runs
            SET claimed_ts = ts
            WHERE schedule_key IS NOT NULL
              AND (
                  typeof(claimed_ts) <> 'integer'
                  OR claimed_ts < ${MIN_REPORT_TIMESTAMP}
                  OR claimed_ts > ${MAX_REPORT_TIMESTAMP}
              );
            UPDATE report_runs
            SET completed_ts = NULL
            WHERE run_status = 'claimed';
            UPDATE report_runs
            SET claim_token = NULL
            WHERE run_status <> 'claimed';
            UPDATE report_runs
            SET schedule_key = NULL, claim_token = NULL
            WHERE schedule_key IS NOT NULL AND trigger <> 'scheduled';
        `);
        const detachInvalidScheduleIdentity = db.prepare(`
            UPDATE report_runs SET schedule_key = NULL, claim_token = NULL WHERE id = ?
        `);
        for (const row of db.prepare(`
            SELECT id, schedule_key FROM report_runs
            WHERE schedule_key IS NOT NULL AND trigger = 'scheduled'
        `).all()) {
            if (!normalizeScheduleKey(row.schedule_key)) detachInvalidScheduleIdentity.run(row.id);
        }
        const index = db.pragma('index_list(report_runs)')
            .find(candidate => candidate.name === 'idx_report_runs_schedule_key');
        const indexColumns = index ? db.pragma('index_info(idx_report_runs_schedule_key)') : [];
        const validUniqueIndex = index?.unique === 1
            && index.partial === 0
            && indexColumns.length === 1
            && indexColumns[0].name === 'schedule_key';
        if (!validUniqueIndex) {
            // A partially deployed schema may contain duplicate keys without its
            // unique index. Preserve all history, but retain identity on one row.
            db.exec(`
                DROP INDEX IF EXISTS idx_report_runs_schedule_key;
                UPDATE report_runs
                SET schedule_key = NULL
                WHERE schedule_key IS NOT NULL
                  AND id NOT IN (
                      SELECT id FROM (
                          SELECT id,
                                 ROW_NUMBER() OVER (
                                     PARTITION BY schedule_key
                                     ORDER BY
                                         CASE
                                             WHEN run_status = 'completed' AND delivery_status = 'sent' THEN 0
                                             WHEN run_status = 'completed' THEN 1
                                             WHEN run_status = 'exhausted' THEN 2
                                             WHEN run_status = 'failed' THEN 3
                                             WHEN run_status = 'claimed' THEN 4
                                             ELSE 5
                                         END,
                                         COALESCE(completed_ts, ts) DESC,
                                         id DESC
                                 ) AS identity_rank
                          FROM report_runs
                          WHERE schedule_key IS NOT NULL
                      ) ranked
                      WHERE identity_rank = 1
                  );
                CREATE UNIQUE INDEX idx_report_runs_schedule_key
                ON report_runs(schedule_key);
            `);
        }
    });
    migrateReportRuns.immediate();
    emit('info', {
        module: 'database.sqlite', function: 'createHistoryDb', code: ERROR_CODES.DB_CONNECT_SUCCESS,
        message: 'SQLite database connected', fields: { file: path.basename(file), journal_mode: 'WAL', slow_query_ms: slowQueryMs }
    });

    let activeQueries = 0;
    let slowQueries = 0;
    let failedQueries = 0;
    let lastQueryLatencyMs = 0;
    let lastError = null;
    let closed = false;

    function measure(operation, table, fn, { transaction = false } = {}) {
        const started = performance.now();
        activeQueries += 1;
        try {
            const result = fn();
            lastQueryLatencyMs = Number((performance.now() - started).toFixed(2));
            lastError = null;
            if (lastQueryLatencyMs >= slowQueryMs) {
                slowQueries += 1;
                emit('warning', {
                    module: 'database.sqlite', function: operation, code: ERROR_CODES.DB_QUERY_SLOW,
                    message: 'Slow SQLite operation', fields: { operation, table, duration_ms: lastQueryLatencyMs }
                });
            }
            return result;
        } catch (error) {
            lastQueryLatencyMs = Number((performance.now() - started).toFixed(2));
            lastError = error.message;
            failedQueries += 1;
            emit('error', {
                module: 'database.sqlite', function: operation,
                code: transaction ? ERROR_CODES.DB_TRANSACTION_FAILED : ERROR_CODES.DB_QUERY_FAILED,
                message: transaction ? 'SQLite transaction failed and was rolled back' : 'SQLite operation failed',
                error, fields: { operation, table, duration_ms: lastQueryLatencyMs }
            });
            throw error;
        } finally {
            activeQueries -= 1;
        }
    }

    const insertPointStmt = db.prepare('INSERT INTO history (series, ts, data) VALUES (?, ?, ?)');
    const countSeriesStmt = db.prepare('SELECT COUNT(*) AS count FROM history WHERE series = ?');
    const getSinceStmt = db.prepare('SELECT ts, data FROM history INDEXED BY idx_history_series_ts_id WHERE series = ? AND ts >= ? ORDER BY ts ASC, id ASC');
    const getLatestStmt = db.prepare('SELECT ts, data FROM history WHERE series = ? ORDER BY ts DESC, id DESC LIMIT 1');
    const deleteSeriesStmt = db.prepare('DELETE FROM history WHERE series = ?');
    const deleteBeforeStmt = db.prepare('DELETE FROM history WHERE series = ? AND ts < ?');
    const countPointsStmt = db.prepare('SELECT COUNT(*) AS count FROM history WHERE series = ?');
    const deleteOldestStmt = db.prepare(`
        DELETE FROM history WHERE id IN (
            SELECT id FROM history WHERE series = ? ORDER BY ts ASC, id ASC LIMIT ?
        )
    `);
    const insertUnifiTelemetryStmt = db.prepare(`
        INSERT OR IGNORE INTO unifi_device_telemetry (sampled_ts, device_id, data)
        VALUES (@sampled_ts, @device_id, @data)
    `);
    const listUnifiTelemetryStmt = db.prepare(`
        SELECT sampled_ts, device_id, data
        FROM unifi_device_telemetry
        WHERE sampled_ts >= ?
        ORDER BY sampled_ts ASC, device_id ASC, id ASC
        LIMIT 100000
    `);
    const deleteOldUnifiTelemetryStmt = db.prepare('DELETE FROM unifi_device_telemetry WHERE sampled_ts < ?');
    const countUnifiTelemetryStmt = db.prepare('SELECT COUNT(*) AS count FROM unifi_device_telemetry');
    const deleteOldestUnifiTelemetryStmt = db.prepare(`
        DELETE FROM unifi_device_telemetry WHERE id IN (
            SELECT id FROM unifi_device_telemetry ORDER BY sampled_ts ASC, device_id ASC, id ASC LIMIT ?
        )
    `);
    const insertUpsEventStmt = db.prepare(`
        INSERT INTO ups_events (start_ts, end_ts, duration_sec, min_battery, start_voltage)
        VALUES (@start_ts, @end_ts, @duration_sec, @min_battery, @start_voltage)
    `);
    const listUpsEventsStmt = db.prepare('SELECT * FROM ups_events ORDER BY start_ts DESC, id DESC LIMIT 200');
    const openUpsEventStmt = db.prepare('SELECT * FROM ups_events WHERE end_ts IS NULL ORDER BY start_ts DESC, id DESC LIMIT 1');
    const closeUpsEventStmt = db.prepare(`
        UPDATE ups_events
        SET end_ts = @end_ts, duration_sec = @duration_sec
        WHERE id = @id AND end_ts IS NULL
    `);
    const updateUpsMinBatteryStmt = db.prepare(`
        UPDATE ups_events
        SET min_battery = @min_battery
        WHERE id = @id AND end_ts IS NULL
    `);
    const insertUpsPowerEventStmt = db.prepare(`
        INSERT OR IGNORE INTO ups_power_events (
            source, external_id, event_type, event_ts, observed_ts, input_v, severity, description
        ) VALUES (
            @source, @external_id, @event_type, @event_ts, @observed_ts, @input_v, @severity, @description
        )
    `);
    const getUpsPowerEventStmt = db.prepare(`
        SELECT * FROM ups_power_events WHERE source = ? AND external_id = ?
    `);
    const listUpsPowerEventsStmt = db.prepare(`
        SELECT * FROM ups_power_events
        ORDER BY COALESCE(event_ts, observed_ts) DESC, id DESC LIMIT ?
    `);
    const deleteOldUpsPowerEventsStmt = db.prepare(`
        DELETE FROM ups_power_events WHERE id IN (
            SELECT id FROM ups_power_events
            ORDER BY COALESCE(event_ts, observed_ts) DESC, id DESC LIMIT -1 OFFSET 1000
        )
    `);
    const getIntegrationSyncStateStmt = db.prepare(`
        SELECT source, initialized_at, last_success_at, last_external_id, last_event_ts, updated_at
        FROM integration_sync_state WHERE source = ?
    `);
    const upsertIntegrationSyncStateStmt = db.prepare(`
        INSERT INTO integration_sync_state (
            source, initialized_at, last_success_at, last_external_id, last_event_ts, updated_at
        ) VALUES (
            @source, @initialized_at, @last_success_at, @last_external_id, @last_event_ts, @updated_at
        )
        ON CONFLICT(source) DO UPDATE SET
            initialized_at = excluded.initialized_at,
            last_success_at = excluded.last_success_at,
            last_external_id = excluded.last_external_id,
            last_event_ts = excluded.last_event_ts,
            updated_at = excluded.updated_at
    `);
    const deleteOldUpsEventsStmt = db.prepare(`
        DELETE FROM ups_events WHERE id IN (
            SELECT id FROM ups_events ORDER BY start_ts DESC, id DESC LIMIT -1 OFFSET 200
        )
    `);
    const insertBlockStmt = db.prepare(`
        INSERT INTO block_history (ts, mac, name, action, source, reason)
        VALUES (@ts, @mac, @name, @action, @source, @reason)
    `);
    const listBlockStmt = db.prepare('SELECT * FROM block_history ORDER BY ts DESC, id DESC LIMIT 200');
    const insertReportRunStmt = db.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, channel, delivery_error, body,
            schedule_key, run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (
            @ts, @trigger, @title, @delivery_status, @channel, @delivery_error, @body,
            @schedule_key, @run_status, @claimed_ts, @completed_ts, @attempt_count, @claim_token
        )
    `);
    const claimScheduledReportStmt = db.prepare(`
        INSERT INTO report_runs (
            ts, trigger, title, delivery_status, channel, delivery_error, body,
            schedule_key, run_status, claimed_ts, completed_ts, attempt_count, claim_token
        ) VALUES (
            @ts, 'scheduled', @title, 'claimed', NULL, NULL, '',
            @schedule_key, 'claimed', @claimed_ts, NULL, 1, @claim_token
        )
        ON CONFLICT(schedule_key) DO NOTHING
    `);
    const getScheduledReportClaimStmt = db.prepare(`
        SELECT id, schedule_key, title, run_status, attempt_count, claimed_ts, completed_ts
        FROM report_runs WHERE schedule_key = ?
    `);
    const reclaimScheduledReportStmt = db.prepare(`
        UPDATE report_runs
        SET ts = @ts,
            title = @title,
            delivery_status = 'claimed',
            channel = NULL,
            delivery_error = NULL,
            body = '',
            run_status = 'claimed',
            claimed_ts = @claimed_ts,
            completed_ts = NULL,
            claim_token = @claim_token,
            attempt_count = attempt_count + 1
        WHERE schedule_key = @schedule_key
          AND trigger = 'scheduled'
          AND attempt_count < @max_attempts
          AND (
              (run_status = 'failed' AND completed_ts <= @retry_before)
              OR (run_status = 'claimed' AND claimed_ts <= @stale_before)
          )
    `);
    const completeScheduledReportStmt = db.prepare(`
        UPDATE report_runs
        SET ts = @ts,
            title = COALESCE(@title, title),
            delivery_status = @delivery_status,
            channel = @channel,
            delivery_error = @delivery_error,
            body = @body,
            run_status = @run_status,
            completed_ts = @completed_ts,
            claim_token = NULL
        WHERE schedule_key = @schedule_key
          AND trigger = 'scheduled'
          AND run_status = 'claimed'
          AND attempt_count = @attempt_count
          AND claim_token = @claim_token
          AND @completed_ts >= claimed_ts
    `);
    const renewScheduledReportClaimStmt = db.prepare(`
        UPDATE report_runs
        SET claimed_ts = @ts
        WHERE schedule_key = @schedule_key
          AND run_status = 'claimed'
          AND attempt_count = @attempt_count
          AND claim_token = @claim_token
          AND @ts >= claimed_ts
    `);
    const selectRetryableScheduledReportStmt = db.prepare(`
        SELECT id, schedule_key, title
        FROM report_runs
        WHERE schedule_key IS NOT NULL
          AND trigger = 'scheduled'
          AND attempt_count < @max_attempts
          AND (
              (run_status = 'failed' AND completed_ts <= @retry_before)
              OR (run_status = 'claimed' AND claimed_ts <= @stale_before)
          )
        ORDER BY COALESCE(completed_ts, claimed_ts, ts) ASC, id ASC
        LIMIT 1
    `);
    const exhaustScheduledReportClaimsStmt = db.prepare(`
        UPDATE report_runs
        SET delivery_status = 'failed',
            delivery_error = COALESCE(delivery_error, 'scheduled_report_attempts_exhausted'),
            run_status = 'exhausted',
            completed_ts = CASE
                WHEN run_status = 'claimed' THEN @now
                ELSE COALESCE(completed_ts, @now)
            END,
            claim_token = NULL
        WHERE attempt_count >= @max_attempts
          AND schedule_key IS NOT NULL
          AND trigger = 'scheduled'
          AND (
              run_status = 'failed'
              OR (run_status = 'claimed' AND claimed_ts <= @stale_before)
          )
    `);
    const detachInvalidReportScheduleIdentityStmt = db.prepare(`
        UPDATE report_runs
        SET schedule_key = NULL, claim_token = NULL
        WHERE id = @id AND schedule_key = @schedule_key
    `);
    const listReportRunsStmt = db.prepare(`
        SELECT id, ts, trigger, title, delivery_status, channel, delivery_error, body,
               schedule_key, run_status, claimed_ts, completed_ts, attempt_count
        FROM report_runs ORDER BY ts DESC, id DESC LIMIT ?
    `);
    const deleteOldReportRunsStmt = db.prepare(`
        DELETE FROM report_runs
        WHERE id IN (
            SELECT id FROM report_runs
            WHERE schedule_key IS NULL
            ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ${REPORT_RUN_RETENTION}
        ) OR id IN (
            SELECT id FROM report_runs
            WHERE schedule_key IS NOT NULL AND run_status IN ('completed', 'exhausted')
            ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ${REPORT_SCHEDULE_KEY_RETENTION}
        )
    `);
    const getThreatIpBlockByIdStmt = db.prepare('SELECT * FROM threat_ip_blocks WHERE id = ?');
    const getThreatIpBlockByIpStmt = db.prepare('SELECT * FROM threat_ip_blocks WHERE ip = ?');
    const listThreatIpBlocksStmt = db.prepare(`
        SELECT * FROM threat_ip_blocks ORDER BY created_ts DESC, id DESC
    `);
    const insertThreatIpBlockStmt = db.prepare(`
        INSERT INTO threat_ip_blocks (
            id, ip, created_ts, expires_ts, desired_state, sync_state, updated_ts,
            last_attempt_ts, attempt_count, next_retry_ts, last_error
        ) VALUES (
            @id, @ip, @created_ts, @expires_ts, 'active', 'pending', @updated_ts,
            NULL, 0, NULL, NULL
        )
    `);
    const reactivateThreatIpBlockStmt = db.prepare(`
        UPDATE threat_ip_blocks
        SET expires_ts = @expires_ts,
            desired_state = 'active',
            sync_state = 'pending',
            updated_ts = @updated_ts,
            next_retry_ts = NULL,
            last_error = NULL
        WHERE id = @id
    `);
    const removeThreatIpBlockStmt = db.prepare(`
        UPDATE threat_ip_blocks
        SET desired_state = 'removed',
            sync_state = 'pending',
            updated_ts = @updated_ts,
            next_retry_ts = NULL,
            last_error = NULL
        WHERE id = @id AND desired_state <> 'removed'
    `);
    const listExpiredThreatIpBlocksStmt = db.prepare(`
        SELECT * FROM threat_ip_blocks
        WHERE desired_state = 'active' AND expires_ts <= ?
        ORDER BY expires_ts ASC, id ASC
    `);
    const insertThreatIpBlockAuditStmt = db.prepare(`
        INSERT INTO threat_ip_block_audit (block_id, ts, ip, action, outcome, detail)
        VALUES (@block_id, @ts, @ip, @action, @outcome, @detail)
    `);
    const listThreatIpBlockAuditStmt = db.prepare(`
        SELECT * FROM threat_ip_block_audit ORDER BY ts DESC, id DESC LIMIT ?
    `);
    const deleteOldThreatIpBlockAuditStmt = db.prepare(`
        DELETE FROM threat_ip_block_audit WHERE id IN (
            SELECT id FROM threat_ip_block_audit ORDER BY ts DESC, id DESC LIMIT -1 OFFSET 1000
        )
    `);
    const markActiveThreatIpBlocksSyncedStmt = db.prepare(`
        UPDATE threat_ip_blocks
        SET sync_state = 'applied',
            updated_ts = @updated_ts,
            last_attempt_ts = @updated_ts,
            attempt_count = 0,
            next_retry_ts = NULL,
            last_error = NULL
        WHERE desired_state = 'active'
    `);
    const deleteRemovedThreatIpBlocksStmt = db.prepare(`
        DELETE FROM threat_ip_blocks WHERE desired_state = 'removed'
    `);
    const markThreatIpBlockSyncFailureStmt = db.prepare(`
        UPDATE threat_ip_blocks
        SET sync_state = 'error',
            updated_ts = @updated_ts,
            last_attempt_ts = @updated_ts,
            attempt_count = MIN(attempt_count + 1, 1000000),
            next_retry_ts = @next_retry_ts,
            last_error = @last_error
    `);
    const getAdguardServicePolicyByIdStmt = db.prepare('SELECT * FROM adguard_service_policies WHERE id = ?');
    const getAdguardServicePolicyByDeviceStmt = db.prepare('SELECT * FROM adguard_service_policies WHERE device_id = ?');
    const listAdguardServicePoliciesStmt = db.prepare(`
        SELECT * FROM adguard_service_policies ORDER BY created_ts ASC, id ASC
    `);
    const insertAdguardServicePolicyStmt = db.prepare(`
        INSERT INTO adguard_service_policies (
            id, device_id, categories_json, time_zone, allow_windows_json, baseline_json,
            desired_state, sync_state, created_ts, updated_ts, last_attempt_ts,
            attempt_count, next_retry_ts, last_error
        ) VALUES (
            @id, @device_id, @categories_json, @time_zone, @allow_windows_json, NULL,
            'active', 'pending', @created_ts, @updated_ts, NULL, 0, NULL, NULL
        )
    `);
    const updateAdguardServicePolicyStmt = db.prepare(`
        UPDATE adguard_service_policies
        SET categories_json = @categories_json,
            time_zone = @time_zone,
            allow_windows_json = @allow_windows_json,
            desired_state = 'active',
            sync_state = 'pending',
            updated_ts = @updated_ts,
            next_retry_ts = NULL,
            last_error = NULL
        WHERE id = @id
    `);
    const removeAdguardServicePolicyStmt = db.prepare(`
        UPDATE adguard_service_policies
        SET desired_state = 'removed',
            sync_state = 'pending',
            updated_ts = @updated_ts,
            next_retry_ts = NULL,
            last_error = NULL
        WHERE id = @id AND desired_state <> 'removed'
    `);
    const setAdguardServicePolicyBaselineStmt = db.prepare(`
        UPDATE adguard_service_policies
        SET baseline_json = @baseline_json, updated_ts = @updated_ts
        WHERE id = @id AND baseline_json IS NULL
    `);
    const markAdguardServicePolicyAppliedStmt = db.prepare(`
        UPDATE adguard_service_policies
        SET sync_state = 'applied',
            updated_ts = @updated_ts,
            last_attempt_ts = @updated_ts,
            attempt_count = 0,
            next_retry_ts = NULL,
            last_error = NULL
        WHERE id = @id AND desired_state = 'active'
    `);
    const deleteAdguardServicePolicyStmt = db.prepare('DELETE FROM adguard_service_policies WHERE id = ?');
    const markAdguardServicePolicyFailureStmt = db.prepare(`
        UPDATE adguard_service_policies
        SET sync_state = 'error',
            updated_ts = @updated_ts,
            last_attempt_ts = @updated_ts,
            attempt_count = MIN(attempt_count + 1, 1000000),
            next_retry_ts = @next_retry_ts,
            last_error = @last_error
        WHERE id = @id
    `);
    const insertAdguardServicePolicyAuditStmt = db.prepare(`
        INSERT INTO adguard_service_policy_audit (policy_id, ts, device_id, action, outcome, detail)
        VALUES (@policy_id, @ts, @device_id, @action, @outcome, @detail)
    `);
    const listAdguardServicePolicyAuditStmt = db.prepare(`
        SELECT * FROM adguard_service_policy_audit ORDER BY ts DESC, id DESC LIMIT ?
    `);
    const deleteOldAdguardServicePolicyAuditStmt = db.prepare(`
        DELETE FROM adguard_service_policy_audit WHERE id IN (
            SELECT id FROM adguard_service_policy_audit
            ORDER BY ts DESC, id DESC LIMIT -1 OFFSET 1000
        )
    `);
    const getWebPushSubscriptionStmt = db.prepare('SELECT * FROM web_push_subscriptions WHERE endpoint_hash = ?');
    const countWebPushSubscriptionsStmt = db.prepare('SELECT COUNT(*) AS count FROM web_push_subscriptions');
    const listWebPushSubscriptionsStmt = db.prepare(`
        SELECT * FROM web_push_subscriptions ORDER BY created_ts ASC, endpoint_hash ASC
    `);
    const upsertWebPushSubscriptionStmt = db.prepare(`
        INSERT INTO web_push_subscriptions (
            endpoint_hash, endpoint, expiration_ts, p256dh, auth, created_ts, updated_ts,
            last_success_ts, failure_count, next_retry_ts, last_error
        ) VALUES (
            @endpoint_hash, @endpoint, @expiration_ts, @p256dh, @auth, @created_ts, @updated_ts,
            NULL, 0, NULL, NULL
        )
        ON CONFLICT(endpoint_hash) DO UPDATE SET
            endpoint = excluded.endpoint,
            expiration_ts = excluded.expiration_ts,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            updated_ts = excluded.updated_ts,
            failure_count = 0,
            next_retry_ts = NULL,
            last_error = NULL
    `);
    const deleteWebPushSubscriptionStmt = db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint_hash = ?');
    const deleteWebPushClaimsForEndpointStmt = db.prepare('DELETE FROM web_push_delivery_claims WHERE endpoint_hash = ?');
    const markWebPushSuccessStmt = db.prepare(`
        UPDATE web_push_subscriptions
        SET last_success_ts = @timestamp, updated_ts = @timestamp,
            failure_count = 0, next_retry_ts = NULL, last_error = NULL
        WHERE endpoint_hash = @endpoint_hash
    `);
    const markWebPushFailureStmt = db.prepare(`
        UPDATE web_push_subscriptions
        SET updated_ts = @timestamp,
            failure_count = MIN(failure_count + 1, 1000000),
            next_retry_ts = @next_retry_ts,
            last_error = @last_error
        WHERE endpoint_hash = @endpoint_hash
    `);
    const insertWebPushDeliveryClaimStmt = db.prepare(`
        INSERT OR IGNORE INTO web_push_delivery_claims (endpoint_hash, notification_key, created_ts)
        VALUES (@endpoint_hash, @notification_key, @created_ts)
    `);
    const deleteWebPushDeliveryClaimStmt = db.prepare(`
        DELETE FROM web_push_delivery_claims WHERE endpoint_hash = ? AND notification_key = ?
    `);
    const deleteExpiredWebPushDeliveryClaimsStmt = db.prepare(`
        DELETE FROM web_push_delivery_claims WHERE created_ts < ?
    `);
    const boundWebPushDeliveryClaimsStmt = db.prepare(`
        DELETE FROM web_push_delivery_claims WHERE rowid IN (
            SELECT rowid FROM web_push_delivery_claims
            ORDER BY created_ts DESC, endpoint_hash DESC, notification_key DESC
            LIMIT -1 OFFSET 10000
        )
    `);
    const listExpiredWebPushSubscriptionHashesStmt = db.prepare(`
        SELECT endpoint_hash FROM web_push_subscriptions
        WHERE expiration_ts IS NOT NULL AND expiration_ts <= ?
    `);
    const healthStmt = db.prepare('SELECT 1 AS ok');
    const insertPointsBatch = db.transaction(rows => {
        for (const row of rows) insertPointStmt.run(row.series, row.ts, row.data);
    });
    const insertUnifiTelemetryTransaction = db.transaction((rows, cutoff, hardCap) => {
        let inserted = 0;
        for (const row of rows) inserted += insertUnifiTelemetryStmt.run(row).changes;
        deleteOldUnifiTelemetryStmt.run(cutoff);
        const excess = countUnifiTelemetryStmt.get().count - hardCap;
        if (excess > 0) deleteOldestUnifiTelemetryStmt.run(excess);
        return inserted;
    });
    function writeThreatIpAudit(entry) {
        insertThreatIpBlockAuditStmt.run({
            block_id: entry.blockId,
            ts: entry.ts,
            ip: entry.ip,
            action: String(entry.action).slice(0, 40),
            outcome: String(entry.outcome).slice(0, 40),
            detail: entry.detail == null ? null : String(entry.detail).slice(0, 500)
        });
        deleteOldThreatIpBlockAuditStmt.run();
    }
    const requestThreatIpBlockTransaction = db.transaction(entry => {
        const existing = getThreatIpBlockByIpStmt.get(entry.ip);
        if (!existing) {
            insertThreatIpBlockStmt.run({
                id: entry.id,
                ip: entry.ip,
                created_ts: entry.createdTs,
                expires_ts: entry.expiresTs,
                updated_ts: entry.createdTs
            });
            writeThreatIpAudit({
                blockId: entry.id, ts: entry.createdTs, ip: entry.ip,
                action: 'add', outcome: 'pending', detail: `expires_ts=${entry.expiresTs}`
            });
            return { created: true, extended: false, id: entry.id };
        }
        const reactivated = existing.desired_state !== 'active';
        const extended = reactivated || entry.expiresTs > existing.expires_ts;
        if (extended) {
            reactivateThreatIpBlockStmt.run({
                id: existing.id,
                expires_ts: entry.expiresTs,
                updated_ts: entry.createdTs
            });
        }
        writeThreatIpAudit({
            blockId: existing.id, ts: entry.createdTs, ip: entry.ip,
            action: reactivated ? 'reactivate' : (extended ? 'extend' : 'duplicate'),
            outcome: extended ? 'pending' : 'unchanged',
            detail: `requested_expires_ts=${entry.expiresTs}`
        });
        return { created: false, extended, id: existing.id };
    });
    const requestThreatIpBlockRemovalTransaction = db.transaction((id, timestamp, reason) => {
        const existing = getThreatIpBlockByIdStmt.get(id);
        if (!existing) return null;
        const changed = removeThreatIpBlockStmt.run({ id, updated_ts: timestamp }).changes === 1;
        writeThreatIpAudit({
            blockId: existing.id, ts: timestamp, ip: existing.ip,
            action: reason === 'expired' ? 'expire' : 'remove',
            outcome: changed ? 'pending' : 'unchanged', detail: reason
        });
        return { changed, id: existing.id, ip: existing.ip };
    });
    const expireThreatIpBlocksTransaction = db.transaction(timestamp => {
        const expired = listExpiredThreatIpBlocksStmt.all(timestamp);
        for (const row of expired) {
            removeThreatIpBlockStmt.run({ id: row.id, updated_ts: timestamp });
            writeThreatIpAudit({
                blockId: row.id, ts: timestamp, ip: row.ip,
                action: 'expire', outcome: 'pending', detail: `expires_ts=${row.expires_ts}`
            });
        }
        return expired.length;
    });
    const markThreatIpBlocksSyncedTransaction = db.transaction(timestamp => {
        const removed = listThreatIpBlocksStmt.all().filter(row => row.desired_state === 'removed');
        markActiveThreatIpBlocksSyncedStmt.run({ updated_ts: timestamp });
        for (const row of removed) {
            writeThreatIpAudit({
                blockId: row.id, ts: timestamp, ip: row.ip,
                action: 'reconcile', outcome: 'removed', detail: null
            });
        }
        deleteRemovedThreatIpBlocksStmt.run();
        return removed.length;
    });
    const markThreatIpBlockSyncFailureTransaction = db.transaction((timestamp, error, retryAt) => {
        const rows = listThreatIpBlocksStmt.all();
        markThreatIpBlockSyncFailureStmt.run({
            updated_ts: timestamp,
            next_retry_ts: retryAt,
            last_error: String(error).slice(0, 500)
        });
        for (const row of rows) {
            writeThreatIpAudit({
                blockId: row.id, ts: timestamp, ip: row.ip,
                action: 'reconcile', outcome: 'failed', detail: String(error).slice(0, 500)
            });
        }
        return rows.length;
    });
    function mapThreatIpBlock(row) {
        return {
            id: row.id,
            ip: row.ip,
            createdTs: row.created_ts,
            createdAt: new Date(row.created_ts).toISOString(),
            expiresTs: row.expires_ts,
            expiresAt: new Date(row.expires_ts).toISOString(),
            desiredState: row.desired_state,
            syncState: row.sync_state,
            updatedAt: new Date(row.updated_ts).toISOString(),
            lastAttemptAt: row.last_attempt_ts == null ? null : new Date(row.last_attempt_ts).toISOString(),
            attemptCount: row.attempt_count,
            nextRetryTs: row.next_retry_ts,
            nextRetryAt: row.next_retry_ts == null ? null : new Date(row.next_retry_ts).toISOString(),
            lastError: row.last_error
        };
    }
    function boundedPolicyJson(value, field, maxBytes = 16384) {
        let serialized;
        try { serialized = JSON.stringify(value); }
        catch { throw new TypeError(`${field} must be JSON serializable`); }
        if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
            throw new TypeError(`${field} exceeds its storage boundary`);
        }
        return serialized;
    }
    function parsePolicyJson(value, field) {
        try { return JSON.parse(value); }
        catch { throw new TypeError(`stored ${field} is invalid JSON`); }
    }
    function writeAdguardServicePolicyAudit(entry) {
        insertAdguardServicePolicyAuditStmt.run({
            policy_id: entry.policyId,
            ts: entry.ts,
            device_id: entry.deviceId,
            action: String(entry.action).slice(0, 40),
            outcome: String(entry.outcome).slice(0, 40),
            detail: entry.detail == null ? null : String(entry.detail).slice(0, 500)
        });
        deleteOldAdguardServicePolicyAuditStmt.run();
    }
    const upsertAdguardServicePolicyTransaction = db.transaction(entry => {
        const categoriesJson = boundedPolicyJson(entry.categories, 'categories', 2048);
        const allowWindowsJson = boundedPolicyJson(entry.allowWindows, 'allowWindows', 4096);
        const existing = getAdguardServicePolicyByDeviceStmt.get(entry.deviceId);
        if (!existing) {
            insertAdguardServicePolicyStmt.run({
                id: entry.id,
                device_id: entry.deviceId,
                categories_json: categoriesJson,
                time_zone: entry.timeZone,
                allow_windows_json: allowWindowsJson,
                created_ts: entry.timestamp,
                updated_ts: entry.timestamp
            });
            writeAdguardServicePolicyAudit({
                policyId: entry.id, ts: entry.timestamp, deviceId: entry.deviceId,
                action: 'create', outcome: 'pending', detail: `categories=${entry.categories.join(',')}`
            });
            return { id: entry.id, created: true, changed: true };
        }
        const changed = existing.desired_state !== 'active'
            || existing.categories_json !== categoriesJson
            || existing.time_zone !== entry.timeZone
            || existing.allow_windows_json !== allowWindowsJson;
        if (changed) {
            updateAdguardServicePolicyStmt.run({
                id: existing.id,
                categories_json: categoriesJson,
                time_zone: entry.timeZone,
                allow_windows_json: allowWindowsJson,
                updated_ts: entry.timestamp
            });
        }
        writeAdguardServicePolicyAudit({
            policyId: existing.id, ts: entry.timestamp, deviceId: existing.device_id,
            action: changed ? 'update' : 'duplicate', outcome: changed ? 'pending' : 'unchanged',
            detail: `categories=${entry.categories.join(',')}`
        });
        return { id: existing.id, created: false, changed };
    });
    const removeAdguardServicePolicyTransaction = db.transaction((id, timestamp) => {
        const existing = getAdguardServicePolicyByIdStmt.get(id);
        if (!existing) return null;
        const changed = removeAdguardServicePolicyStmt.run({ id, updated_ts: timestamp }).changes === 1;
        writeAdguardServicePolicyAudit({
            policyId: id, ts: timestamp, deviceId: existing.device_id,
            action: 'remove', outcome: changed ? 'pending' : 'unchanged', detail: null
        });
        return { id, deviceId: existing.device_id, changed };
    });
    const setAdguardServicePolicyBaselineTransaction = db.transaction((id, baseline, timestamp) => {
        const existing = getAdguardServicePolicyByIdStmt.get(id);
        if (!existing) return false;
        const serialized = boundedPolicyJson(baseline, 'baseline', 16384);
        const changed = setAdguardServicePolicyBaselineStmt.run({
            id, baseline_json: serialized, updated_ts: timestamp
        }).changes === 1;
        if (changed) writeAdguardServicePolicyAudit({
            policyId: id, ts: timestamp, deviceId: existing.device_id,
            action: 'baseline', outcome: 'stored', detail: null
        });
        return changed;
    });
    const markAdguardServicePolicySyncedTransaction = db.transaction((id, timestamp, changed) => {
        const existing = getAdguardServicePolicyByIdStmt.get(id);
        if (!existing) return null;
        if (existing.desired_state === 'removed') {
            writeAdguardServicePolicyAudit({
                policyId: id, ts: timestamp, deviceId: existing.device_id,
                action: 'reconcile', outcome: 'restored', detail: changed ? 'upstream_changed' : 'upstream_unchanged'
            });
            deleteAdguardServicePolicyStmt.run(id);
            return { removed: true };
        }
        markAdguardServicePolicyAppliedStmt.run({ id, updated_ts: timestamp });
        writeAdguardServicePolicyAudit({
            policyId: id, ts: timestamp, deviceId: existing.device_id,
            action: 'reconcile', outcome: 'applied', detail: changed ? 'upstream_changed' : 'upstream_unchanged'
        });
        return { removed: false };
    });
    const markAdguardServicePolicyFailureTransaction = db.transaction((id, timestamp, error, retryAt) => {
        const existing = getAdguardServicePolicyByIdStmt.get(id);
        if (!existing) return false;
        markAdguardServicePolicyFailureStmt.run({
            id,
            updated_ts: timestamp,
            next_retry_ts: retryAt,
            last_error: String(error).slice(0, 500)
        });
        writeAdguardServicePolicyAudit({
            policyId: id, ts: timestamp, deviceId: existing.device_id,
            action: 'reconcile', outcome: 'failed', detail: String(error).slice(0, 500)
        });
        return true;
    });
    function mapAdguardServicePolicy(row) {
        return {
            id: row.id,
            deviceId: row.device_id,
            categories: parsePolicyJson(row.categories_json, 'categories'),
            timeZone: row.time_zone,
            allowWindows: parsePolicyJson(row.allow_windows_json, 'allowWindows'),
            baseline: row.baseline_json == null ? null : parsePolicyJson(row.baseline_json, 'baseline'),
            desiredState: row.desired_state,
            syncState: row.sync_state,
            createdTs: row.created_ts,
            createdAt: new Date(row.created_ts).toISOString(),
            updatedTs: row.updated_ts,
            updatedAt: new Date(row.updated_ts).toISOString(),
            lastAttemptAt: row.last_attempt_ts == null ? null : new Date(row.last_attempt_ts).toISOString(),
            attemptCount: row.attempt_count,
            nextRetryTs: row.next_retry_ts,
            nextRetryAt: row.next_retry_ts == null ? null : new Date(row.next_retry_ts).toISOString(),
            lastError: row.last_error
        };
    }
    function mapWebPushSubscription(row) {
        return {
            endpointHash: row.endpoint_hash,
            endpoint: row.endpoint,
            expirationTime: row.expiration_ts,
            keys: { p256dh: row.p256dh, auth: row.auth },
            createdTs: row.created_ts,
            updatedTs: row.updated_ts,
            lastSuccessTs: row.last_success_ts,
            failureCount: row.failure_count,
            nextRetryTs: row.next_retry_ts,
            lastError: row.last_error
        };
    }
    const upsertWebPushSubscriptionTransaction = db.transaction(entry => {
        const existing = getWebPushSubscriptionStmt.get(entry.endpointHash);
        if (!existing && countWebPushSubscriptionsStmt.get().count >= 20) {
            throw new RangeError('web push subscription capacity reached');
        }
        upsertWebPushSubscriptionStmt.run({
            endpoint_hash: entry.endpointHash,
            endpoint: entry.endpoint,
            expiration_ts: entry.expirationTime,
            p256dh: entry.keys.p256dh,
            auth: entry.keys.auth,
            created_ts: entry.timestamp,
            updated_ts: entry.timestamp
        });
        return {
            created: !existing,
            subscription: mapWebPushSubscription(getWebPushSubscriptionStmt.get(entry.endpointHash))
        };
    });
    const deleteWebPushSubscriptionTransaction = db.transaction(endpointHash => {
        deleteWebPushClaimsForEndpointStmt.run(endpointHash);
        return deleteWebPushSubscriptionStmt.run(endpointHash).changes === 1;
    });
    const claimWebPushDeliveryTransaction = db.transaction(entry => {
        deleteExpiredWebPushDeliveryClaimsStmt.run(entry.timestamp - 24 * 60 * 60 * 1000);
        const claimed = insertWebPushDeliveryClaimStmt.run({
            endpoint_hash: entry.endpointHash,
            notification_key: entry.notificationKey,
            created_ts: entry.timestamp
        }).changes === 1;
        boundWebPushDeliveryClaimsStmt.run();
        return claimed;
    });
    const pruneExpiredWebPushSubscriptionsTransaction = db.transaction(timestamp => {
        const hashes = listExpiredWebPushSubscriptionHashesStmt.all(timestamp).map(row => row.endpoint_hash);
        for (const endpointHash of hashes) {
            deleteWebPushClaimsForEndpointStmt.run(endpointHash);
            deleteWebPushSubscriptionStmt.run(endpointHash);
        }
        return hashes.length;
    });
    function claimExistingOrInsert(row, { allowInsert = true } = {}) {
        const result = allowInsert ? claimScheduledReportStmt.run(row) : { changes: 0 };
        if (result.changes === 1) {
            deleteOldReportRunsStmt.run();
            return {
                claimed: true,
                id: Number(result.lastInsertRowid),
                scheduleKey: row.schedule_key,
                title: row.title,
                status: 'claimed',
                attemptCount: 1,
                claimToken: row.claim_token,
                recovered: false
            };
        }
        const reclaimed = reclaimScheduledReportStmt.run({
            ...row,
            max_attempts: REPORT_MAX_ATTEMPTS,
            retry_before: row.ts - REPORT_CLAIM_RETRY_AFTER_MS,
            stale_before: row.ts - REPORT_CLAIM_STALE_MS
        });
        if (reclaimed.changes === 1) deleteOldReportRunsStmt.run();
        const existing = getScheduledReportClaimStmt.get(row.schedule_key);
        return {
            claimed: reclaimed.changes === 1,
            id: existing ? existing.id : null,
            scheduleKey: row.schedule_key,
            title: existing ? existing.title : row.title,
            status: existing ? existing.run_status : null,
            attemptCount: existing ? existing.attempt_count : null,
            claimToken: reclaimed.changes === 1 ? row.claim_token : null,
            recovered: reclaimed.changes === 1
        };
    }
    function exhaustFinishedClaims(now) {
        const result = exhaustScheduledReportClaimsStmt.run({
            now,
            max_attempts: REPORT_MAX_ATTEMPTS,
            stale_before: now - REPORT_CLAIM_STALE_MS
        });
        if (result.changes > 0) deleteOldReportRunsStmt.run();
        return result.changes;
    }
    const claimScheduledReportTransaction = db.transaction(row => {
        exhaustFinishedClaims(row.ts);
        return claimExistingOrInsert(row);
    });
    const claimNextScheduledReportTransaction = db.transaction(row => {
        exhaustFinishedClaims(row.ts);
        let candidate;
        for (;;) {
            candidate = selectRetryableScheduledReportStmt.get({
                max_attempts: REPORT_MAX_ATTEMPTS,
                retry_before: row.ts - REPORT_CLAIM_RETRY_AFTER_MS,
                stale_before: row.ts - REPORT_CLAIM_STALE_MS
            });
            if (!candidate) return null;
            if (normalizeScheduleKey(candidate.schedule_key)) break;
            detachInvalidReportScheduleIdentityStmt.run(candidate);
            deleteOldReportRunsStmt.run();
        }
        return claimExistingOrInsert({
            ...row,
            schedule_key: candidate.schedule_key,
            title: candidate.title
        }, { allowInsert: false });
    });
    const completeScheduledReportTransaction = db.transaction(row => {
        const result = completeScheduledReportStmt.run(row);
        if (result.changes !== 1) return false;
        deleteOldReportRunsStmt.run();
        return true;
    });

    // Ordinary telemetry is intentionally buffered in memory and committed in one
    // transaction. Critical events (UPS outages, block actions, reports) use their
    // own tables below and remain immediately durable.
    let pendingPoints = [];
    let pendingBytes = 0;
    let totalBufferedPoints = 0;
    let totalFlushedPoints = 0;
    let flushCount = 0;
    let lastFlushAt = null;

    function recalculatePendingBytes() {
        pendingBytes = pendingPoints.reduce((sum, row) => sum + Buffer.byteLength(row.data) + 32, 0);
    }

    function decodePoint(row, series) {
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        if (series === 'wiim') data.ts = Math.floor(row.ts / 1000);
        else data.t = new Date(row.ts).toISOString();
        return data;
    }

    function getSince(series, cutoffMs = 0) {
        return measure('getSince', 'history', () => {
            const cutoff = Math.max(0, Number(cutoffMs) || 0);
            const rows = getSinceStmt.all(series, cutoff)
                .concat(pendingPoints.filter(row => row.series === series && row.ts >= cutoff))
                .sort((a, b) => a.ts - b.ts);
            return rows.map(row => decodePoint(row, series));
        });
    }

    function getLatest(series) {
        return measure('getLatest', 'history', () => {
            let row = getLatestStmt.get(series);
            for (const pending of pendingPoints) {
                if (pending.series === series && (!row || pending.ts >= row.ts)) row = pending;
            }
            return row ? decodePoint(row, series) : null;
        });
    }

    function flush() {
        if (!pendingPoints.length) return { flushed: 0, pending: 0, pending_bytes: 0 };
        const batch = pendingPoints;
        return measure('flushPoints', 'history', () => {
            insertPointsBatch(batch);
            pendingPoints = [];
            pendingBytes = 0;
            totalFlushedPoints += batch.length;
            flushCount += 1;
            lastFlushAt = new Date().toISOString();
            return { flushed: batch.length, pending: 0, pending_bytes: 0 };
        }, { transaction: true });
    }

    function insertPoint(series, point) {
        const ts = pointTimestamp(point, series);
        if (!Number.isFinite(ts)) return false;
        const payload = { ...point };
        delete payload.t;
        delete payload.ts;
        const data = JSON.stringify(payload);
        pendingPoints.push({ series, ts, data });
        pendingBytes += Buffer.byteLength(data) + 32;
        totalBufferedPoints += 1;
        if (pendingPoints.length >= maxPendingPoints || pendingBytes >= maxPendingBytes) flush();
        return true;
    }

    function insertUnifiTelemetryBatch(snapshot, { keepDays = 30, hardCap = 100000 } = {}) {
        if (!snapshot || snapshot.stale || !Array.isArray(snapshot.rows)) {
            return { inserted: 0, rejected: Array.isArray(snapshot?.rows) ? snapshot.rows.length : 0 };
        }
        const sampledTs = Date.parse(snapshot.collectedAt || '');
        if (!Number.isFinite(sampledTs)) return { inserted: 0, rejected: snapshot.rows.length };
        const rows = [];
        let rejected = Math.max(0, snapshot.rows.length - 1000);
        for (const value of snapshot.rows.slice(0, 1000)) {
            const deviceId = typeof value?.deviceId === 'string' ? value.deviceId.trim().toLowerCase() : '';
            if (!deviceId || deviceId.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(deviceId)) {
                rejected += 1;
                continue;
            }
            const boundedNumber = (number, min, max, { integer = false } = {}) => {
                if (number === null || number === undefined) return null;
                if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) return undefined;
                if (integer && !Number.isSafeInteger(number)) return undefined;
                return number;
            };
            const online = value.online === true;
            const temperatureStatus = typeof value.temperatureStatus === 'string'
                ? value.temperatureStatus.slice(0, 32)
                : 'unavailable';
            if (!['supported', 'unsupported', 'not_configured', 'offline', 'stale', 'authentication_failed', 'host_key_mismatch', 'timeout', 'unavailable'].includes(temperatureStatus)) {
                rejected += 1;
                continue;
            }
            const cpu = boundedNumber(value.cpu, 0, 100);
            const temperature = boundedNumber(value.temperature, -60, 150);
            const clientCount = boundedNumber(value.clientCount, 0, 100000, { integer: true });
            const linkSpeedMbps = boundedNumber(value.linkSpeedMbps, 0, 1000000);
            const counters = ['rxBytes', 'txBytes', 'rxErrors', 'txErrors', 'rxDropped', 'txDropped']
                .map(key => boundedNumber(value[key], 0, Number.MAX_SAFE_INTEGER, { integer: true }));
            if ([cpu, temperature, clientCount, linkSpeedMbps, ...counters].includes(undefined)) {
                rejected += 1;
                continue;
            }
            const payload = {
                name: String(value.name || '').slice(0, 128),
                model: value.model == null ? null : String(value.model).slice(0, 64),
                type: value.type == null ? null : String(value.type).slice(0, 32),
                online,
                cpu,
                temperature: online && temperatureStatus === 'supported' ? temperature : null,
                temperatureStatus,
                temperatureSource: value.temperatureSource == null ? null : String(value.temperatureSource).slice(0, 32),
                clientCount,
                linkSpeedMbps,
                rxBytes: counters[0],
                txBytes: counters[1],
                rxErrors: counters[2],
                txErrors: counters[3],
                rxDropped: counters[4],
                txDropped: counters[5]
            };
            const data = JSON.stringify(payload);
            if (Buffer.byteLength(data) > 64 * 1024) {
                rejected += 1;
                continue;
            }
            rows.push({ sampled_ts: sampledTs, device_id: deviceId, data });
        }
        const days = Math.min(Math.max(Number(keepDays) || 1, 1), 365);
        const cap = Math.min(Math.max(Number(hardCap) || 1, 1), 1000000);
        const inserted = measure('insertUnifiTelemetryBatch', 'unifi_device_telemetry', () => (
            insertUnifiTelemetryTransaction(rows, Date.now() - days * 86400000, cap)
        ), { transaction: true });
        return { inserted, rejected };
    }

    function listUnifiTelemetrySince(cutoffMs = 0) {
        const cutoff = Math.max(0, Number(cutoffMs) || 0);
        return measure('listUnifiTelemetrySince', 'unifi_device_telemetry', () => (
            listUnifiTelemetryStmt.all(cutoff).map(row => {
                let data;
                try { data = JSON.parse(row.data); } catch { data = {}; }
                return { collectedAt: new Date(row.sampled_ts).toISOString(), deviceId: row.device_id, ...data };
            })
        ));
    }

    function pruneRaw(series, keepDays = 30, hardCap = 100000) {
        const days = Math.max(Number(keepDays) || 1, 1);
        deleteBeforeStmt.run(series, Date.now() - days * 86400000);
        const count = countPointsStmt.get(series).count;
        const excess = count - Math.max(Number(hardCap) || 1, 1);
        if (excess > 0) deleteOldestStmt.run(series, excess);
    }

    function prune(series, keepDays = 30, hardCap = 100000) {
        flush();
        return measure('prune', 'history', db.transaction(() => pruneRaw(series, keepDays, hardCap)), { transaction: true });
    }

    function migrateFromJson() {
        emit('info', {
            module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_START,
            message: 'Legacy JSON migration check started'
        });
        const filesToRename = [];
        const migrate = db.transaction(() => {
            for (const series of HISTORY_SERIES) {
                const source = path.join(dataDir, JSON_HISTORY_FILES[series]);
                if (!fs.existsSync(source) || countSeriesStmt.get(series).count > 0) continue;
                let points;
                try { points = JSON.parse(fs.readFileSync(source, 'utf8')); } catch (error) {
                    emit('error', {
                        module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_FAILED,
                        message: 'Legacy history JSON parse failed', error, fields: { file: JSON_HISTORY_FILES[series], series }
                    });
                    continue;
                }
                if (!Array.isArray(points)) {
                    emit('warning', {
                        module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_FAILED,
                        message: 'Legacy history file is not an array; migration skipped', fields: { file: JSON_HISTORY_FILES[series], series }
                    });
                    continue;
                }
                let imported = 0;
                for (const point of points) {
                    const ts = pointTimestamp(point, series);
                    if (!Number.isFinite(ts)) continue;
                    const payload = { ...point };
                    delete payload.t;
                    delete payload.ts;
                    insertPointStmt.run(series, ts, JSON.stringify(payload));
                    imported++;
                }
                filesToRename.push({ source, imported });
                emit('info', {
                    module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_SUCCESS,
                    message: 'Legacy history imported', fields: { file: JSON_HISTORY_FILES[series], series, imported, total: points.length }
                });
            }

            const eventSource = path.join(dataDir, 'ups-events.json');
            if (fs.existsSync(eventSource) && db.prepare('SELECT COUNT(*) AS count FROM ups_events').get().count === 0) {
                let events;
                try { events = JSON.parse(fs.readFileSync(eventSource, 'utf8')); } catch (error) {
                    emit('error', {
                        module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_FAILED,
                        message: 'Legacy UPS events JSON parse failed', error, fields: { file: 'ups-events.json' }
                    });
                    events = null;
                }
                if (Array.isArray(events)) {
                    for (const event of events) {
                        const startTs = eventTimestamp(event.start);
                        if (!Number.isFinite(startTs)) continue;
                        insertUpsEventStmt.run({
                            start_ts: startTs,
                            end_ts: event.end ? eventTimestamp(event.end) : null,
                            duration_sec: event.durationSec ?? null,
                            min_battery: event.minBattery ?? null,
                            start_voltage: event.startVoltage ?? null
                        });
                    }
                    filesToRename.push({ source: eventSource, imported: events.length });
                    emit('info', {
                        module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_SUCCESS,
                        message: 'Legacy UPS events imported', fields: { file: 'ups-events.json', imported: events.length }
                    });
                }
            }

            const blockSource = path.join(dataDir, 'block-history.json');
            if (fs.existsSync(blockSource) && db.prepare('SELECT COUNT(*) AS count FROM block_history').get().count === 0) {
                let entries;
                try { entries = JSON.parse(fs.readFileSync(blockSource, 'utf8')); } catch (error) {
                    emit('error', {
                        module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_FAILED,
                        message: 'Legacy block history JSON parse failed', error, fields: { file: 'block-history.json' }
                    });
                    entries = null;
                }
                if (Array.isArray(entries)) {
                    for (const entry of entries) {
                        const ts = eventTimestamp(entry.datetime);
                        if (!Number.isFinite(ts)) continue;
                        insertBlockStmt.run({
                            ts,
                            mac: entry.mac ?? null,
                            name: entry.name ?? null,
                            action: entry.action ?? null,
                            source: entry.source ?? null,
                            reason: entry.reason ?? null
                        });
                    }
                    filesToRename.push({ source: blockSource, imported: entries.length });
                    emit('info', {
                        module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_SUCCESS,
                        message: 'Legacy block history imported', fields: { file: 'block-history.json', imported: entries.length }
                    });
                }
            }
        });

        measure('migrateFromJson', 'all', migrate, { transaction: true });
        for (const { source } of filesToRename) {
            const backup = `${source}.migrated.bak`;
            try {
                if (fs.existsSync(backup)) {
                    // Never delete a user's original backup; retain another copy if needed.
                    fs.renameSync(source, `${source}.migrated.${Date.now()}.bak`);
                } else {
                    fs.renameSync(source, backup);
                }
            } catch (error) {
                emit('error', {
                    module: 'database.migration', function: 'backupLegacyJson', code: ERROR_CODES.DB_MIGRATION_FAILED,
                    message: 'Legacy JSON backup rename failed', error, fields: { file: path.basename(source) }
                });
            }
        }
        emit('info', {
            module: 'database.migration', function: 'migrateFromJson', code: ERROR_CODES.DB_MIGRATION_SUCCESS,
            message: 'Legacy JSON migration check completed', fields: { migrated_files: filesToRename.length }
        });
    }

    migrateFromJson();

    return {
        file,
        insertPoint,
        insertUnifiTelemetryBatch,
        listUnifiTelemetrySince,
        flush,
        getSince,
        getLatest,
        deleteSeries(series) {
            pendingPoints = pendingPoints.filter(row => row.series !== series);
            recalculatePendingBytes();
            return measure('deleteSeries', 'history', () => deleteSeriesStmt.run(series));
        },
        prune,
        insertUpsEvent(event) {
            const startTs = eventTimestamp(event.start);
            if (!Number.isFinite(startTs)) return null;
            return measure('insertUpsEvent', 'ups_events', () => {
                const result = insertUpsEventStmt.run({
                    start_ts: startTs,
                    end_ts: event.end ? eventTimestamp(event.end) : null,
                    duration_sec: event.durationSec ?? null,
                    min_battery: event.minBattery ?? null,
                    start_voltage: event.startVoltage ?? null
                });
                deleteOldUpsEventsStmt.run();
                return result.lastInsertRowid;
            });
        },
        listUpsEvents() {
            return measure('listUpsEvents', 'ups_events', () => listUpsEventsStmt.all().map(row => ({
                    id: row.id,
                    start: new Date(row.start_ts).toISOString(),
                    end: row.end_ts == null ? null : new Date(row.end_ts).toISOString(),
                    durationSec: row.duration_sec,
                    minBattery: row.min_battery,
                    startVoltage: row.start_voltage
                })));
        },
        getOpenUpsEvent() {
            return measure('getOpenUpsEvent', 'ups_events', () => {
                const row = openUpsEventStmt.get();
                return row ? {
                    id: row.id,
                    start: new Date(row.start_ts).toISOString(),
                    end: null,
                    durationSec: row.duration_sec,
                    minBattery: row.min_battery,
                    startVoltage: row.start_voltage
                } : null;
            });
        },
        closeOpenUpsEvent(end, durationSec) {
            return measure('closeOpenUpsEvent', 'ups_events', () => {
                const open = openUpsEventStmt.get();
                if (!open) return null;
                const endTs = eventTimestamp(end);
                if (!Number.isFinite(endTs)) return null;
                closeUpsEventStmt.run({ id: open.id, end_ts: endTs, duration_sec: durationSec });
                return { ...open, end_ts: endTs, duration_sec: durationSec };
            });
        },
        updateOpenUpsMinBattery(minBattery) {
            return measure('updateOpenUpsMinBattery', 'ups_events', () => {
                const open = openUpsEventStmt.get();
                if (!open || minBattery == null) return;
                updateUpsMinBatteryStmt.run({ id: open.id, min_battery: minBattery });
            });
        },
        recordUpsPowerEvent(entry) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('UPS power event must be an object');
            }
            const source = boundedRequiredString(entry.source, 32, 'UPS power event source');
            const externalId = boundedRequiredString(entry.externalId, 200, 'UPS power event externalId');
            const eventType = boundedRequiredString(entry.type, 64, 'UPS power event type');
            const severity = boundedRequiredString(entry.severity || 'info', 16, 'UPS power event severity');
            const description = boundedRequiredString(entry.description, 500, 'UPS power event description');
            const eventTs = entry.eventTs == null ? null : Number(entry.eventTs);
            const observedTs = Number(entry.observedTs);
            const inputV = entry.inputV == null ? null : Number(entry.inputV);
            if ((eventTs !== null && !Number.isInteger(eventTs)) || !Number.isInteger(observedTs)
                || (inputV !== null && !Number.isFinite(inputV))) {
                throw new TypeError('UPS power event timestamps or voltage are invalid');
            }
            return measure('recordUpsPowerEvent', 'ups_power_events', db.transaction(() => {
                const result = insertUpsPowerEventStmt.run({
                    source, external_id: externalId, event_type: eventType,
                    event_ts: eventTs, observed_ts: observedTs, input_v: inputV,
                    severity, description
                });
                deleteOldUpsPowerEventsStmt.run();
                const row = getUpsPowerEventStmt.get(source, externalId);
                return { created: result.changes === 1, event: row ? {
                    id: row.id, source: row.source, externalId: row.external_id,
                    type: row.event_type, eventTs: row.event_ts, observedTs: row.observed_ts,
                    inputV: row.input_v, severity: row.severity, description: row.description
                } : null };
            }), { transaction: true });
        },
        listUpsPowerEvents(limit = 200) {
            const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 200);
            return measure('listUpsPowerEvents', 'ups_power_events', () => (
                listUpsPowerEventsStmt.all(safeLimit).map(row => ({
                    id: row.id, source: row.source, externalId: row.external_id,
                    type: row.event_type, eventTs: row.event_ts, observedTs: row.observed_ts,
                    inputV: row.input_v, severity: row.severity, description: row.description
                }))
            ));
        },
        getIntegrationSyncState(source) {
            const safeSource = boundedRequiredString(source, 32, 'integration sync source');
            return measure('getIntegrationSyncState', 'integration_sync_state', () => {
                const row = getIntegrationSyncStateStmt.get(safeSource);
                return row ? {
                    source: row.source,
                    initializedAt: row.initialized_at,
                    lastSuccessAt: row.last_success_at,
                    lastExternalId: row.last_external_id,
                    lastEventTs: row.last_event_ts,
                    updatedAt: row.updated_at
                } : null;
            });
        },
        upsertIntegrationSyncState(state) {
            if (!state || typeof state !== 'object' || Array.isArray(state)) {
                throw new TypeError('integration sync state must be an object');
            }
            const source = boundedRequiredString(state.source, 32, 'integration sync source');
            const initializedAt = state.initializedAt == null ? null : Number(state.initializedAt);
            const lastSuccessAt = state.lastSuccessAt == null ? null : Number(state.lastSuccessAt);
            const lastEventTs = state.lastEventTs == null ? null : Number(state.lastEventTs);
            const updatedAt = Number(state.updatedAt);
            const lastExternalId = state.lastExternalId == null
                ? null
                : boundedRequiredString(state.lastExternalId, 200, 'integration sync lastExternalId');
            if ((initializedAt !== null && !Number.isInteger(initializedAt))
                || (lastSuccessAt !== null && !Number.isInteger(lastSuccessAt))
                || (lastEventTs !== null && !Number.isInteger(lastEventTs))
                || !Number.isInteger(updatedAt)) {
                throw new TypeError('integration sync timestamps must be integers or null');
            }
            return measure('upsertIntegrationSyncState', 'integration_sync_state', () => {
                upsertIntegrationSyncStateStmt.run({
                    source,
                    initialized_at: initializedAt,
                    last_success_at: lastSuccessAt,
                    last_external_id: lastExternalId,
                    last_event_ts: lastEventTs,
                    updated_at: updatedAt
                });
                const row = getIntegrationSyncStateStmt.get(source);
                return {
                    source: row.source,
                    initializedAt: row.initialized_at,
                    lastSuccessAt: row.last_success_at,
                    lastExternalId: row.last_external_id,
                    lastEventTs: row.last_event_ts,
                    updatedAt: row.updated_at
                };
            });
        },
        insertBlock(entry) {
            return measure('insertBlock', 'block_history', db.transaction(() => {
                const ts = eventTimestamp(entry.datetime) || Date.now();
                insertBlockStmt.run({
                    ts,
                    mac: entry.mac ?? null,
                    name: entry.name ?? null,
                    action: entry.action ?? null,
                    source: entry.source ?? null,
                    reason: entry.reason ?? null
                });
                db.prepare(`DELETE FROM block_history WHERE id IN (
                    SELECT id FROM block_history ORDER BY ts DESC, id DESC LIMIT -1 OFFSET 200
                )`).run();
            }), { transaction: true });
        },
        listBlockHistory() {
            return measure('listBlockHistory', 'block_history', () => listBlockStmt.all().map(row => ({
                datetime: new Date(row.ts).toISOString(),
                    mac: row.mac,
                    name: row.name,
                    action: row.action,
                    source: row.source,
                ...(row.reason ? { reason: row.reason } : {})
            })));
        },
        requestThreatIpBlock(entry) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('threat IP block request must be an object');
            }
            if (typeof entry.id !== 'string' || typeof entry.ip !== 'string'
                || !Number.isInteger(entry.createdTs) || !Number.isInteger(entry.expiresTs)
                || entry.expiresTs <= entry.createdTs) {
                throw new TypeError('threat IP block request is invalid');
            }
            return measure('requestThreatIpBlock', 'threat_ip_blocks', () => {
                const result = requestThreatIpBlockTransaction.immediate(entry);
                return { ...result, block: mapThreatIpBlock(getThreatIpBlockByIdStmt.get(result.id)) };
            }, { transaction: true });
        },
        requestThreatIpBlockRemoval(id, timestamp, reason = 'manual') {
            if (typeof id !== 'string' || !Number.isInteger(timestamp)) {
                throw new TypeError('threat IP block removal request is invalid');
            }
            return measure('requestThreatIpBlockRemoval', 'threat_ip_blocks', () => (
                requestThreatIpBlockRemovalTransaction.immediate(id, timestamp, reason)
            ), { transaction: true });
        },
        expireThreatIpBlocks(timestamp = Date.now()) {
            if (!Number.isInteger(timestamp)) throw new TypeError('threat IP expiry timestamp must be an integer');
            return measure('expireThreatIpBlocks', 'threat_ip_blocks', () => (
                expireThreatIpBlocksTransaction.immediate(timestamp)
            ), { transaction: true });
        },
        listThreatIpBlocks() {
            return measure('listThreatIpBlocks', 'threat_ip_blocks', () => (
                listThreatIpBlocksStmt.all().map(mapThreatIpBlock)
            ));
        },
        listThreatIpBlockAudit(limit = 100) {
            const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
            return measure('listThreatIpBlockAudit', 'threat_ip_block_audit', () => (
                listThreatIpBlockAuditStmt.all(safeLimit).map(row => ({
                    id: row.id,
                    blockId: row.block_id,
                    timestamp: new Date(row.ts).toISOString(),
                    ip: row.ip,
                    action: row.action,
                    outcome: row.outcome,
                    detail: row.detail
                }))
            ));
        },
        markThreatIpBlocksSynced(timestamp = Date.now()) {
            if (!Number.isInteger(timestamp)) throw new TypeError('threat IP sync timestamp must be an integer');
            return measure('markThreatIpBlocksSynced', 'threat_ip_blocks', () => (
                markThreatIpBlocksSyncedTransaction.immediate(timestamp)
            ), { transaction: true });
        },
        markThreatIpBlockSyncFailure(timestamp, error, retryAt) {
            if (!Number.isInteger(timestamp) || !Number.isInteger(retryAt) || retryAt <= timestamp) {
                throw new TypeError('threat IP retry timestamps are invalid');
            }
            return measure('markThreatIpBlockSyncFailure', 'threat_ip_blocks', () => (
                markThreatIpBlockSyncFailureTransaction.immediate(timestamp, error, retryAt)
            ), { transaction: true });
        },
        upsertAdguardServicePolicy(entry) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                || typeof entry.id !== 'string' || typeof entry.deviceId !== 'string'
                || !Array.isArray(entry.categories) || typeof entry.timeZone !== 'string'
                || !entry.allowWindows || typeof entry.allowWindows !== 'object'
                || !Number.isInteger(entry.timestamp)) {
                throw new TypeError('AdGuard service policy request is invalid');
            }
            return measure('upsertAdguardServicePolicy', 'adguard_service_policies', () => {
                const result = upsertAdguardServicePolicyTransaction.immediate(entry);
                return { ...result, policy: mapAdguardServicePolicy(getAdguardServicePolicyByIdStmt.get(result.id)) };
            }, { transaction: true });
        },
        requestAdguardServicePolicyRemoval(id, timestamp) {
            if (typeof id !== 'string' || !Number.isInteger(timestamp)) {
                throw new TypeError('AdGuard service policy removal request is invalid');
            }
            return measure('requestAdguardServicePolicyRemoval', 'adguard_service_policies', () => (
                removeAdguardServicePolicyTransaction.immediate(id, timestamp)
            ), { transaction: true });
        },
        listAdguardServicePolicies() {
            return measure('listAdguardServicePolicies', 'adguard_service_policies', () => (
                listAdguardServicePoliciesStmt.all().map(mapAdguardServicePolicy)
            ));
        },
        listAdguardServicePolicyAudit(limit = 100) {
            const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
            return measure('listAdguardServicePolicyAudit', 'adguard_service_policy_audit', () => (
                listAdguardServicePolicyAuditStmt.all(safeLimit).map(row => ({
                    id: row.id,
                    policyId: row.policy_id,
                    timestamp: new Date(row.ts).toISOString(),
                    deviceId: row.device_id,
                    action: row.action,
                    outcome: row.outcome,
                    detail: row.detail
                }))
            ));
        },
        setAdguardServicePolicyBaseline(id, baseline, timestamp) {
            if (typeof id !== 'string' || !baseline || typeof baseline !== 'object'
                || Array.isArray(baseline) || !Number.isInteger(timestamp)) {
                throw new TypeError('AdGuard service policy baseline is invalid');
            }
            return measure('setAdguardServicePolicyBaseline', 'adguard_service_policies', () => (
                setAdguardServicePolicyBaselineTransaction.immediate(id, baseline, timestamp)
            ), { transaction: true });
        },
        markAdguardServicePolicySynced(id, timestamp, changed = false) {
            if (typeof id !== 'string' || !Number.isInteger(timestamp) || typeof changed !== 'boolean') {
                throw new TypeError('AdGuard service policy sync result is invalid');
            }
            return measure('markAdguardServicePolicySynced', 'adguard_service_policies', () => (
                markAdguardServicePolicySyncedTransaction.immediate(id, timestamp, changed)
            ), { transaction: true });
        },
        markAdguardServicePolicyFailure(id, timestamp, error, retryAt) {
            if (typeof id !== 'string' || !Number.isInteger(timestamp)
                || !Number.isInteger(retryAt) || retryAt <= timestamp) {
                throw new TypeError('AdGuard service policy retry result is invalid');
            }
            return measure('markAdguardServicePolicyFailure', 'adguard_service_policies', () => (
                markAdguardServicePolicyFailureTransaction.immediate(id, timestamp, error, retryAt)
            ), { transaction: true });
        },
        upsertWebPushSubscription(entry) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                || typeof entry.endpointHash !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.endpointHash)
                || typeof entry.endpoint !== 'string' || entry.endpoint.length > 2048
                || !entry.keys || typeof entry.keys.p256dh !== 'string' || typeof entry.keys.auth !== 'string'
                || !(entry.expirationTime == null || Number.isSafeInteger(entry.expirationTime))
                || !Number.isSafeInteger(entry.timestamp)) {
                throw new TypeError('web push subscription is invalid');
            }
            return measure('upsertWebPushSubscription', 'web_push_subscriptions', () => (
                upsertWebPushSubscriptionTransaction.immediate(entry)
            ), { transaction: true });
        },
        deleteWebPushSubscription(endpointHash) {
            if (typeof endpointHash !== 'string' || !/^[0-9a-f]{64}$/u.test(endpointHash)) {
                throw new TypeError('web push endpoint hash is invalid');
            }
            return measure('deleteWebPushSubscription', 'web_push_subscriptions', () => (
                deleteWebPushSubscriptionTransaction.immediate(endpointHash)
            ), { transaction: true });
        },
        listWebPushSubscriptions() {
            return measure('listWebPushSubscriptions', 'web_push_subscriptions', () => (
                listWebPushSubscriptionsStmt.all().map(mapWebPushSubscription)
            ));
        },
        countWebPushSubscriptions() {
            return measure('countWebPushSubscriptions', 'web_push_subscriptions', () => (
                countWebPushSubscriptionsStmt.get().count
            ));
        },
        markWebPushSuccess(endpointHash, timestamp) {
            if (typeof endpointHash !== 'string' || !/^[0-9a-f]{64}$/u.test(endpointHash)
                || !Number.isSafeInteger(timestamp)) {
                throw new TypeError('web push success result is invalid');
            }
            return measure('markWebPushSuccess', 'web_push_subscriptions', () => (
                markWebPushSuccessStmt.run({ endpoint_hash: endpointHash, timestamp }).changes === 1
            ));
        },
        markWebPushFailure(endpointHash, timestamp, error, retryAt) {
            if (typeof endpointHash !== 'string' || !/^[0-9a-f]{64}$/u.test(endpointHash)
                || !Number.isSafeInteger(timestamp) || !Number.isSafeInteger(retryAt) || retryAt <= timestamp) {
                throw new TypeError('web push failure result is invalid');
            }
            return measure('markWebPushFailure', 'web_push_subscriptions', () => (
                markWebPushFailureStmt.run({
                    endpoint_hash: endpointHash,
                    timestamp,
                    next_retry_ts: retryAt,
                    last_error: String(error || 'push_failed').slice(0, 120)
                }).changes === 1
            ));
        },
        claimWebPushDelivery(endpointHash, notificationKey, timestamp) {
            if (typeof endpointHash !== 'string' || !/^[0-9a-f]{64}$/u.test(endpointHash)
                || typeof notificationKey !== 'string' || !/^[0-9a-f]{64}$/u.test(notificationKey)
                || !Number.isSafeInteger(timestamp)) {
                throw new TypeError('web push delivery claim is invalid');
            }
            return measure('claimWebPushDelivery', 'web_push_delivery_claims', () => (
                claimWebPushDeliveryTransaction.immediate({ endpointHash, notificationKey, timestamp })
            ), { transaction: true });
        },
        releaseWebPushDelivery(endpointHash, notificationKey) {
            if (typeof endpointHash !== 'string' || !/^[0-9a-f]{64}$/u.test(endpointHash)
                || typeof notificationKey !== 'string' || !/^[0-9a-f]{64}$/u.test(notificationKey)) {
                throw new TypeError('web push delivery claim is invalid');
            }
            return measure('releaseWebPushDelivery', 'web_push_delivery_claims', () => (
                deleteWebPushDeliveryClaimStmt.run(endpointHash, notificationKey).changes === 1
            ));
        },
        pruneExpiredWebPushSubscriptions(timestamp) {
            if (!Number.isSafeInteger(timestamp)) throw new TypeError('web push expiry timestamp is invalid');
            return measure('pruneExpiredWebPushSubscriptions', 'web_push_subscriptions', () => (
                pruneExpiredWebPushSubscriptionsTransaction.immediate(timestamp)
            ), { transaction: true });
        },
        insertReportRun(entry) {
            return measure('insertReportRun', 'report_runs', db.transaction(() => {
                const trigger = String(entry.trigger || 'manual').slice(0, 40);
                let scheduleKey = null;
                if (trigger === 'scheduled' && entry.scheduleKey != null) {
                    scheduleKey = normalizeScheduleKey(entry.scheduleKey);
                    if (!scheduleKey) throw new TypeError('scheduleKey must use scheduled:YYYY-MM-DD:HH format');
                }
                const ts = reportTimestamp(entry.ts);
                const completedTs = Number.isFinite(ts) ? ts : Date.now();
                const result = insertReportRunStmt.run({
                    ts: completedTs,
                    trigger,
                    title: String(entry.title || 'SmartHub report').slice(0, 200),
                    delivery_status: String(entry.deliveryStatus || 'generated').slice(0, 40),
                    channel: entry.channel == null ? null : String(entry.channel).slice(0, 40),
                    delivery_error: entry.deliveryError == null ? null : String(entry.deliveryError).slice(0, 500),
                    body: String(entry.body || '').slice(0, 50000),
                    schedule_key: scheduleKey,
                    run_status: entry.deliveryStatus === 'failed' ? 'failed' : 'completed',
                    claimed_ts: scheduleKey ? completedTs : null,
                    completed_ts: completedTs,
                    attempt_count: 1,
                    claim_token: null
                });
                deleteOldReportRunsStmt.run();
                return result.lastInsertRowid;
            }), { transaction: true });
        },
        claimScheduledReport(entry) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('scheduled report claim must be an object');
            }
            const scheduleKey = normalizeScheduleKey(entry.scheduleKey);
            if (!scheduleKey) throw new TypeError('scheduleKey must use scheduled:YYYY-MM-DD:HH format');
            const ts = reportTimestamp(entry.ts);
            if (!Number.isFinite(ts)) throw new TypeError('scheduled report claim ts must be a finite timestamp');
            const title = boundedRequiredString(entry.title, 200, 'scheduled report claim title');
            return measure('claimScheduledReport', 'report_runs', () => claimScheduledReportTransaction.immediate({
                schedule_key: scheduleKey,
                ts,
                claimed_ts: ts,
                title,
                claim_token: randomUUID()
            }), { transaction: true });
        },
        claimNextScheduledReport(entry) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('scheduled report recovery claim must be an object');
            }
            const ts = reportTimestamp(entry.ts);
            if (!Number.isFinite(ts)) throw new TypeError('scheduled report recovery claim ts must be a finite timestamp');
            return measure('claimNextScheduledReport', 'report_runs', () => claimNextScheduledReportTransaction.immediate({
                ts,
                claimed_ts: ts,
                claim_token: randomUUID()
            }), { transaction: true });
        },
        renewScheduledReportClaim(scheduleKeyInput, entry) {
            const scheduleKey = normalizeScheduleKey(scheduleKeyInput);
            if (!scheduleKey) throw new TypeError('scheduleKey must use scheduled:YYYY-MM-DD:HH format');
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('scheduled report renewal must be an object');
            }
            const ts = reportTimestamp(entry.ts);
            if (!Number.isFinite(ts)) throw new TypeError('scheduled report renewal ts must be a finite timestamp');
            if (!Number.isInteger(entry.attemptCount) || entry.attemptCount < 1 || entry.attemptCount > REPORT_MAX_ATTEMPTS) {
                throw new TypeError(`scheduled report renewal attemptCount must be an integer from 1 through ${REPORT_MAX_ATTEMPTS}`);
            }
            const claimToken = normalizeClaimToken(entry.claimToken);
            if (!claimToken) throw new TypeError('scheduled report renewal claimToken must be a UUID');
            return measure('renewScheduledReportClaim', 'report_runs', () => renewScheduledReportClaimStmt.run({
                schedule_key: scheduleKey,
                ts,
                attempt_count: entry.attemptCount,
                claim_token: claimToken
            }).changes === 1);
        },
        completeScheduledReport(scheduleKeyInput, entry) {
            const scheduleKey = normalizeScheduleKey(scheduleKeyInput);
            if (!scheduleKey) throw new TypeError('scheduleKey must use scheduled:YYYY-MM-DD:HH format');
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('scheduled report completion must be an object');
            }
            const ts = reportTimestamp(entry.ts);
            if (!Number.isFinite(ts)) throw new TypeError('scheduled report completion ts must be a finite timestamp');
            if (!Number.isInteger(entry.attemptCount) || entry.attemptCount < 1 || entry.attemptCount > REPORT_MAX_ATTEMPTS) {
                throw new TypeError(`scheduled report completion attemptCount must be an integer from 1 through ${REPORT_MAX_ATTEMPTS}`);
            }
            const claimToken = normalizeClaimToken(entry.claimToken);
            if (!claimToken) throw new TypeError('scheduled report completion claimToken must be a UUID');
            const title = entry.title == null ? null : boundedRequiredString(entry.title, 200, 'scheduled report completion title');
            const deliveryStatus = String(entry.deliveryStatus || 'generated').slice(0, 40);
            const runStatus = deliveryStatus === 'failed'
                ? (entry.attemptCount >= REPORT_MAX_ATTEMPTS ? 'exhausted' : 'failed')
                : 'completed';
            return measure('completeScheduledReport', 'report_runs', () => completeScheduledReportTransaction.immediate({
                schedule_key: scheduleKey,
                attempt_count: entry.attemptCount,
                claim_token: claimToken,
                ts,
                title,
                delivery_status: deliveryStatus,
                channel: entry.channel == null ? null : String(entry.channel).slice(0, 40),
                delivery_error: entry.deliveryError == null ? null : String(entry.deliveryError).slice(0, 500),
                body: String(entry.body || '').slice(0, 50000),
                run_status: runStatus,
                completed_ts: ts
            }), { transaction: true });
        },
        listReportRuns(limit = 20) {
            const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
            return measure('listReportRuns', 'report_runs', () => listReportRunsStmt.all(safeLimit).map(row => ({
                id: row.id,
                ts: reportTimestampIso(row.ts),
                trigger: row.trigger,
                title: row.title,
                deliveryStatus: row.delivery_status,
                channel: row.channel,
                deliveryError: row.delivery_error,
                body: row.body,
                scheduleKey: row.schedule_key,
                runStatus: row.run_status,
                claimedAt: reportTimestampIso(row.claimed_ts),
                completedAt: reportTimestampIso(row.completed_ts),
                attemptCount: row.attempt_count
            })));
        },
        cleanup(keepDays = 30, hardCap = 100000) {
            flush();
            const cutoff = Date.now() - Math.max(Number(keepDays) || 1, 1) * 86400000;
            const cleanup = db.transaction(() => {
                for (const series of HISTORY_SERIES) {
                    deleteBeforeStmt.run(series, cutoff);
                    const excess = countPointsStmt.get(series).count - Math.max(Number(hardCap) || 1, 1);
                    if (excess > 0) deleteOldestStmt.run(series, excess);
                }
                deleteOldUnifiTelemetryStmt.run(cutoff);
                const telemetryExcess = countUnifiTelemetryStmt.get().count - Math.max(Number(hardCap) || 1, 1);
                if (telemetryExcess > 0) deleteOldestUnifiTelemetryStmt.run(telemetryExcess);
            });
            measure('cleanup', 'history', cleanup, { transaction: true });
            try { db.pragma('incremental_vacuum(200)'); } catch { }
        },
        diagnostics() {
            const started = performance.now();
            try {
                healthStmt.get();
                const latency = Number((performance.now() - started).toFixed(2));
                return {
                    ok: !closed,
                    latency_ms: latency,
                    file_name: path.basename(file),
                    pool: { type: 'single_connection', size: 1, active: activeQueries > 0 ? 1 : 0, available: activeQueries > 0 ? 0 : 1, waiting: 0 },
                    slow_queries: slowQueries,
                    failed_queries: failedQueries,
                    last_query_latency_ms: lastQueryLatencyMs,
                    last_error: lastError,
                    write_buffer: {
                        pending_points: pendingPoints.length,
                        pending_bytes: pendingBytes,
                        max_points: maxPendingPoints,
                        max_bytes: maxPendingBytes,
                        total_buffered_points: totalBufferedPoints,
                        total_flushed_points: totalFlushedPoints,
                        flush_count: flushCount,
                        last_flush_at: lastFlushAt
                    }
                };
            } catch (error) {
                failedQueries += 1;
                lastError = error.message;
                emit('critical', {
                    module: 'database.sqlite', function: 'diagnostics', code: ERROR_CODES.DB_HEALTH_FAILED,
                    message: 'SQLite health query failed', error
                });
                return {
                    ok: false, latency_ms: Number((performance.now() - started).toFixed(2)), file_name: path.basename(file),
                    pool: { type: 'single_connection', size: 1, active: 0, available: 0, waiting: 0 },
                    slow_queries: slowQueries, failed_queries: failedQueries, last_error: lastError
                };
            }
        },
        async backup(destination) {
            flush();
            return db.backup(destination);
        },
        close() {
            if (closed) return;
            flush();
            try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { }
            db.close();
            closed = true;
            emit('info', {
                module: 'database.sqlite', function: 'close', code: ERROR_CODES.DB_CLOSE,
                message: 'SQLite database closed', fields: { file: path.basename(file) }
            });
        }
    };
}

module.exports = {
    REPORT_CLAIM_RETRY_AFTER_MS,
    REPORT_CLAIM_STALE_MS,
    REPORT_MAX_ATTEMPTS,
    REPORT_RUN_RETENTION,
    REPORT_SCHEDULE_KEY_RETENTION,
    createHistoryDb
};

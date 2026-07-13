const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { performance } = require('perf_hooks');
const { ERROR_CODES } = require('./observability/error-codes');

const HISTORY_SERIES = ['trend', 'ucg', 'nas', 'ups', 'wiim', 'linux'];
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

function createHistoryDb(dataDir, options = {}) {
    const logger = typeof options === 'function' ? null : options.logger;
    const legacyLogger = typeof options === 'function' ? options : null;
    const slowQueryMs = Math.max(Number(options.slowQueryMs || process.env.DB_SLOW_QUERY_MS) || 1000, 1);
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

    // auto_vacuum must be configured before tables are created. Existing DBs keep
    // their current mode, which is safe; new databases use incremental vacuum.
    try { db.pragma('auto_vacuum = INCREMENTAL'); } catch { }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY,
            series TEXT NOT NULL,
            ts INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_series_ts ON history(series, ts);
        CREATE TABLE IF NOT EXISTS ups_events (
            id INTEGER PRIMARY KEY,
            start_ts INTEGER NOT NULL,
            end_ts INTEGER,
            duration_sec INTEGER,
            min_battery REAL,
            start_voltage REAL
        );
        CREATE INDEX IF NOT EXISTS idx_ups_events_start ON ups_events(start_ts);
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
    `);
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
    const getSinceStmt = db.prepare('SELECT ts, data FROM history WHERE series = ? AND ts >= ? ORDER BY ts ASC, id ASC');
    const getLatestStmt = db.prepare('SELECT ts, data FROM history WHERE series = ? ORDER BY ts DESC, id DESC LIMIT 1');
    const deleteSeriesStmt = db.prepare('DELETE FROM history WHERE series = ?');
    const deleteBeforeStmt = db.prepare('DELETE FROM history WHERE series = ? AND ts < ?');
    const countPointsStmt = db.prepare('SELECT COUNT(*) AS count FROM history WHERE series = ?');
    const deleteOldestStmt = db.prepare(`
        DELETE FROM history WHERE id IN (
            SELECT id FROM history WHERE series = ? ORDER BY ts ASC, id ASC LIMIT ?
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
    const healthStmt = db.prepare('SELECT 1 AS ok');

    function decodePoint(row, series) {
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        if (series === 'wiim') data.ts = Math.floor(row.ts / 1000);
        else data.t = new Date(row.ts).toISOString();
        return data;
    }

    function getSince(series, cutoffMs = 0) {
        return measure('getSince', 'history', () =>
            getSinceStmt.all(series, Math.max(0, Number(cutoffMs) || 0)).map(row => decodePoint(row, series)));
    }

    function getLatest(series) {
        return measure('getLatest', 'history', () => {
            const row = getLatestStmt.get(series);
            return row ? decodePoint(row, series) : null;
        });
    }

    function insertPoint(series, point, { keepDays = 30, hardCap = 100000 } = {}) {
        const ts = pointTimestamp(point, series);
        if (!Number.isFinite(ts)) return false;
        return measure('insertPoint', 'history', () => {
            const payload = { ...point };
            delete payload.t;
            delete payload.ts;
            insertPointStmt.run(series, ts, JSON.stringify(payload));
            pruneRaw(series, keepDays, hardCap);
            return true;
        });
    }

    function pruneRaw(series, keepDays = 30, hardCap = 100000) {
        const days = Math.max(Number(keepDays) || 1, 1);
        deleteBeforeStmt.run(series, Date.now() - days * 86400000);
        const count = countPointsStmt.get(series).count;
        const excess = count - Math.max(Number(hardCap) || 1, 1);
        if (excess > 0) deleteOldestStmt.run(series, excess);
    }

    function prune(series, keepDays = 30, hardCap = 100000) {
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
        getSince,
        getLatest,
        deleteSeries(series) { return measure('deleteSeries', 'history', () => deleteSeriesStmt.run(series)); },
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
        cleanup(keepDays = 30) {
            const cutoff = Date.now() - Math.max(Number(keepDays) || 1, 1) * 86400000;
            const cleanup = db.transaction(() => {
                for (const series of HISTORY_SERIES) deleteBeforeStmt.run(series, cutoff);
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
                    last_error: lastError
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
        close() {
            if (closed) return;
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

module.exports = { createHistoryDb };

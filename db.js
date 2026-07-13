const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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

function createHistoryDb(dataDir, logger = () => {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'smarthub.db');
    const db = new Database(file);

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

    function decodePoint(row, series) {
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        if (series === 'wiim') data.ts = Math.floor(row.ts / 1000);
        else data.t = new Date(row.ts).toISOString();
        return data;
    }

    function getSince(series, cutoffMs = 0) {
        return getSinceStmt.all(series, Math.max(0, Number(cutoffMs) || 0)).map(row => decodePoint(row, series));
    }

    function getLatest(series) {
        const row = getLatestStmt.get(series);
        return row ? decodePoint(row, series) : null;
    }

    function insertPoint(series, point, { keepDays = 30, hardCap = 100000 } = {}) {
        const ts = pointTimestamp(point, series);
        if (!Number.isFinite(ts)) return false;
        const payload = { ...point };
        delete payload.t;
        delete payload.ts;
        insertPointStmt.run(series, ts, JSON.stringify(payload));
        prune(series, keepDays, hardCap);
        return true;
    }

    function prune(series, keepDays = 30, hardCap = 100000) {
        const days = Math.max(Number(keepDays) || 1, 1);
        deleteBeforeStmt.run(series, Date.now() - days * 86400000);
        const count = countPointsStmt.get(series).count;
        const excess = count - Math.max(Number(hardCap) || 1, 1);
        if (excess > 0) deleteOldestStmt.run(series, excess);
    }

    function migrateFromJson() {
        const filesToRename = [];
        const migrate = db.transaction(() => {
            for (const series of HISTORY_SERIES) {
                const source = path.join(dataDir, JSON_HISTORY_FILES[series]);
                if (!fs.existsSync(source) || countSeriesStmt.get(series).count > 0) continue;
                let points;
                try { points = JSON.parse(fs.readFileSync(source, 'utf8')); } catch (error) {
                    logger(`[SQLite] ${JSON_HISTORY_FILES[series]} 解析失敗: ${error.message}`);
                    continue;
                }
                if (!Array.isArray(points)) {
                    logger(`[SQLite] ${JSON_HISTORY_FILES[series]} 不是陣列，略過匯入`);
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
                logger(`[SQLite] 已匯入 ${JSON_HISTORY_FILES[series]}：${imported}/${points.length} 筆`);
            }

            const eventSource = path.join(dataDir, 'ups-events.json');
            if (fs.existsSync(eventSource) && db.prepare('SELECT COUNT(*) AS count FROM ups_events').get().count === 0) {
                let events;
                try { events = JSON.parse(fs.readFileSync(eventSource, 'utf8')); } catch (error) {
                    logger(`[SQLite] ups-events.json 解析失敗: ${error.message}`);
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
                    logger(`[SQLite] 已匯入 ups-events.json：${events.length} 筆`);
                }
            }

            const blockSource = path.join(dataDir, 'block-history.json');
            if (fs.existsSync(blockSource) && db.prepare('SELECT COUNT(*) AS count FROM block_history').get().count === 0) {
                let entries;
                try { entries = JSON.parse(fs.readFileSync(blockSource, 'utf8')); } catch (error) {
                    logger(`[SQLite] block-history.json 解析失敗: ${error.message}`);
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
                    logger(`[SQLite] 已匯入 block-history.json：${entries.length} 筆`);
                }
            }
        });

        migrate();
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
                logger(`[SQLite] ${path.basename(source)} 備份改名失敗: ${error.message}`);
            }
        }
    }

    migrateFromJson();

    return {
        file,
        insertPoint,
        getSince,
        getLatest,
        deleteSeries(series) { deleteSeriesStmt.run(series); },
        prune,
        insertUpsEvent(event) {
            const startTs = eventTimestamp(event.start);
            if (!Number.isFinite(startTs)) return null;
            const result = insertUpsEventStmt.run({
                start_ts: startTs,
                end_ts: event.end ? eventTimestamp(event.end) : null,
                duration_sec: event.durationSec ?? null,
                min_battery: event.minBattery ?? null,
                start_voltage: event.startVoltage ?? null
            });
            deleteOldUpsEventsStmt.run();
            return result.lastInsertRowid;
        },
        listUpsEvents() {
            return listUpsEventsStmt.all().map(row => ({
                id: row.id,
                start: new Date(row.start_ts).toISOString(),
                end: row.end_ts == null ? null : new Date(row.end_ts).toISOString(),
                durationSec: row.duration_sec,
                minBattery: row.min_battery,
                startVoltage: row.start_voltage
            }));
        },
        getOpenUpsEvent() {
            const row = openUpsEventStmt.get();
            return row ? {
                id: row.id,
                start: new Date(row.start_ts).toISOString(),
                end: null,
                durationSec: row.duration_sec,
                minBattery: row.min_battery,
                startVoltage: row.start_voltage
            } : null;
        },
        closeOpenUpsEvent(end, durationSec) {
            const open = openUpsEventStmt.get();
            if (!open) return null;
            const endTs = eventTimestamp(end);
            if (!Number.isFinite(endTs)) return null;
            closeUpsEventStmt.run({ id: open.id, end_ts: endTs, duration_sec: durationSec });
            return { ...open, end_ts: endTs, duration_sec: durationSec };
        },
        updateOpenUpsMinBattery(minBattery) {
            const open = openUpsEventStmt.get();
            if (!open || minBattery == null) return;
            updateUpsMinBatteryStmt.run({ id: open.id, min_battery: minBattery });
        },
        insertBlock(entry) {
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
        },
        listBlockHistory() {
            return listBlockStmt.all().map(row => ({
                datetime: new Date(row.ts).toISOString(),
                mac: row.mac,
                name: row.name,
                action: row.action,
                source: row.source,
                ...(row.reason ? { reason: row.reason } : {})
            }));
        },
        cleanup(keepDays = 30) {
            const cutoff = Date.now() - Math.max(Number(keepDays) || 1, 1) * 86400000;
            const cleanup = db.transaction(() => {
                for (const series of HISTORY_SERIES) deleteBeforeStmt.run(series, cutoff);
            });
            cleanup();
            try { db.pragma('incremental_vacuum(200)'); } catch { }
        },
        close() {
            try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { }
            db.close();
        }
    };
}

module.exports = { createHistoryDb };

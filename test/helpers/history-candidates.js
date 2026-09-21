'use strict';

const Database = require('better-sqlite3');
const { createHistoryDb } = require('../../db');

// Capture the statements prepared by the real DB owner, not copies of its SQL.
// Initialization is synchronous; always restore the prototype before returning.
function captureHistoryCandidates(directory) {
    const statements = [];
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (sql) {
        if (/SELECT DISTINCT/.test(sql) && /AS bucket_ts/.test(sql)) statements.push(sql);
        return prepare.call(this, sql);
    };
    let history;
    try { history = createHistoryDb(directory); }
    finally { Database.prototype.prepare = prepare; }
    return { history, statements };
}

function candidateParams(sql, start, end, limit) {
    if (/FROM history_rollups/.test(sql)) return ['trend', '1m', start, end, limit];
    if (/FROM history WHERE/.test(sql)) return ['trend', start, end, limit];
    if (/FROM unifi_device_telemetry_rollups/.test(sql)) return ['1m', start, end, limit];
    return [start, end, limit];
}

module.exports = { captureHistoryCandidates, candidateParams };

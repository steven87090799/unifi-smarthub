'use strict';

/**
 * Register NAS log IDs and immediately forward every newly received log after
 * the initial baseline. This path deliberately bypasses telemetry buffering:
 * once SmartHub receives a NAS event, the configured phone channel is called
 * before this function resolves.
 */
async function forwardNasLogs(logs, { knownIds, bootstrapped, notify }) {
    let forwarded = 0;
    for (const log of Array.isArray(logs) ? logs : []) {
        if (knownIds.has(log.log_id)) continue;
        knownIds.add(log.log_id);
        if (!bootstrapped) continue;
        const emoji = { critical: '🚨', error: '❌', warning: '⚠️' }[log.level] || '📋';
        await notify(`${emoji} NAS 日誌 [${log.level}]`, `[${log.module}] ${log.content}`);
        forwarded += 1;
    }
    return forwarded;
}

async function forwardNasAlerts(events, { knownIds, bootstrapped, notify }) {
    let forwarded = 0;
    for (const event of Array.isArray(events) ? events : []) {
        if (event.acknowledged || event.level === 'info' || knownIds.has(event.id)) continue;
        knownIds.add(event.id);
        if (!bootstrapped) continue;
        await notify('💾 NAS 警報', `[${event.level}] ${event.message || event.metric}`);
        forwarded += 1;
    }
    return forwarded;
}

module.exports = { forwardNasLogs, forwardNasAlerts };

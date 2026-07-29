'use strict';

function createPpbEventSync({
    db,
    fetchEvents,
    normalizeEvent,
    loadSettings = () => ({ enabled: false }),
    notify = async () => {},
    now = Date.now
} = {}) {
    if (!db || typeof db.getIntegrationSyncState !== 'function'
        || typeof db.upsertIntegrationSyncState !== 'function'
        || typeof db.recordUpsPowerEvent !== 'function') {
        throw new TypeError('PPB event sync requires persistent database methods');
    }
    if (typeof fetchEvents !== 'function' || typeof normalizeEvent !== 'function') {
        throw new TypeError('PPB event sync requires fetchEvents and normalizeEvent');
    }
    let inFlight = null;
    let lastAttemptAt = 0;
    let lastSuccessAt = 0;

    async function performSync() {
        lastAttemptAt = now();
        const existingState = db.getIntegrationSyncState('ppb');
        const raw = await fetchEvents();
        const normalized = (Array.isArray(raw) ? raw : []).map(normalizeEvent).filter(Boolean);
        const created = [];
        for (const event of normalized) {
            const result = db.recordUpsPowerEvent(event);
            if (result.created && result.event) created.push({ ...result.event, sag: event.sag === true });
        }
        const completedAt = now();
        let newest = null;
        for (const event of normalized) {
            const timestamp = event.eventTs ?? event.observedTs ?? 0;
            const newestTimestamp = newest ? (newest.eventTs ?? newest.observedTs ?? 0) : -Infinity;
            if (timestamp >= newestTimestamp) newest = event;
        }
        db.upsertIntegrationSyncState({
            source: 'ppb',
            initializedAt: existingState?.initializedAt || completedAt,
            lastSuccessAt: completedAt,
            lastExternalId: newest?.externalId || existingState?.lastExternalId || null,
            lastEventTs: newest?.eventTs ?? existingState?.lastEventTs ?? null,
            updatedAt: completedAt
        });
        lastSuccessAt = completedAt;

        const settings = loadSettings() || {};
        if (existingState && settings.enabled && settings.triggerUpsSag !== false) {
            for (const item of created.filter(event => event.sag).slice(0, 3)) {
                await notify('⚠️ UPS 原廠記錄到市電壓降', item.description);
            }
        }
        return { created: created.length, events: db.listUpsPowerEvents(200) };
    }

    async function run() {
        if (inFlight) return inFlight;
        const current = performSync();
        inFlight = current;
        try { return await current; }
        finally { if (inFlight === current) inFlight = null; }
    }

    return Object.freeze({
        run,
        snapshot: () => ({
            initialized: !!db.getIntegrationSyncState('ppb'),
            inFlight: !!inFlight,
            lastAttemptAt,
            lastSuccessAt
        })
    });
}

module.exports = { createPpbEventSync };

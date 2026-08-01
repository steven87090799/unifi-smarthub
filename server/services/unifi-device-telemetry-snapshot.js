'use strict';

function errorReason(error) {
    const code = String(error?.code || '').toLowerCase();
    const text = String(error?.message || '').toLowerCase();
    if (/auth|permission/.test(`${code} ${text}`)) return 'authentication_failed';
    if (/timeout|timed out/.test(`${code} ${text}`)) return 'timeout';
    return 'unavailable';
}

function staleCopy(snapshot, { now, reason }) {
    const lastSuccessfulAt = snapshot?.lastSuccessfulAt || snapshot?.collectedAt || null;
    return {
        ...(snapshot || {}),
        collectedAt: snapshot?.collectedAt || null,
        lastSuccessfulAt,
        stale: true,
        errorReason: reason || snapshot?.errorReason || 'unavailable',
        observedAt: new Date(now).toISOString(),
        source: snapshot?.source || { system: 'unifi_controller' },
        devices: (Array.isArray(snapshot?.devices) ? snapshot.devices : []).map(device => ({
            ...device,
            freshness: {
                ...(device.freshness || {}),
                lastSuccessfulAt: device.freshness?.lastSuccessfulAt || lastSuccessfulAt,
                stale: true,
                errorReason: reason || device.freshness?.errorReason || 'unavailable'
            },
            temperature: device.temperature ? { ...device.temperature, stale: true, status: 'stale' } : null
        }))
    };
}

function createUnifiDeviceTelemetrySnapshot({ sample, now = () => Date.now(), staleAfterMs } = {}) {
    if (typeof sample !== 'function') throw new TypeError('sample is required');
    if (typeof staleAfterMs !== 'function') throw new TypeError('staleAfterMs is required');
    let latest = null;
    let inflight = null;
    let lastAttemptAt = null;
    let lastErrorAt = null;
    let lastFailureAt = null;
    let consecutiveFailures = 0;
    let lastErrorReason = null;

    function present() {
        if (!latest) return staleCopy(null, { now: now(), reason: lastErrorReason || 'unavailable' });
        const collectedAt = Date.parse(latest.collectedAt || '');
        const expired = !Number.isFinite(collectedAt) || now() - collectedAt > staleAfterMs();
        return expired || lastErrorAt
            ? staleCopy(latest, { now: now(), reason: lastErrorReason || 'stale' })
            : { ...latest, stale: false, errorReason: null };
    }

    function refresh() {
        if (inflight) return inflight;
        lastAttemptAt = now();
        inflight = Promise.resolve().then(sample).then(snapshot => {
            if (!snapshot || !Array.isArray(snapshot.devices)) throw new Error('invalid telemetry snapshot');
            const collectedAt = snapshot.collectedAt || new Date(now()).toISOString();
            latest = { ...snapshot, collectedAt, lastSuccessfulAt: collectedAt, stale: false, errorReason: null };
            lastErrorAt = null;
            consecutiveFailures = 0;
            lastErrorReason = null;
            return present();
        }).catch(error => {
            lastErrorAt = now();
            lastFailureAt = lastErrorAt;
            consecutiveFailures += 1;
            lastErrorReason = errorReason(error);
            return present();
        }).finally(() => { inflight = null; });
        return inflight;
    }

    function clear() {
        latest = null;
        lastAttemptAt = null;
        lastErrorAt = null;
        lastFailureAt = null;
        consecutiveFailures = 0;
        lastErrorReason = null;
    }

    return Object.freeze({
        read: present,
        refresh,
        clear,
        diagnostics: () => ({
            hasSnapshot: !!latest,
            inflight: !!inflight,
            lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null,
            lastSuccessfulAt: latest?.lastSuccessfulAt || null,
            lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
            lastFailureAt: lastFailureAt ? new Date(lastFailureAt).toISOString() : null,
            consecutiveFailures,
            lastErrorReason
        })
    });
}

module.exports = { createUnifiDeviceTelemetrySnapshot, errorReason, staleCopy };

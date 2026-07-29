'use strict';

function markSnapshotDevicesStale(snapshot) {
    return {
        ...snapshot,
        stale: true,
        devices: (Array.isArray(snapshot?.devices) ? snapshot.devices : []).map(device => ({
            ...device,
            telemetryStale: true,
            temperature: device.temperature ? { ...device.temperature, stale: true } : null,
            temperatureStatus: device.temperature ? 'telemetry_snapshot_stale' : device.temperatureStatus
        }))
    };
}

function createUnifiDeviceTelemetrySnapshot({ sample, now = () => Date.now(), staleAfterMs } = {}) {
    if (typeof sample !== 'function') throw new TypeError('sample is required');
    if (typeof staleAfterMs !== 'function') throw new TypeError('staleAfterMs is required');
    let latest = null;
    let inflight = null;

    function present(snapshot = latest) {
        if (!snapshot) return null;
        const sampledAtMs = Date.parse(snapshot.sampledAt || '');
        const stale = Boolean(snapshot.stale) || !Number.isFinite(sampledAtMs) || now() - sampledAtMs > staleAfterMs();
        const presented = {
            ...snapshot,
            stale,
            controllerSampledAt: snapshot.controllerSampledAt || snapshot.sampledAt,
            thermalSampledAt: snapshot.thermalSampledAt || snapshot.sampledAt
        };
        return stale ? markSnapshotDevicesStale(presented) : presented;
    }

    async function refresh() {
        if (inflight) return inflight;
        inflight = Promise.resolve().then(sample).then(snapshot => {
            latest = snapshot;
            return present(snapshot);
        }).finally(() => { inflight = null; });
        return inflight;
    }

    async function read() {
        if (latest) return present();
        return refresh();
    }

    return Object.freeze({ read, refresh, snapshot: () => present(), clear: () => { latest = null; } });
}

module.exports = { createUnifiDeviceTelemetrySnapshot, markSnapshotDevicesStale };

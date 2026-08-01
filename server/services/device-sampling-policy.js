'use strict';

const DEFAULTS = Object.freeze({
    deviceActiveBackendSampleSec: 5,
    deviceIdleBackendSampleSec: 600,
    upsActiveBackendSampleSec: 3,
    upsIdleBackendSampleSec: 10,
    upsPpbEventActiveBackendSampleSec: 10,
    upsPpbEventIdleBackendSampleSec: 60,
    unifiTelemetryActiveSec: 60,
    unifiTelemetryIdleSec: 300
});

function createDeviceSamplingPolicy({ getSettings = () => DEFAULTS, isActive = () => false } = {}) {
    if (typeof getSettings !== 'function') throw new TypeError('getSettings must be a function');
    if (typeof isActive !== 'function') throw new TypeError('isActive must be a function');

    function seconds(key, fallback) {
        const value = Number(getSettings()?.[key]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    function deviceMs(scope) {
        const active = Boolean(isActive(scope));
        return seconds(active ? 'deviceActiveBackendSampleSec' : 'deviceIdleBackendSampleSec',
            active ? DEFAULTS.deviceActiveBackendSampleSec : DEFAULTS.deviceIdleBackendSampleSec) * 1000;
    }

    function upsMs() {
        const active = Boolean(isActive('ups'));
        return seconds(active ? 'upsActiveBackendSampleSec' : 'upsIdleBackendSampleSec',
            active ? DEFAULTS.upsActiveBackendSampleSec : DEFAULTS.upsIdleBackendSampleSec) * 1000;
    }

    function ppbEventMs() {
        const active = Boolean(isActive('ups'));
        return seconds(active ? 'upsPpbEventActiveBackendSampleSec' : 'upsPpbEventIdleBackendSampleSec',
            active ? DEFAULTS.upsPpbEventActiveBackendSampleSec : DEFAULTS.upsPpbEventIdleBackendSampleSec) * 1000;
    }

    function telemetryMs() {
        const active = Boolean(isActive('unifi-device-telemetry'));
        return seconds(active ? 'unifiTelemetryActiveSec' : 'unifiTelemetryIdleSec',
            active ? DEFAULTS.unifiTelemetryActiveSec : DEFAULTS.unifiTelemetryIdleSec) * 1000;
    }

    return Object.freeze({ deviceMs, upsMs, ppbEventMs, telemetryMs });
}

module.exports = { createDeviceSamplingPolicy };

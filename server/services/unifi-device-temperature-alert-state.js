'use strict';

function createUnifiDeviceTemperatureAlertState({
    now = () => Date.now(), maxEntries = 1000, load = () => null, save = () => {}
} = {}) {
    const devices = new Map();
    function evaluate(device, { threshold = 75, criticalThreshold = 90 } = {}) {
        const id = device?.id;
        const temperature = device?.temperature;
        if (!id || device?.freshness?.stale || temperature?.status !== 'supported'
            || temperature?.stale || !Number.isFinite(temperature?.value) || !temperature?.sampledAt) return null;
        const previous = devices.get(id) || load(id) || {
            consecutiveHigh: 0, consecutiveRecovery: 0, alertActive: false,
            lastAlertAt: 0, lastRecoveryAt: 0, lastSampledAt: null
        };
        if (previous.lastSampledAt === temperature.sampledAt) return null;
        if (previous.lastSampledAt && String(temperature.sampledAt) < String(previous.lastSampledAt)) return null;
        previous.lastSampledAt = temperature.sampledAt;
        const value = temperature.value;
        let action = null;
        if (value >= threshold) {
            previous.consecutiveHigh += 1;
            previous.consecutiveRecovery = 0;
            const critical = value >= criticalThreshold;
            if ((!previous.alertActive && (critical || previous.consecutiveHigh >= 3))
                || (previous.alertActive && critical && now() - previous.lastAlertAt >= 30 * 60 * 1000)) {
                previous.alertActive = true;
                previous.lastAlertAt = now();
                action = { type: critical ? 'critical' : 'high', value, threshold };
            }
        } else if (previous.alertActive && value <= threshold - 5) {
            previous.consecutiveHigh = 0;
            previous.consecutiveRecovery += 1;
            if (previous.consecutiveRecovery >= 2) {
                previous.alertActive = false;
                previous.consecutiveRecovery = 0;
                previous.lastRecoveryAt = now();
                action = { type: 'recovered', value, threshold: threshold - 5 };
            }
        } else {
            previous.consecutiveHigh = 0;
            previous.consecutiveRecovery = 0;
        }
        devices.set(id, previous);
        if (devices.size > maxEntries) devices.delete(devices.keys().next().value);
        save(id, previous);
        return action;
    }
    return Object.freeze({ evaluate, clear: () => devices.clear(), snapshot: id => devices.get(id) || load(id) || null });
}

module.exports = { createUnifiDeviceTemperatureAlertState };

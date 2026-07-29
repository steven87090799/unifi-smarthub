'use strict';

function createUnifiDeviceTemperatureAlertState({ now = () => Date.now(), maxEntries = 1000 } = {}) {
    const devices = new Map();
    function evaluate(device, { threshold = 75, criticalThreshold = 90 } = {}) {
        const id = device?.id;
        const temperature = device?.temperature;
        if (!id || device?.telemetryStale || !Number.isFinite(temperature?.value) || temperature.stale || !temperature.sampledAt) return null;
        const previous = devices.get(id) || { consecutiveHigh: 0, consecutiveRecovery: 0, alertActive: false, lastAlertAt: 0, lastSampledAt: null };
        if (previous.lastSampledAt === temperature.sampledAt) return null;
        previous.lastSampledAt = temperature.sampledAt;
        const value = temperature.value;
        let action = null;
        if (value >= threshold) {
            previous.consecutiveHigh += 1;
            previous.consecutiveRecovery = 0;
            const severe = value >= criticalThreshold;
            if ((!previous.alertActive && (severe || previous.consecutiveHigh >= 3))
                || (previous.alertActive && severe && now() - previous.lastAlertAt >= 30 * 60 * 1000)) {
                previous.alertActive = true;
                previous.lastAlertAt = now();
                action = { type: severe ? 'critical' : 'high', value, threshold };
            }
        } else if (previous.alertActive && value <= threshold - 5) {
            previous.consecutiveHigh = 0;
            previous.consecutiveRecovery += 1;
            if (previous.consecutiveRecovery >= 2) {
                previous.alertActive = false;
                previous.consecutiveRecovery = 0;
                action = { type: 'recovered', value, threshold: threshold - 5 };
            }
        } else {
            previous.consecutiveHigh = 0;
            previous.consecutiveRecovery = 0;
        }
        devices.set(id, previous);
        if (devices.size > maxEntries) devices.delete(devices.keys().next().value);
        return action;
    }
    return { evaluate, clear: () => devices.clear(), snapshot: id => devices.get(id) || null };
}

module.exports = { createUnifiDeviceTemperatureAlertState };

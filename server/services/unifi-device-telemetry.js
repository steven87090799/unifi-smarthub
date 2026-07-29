'use strict';

const TEMPERATURE_FIELDS = Object.freeze([
    ['general_temperature'],
    ['system-stats', 'temperature'],
    ['system-stats', 'temp']
]);

function finiteNumber(value, { min, max } = {}) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (min !== undefined && number < min) return null;
    if (max !== undefined && number > max) return null;
    return number;
}

function readPath(object, path) {
    let current = object;
    for (const key of path) {
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
        current = current[key];
    }
    return current;
}

function stableDeviceId(device) {
    const id = device?.mac || device?._id;
    return typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : null;
}

function onlineState(state) {
    return state === 1 || state === '1' || String(state).toLowerCase() === 'connected';
}

function findTemperature(device) {
    // UniFi's capability flag is authoritative. A temperature-looking field is
    // ignored when the device explicitly says it has no temperature sensor.
    if (device?.has_temperature !== true) return null;
    for (const path of TEMPERATURE_FIELDS) {
        const value = finiteNumber(readPath(device, path), { min: -60, max: 150 });
        if (value !== null) return { value, sourceField: path.join('.') };
    }
    return null;
}

function presentUnifiDeviceTelemetry(rawDevices, { sampledAt = new Date().toISOString() } = {}) {
    const devices = (Array.isArray(rawDevices) ? rawDevices : []).map(device => {
        const id = stableDeviceId(device);
        if (!id) return null;
        const cpu = finiteNumber(readPath(device, ['system-stats', 'cpu']), { min: 0, max: 100 });
        const temperature = findTemperature(device);
        const temperatureCapability = device.has_temperature === true;
        return {
            id,
            name: String(device.name || device.model || id).slice(0, 128),
            model: String(device.model || '').slice(0, 64),
            type: String(device.type || '').slice(0, 32),
            version: String(device.version || '').slice(0, 64),
            online: onlineState(device.state),
            cpu: cpu === null ? null : {
                value: cpu,
                unit: 'percent',
                sourceField: 'system-stats.cpu',
                verifiedSource: true
            },
            temperature: temperature === null ? null : {
                value: temperature.value,
                unit: 'celsius',
                sourceField: temperature.sourceField,
                verifiedSource: true
            },
            temperatureCapability,
            temperatureStatus: temperature
                ? 'reported'
                : temperatureCapability
                    ? 'value_not_reported'
                    : 'device_reported_unsupported'
        };
    }).filter(Boolean);

    return {
        sampledAt,
        source: {
            system: 'UniFi Network Controller',
            endpoint: '/proxy/network/api/s/default/stat/device',
            interpretation: 'direct_device_report'
        },
        devices
    };
}

function telemetryHistoryPoint(telemetry) {
    return {
        t: telemetry.sampledAt,
        devices: telemetry.devices.map(device => ({
            id: device.id,
            name: device.name,
            model: device.model,
            type: device.type,
            online: device.online,
            cpu: device.cpu?.value ?? null,
            temperature: device.temperature?.value ?? null,
            cpuSourceField: device.cpu?.sourceField ?? null,
            temperatureSourceField: device.temperature?.sourceField ?? null,
            temperatureStatus: device.temperatureStatus
        }))
    };
}

module.exports = {
    TEMPERATURE_FIELDS,
    findTemperature,
    presentUnifiDeviceTelemetry,
    telemetryHistoryPoint
};

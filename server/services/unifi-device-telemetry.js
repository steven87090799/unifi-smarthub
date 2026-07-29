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

function directSshStatus(entry, configured, controllerCapability) {
    if (!configured && entry?.selected) return 'device_ssh_not_configured';
    if (!configured) return controllerCapability ? 'controller_value_not_reported' : 'controller_unsupported';
    if (!entry?.selected) return 'device_ssh_not_selected';
    if (!entry?.lastSuccessAt && !entry?.lastErrorAt && !entry?.errorCode) return 'device_ssh_waiting';
    const codes = {
        management_ip_missing: 'device_ssh_no_management_ip',
        authentication_failed: 'device_ssh_auth_failed',
        connection_timeout: 'device_ssh_unreachable',
        connection_refused: 'device_ssh_unreachable',
        device_offline: 'device_ssh_unreachable',
        no_thermal_zone: 'device_ssh_no_thermal_zone',
        invalid_response: 'device_ssh_invalid_response'
    };
    return codes[entry?.errorCode] || (entry?.errorCode ? 'device_ssh_invalid_response' : 'device_ssh_waiting');
}

function presentUnifiDeviceTelemetry(rawDevices, {
    sampledAt = new Date().toISOString(),
    directThermalByDevice = new Map(),
    thermalSshConfigured = false
} = {}) {
    const devices = (Array.isArray(rawDevices) ? rawDevices : []).map(device => {
        const id = stableDeviceId(device);
        if (!id) return null;
        const cpu = finiteNumber(readPath(device, ['system-stats', 'cpu']), { min: 0, max: 100 });
        const controllerTemperature = findTemperature(device);
        const direct = directThermalByDevice instanceof Map
            ? directThermalByDevice.get(id)
            : directThermalByDevice?.[id];
        const temperatureCapability = device.has_temperature === true;
        const controllerSampledAt = sampledAt;
        const directTemperature = direct?.thermal;
        const useDirect = !controllerTemperature && directTemperature;
        const temperature = controllerTemperature
            ? {
                value: controllerTemperature.value,
                sourceField: controllerTemperature.sourceField,
                sourceSystem: 'controller',
                sampledAt: controllerSampledAt,
                stale: false,
                zones: []
            }
            : useDirect
                ? {
                    value: directTemperature.maxTemperatureC,
                    sourceField: directTemperature.source?.path || '/sys/class/thermal/thermal_zone*/temp',
                    sourceSystem: 'device_ssh',
                    sampledAt: directTemperature.sampledAt,
                    stale: direct.stale === true,
                    zones: directTemperature.zones || [],
                    sensorCount: Array.isArray(directTemperature.zones) ? directTemperature.zones.length : 0,
                    cpuTemperatureC: directTemperature.cpuTemperatureC ?? null
                }
                : null;
        const temperatureStatus = controllerTemperature
            ? 'controller_reported'
            : useDirect
                ? (direct.stale ? 'device_ssh_stale' : 'device_ssh_reported')
                : directSshStatus(direct, thermalSshConfigured, temperatureCapability);
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
                sourceSystem: temperature.sourceSystem,
                verifiedSource: true,
                sampledAt: temperature.sampledAt,
                stale: temperature.stale
            },
            temperatureZones: temperature?.zones || [],
            temperatureSensorCount: temperature?.sensorCount || 0,
            cpuTemperatureC: temperature?.cpuTemperatureC ?? null,
            temperatureCapability,
            temperatureStatus,
            directSshConfigured: !!thermalSshConfigured,
            directSshSelected: !!direct?.selected,
            directSshLastSuccessAt: direct?.lastSuccessAt || null,
            directSshLastErrorAt: direct?.lastErrorAt || null,
            directSshErrorCode: direct?.errorCode || null
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
            temperature: device.temperature?.stale ? null : (device.temperature?.value ?? null),
            cpuSourceField: device.cpu?.sourceField ?? null,
            temperatureSourceField: device.temperature?.sourceField ?? null,
            temperatureSourceSystem: device.temperature?.sourceSystem ?? null,
            temperatureStatus: device.temperatureStatus,
            temperatureSampledAt: device.temperature?.stale ? null : (device.temperature?.sampledAt ?? null)
        }))
    };
}

module.exports = {
    TEMPERATURE_FIELDS,
    findTemperature,
    directSshStatus,
    presentUnifiDeviceTelemetry,
    telemetryHistoryPoint
};

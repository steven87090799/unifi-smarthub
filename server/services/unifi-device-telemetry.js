'use strict';

const net = require('node:net');

const TEMPERATURE_FIELDS = Object.freeze([
    ['general_temperature'],
    ['system-stats', 'temperature'],
    ['system-stats', 'temp']
]);
const TEMPERATURE_STATUSES = Object.freeze([
    'supported', 'unsupported', 'not_configured', 'offline', 'stale',
    'authentication_failed', 'host_key_mismatch', 'timeout', 'unavailable'
]);

function boundedText(value, maxLength) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, maxLength);
}

function finiteNumber(value, { min, max, integer = false } = {}) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) return null;
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

function firstNumber(object, paths, bounds) {
    for (const path of paths) {
        const value = finiteNumber(readPath(object, path), bounds);
        if (value !== null) return { value, sourceField: path.join('.') };
    }
    return null;
}

function stableDeviceId(device) {
    const candidate = boundedText(device?.mac || device?._id, 128).toLowerCase();
    return candidate || null;
}

function onlineState(state) {
    return state === 1 || state === '1' || String(state).toLowerCase() === 'connected';
}

function literalIp(device) {
    for (const field of ['ip', 'last_ip']) {
        const value = boundedText(device?.[field], 64);
        if (net.isIP(value)) return value;
    }
    return null;
}

function findTemperature(device) {
    if (device?.has_temperature !== true) return null;
    for (const path of TEMPERATURE_FIELDS) {
        const value = finiteNumber(readPath(device, path), { min: -60, max: 150 });
        if (value !== null) return { value, sourceField: path.join('.') };
    }
    return null;
}

function normalizeRadios(device) {
    const radios = Array.isArray(device?.radio_table) ? device.radio_table : [];
    return radios.slice(0, 16).map((radio, index) => ({
        name: boundedText(radio?.name || radio?.radio || `radio-${index + 1}`, 32),
        band: boundedText(radio?.radio || radio?.band || '', 16) || null,
        channel: finiteNumber(radio?.channel, { min: 0, max: 10000, integer: true }),
        channelWidthMhz: finiteNumber(radio?.channel_width ?? radio?.ht, { min: 1, max: 1000, integer: true }),
        utilizationPercent: finiteNumber(radio?.cu_total ?? radio?.channel_utilization, { min: 0, max: 100 }),
        clientCount: finiteNumber(radio?.num_sta, { min: 0, max: 100000, integer: true })
    }));
}

function normalizeVaps(device) {
    const vaps = Array.isArray(device?.vap_table) ? device.vap_table : [];
    return vaps.slice(0, 64).map(vap => ({
        ssid: boundedText(vap?.essid || vap?.ssid || '', 64) || null,
        radio: boundedText(vap?.radio || vap?.radio_name || '', 32) || null,
        up: vap?.up === true || vap?.up === 1 || vap?.up === '1',
        clientCount: finiteNumber(vap?.num_sta, { min: 0, max: 100000, integer: true })
    }));
}

function directStatus(entry, { selected, controllerCapability }) {
    if (!selected) return controllerCapability ? 'unavailable' : 'unsupported';
    const status = entry?.status || entry?.errorCode;
    if (status === 'not_configured') return 'not_configured';
    if (status === 'device_offline' || status === 'offline') return 'offline';
    if (status === 'authentication_failed') return 'authentication_failed';
    if (status === 'host_key_mismatch') return 'host_key_mismatch';
    if (['connection_timeout', 'command_timeout', 'timeout', 'SSH_COMMAND_TIMEOUT'].includes(status)) return 'timeout';
    if (status === 'no_thermal_zone' || status === 'unsupported') return 'unsupported';
    if (entry?.stale || status === 'stale') return 'stale';
    return 'unavailable';
}

function temperatureFor(device, direct, collectedAt) {
    const online = onlineState(device?.state);
    if (!online) return { value: null, status: 'offline', source: null, sourceField: null, sampledAt: null, stale: false };
    const controller = findTemperature(device);
    if (controller) {
        return {
            value: controller.value,
            status: 'supported',
            source: 'controller',
            sourceField: controller.sourceField,
            sampledAt: collectedAt,
            stale: false
        };
    }
    if (direct?.thermal && !direct.stale && direct.status === 'supported') {
        return {
            value: direct.thermal.maxTemperatureC,
            status: 'supported',
            source: 'device_ssh',
            sourceField: direct.thermal.source?.path || '/sys/class/thermal/thermal_zone*/temp',
            sampledAt: direct.thermal.sampledAt || direct.lastSuccessAt || collectedAt,
            stale: false
        };
    }
    return {
        value: null,
        status: directStatus(direct, { selected: direct?.selected === true, controllerCapability: device?.has_temperature === true }),
        source: direct?.thermal ? 'device_ssh' : null,
        sourceField: null,
        sampledAt: direct?.lastSuccessAt || null,
        stale: direct?.stale === true
    };
}

function normalizeDevice(device, direct, collectedAt) {
    const id = stableDeviceId(device);
    if (!id) return null;
    const online = onlineState(device.state);
    const radios = normalizeRadios(device);
    const vaps = normalizeVaps(device);
    const cpu = firstNumber(device, [['system-stats', 'cpu'], ['cpu']], { min: 0, max: 100 });
    const uptime = firstNumber(device, [['uptime'], ['system-stats', 'uptime']], { min: 0, max: Number.MAX_SAFE_INTEGER });
    const uplink = device?.uplink && typeof device.uplink === 'object' ? device.uplink : {};
    const linkSpeed = firstNumber(uplink, [['speed'], ['link_speed']], { min: 0, max: 1000000 });
    const clientCount = firstNumber(device, [['num_sta'], ['user-num_sta'], ['client_count']], { min: 0, max: 100000, integer: true });
    const counter = (paths) => firstNumber(device, paths, { min: 0, max: Number.MAX_SAFE_INTEGER })?.value ?? null;
    const temperature = temperatureFor(device, direct, collectedAt);
    return {
        id,
        name: boundedText(device.name || device.model || id, 128),
        model: boundedText(device.model, 64) || null,
        type: boundedText(device.type, 32) || null,
        firmware: boundedText(device.version || device.firmware_version, 64) || null,
        ip: literalIp(device),
        online,
        uptimeSeconds: uptime?.value ?? null,
        uplink: {
            deviceId: boundedText(uplink.uplink_mac || uplink.mac, 128).toLowerCase() || null,
            port: finiteNumber(uplink.uplink_remote_port ?? uplink.port_idx ?? uplink.port, { min: 0, max: 65535, integer: true }),
            state: online && (uplink.up === true || uplink.up === 1 || uplink.up === '1' || String(uplink.state).toLowerCase() === 'up') ? 'up' : 'down',
            speedMbps: linkSpeed?.value ?? null,
            duplex: uplink.full_duplex === true || uplink.full_duplex === 1 || String(uplink.duplex).toLowerCase() === 'full'
                ? 'full'
                : uplink.half_duplex === true || String(uplink.duplex).toLowerCase() === 'half' ? 'half' : null
        },
        traffic: {
            rxBytes: counter([['rx_bytes'], ['bytes-r'], ['uplink', 'rx_bytes']]),
            txBytes: counter([['tx_bytes'], ['bytes-t'], ['uplink', 'tx_bytes']]),
            rxPackets: counter([['rx_packets'], ['uplink', 'rx_packets']]),
            txPackets: counter([['tx_packets'], ['uplink', 'tx_packets']]),
            rxErrors: counter([['rx_errors'], ['uplink', 'rx_errors']]),
            txErrors: counter([['tx_errors'], ['uplink', 'tx_errors']]),
            rxDropped: counter([['rx_dropped'], ['rx_drops'], ['uplink', 'rx_dropped']]),
            txDropped: counter([['tx_dropped'], ['tx_drops'], ['uplink', 'tx_dropped']])
        },
        radios,
        vaps,
        clientCount: clientCount?.value ?? radios.reduce((sum, radio) => sum + (radio.clientCount || 0), 0),
        cpu: cpu ? { value: cpu.value, unit: 'percent', sourceField: cpu.sourceField } : null,
        temperature: {
            value: temperature.value,
            unit: 'celsius',
            status: temperature.status,
            source: temperature.source,
            sourceField: temperature.sourceField,
            sampledAt: temperature.sampledAt,
            stale: temperature.stale
        },
        temperatureZones: temperature.source === 'device_ssh' && Array.isArray(direct?.thermal?.zones)
            ? direct.thermal.zones.slice(0, 32)
            : [],
        hostKeyPinned: direct?.hostKeyPinned === true,
        freshness: {
            collectedAt,
            lastSuccessfulAt: collectedAt,
            stale: false,
            errorReason: direct?.errorReason || null
        }
    };
}

function deviceRichness(device) {
    return (onlineState(device?.state) ? 100 : 0)
        + (literalIp(device) ? 10 : 0)
        + (Array.isArray(device?.radio_table) ? device.radio_table.length : 0)
        + (Array.isArray(device?.vap_table) ? device.vap_table.length : 0)
        + Object.keys(device || {}).length / 1000;
}

function presentUnifiDeviceTelemetry(rawDevices, {
    collectedAt = new Date().toISOString(),
    directThermalByDevice = new Map()
} = {}) {
    const unique = new Map();
    for (const raw of Array.isArray(rawDevices) ? rawDevices : []) {
        const id = stableDeviceId(raw);
        if (!id) continue;
        const current = unique.get(id);
        if (!current || deviceRichness(raw) > deviceRichness(current)) unique.set(id, raw);
    }
    const devices = [...unique.values()].map(raw => {
        const id = stableDeviceId(raw);
        const direct = directThermalByDevice instanceof Map ? directThermalByDevice.get(id) : directThermalByDevice?.[id];
        return normalizeDevice(raw, direct, collectedAt);
    }).filter(Boolean).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return {
        collectedAt,
        lastSuccessfulAt: collectedAt,
        stale: false,
        source: { system: 'unifi_controller', endpoint: '/proxy/network/api/s/default/stat/device' },
        devices
    };
}

function telemetryHistoryRows(snapshot) {
    if (!snapshot || snapshot.stale || !Array.isArray(snapshot.devices)) return [];
    return snapshot.devices.map(device => ({
        collectedAt: snapshot.collectedAt,
        deviceId: device.id,
        name: device.name,
        model: device.model,
        type: device.type,
        online: device.online,
        cpu: device.cpu?.value ?? null,
        temperature: !device.online || device.temperature?.stale ? null : (device.temperature?.value ?? null),
        temperatureStatus: device.temperature?.status || 'unavailable',
        temperatureSource: device.temperature?.source || null,
        clientCount: device.clientCount,
        linkSpeedMbps: device.uplink?.speedMbps ?? null,
        rxBytes: device.traffic?.rxBytes ?? null,
        txBytes: device.traffic?.txBytes ?? null,
        rxErrors: device.traffic?.rxErrors ?? null,
        txErrors: device.traffic?.txErrors ?? null,
        rxDropped: device.traffic?.rxDropped ?? null,
        txDropped: device.traffic?.txDropped ?? null
    }));
}

module.exports = {
    TEMPERATURE_FIELDS,
    TEMPERATURE_STATUSES,
    boundedText,
    findTemperature,
    finiteNumber,
    onlineState,
    presentUnifiDeviceTelemetry,
    stableDeviceId,
    telemetryHistoryRows
};

'use strict';

const THERMAL_ZONE_PATH = '/sys/class/thermal/thermal_zone*/temp';
const CPU_ZONE_TYPE = /(?:cpu|soc|package|processor)/iu;

function cleanText(value, max) {
    return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, max);
}

function parseThermalZones(output, { sampledAt = new Date().toISOString() } = {}) {
    const blocks = String(output || '').split('__ZONE_BEGIN__').slice(1);
    const seen = new Set();
    const zones = [];
    for (const block of blocks) {
        const body = block.split('__ZONE_END__', 1)[0];
        const lines = body.split(/\r?\n/u).map(line => cleanText(line, 256)).filter(Boolean);
        if (lines.length < 3) continue;
        const path = lines[0];
        const zone = cleanText(path.split('/').pop(), 64);
        const type = cleanText(lines[1], 128);
        const raw = lines[2];
        if (!/^thermal_zone\d+$/u.test(zone) || !type || !/^(?:0|[1-9]\d*)$/u.test(raw) || seen.has(zone)) continue;
        const rawMilliCelsius = Number(raw);
        const temperatureC = rawMilliCelsius / 1000;
        if (!Number.isSafeInteger(rawMilliCelsius) || temperatureC < 0 || temperatureC > 150) continue;
        seen.add(zone);
        zones.push({ zone, type, temperatureC, rawMilliCelsius });
    }
    if (!zones.length) return null;
    const maxTemperatureC = Math.max(...zones.map(zone => zone.temperatureC));
    const averageTemperatureC = Number((zones.reduce((sum, zone) => sum + zone.temperatureC, 0) / zones.length).toFixed(3));
    const cpuZones = zones.filter(zone => CPU_ZONE_TYPE.test(zone.type));
    return {
        zones,
        maxTemperatureC,
        averageTemperatureC,
        cpuTemperatureC: cpuZones.length ? Math.max(...cpuZones.map(zone => zone.temperatureC)) : null,
        sampledAt,
        source: { system: 'UniFi device SSH', path: THERMAL_ZONE_PATH, verifiedSource: true }
    };
}

module.exports = { CPU_ZONE_TYPE, THERMAL_ZONE_PATH, cleanText, parseThermalZones };

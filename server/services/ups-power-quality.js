'use strict';

const crypto = require('node:crypto');

const DEFAULT_SAG_THRESHOLD_V = 105;
const DEFAULT_RECOVERY_MARGIN_V = 3;
const PPB_SAG_PATTERN = /\b(power\s+sag|brownout|under[ -]?voltage|low\s+(?:input|utility)\s+voltage|utility\s+voltage\s+abnormal|voltage\s+(?:is\s+)?(?:low|abnormal))\b/i;

function finiteVoltage(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function voltageScale(inputV) {
    return inputV > 180 ? 2 : 1;
}

function createUpsSagDetector({
    thresholdV = DEFAULT_SAG_THRESHOLD_V,
    recoveryMarginV = DEFAULT_RECOVERY_MARGIN_V,
    now = Date.now
} = {}) {
    if (!Number.isFinite(thresholdV) || thresholdV < 80 || thresholdV > 125) {
        throw new TypeError('thresholdV must be between 80 and 125 volts for a 110V reference');
    }
    if (!Number.isFinite(recoveryMarginV) || recoveryMarginV <= 0 || recoveryMarginV > 20) {
        throw new TypeError('recoveryMarginV must be between 0 and 20 volts');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    let active = false;
    let startedAt = null;
    let minimumV = null;

    function observe(sample) {
        const inputV = finiteVoltage(sample?.inputV);
        if (inputV === null || sample?.onBattery === true) return { type: null, active };
        const scale = voltageScale(inputV);
        const threshold = thresholdV * scale;
        const recovery = (thresholdV + recoveryMarginV) * scale;
        const timestamp = now();
        if (!Number.isFinite(timestamp)) throw new TypeError('now() must return a finite timestamp');

        if (!active && inputV < threshold) {
            active = true;
            startedAt = timestamp;
            minimumV = inputV;
            return { type: 'sag_started', active, at: timestamp, inputV, thresholdV: threshold, scale };
        }
        if (active) {
            minimumV = minimumV === null ? inputV : Math.min(minimumV, inputV);
            if (inputV >= recovery) {
                const event = {
                    type: 'sag_recovered', active: false, at: timestamp, inputV,
                    thresholdV: threshold, recoveryV: recovery, minimumV,
                    startedAt, durationMs: Math.max(0, timestamp - startedAt), scale
                };
                active = false;
                startedAt = null;
                minimumV = null;
                return event;
            }
        }
        return { type: null, active, inputV, thresholdV: threshold };
    }

    return Object.freeze({ observe, snapshot: () => ({ active, startedAt, minimumV }) });
}

function normalizePpbTimestamp(value) {
    if (Number.isFinite(Number(value))) {
        const number = Number(value);
        return number < 10_000_000_000 ? number * 1000 : number;
    }
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Date.parse(value.trim().replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizePpbEvent(event, { translate = value => value, observedAt = Date.now() } = {}) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    const rawDescription = String(event.description || event.desc || '').trim().slice(0, 500);
    if (!rawDescription) return null;
    const rawTimestamp = String(event.logTime24H || event.ts || '').trim().slice(0, 100);
    const externalId = event.id === null || event.id === undefined || String(event.id).trim() === ''
        ? crypto.createHash('sha256').update(`${rawTimestamp}\n${rawDescription}`).digest('hex')
        : String(event.id).trim().slice(0, 200);
    const description = String(translate(rawDescription) || rawDescription).slice(0, 500);
    const sag = PPB_SAG_PATTERN.test(rawDescription);
    const recovery = /resumed|restored|normal|recover/i.test(rawDescription);
    return {
        source: 'ppb', externalId,
        type: sag ? 'voltage_sag' : recovery ? 'power_recovered' : 'ppb_event',
        eventTs: normalizePpbTimestamp(event.logTime24H || event.ts),
        observedTs: observedAt,
        inputV: null,
        description,
        severity: sag || /failure|lost|fault/i.test(rawDescription) ? 'warning'
            : /test/i.test(rawDescription) ? 'test' : recovery ? 'ok' : 'info',
        sag
    };
}

module.exports = {
    DEFAULT_RECOVERY_MARGIN_V,
    DEFAULT_SAG_THRESHOLD_V,
    PPB_SAG_PATTERN,
    createUpsSagDetector,
    normalizePpbEvent,
    normalizePpbTimestamp
};

'use strict';

const UPS_SOURCES = Object.freeze(['ppb', 'nut', 'pwrstat', 'pmset']);

function normalizeSource(value = 'auto') {
    const source = String(value || 'auto').trim().toLowerCase();
    if (source !== 'auto' && !UPS_SOURCES.includes(source)) {
        throw new Error(`UPS_SOURCE must be auto or one of: ${UPS_SOURCES.join(', ')}`);
    }
    return source;
}

function parseBoolean(value, field) {
    if (value === undefined || value === null || value === '') return false;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new Error(`${field} must be true or false`);
}

function resolveUpsSourceConfig({ source = 'auto', allowFallback = false } = {}) {
    const configuredSource = normalizeSource(source);
    const explicitFallback = parseBoolean(allowFallback, 'UPS_ALLOW_FALLBACK');
    return Object.freeze({
        configuredSource,
        fallbackAllowed: configuredSource === 'auto' || explicitFallback
    });
}

function failureReason(source, error) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    if (/auth|permission/.test(`${code} ${message}`)) return `${source}_authentication_failed`;
    if (/timeout|timed out/.test(`${code} ${message}`)) return `${source}_timeout`;
    return `${source}_unreachable`;
}

async function selectUpsSource({ configuredSource = 'auto', allowFallback = false, readers = {}, onAttempt } = {}) {
    const config = resolveUpsSourceConfig({ source: configuredSource, allowFallback });
    const candidates = config.configuredSource === 'auto'
        ? [...UPS_SOURCES]
        : config.fallbackAllowed
            ? [config.configuredSource, ...UPS_SOURCES.filter(source => source !== config.configuredSource)]
            : [config.configuredSource];
    const failures = [];

    for (const source of candidates) {
        const reader = readers[source];
        if (typeof reader !== 'function') {
            const reason = `${source}_unavailable`;
            failures.push(reason);
            onAttempt?.({ source, ok: false, reason });
            continue;
        }
        try {
            const data = await reader();
            if (data) {
                // A fallback is only used after an earlier candidate failed.
                // Comparing the actual source with `configuredSource` marks
                // the normal `auto -> ppb` case as a fallback even though no
                // alternate candidate was needed.
                const fallbackUsed = failures.length > 0;
                const fallbackReason = fallbackUsed ? failures[0] : null;
                const selection = {
                    data: {
                        ...data,
                        configuredSource: config.configuredSource,
                        actualSource: source,
                        fallbackAllowed: config.fallbackAllowed,
                        fallbackUsed,
                        fallbackReason
                    },
                    configuredSource: config.configuredSource,
                    actualSource: source,
                    fallbackAllowed: config.fallbackAllowed,
                    fallbackUsed,
                    fallbackReason,
                    failureReason: null,
                    failures
                };
                onAttempt?.({ source, ok: true, reason: null });
                return selection;
            }
            const reason = `${source}_unreachable`;
            failures.push(reason);
            onAttempt?.({ source, ok: false, reason });
        } catch (error) {
            const reason = failureReason(source, error);
            failures.push(reason);
            onAttempt?.({ source, ok: false, reason, error });
        }
    }

    return {
        data: null,
        configuredSource: config.configuredSource,
        actualSource: null,
        fallbackAllowed: config.fallbackAllowed,
        fallbackUsed: false,
        fallbackReason: failures[0] || `${config.configuredSource}_unreachable`,
        failureReason: failures.join(',') || `${config.configuredSource}_unreachable`,
        failures
    };
}

module.exports = {
    UPS_SOURCES,
    failureReason,
    normalizeSource,
    resolveUpsSourceConfig,
    selectUpsSource
};

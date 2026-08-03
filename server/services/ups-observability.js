'use strict';

function normalizeCooldown(value) {
    if (!Number.isFinite(value) || value < 1) throw new TypeError('cooldownMs must be positive');
    return value;
}

function createUpsObservability({ cooldownMs = 300000 } = {}) {
    const cooldown = normalizeCooldown(cooldownMs);
    let previousHealth = 'unknown';
    let failureIncident = null;
    let fallbackIncident = null;

    function event(level, kind, message, fields = {}) {
        return { level, kind, message, fields };
    }

    function observe({
        ok = false,
        fetchHealth = 'unknown',
        failureMessage = 'UPS monitoring sources are unavailable',
        failureReason = null,
        selection = null,
        now = Date.now()
    } = {}) {
        if (!Number.isFinite(now)) throw new TypeError('now must be finite');
        const events = [];
        if (ok) {
            if (failureIncident) {
                events.push(event('info', 'recovered', 'UPS monitoring source recovered', {
                    incident_ms: Math.max(0, now - failureIncident.startedAt),
                    previous_failure: failureIncident.key
                }));
                failureIncident = null;
            }
            if (fallbackIncident && selection?.fallbackUsed !== true) {
                events.push(event('info', 'fallback_ended', 'UPS fallback ended; configured source recovered', {
                    configured_source: selection?.configuredSource || fallbackIncident.configuredSource,
                    actual_source: selection?.actualSource || null
                }));
                fallbackIncident = null;
            } else if (selection?.fallbackUsed === true) {
                const key = [selection.configuredSource, selection.actualSource, selection.fallbackReason].join('|');
                if (!fallbackIncident || fallbackIncident.key !== key) {
                    fallbackIncident = {
                        key,
                        configuredSource: selection.configuredSource,
                        startedAt: now
                    };
                    events.push(event('warning', 'fallback_entered', 'UPS fallback source selected', {
                        configured_source: selection.configuredSource,
                        actual_source: selection.actualSource,
                        fallback_reason: selection.fallbackReason
                    }));
                }
            }
            previousHealth = 'healthy';
            return events;
        }

        const health = String(fetchHealth || 'unknown');
        const key = String(failureMessage || failureReason || 'UPS monitoring sources are unavailable');
        if (!failureIncident || failureIncident.key !== key) {
            failureIncident = { key, startedAt: now, lastSummaryAt: now };
            events.push(event('warning', 'degraded', failureMessage, {
                fetch_health: health,
                failure_reason: failureReason
            }));
        } else if (health === 'offline' && previousHealth !== 'offline') {
            events.push(event('error', 'offline', 'UPS monitoring sources are confirmed offline', {
                failure_reason: failureReason
            }));
            failureIncident.lastSummaryAt = now;
        } else if (now - failureIncident.lastSummaryAt >= cooldown) {
            events.push(event('warning', 'summary', 'UPS monitoring failure persists', {
                fetch_health: health,
                failure_reason: failureReason,
                cooldown_ms: cooldown
            }));
            failureIncident.lastSummaryAt = now;
        }
        previousHealth = health;
        return events;
    }

    return Object.freeze({ observe });
}

module.exports = { createUpsObservability };

'use strict';

function operationalDependency({ configured, lastSuccessAt = null, lastFailureAt = null, consecutiveFailures = 0, staleAfterMs = 180_000, detail = null, now = Date.now() }) {
    const successTs = typeof lastSuccessAt === 'number' ? lastSuccessAt : Date.parse(lastSuccessAt || '');
    const staleAge = Number.isFinite(successTs) ? Math.max(0, now - successTs) : null;
    const status = !configured ? 'not_configured'
        : !Number.isFinite(successTs) ? (consecutiveFailures ? 'degraded' : 'unknown')
            : consecutiveFailures > 0 ? (consecutiveFailures > 2 ? 'critical' : 'degraded')
                : staleAge > staleAfterMs ? 'degraded' : 'healthy';
    return {
        configured: Boolean(configured),
        status,
        detail,
        last_success_at: Number.isFinite(successTs) ? new Date(successTs).toISOString() : null,
        last_failure_at: lastFailureAt ? new Date(typeof lastFailureAt === 'number' ? lastFailureAt : Date.parse(lastFailureAt)).toISOString() : null,
        stale_age_ms: staleAge,
        consecutive_failures: Math.max(0, Number(consecutiveFailures) || 0)
    };
}

module.exports = { operationalDependency };

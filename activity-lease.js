'use strict';

const DEFAULT_SCOPES = ['general', 'trend', 'ucg', 'nas', 'wiim', 'linux', 'ups'];

// A short server-timed lease prevents a stale browser tab from keeping device
// polling fast forever. Client clocks are never trusted.
function createActivityLease({ scopes = DEFAULT_SCOPES, maxLeaseMs = 180000, now = () => Date.now() } = {}) {
    const allowed = new Set(scopes);
    // Each browser tab owns its own set of leases.  Releasing one hidden tab
    // must not make another visible tab look idle.
    const sessions = new Map();

    function duration(requestedMs) {
        const requested = Number(requestedMs);
        const safeRequested = Number.isFinite(requested) ? requested : maxLeaseMs;
        return Math.min(Math.max(safeRequested, 1000), maxLeaseMs);
    }

    function prune(nowMs = now()) {
        for (const [sessionId, leases] of sessions) {
            for (const [scope, expiresAt] of leases) {
                if (expiresAt <= nowMs) leases.delete(scope);
            }
            if (leases.size === 0) sessions.delete(sessionId);
        }
    }

    function mark(scopeList, requestedMs, { replace = false, sessionId = 'legacy' } = {}) {
        const nowMs = now();
        prune(nowMs);
        const expiresAt = nowMs + duration(requestedMs);
        const requested = String(scopeList || '').split(',').map(scope => scope.trim()).filter(Boolean);
        const accepted = [...new Set(requested.filter(scope => allowed.has(scope)))];
        // Distinguish a newly opened/returned page from its regular heartbeat.
        // The caller can use this to take one prompt sample without letting every
        // five-second heartbeat continually reset its sampling interval.
        const activated = accepted.filter(scope => !isActive(scope));
        const key = String(sessionId || 'legacy');
        if (replace) sessions.delete(key);
        if (accepted.length) {
            const leases = sessions.get(key) || new Map();
            accepted.forEach(scope => leases.set(scope, expiresAt));
            sessions.set(key, leases);
        }
        return { accepted, activated, expiresAt };
    }

    function isActive(scope) {
        if (!allowed.has(scope)) return false;
        const nowMs = now();
        prune(nowMs);
        return [...sessions.values()].some(leases => (leases.get(scope) || 0) > nowMs);
    }

    function activeScopes() {
        prune();
        return [...allowed].filter(isActive);
    }

    return { mark, isActive, activeScopes, prune, sessionCount: () => { prune(); return sessions.size; }, maxLeaseMs };
}

module.exports = { createActivityLease, DEFAULT_SCOPES };

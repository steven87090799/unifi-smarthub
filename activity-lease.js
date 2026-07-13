'use strict';

const DEFAULT_SCOPES = ['trend', 'nas', 'wiim', 'linux'];

// A short server-timed lease prevents a stale browser tab from keeping device
// polling fast forever. Client clocks are never trusted.
function createActivityLease({ scopes = DEFAULT_SCOPES, maxLeaseMs = 180000, now = () => Date.now() } = {}) {
    const allowed = new Set(scopes);
    const leases = new Map();

    function duration(requestedMs) {
        const requested = Number(requestedMs);
        const safeRequested = Number.isFinite(requested) ? requested : maxLeaseMs;
        return Math.min(Math.max(safeRequested, 1000), maxLeaseMs);
    }

    function mark(scopeList, requestedMs) {
        const expiresAt = now() + duration(requestedMs);
        const requested = String(scopeList || '').split(',').map(scope => scope.trim()).filter(Boolean);
        const accepted = [...new Set(requested.filter(scope => allowed.has(scope)))];
        accepted.forEach(scope => leases.set(scope, expiresAt));
        return { accepted, expiresAt };
    }

    function isActive(scope) {
        return allowed.has(scope) && (leases.get(scope) || 0) > now();
    }

    function activeScopes() {
        return [...allowed].filter(isActive);
    }

    return { mark, isActive, activeScopes, maxLeaseMs };
}

module.exports = { createActivityLease, DEFAULT_SCOPES };

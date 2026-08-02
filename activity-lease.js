'use strict';

const DEFAULT_SCOPES = ['general', 'trend', 'ucg', 'unifi-device-telemetry', 'nas', 'wiim', 'linux', 'ups'];

// A short server-timed lease prevents a stale browser tab from keeping device
// polling fast forever. Client clocks are never trusted.
function createActivityLease({
    scopes = DEFAULT_SCOPES,
    maxLeaseMs = 180000,
    maxSessions = 1000,
    maxScopesPerSession = 8,
    now = () => Date.now()
} = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
        throw new TypeError('maxSessions must be a positive integer');
    }
    if (!Number.isSafeInteger(maxScopesPerSession) || maxScopesPerSession <= 0) {
        throw new TypeError('maxScopesPerSession must be a positive integer');
    }
    const allowed = new Set(scopes);
    // Each browser tab owns its own set of leases.  Releasing one hidden tab
    // must not make another visible tab look idle.
    const sessions = new Map();
    const lastSequences = new Map();
    let evictions = 0;
    let expiredSessionsRemoved = 0;

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
            if (leases.size === 0) {
                sessions.delete(sessionId);
                lastSequences.delete(sessionId);
                expiredSessionsRemoved += 1;
            }
        }
    }

    function refreshSession(key, leases) {
        sessions.delete(key);
        sessions.set(key, leases);
    }

    function ensureCapacity(key) {
        if (sessions.has(key) || sessions.size < maxSessions) return;
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) return;
        sessions.delete(oldest);
        lastSequences.delete(oldest);
        evictions += 1;
    }

    function mark(scopeList, requestedMs, { replace = false, sessionId = 'legacy', sequence = 0 } = {}) {
        const nowMs = now();
        prune(nowMs);
        const key = String(sessionId || 'legacy');
        const candidateSequence = Number(sequence);
        const sequenced = Number.isSafeInteger(candidateSequence) && candidateSequence > 0;
        const lastSequence = lastSequences.get(key) || 0;
        if (sequenced && candidateSequence <= lastSequence) {
            const leases = sessions.get(key);
            return {
                accepted: [],
                activated: [],
                expiresAt: leases ? Math.max(...leases.values(), nowMs) : nowMs,
                stale: true,
                sequence: lastSequence
            };
        }
        if (sequenced) {
            lastSequences.delete(key);
            lastSequences.set(key, candidateSequence);
            while (lastSequences.size > maxSessions) lastSequences.delete(lastSequences.keys().next().value);
        }
        const expiresAt = nowMs + duration(requestedMs);
        const requested = String(scopeList || '').split(',').map(scope => scope.trim()).filter(Boolean);
        const accepted = [...new Set(requested.filter(scope => allowed.has(scope)))]
            .slice(0, maxScopesPerSession);
        // Distinguish a newly opened/returned page from its regular heartbeat.
        // The caller can use this to take one prompt sample without letting every
        // five-second heartbeat continually reset its sampling interval.
        const activated = accepted.filter(scope => !isActive(scope));
        if (replace) sessions.delete(key);
        if (accepted.length) {
            const leases = sessions.get(key) || new Map();
            accepted.forEach(scope => leases.set(scope, expiresAt));
            while (leases.size > maxScopesPerSession) leases.delete(leases.keys().next().value);
            ensureCapacity(key);
            refreshSession(key, leases);
        }
        return { accepted, activated, expiresAt, stale: false, sequence: sequenced ? candidateSequence : lastSequence };
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

    function snapshot() {
        prune();
        return {
            sessionCount: sessions.size,
            activeScopes: activeScopes(),
            evictions,
            maxSessions,
            expiredSessionsRemoved
        };
    }

    return {
        mark,
        isActive,
        activeScopes,
        prune,
        snapshot,
        sessionCount: () => {
            prune();
            return sessions.size;
        },
        maxLeaseMs,
        maxSessions,
        maxScopesPerSession
    };
}

module.exports = { createActivityLease, DEFAULT_SCOPES };

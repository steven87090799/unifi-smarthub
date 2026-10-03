'use strict';

// Cache expiry is a scheduling hint, never evidence of a failed connection.
// null means there is not enough evidence to change the previous alert state.
function connectionObservation(snapshot, intervalMs, now = Date.now()) {
    if (!snapshot) return null;
    const success = Number(snapshot.lastSuccessAt);
    const failures = Number(snapshot.consecutiveFailures || 0);
    if (failures >= 2) return false;
    if (failures > 0 || snapshot.lastErrorAt != null) return null;
    if (snapshot.lastSuccessAt == null || !Number.isFinite(success)) return null;
    if (now - success > Math.max(180000, intervalMs * 3)) return null;
    return true;
}
module.exports = { connectionObservation };

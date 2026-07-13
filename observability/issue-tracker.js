'use strict';

class IssueTracker {
    constructor({ cooldownSeconds = 300, maxResolved = 20 } = {}) {
        this.cooldownMs = Math.max(Number(cooldownSeconds) || 300, 1) * 1000;
        this.maxResolved = maxResolved;
        this.active = new Map();
        this.resolved = [];
    }

    report(input, now = Date.now()) {
        const key = input.id || input.code;
        const existing = this.active.get(key);
        if (existing) {
            existing.last_seen = new Date(now).toISOString();
            existing.occurrences += 1;
            existing.severity = input.severity || existing.severity;
            existing.message = input.message || existing.message;
            existing.details = input.details || existing.details;
            const shouldLog = now - existing.last_logged_at >= this.cooldownMs;
            if (shouldLog) existing.last_logged_at = now;
            return { issue: { ...existing }, shouldLog, isNew: false };
        }
        const issue = {
            id: key,
            severity: input.severity || 'warning',
            code: input.code,
            message: input.message,
            details: input.details || {},
            first_seen: new Date(now).toISOString(),
            last_seen: new Date(now).toISOString(),
            occurrences: 1,
            last_logged_at: now
        };
        this.active.set(key, issue);
        return { issue: { ...issue }, shouldLog: true, isNew: true };
    }

    resolve(key, now = Date.now()) {
        const issue = this.active.get(key);
        if (!issue) return null;
        this.active.delete(key);
        const resolvedAt = new Date(now).toISOString();
        const resolved = {
            ...issue,
            status: 'resolved',
            resolved_at: resolvedAt,
            duration_seconds: Math.max(0, Math.round((now - Date.parse(issue.first_seen)) / 1000))
        };
        delete resolved.last_logged_at;
        this.resolved.unshift(resolved);
        this.resolved = this.resolved.slice(0, this.maxResolved);
        return { ...resolved };
    }

    listActive() {
        return [...this.active.values()].map(issue => {
            const copy = { ...issue };
            delete copy.last_logged_at;
            return copy;
        }).sort((a, b) => {
            const rank = { critical: 2, warning: 1 };
            return (rank[b.severity] || 0) - (rank[a.severity] || 0) || Date.parse(a.first_seen) - Date.parse(b.first_seen);
        });
    }

    listResolved() { return this.resolved.map(issue => ({ ...issue })); }
}

module.exports = { IssueTracker };

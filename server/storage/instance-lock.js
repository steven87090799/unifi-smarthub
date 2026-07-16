'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const LOCK_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 4096;
const DEFAULT_INVALID_GRACE_MS = 5000;
const DEFAULT_LEASE_MS = 8000;
const DEFAULT_HEARTBEAT_MS = 2000;
const OWNED_LOCKS = new Map();
const SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid > 0),
    token TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    runtime_id TEXT NOT NULL DEFAULT '',
    lease_expires_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

class InstanceLockError extends Error {
    constructor(code, message, lockFile, options = {}) {
        super(`${code}: ${message}`, options.cause ? { cause: options.cause } : undefined);
        this.name = 'InstanceLockError';
        this.code = code;
        this.lockFile = lockFile;
        if (options.ownerPid) this.ownerPid = options.ownerPid;
    }
}

function lockError(code, message, lockFile, cause, ownerPid) {
    if (cause instanceof InstanceLockError) return cause;
    return new InstanceLockError(code, message, lockFile, { cause, ownerPid });
}

function resolvedLockFile(lockFile) {
    if (typeof lockFile !== 'string' || !lockFile.trim()) {
        throw new InstanceLockError('INSTANCE_LOCK_PATH_INVALID', 'lock path must be a non-empty string', '');
    }
    return path.resolve(lockFile);
}

function parseLegacyOwner(content) {
    const match = /^([1-9]\d{0,9})\n?$/.exec(content);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) ? pid : null;
}

function canonicalRuntimeId(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError('instance lock runtime identity must be a bounded non-empty string');
    }
    return crypto.createHash('sha256').update(value).digest('hex');
}

function ownerIsAlive(owner, lockFile, timestamp) {
    const locallyOwned = OWNED_LOCKS.get(lockFile);
    if (locallyOwned && locallyOwned.token === owner.token) return true;
    if (!Number.isSafeInteger(owner.leaseExpiresAt) || owner.leaseExpiresAt < 0) {
        throw new InstanceLockError(
            'INSTANCE_LOCK_OWNER_INVALID',
            'existing owner lease metadata is invalid',
            lockFile,
            { ownerPid: owner.pid }
        );
    }
    return owner.leaseExpiresAt > timestamp;
}

function inspectLegacyLock({ legacyLockFile, currentPid, kill, now, invalidGraceMs }) {
    if (!legacyLockFile) return;
    const absolutePath = path.resolve(legacyLockFile);
    let stat;
    try { stat = fs.lstatSync(absolutePath); }
    catch (error) {
        if (error?.code === 'ENOENT') return;
        throw lockError('INSTANCE_LOCK_LEGACY_READ_FAILED', 'legacy lock could not be inspected', absolutePath, error);
    }
    if (!stat.isFile()) {
        throw new InstanceLockError('INSTANCE_LOCK_NOT_REGULAR', 'legacy lock path must be a regular file', absolutePath);
    }
    if (stat.size > MAX_LOCK_BYTES) {
        throw new InstanceLockError('INSTANCE_LOCK_INVALID', 'legacy lock exceeds its bounded size', absolutePath);
    }
    let content;
    try { content = fs.readFileSync(absolutePath, 'utf8'); }
    catch (error) { throw lockError('INSTANCE_LOCK_LEGACY_READ_FAILED', 'legacy lock could not be read', absolutePath, error); }
    const pid = parseLegacyOwner(content);
    if (pid && pid !== currentPid) {
        try {
            kill(pid, 0);
            throw new InstanceLockError(
                'INSTANCE_LOCK_HELD',
                'a legacy owner is still using this data directory',
                absolutePath,
                { ownerPid: pid }
            );
        } catch (error) {
            if (error instanceof InstanceLockError) throw error;
            if (error?.code === 'EPERM') {
                throw new InstanceLockError(
                    'INSTANCE_LOCK_HELD',
                    'a legacy owner is still using this data directory',
                    absolutePath,
                    { ownerPid: pid }
                );
            }
            if (error?.code !== 'ESRCH') {
                throw lockError('INSTANCE_LOCK_LIVENESS_UNKNOWN', 'legacy owner liveness could not be determined', absolutePath, error, pid);
            }
        }
    } else if (!pid && Math.max(0, now() - stat.mtimeMs) < invalidGraceMs) {
        throw new InstanceLockError(
            'INSTANCE_LOCK_INITIALIZING',
            'legacy owner metadata is incomplete or was created recently',
            absolutePath
        );
    }
    try { fs.unlinkSync(absolutePath); }
    catch (error) { if (error?.code !== 'ENOENT') throw lockError('INSTANCE_LOCK_LEGACY_REMOVE_FAILED', 'stale legacy lock could not be removed', absolutePath, error); }
}

function openLockDatabase(lockFile) {
    let database;
    try {
        database = new Database(lockFile);
        fs.chmodSync(lockFile, LOCK_FILE_MODE);
        database.pragma('busy_timeout = 5000');
        database.pragma('journal_mode = DELETE');
        database.pragma('synchronous = FULL');
        database.exec(SCHEMA);
        const columns = new Set(database.pragma('table_info(instance_owner)').map(column => column.name));
        if (!columns.has('runtime_id')) database.exec("ALTER TABLE instance_owner ADD COLUMN runtime_id TEXT NOT NULL DEFAULT ''");
        if (!columns.has('lease_expires_at')) database.exec('ALTER TABLE instance_owner ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0');
        return database;
    } catch (error) {
        try { database?.close(); } catch { }
        throw lockError('INSTANCE_LOCK_DB_FAILED', 'lock database could not be opened or initialized', lockFile, error);
    }
}

function acquireInstanceLock(options = {}) {
    const currentPid = options.pid ?? process.pid;
    const kill = options.kill || process.kill.bind(process);
    const now = options.now || Date.now;
    const invalidGraceMs = Number.isSafeInteger(options.invalidGraceMs) && options.invalidGraceMs >= 0
        ? options.invalidGraceMs
        : DEFAULT_INVALID_GRACE_MS;
    const leaseMs = Number.isSafeInteger(options.leaseMs) && options.leaseMs >= 4000
        ? options.leaseMs
        : DEFAULT_LEASE_MS;
    const heartbeatMs = Number.isSafeInteger(options.heartbeatMs) && options.heartbeatMs > 0 && options.heartbeatMs < leaseMs
        ? options.heartbeatMs
        : DEFAULT_HEARTBEAT_MS;
    if (!Number.isSafeInteger(currentPid) || currentPid <= 0) throw new TypeError('instance lock PID must be a positive safe integer');
    const lockFile = resolvedLockFile(options.lockFile);
    const token = crypto.randomUUID();
    const runtimeId = canonicalRuntimeId(options.runtimeId || process.env.HOSTNAME || os.hostname());
    const acquiredAtMs = now();
    if (!Number.isSafeInteger(acquiredAtMs) || acquiredAtMs < 0) throw new TypeError('instance lock clock must return a non-negative safe integer');
    const owner = Object.freeze({ pid: currentPid, token, runtimeId, acquiredAt: new Date(acquiredAtMs).toISOString() });
    const ownerRecord = { ...owner, leaseExpiresAt: acquiredAtMs + leaseMs };
    const database = openLockDatabase(lockFile);
    const selectOwner = database.prepare(`
        SELECT pid, token, acquired_at AS acquiredAt, runtime_id AS runtimeId, lease_expires_at AS leaseExpiresAt
        FROM instance_owner WHERE singleton = 1
    `);
    const replaceOwner = database.prepare(`
        INSERT INTO instance_owner(singleton, pid, token, acquired_at, runtime_id, lease_expires_at)
        VALUES (1, @pid, @token, @acquiredAt, @runtimeId, @leaseExpiresAt)
        ON CONFLICT(singleton) DO UPDATE SET
            pid = excluded.pid,
            token = excluded.token,
            acquired_at = excluded.acquired_at,
            runtime_id = excluded.runtime_id,
            lease_expires_at = excluded.lease_expires_at
    `);
    const renewOwned = database.prepare(`
        UPDATE instance_owner SET lease_expires_at = MAX(lease_expires_at, ?)
        WHERE singleton = 1 AND pid = ? AND token = ? AND runtime_id = ?
    `);
    const deleteOwned = database.prepare('DELETE FROM instance_owner WHERE singleton = 1 AND pid = ? AND token = ? AND runtime_id = ?');

    try {
        database.transaction(() => {
            const existing = selectOwner.get();
            if (existing && ownerIsAlive(existing, lockFile, acquiredAtMs)) {
                throw new InstanceLockError(
                    'INSTANCE_LOCK_HELD',
                    'another process already owns this data directory',
                    lockFile,
                    { ownerPid: existing.pid }
                );
            }
            replaceOwner.run(ownerRecord);
        }).immediate();
        OWNED_LOCKS.set(lockFile, owner);
        try {
            inspectLegacyLock({
                legacyLockFile: options.legacyLockFile,
                currentPid,
                kill,
                now,
                invalidGraceMs
            });
        } catch (error) {
            database.transaction(() => deleteOwned.run(currentPid, token, runtimeId)).immediate();
            OWNED_LOCKS.delete(lockFile);
            throw error;
        }
    } catch (error) {
        try { database.close(); } catch { }
        if (error instanceof InstanceLockError) throw error;
        throw lockError('INSTANCE_LOCK_DB_FAILED', 'transactional lock acquisition failed', lockFile, error);
    }

    let released = false;
    return Object.freeze({
        heartbeatMs,
        leaseMs,
        lockFile,
        owner,
        renew() {
            if (released) return false;
            const timestamp = now();
            if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('instance lock clock must return a non-negative safe integer');
            return database.transaction(() => renewOwned.run(timestamp + leaseMs, currentPid, token, runtimeId).changes === 1).immediate();
        },
        release() {
            if (released) return false;
            released = true;
            OWNED_LOCKS.delete(lockFile);
            let removed = false;
            try { removed = database.transaction(() => deleteOwned.run(currentPid, token, runtimeId).changes === 1).immediate(); }
            catch { removed = false; }
            try { database.close(); } catch { }
            return removed;
        }
    });
}

module.exports = {
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_INVALID_GRACE_MS,
    DEFAULT_LEASE_MS,
    LOCK_FILE_MODE,
    MAX_LOCK_BYTES,
    InstanceLockError,
    acquireInstanceLock,
    canonicalRuntimeId,
    parseLegacyOwner
};

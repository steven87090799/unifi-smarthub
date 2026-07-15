'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const LOCK_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 4096;
const DEFAULT_INVALID_GRACE_MS = 5000;
const OWNED_LOCKS = new Map();
const SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid > 0),
    token TEXT NOT NULL,
    acquired_at TEXT NOT NULL
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

function ownerIsAlive(owner, lockFile, currentPid, kill) {
    const locallyOwned = OWNED_LOCKS.get(lockFile);
    if (owner.pid === currentPid) return Boolean(locallyOwned && locallyOwned.token === owner.token);
    try {
        kill(owner.pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        if (error?.code === 'EPERM') return true;
        throw lockError('INSTANCE_LOCK_LIVENESS_UNKNOWN', 'existing owner liveness could not be determined', lockFile, error, owner.pid);
    }
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
    if (!Number.isSafeInteger(currentPid) || currentPid <= 0) throw new TypeError('instance lock PID must be a positive safe integer');
    const lockFile = resolvedLockFile(options.lockFile);
    const token = crypto.randomUUID();
    const owner = Object.freeze({ pid: currentPid, token, acquiredAt: new Date(now()).toISOString() });
    const database = openLockDatabase(lockFile);
    const selectOwner = database.prepare('SELECT pid, token, acquired_at AS acquiredAt FROM instance_owner WHERE singleton = 1');
    const replaceOwner = database.prepare(`
        INSERT INTO instance_owner(singleton, pid, token, acquired_at)
        VALUES (1, @pid, @token, @acquiredAt)
        ON CONFLICT(singleton) DO UPDATE SET
            pid = excluded.pid,
            token = excluded.token,
            acquired_at = excluded.acquired_at
    `);
    const deleteOwned = database.prepare('DELETE FROM instance_owner WHERE singleton = 1 AND pid = ? AND token = ?');

    try {
        database.transaction(() => {
            const existing = selectOwner.get();
            if (existing && ownerIsAlive(existing, lockFile, currentPid, kill)) {
                throw new InstanceLockError(
                    'INSTANCE_LOCK_HELD',
                    'another process already owns this data directory',
                    lockFile,
                    { ownerPid: existing.pid }
                );
            }
            replaceOwner.run(owner);
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
            database.transaction(() => deleteOwned.run(currentPid, token)).immediate();
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
        lockFile,
        owner,
        release() {
            if (released) return false;
            released = true;
            OWNED_LOCKS.delete(lockFile);
            let removed = false;
            try { removed = database.transaction(() => deleteOwned.run(currentPid, token).changes === 1).immediate(); }
            catch { removed = false; }
            try { database.close(); } catch { }
            return removed;
        }
    });
}

module.exports = {
    DEFAULT_INVALID_GRACE_MS,
    LOCK_FILE_MODE,
    MAX_LOCK_BYTES,
    InstanceLockError,
    acquireInstanceLock,
    parseLegacyOwner
};

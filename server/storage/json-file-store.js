'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const JSON_FILE_MODE = 0o600;
const MAX_JSON_FILE_BYTES = 1024 * 1024;
const DIRECTORY_FSYNC_UNSUPPORTED = new Set([
    'EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'
]);

class JsonFileError extends Error {
    constructor(code, message, filePath, cause) {
        super(`${code}: ${message}`, cause ? { cause } : undefined);
        this.name = 'JsonFileError';
        this.code = code;
        this.filePath = filePath;
    }
}

function jsonFileError(code, message, filePath, cause) {
    if (cause instanceof JsonFileError) return cause;
    return new JsonFileError(code, message, filePath, cause);
}

function resolvedJsonFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new JsonFileError('JSON_FILE_PATH_INVALID', 'JSON file path must be a non-empty string', '');
    }
    return path.resolve(filePath);
}

function assertPlainObject(value, field = 'JSON value') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${field} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${field} must be a plain object`);
    }
    return value;
}

function readJsonObjectFile(filePath, options = {}) {
    const fsImpl = options.fs || fs;
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : MAX_JSON_FILE_BYTES;
    const absolutePath = resolvedJsonFile(filePath);
    let stat;
    try { stat = fsImpl.lstatSync(absolutePath); }
    catch (error) { throw jsonFileError('JSON_FILE_UNAVAILABLE', 'JSON file could not be inspected', absolutePath, error); }
    if (!stat.isFile()) {
        throw new JsonFileError('JSON_FILE_NOT_REGULAR', 'JSON file must be a regular file', absolutePath);
    }
    if ((stat.mode & 0o777) !== JSON_FILE_MODE) {
        try { fsImpl.chmodSync(absolutePath, JSON_FILE_MODE); }
        catch (error) { throw jsonFileError('JSON_FILE_MODE_INVALID', 'JSON file mode could not be normalized', absolutePath, error); }
    }
    if (stat.size === 0) throw new JsonFileError('JSON_FILE_EMPTY', 'JSON file must not be empty', absolutePath);
    if (stat.size > maxBytes) {
        throw new JsonFileError('JSON_FILE_TOO_LARGE', `JSON file must not exceed ${maxBytes} bytes`, absolutePath);
    }
    let parsed;
    try { parsed = JSON.parse(fsImpl.readFileSync(absolutePath, 'utf8')); }
    catch (error) { throw jsonFileError('JSON_FILE_INVALID', 'JSON file is not valid JSON', absolutePath, error); }
    try { return assertPlainObject(parsed, 'JSON file root'); }
    catch (error) { throw jsonFileError('JSON_FILE_INVALID', error.message, absolutePath, error); }
}

function writeAll(fsImpl, descriptor, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
        const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (!Number.isInteger(written) || written <= 0) {
            const error = new Error('JSON temporary write made no progress');
            error.code = 'EIO';
            throw error;
        }
        offset += written;
    }
}

function fsyncParentDirectory(fsImpl, directory) {
    let descriptor;
    try {
        descriptor = fsImpl.openSync(directory, 'r');
        fsImpl.fsyncSync(descriptor);
    } catch (error) {
        if (!DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fsImpl.closeSync(descriptor); } catch { }
        }
    }
}

function writeJsonObjectAtomically(filePath, value, options = {}) {
    assertPlainObject(value);
    const fsImpl = options.fs || fs;
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : MAX_JSON_FILE_BYTES;
    const absolutePath = resolvedJsonFile(filePath);
    let serialized;
    try {
        const json = JSON.stringify(value, null, 2);
        if (typeof json !== 'string') throw new TypeError('JSON value did not serialize to text');
        serialized = `${json}\n`;
    }
    catch (error) { throw jsonFileError('JSON_FILE_SERIALIZE_FAILED', 'JSON value could not be serialized', absolutePath, error); }
    const bytes = Buffer.from(serialized, 'utf8');
    if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new JsonFileError('JSON_FILE_TOO_LARGE', `JSON replacement must not exceed ${maxBytes} bytes`, absolutePath);
    }

    const directory = path.dirname(absolutePath);
    const basename = path.basename(absolutePath);
    let temporaryPath;
    let descriptor;
    let stage = 'create';
    try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            temporaryPath = path.join(directory, `.${basename}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
            try {
                descriptor = fsImpl.openSync(temporaryPath, 'wx', JSON_FILE_MODE);
                break;
            } catch (error) {
                if (error?.code !== 'EEXIST' || attempt === 4) throw error;
            }
        }
        stage = 'write';
        fsImpl.fchmodSync(descriptor, JSON_FILE_MODE);
        writeAll(fsImpl, descriptor, bytes);
        fsImpl.fsyncSync(descriptor);
        fsImpl.closeSync(descriptor);
        descriptor = undefined;

        stage = 'rename';
        fsImpl.renameSync(temporaryPath, absolutePath);
        temporaryPath = undefined;

        stage = 'directory_fsync';
        fsyncParentDirectory(fsImpl, directory);
        return { committed: true, durable: true, bytes: bytes.length };
    } catch (error) {
        if (stage === 'directory_fsync') {
            const committedError = jsonFileError(
                'JSON_FILE_DIRECTORY_SYNC_FAILED',
                'JSON replacement is visible, but directory durability could not be confirmed',
                absolutePath,
                error
            );
            committedError.committed = true;
            committedError.ambiguous = true;
            committedError.outcome = 'committed_durability_unknown';
            throw committedError;
        }
        const code = stage === 'rename' ? 'JSON_FILE_RENAME_FAILED' : 'JSON_FILE_WRITE_FAILED';
        throw jsonFileError(code, `JSON atomic replacement failed during ${stage}`, absolutePath, error);
    } finally {
        if (descriptor !== undefined) {
            try { fsImpl.closeSync(descriptor); } catch { }
        }
        if (temporaryPath) {
            try { fsImpl.unlinkSync(temporaryPath); } catch { }
        }
    }
}

module.exports = {
    JSON_FILE_MODE,
    MAX_JSON_FILE_BYTES,
    JsonFileError,
    readJsonObjectFile,
    writeJsonObjectAtomically
};

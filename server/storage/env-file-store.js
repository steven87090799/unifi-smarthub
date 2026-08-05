'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ENV_FILE_MODE = 0o600;
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const DIRECTORY_FSYNC_UNSUPPORTED = new Set([
    'EBADF',
    'EISDIR',
    'EINVAL',
    'ENOTSUP',
    'EOPNOTSUPP',
    'EPERM'
]);

class EnvFileError extends Error {
    constructor(code, message, filePath, cause) {
        super(`${code}: ${message}`, cause ? { cause } : undefined);
        this.name = 'EnvFileError';
        this.code = code;
        this.filePath = filePath;
    }
}

function resolvedEnvFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new EnvFileError('ENV_FILE_PATH_INVALID', 'ENV_FILE must be a non-empty path', '');
    }
    return path.resolve(filePath);
}

function envFileError(code, message, filePath, cause) {
    if (cause instanceof EnvFileError) return cause;
    return new EnvFileError(code, message, filePath, cause);
}

function validateFileStat(stat, filePath) {
    if (!stat.isFile()) {
        throw new EnvFileError(
            'ENV_FILE_NOT_REGULAR',
            'ENV_FILE must be a regular file (symlinks and directories are not accepted)',
            filePath
        );
    }
    if (stat.size === 0) {
        throw new EnvFileError('ENV_FILE_EMPTY', 'ENV_FILE must not be empty', filePath);
    }
    if (stat.size > MAX_ENV_FILE_BYTES) {
        throw new EnvFileError(
            'ENV_FILE_TOO_LARGE',
            `ENV_FILE must not exceed ${MAX_ENV_FILE_BYTES} bytes`,
            filePath
        );
    }
    return stat;
}

function assertRegularFile(filePath, fsImpl) {
    let stat;
    try {
        stat = fsImpl.lstatSync(filePath);
    } catch (error) {
        throw envFileError(
            'ENV_FILE_UNAVAILABLE',
            'ENV_FILE does not exist or cannot be inspected',
            filePath,
            error
        );
    }
    return validateFileStat(stat, filePath);
}

/**
 * Production uses the env file as mutable application state. Refuse to start
 * unless that state has one unambiguous, secure, writable backing file.
 */
function assertEnvFileReady(filePath, options = {}) {
    const fsImpl = options.fs || fs;
    const absolutePath = resolvedEnvFile(filePath);
    let stat = assertRegularFile(absolutePath, fsImpl);

    if ((stat.mode & 0o777) !== ENV_FILE_MODE) {
        try {
            fsImpl.chmodSync(absolutePath, ENV_FILE_MODE);
        } catch (error) {
            throw envFileError(
                'ENV_FILE_PERMISSIONS_INVALID',
                'ENV_FILE permissions could not be normalized to 0600',
                absolutePath,
                error
            );
        }
        stat = assertRegularFile(absolutePath, fsImpl);
    }

    if ((stat.mode & 0o777) !== ENV_FILE_MODE) {
        throw new EnvFileError(
            'ENV_FILE_PERMISSIONS_INVALID',
            'ENV_FILE permissions must be exactly 0600',
            absolutePath
        );
    }

    try {
        fsImpl.accessSync(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
        throw envFileError(
            'ENV_FILE_NOT_READ_WRITE',
            'ENV_FILE must be readable and writable by the SmartHub process',
            absolutePath,
            error
        );
    }
    try {
        fsImpl.accessSync(path.dirname(absolutePath), fs.constants.W_OK | fs.constants.X_OK);
    } catch (error) {
        throw envFileError(
            'ENV_FILE_DIRECTORY_NOT_WRITABLE',
            'ENV_FILE parent directory must be writable for atomic replacement',
            absolutePath,
            error
        );
    }

    return absolutePath;
}

function readEnvFile(filePath, options = {}) {
    const fsImpl = options.fs || fs;
    const absolutePath = resolvedEnvFile(filePath);
    assertRegularFile(absolutePath, fsImpl);
    let descriptor;
    try {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        descriptor = fsImpl.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
        validateFileStat(fsImpl.fstatSync(descriptor), absolutePath);

        // Read at most the supported maximum plus one sentinel byte. The fd
        // check closes the lstat/open race and prevents unbounded sync reads.
        const buffer = Buffer.allocUnsafe(MAX_ENV_FILE_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const bytesRead = fsImpl.readSync(descriptor, buffer, offset, buffer.length - offset, null);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset === 0) throw new EnvFileError('ENV_FILE_EMPTY', 'ENV_FILE must not be empty', absolutePath);
        if (offset > MAX_ENV_FILE_BYTES) {
            throw new EnvFileError(
                'ENV_FILE_TOO_LARGE',
                `ENV_FILE must not exceed ${MAX_ENV_FILE_BYTES} bytes`,
                absolutePath
            );
        }
        return buffer.toString('utf8', 0, offset);
    } catch (error) {
        throw envFileError(
            'ENV_FILE_READ_FAILED',
            'ENV_FILE could not be read; refusing to replace it',
            absolutePath,
            error
        );
    } finally {
        if (descriptor !== undefined) {
            try { fsImpl.closeSync(descriptor); } catch { }
        }
    }
}

function parseDesiredEnvFile(filePath, options = {}) {
    return dotenv.parse(readEnvFile(filePath, options));
}

function upsertEnvAssignment(content, key, assignment) {
    if (typeof content !== 'string') throw new TypeError('env file content must be a string');
    if (typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new TypeError('env assignment key is invalid');
    }
    if (typeof assignment !== 'string' || /[\r\n]/.test(assignment) || !assignment.startsWith(`${key}=`)) {
        throw new TypeError('env assignment line is invalid');
    }
    const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'gm');
    let replaced = false;
    const updated = content.replace(pattern, () => {
        if (replaced) return '';
        replaced = true;
        return assignment;
    });
    if (replaced) return updated;
    return updated + (updated.endsWith('\n') || !updated ? '' : '\n') + assignment + '\n';
}

function loadEnvFile(filePath, options = {}) {
    const fsImpl = options.fs || fs;
    const environment = options.environment || process.env;
    const required = options.required === true;
    const absolutePath = resolvedEnvFile(filePath);
    try {
        assertEnvFileReady(absolutePath, { fs: fsImpl });
    } catch (error) {
        const missingOptional = !required
            && error?.code === 'ENV_FILE_UNAVAILABLE'
            && error?.cause?.code === 'ENOENT';
        if (missingOptional) return { loaded: false, parsed: {}, path: absolutePath };
        throw error;
    }

    const parsed = parseDesiredEnvFile(absolutePath, { fs: fsImpl });
    for (const [key, value] of Object.entries(parsed)) {
        if (!Object.hasOwn(environment, key)) environment[key] = value;
    }
    return { loaded: true, parsed, path: absolutePath };
}

function writeAll(fsImpl, descriptor, content) {
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
        const written = fsImpl.writeSync(descriptor, buffer, offset, buffer.length - offset, null);
        if (!Number.isInteger(written) || written <= 0) {
            const error = new Error('ENV_FILE temporary write made no progress');
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

/**
 * Rewrite an existing env file without ever using an empty fallback. The temp
 * file is created exclusively in the destination directory, fully flushed,
 * and then renamed over the old file. A failure before rename leaves the old
 * file untouched.
 */
function rewriteEnvFileAtomically(filePath, transform, options = {}) {
    if (typeof transform !== 'function') throw new TypeError('transform must be a function');
    const fsImpl = options.fs || fs;
    const absolutePath = assertEnvFileReady(filePath, { fs: fsImpl });
    const original = readEnvFile(absolutePath, { fs: fsImpl });
    const replacement = transform(original);
    if (typeof replacement !== 'string') throw new TypeError('env file transform must return a string');
    const replacementBytes = Buffer.byteLength(replacement, 'utf8');
    if (replacementBytes === 0 || replacementBytes > MAX_ENV_FILE_BYTES) {
        throw new EnvFileError(
            replacementBytes === 0 ? 'ENV_FILE_EMPTY' : 'ENV_FILE_TOO_LARGE',
            replacementBytes === 0
                ? 'ENV_FILE replacement must not be empty'
                : `ENV_FILE replacement must not exceed ${MAX_ENV_FILE_BYTES} bytes`,
            absolutePath
        );
    }

    const directory = path.dirname(absolutePath);
    const basename = path.basename(absolutePath);
    let temporaryPath;
    let descriptor;
    let stage = 'create';

    try {
        // O_EXCL (the "x" in wx) makes the generated name safe even if a
        // collision or malicious pre-created path appears.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            temporaryPath = path.join(
                directory,
                `.${basename}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`
            );
            try {
                descriptor = fsImpl.openSync(temporaryPath, 'wx', ENV_FILE_MODE);
                break;
            } catch (error) {
                if (error?.code !== 'EEXIST' || attempt === 4) throw error;
            }
        }

        stage = 'write';
        fsImpl.fchmodSync(descriptor, ENV_FILE_MODE);
        writeAll(fsImpl, descriptor, replacement);
        fsImpl.fsyncSync(descriptor);
        fsImpl.closeSync(descriptor);
        descriptor = undefined;

        stage = 'rename';
        fsImpl.renameSync(temporaryPath, absolutePath);
        temporaryPath = undefined;

        stage = 'directory_fsync';
        fsyncParentDirectory(fsImpl, directory);
        return replacement;
    } catch (error) {
        if (stage === 'directory_fsync') {
            const committedError = envFileError(
                'ENV_FILE_DIRECTORY_SYNC_FAILED',
                'ENV_FILE replacement is visible, but directory durability could not be confirmed',
                absolutePath,
                error
            );
            committedError.committed = true;
            committedError.ambiguous = true;
            committedError.outcome = 'committed_durability_unknown';
            throw committedError;
        }
        const code = stage === 'rename' ? 'ENV_FILE_RENAME_FAILED' : 'ENV_FILE_WRITE_FAILED';
        throw envFileError(code, `ENV_FILE atomic rewrite failed during ${stage}`, absolutePath, error);
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
    DIRECTORY_FSYNC_UNSUPPORTED,
    ENV_FILE_MODE,
    MAX_ENV_FILE_BYTES,
    EnvFileError,
    assertEnvFileReady,
    fsyncParentDirectory,
    loadEnvFile,
    parseDesiredEnvFile,
    readEnvFile,
    rewriteEnvFileAtomically,
    upsertEnvAssignment
};

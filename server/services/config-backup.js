const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

const BACKUP_FORMAT = 'unifi-smarthub-backup';
const BACKUP_VERSION = 1;
const BACKUP_MEDIA_TYPE = 'application/vnd.unifi-smarthub.backup+json';
const BACKUP_V2_MEDIA_TYPE = 'application/vnd.unifi-smarthub.backup+stream';
const RESTORE_CONFIRMATION = 'RESTORE';
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
// Keep enough envelope room for base64 expansion, four bounded JSON files,
// masked env metadata, and the manifest under the 64 MiB restore parser cap.
const MAX_DATABASE_BYTES = 43 * 1024 * 1024;
const DEFAULT_V2_MAX_BYTES = 512 * 1024 * 1024;
const MAX_V2_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const PENDING_DIR_NAME = '.restore-pending';
const TRANSACTION_FILE_NAME = '.restore-transaction.json';
const BACKUP_DIR_NAME = 'restore-backups';
const RESTORABLE_FILES = Object.freeze([
    'app-settings.json',
    'client-aliases.json',
    'security-settings.json',
    'ui-preferences.json'
]);
const REQUIRED_TABLES = Object.freeze(['history', 'ups_events', 'block_history', 'report_runs']);
const SECRET_ENV_KEY = /(?:PASSWORD|PASSCODE|TOKEN|SECRET|API_KEY|PRIVATE_KEY|WEBHOOK|HOST_KEYS|TARGET_IDS)/i;

class BackupValidationError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'BackupValidationError';
        this.httpStatus = options.httpStatus || 400;
        this.code = options.code || 'invalid_backup';
    }
}

function resolveBackupMaxBytes(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
        ? Math.min(parsed, MAX_V2_MAX_BYTES)
        : DEFAULT_V2_MAX_BYTES;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalBase64(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_DATABASE_BYTES / 3) * 4 + 8) {
        throw new BackupValidationError(`${field} is missing or too large`);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new BackupValidationError(`${field} is not canonical base64`);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) throw new BackupValidationError(`${field} is not canonical base64`);
    return decoded;
}

function assertPlainObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new BackupValidationError(`${field} must be an object`);
    }
    return value;
}

function assertExactKeys(value, allowed, field) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new BackupValidationError(`${field} contains unsupported field ${key}`);
    }
}

function validateDatabaseFile(file, { maxBytes = MAX_DATABASE_BYTES } = {}) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
        throw new BackupValidationError('database snapshot is missing or too large');
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const quick = db.pragma('quick_check');
        if (quick.length !== 1 || quick[0].quick_check !== 'ok') throw new BackupValidationError('database quick_check failed');
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        for (const table of REQUIRED_TABLES) {
            if (!tables.has(table)) throw new BackupValidationError(`database is missing required table ${table}`);
        }
    } finally {
        db.close();
    }
}

function checkpointDatabaseForRollback(file) {
    const db = new Database(file, { fileMustExist: true });
    try {
        db.pragma('busy_timeout = 5000');
        db.pragma('wal_checkpoint(TRUNCATE)');
        const quick = db.pragma('quick_check');
        if (quick.length !== 1 || quick[0].quick_check !== 'ok') throw new BackupValidationError('current database quick_check failed before restore');
    } finally { db.close(); }
}

function safeJsonBytes(value, field) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CONFIG_FILE_BYTES) {
        throw new BackupValidationError(`${field} is missing or too large`);
    }
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { throw new BackupValidationError(`${field} is not valid JSON`); }
    assertPlainObject(parsed, field);
    return Buffer.from(value);
}

function maskedEnvironment(envFile) {
    let parsed = {};
    try { parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const values = {};
    for (const key of Object.keys(parsed).sort()) {
        if (SECRET_ENV_KEY.test(key)) values[key] = { secret: true, configured: parsed[key].trim().length > 0 };
        else values[key] = { secret: false, value: parsed[key] };
    }
    return { restorable: false, values };
}

function validateArtifact(input, appVersion) {
    const artifact = assertPlainObject(input, 'backup');
    assertExactKeys(artifact, ['manifest', 'database', 'files', 'environment'], 'backup');
    const manifest = assertPlainObject(artifact.manifest, 'manifest');
    assertExactKeys(manifest, ['format', 'backupVersion', 'applicationVersion', 'createdAt', 'integrity'], 'manifest');
    if (manifest.format !== BACKUP_FORMAT || manifest.backupVersion !== BACKUP_VERSION) {
        throw new BackupValidationError('unsupported backup format or version', { code: 'unsupported_backup' });
    }
    if (typeof manifest.applicationVersion !== 'string'
        || manifest.applicationVersion.split('.')[0] !== String(appVersion).split('.')[0]) {
        throw new BackupValidationError('backup application version is incompatible', { code: 'incompatible_version' });
    }
    if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new BackupValidationError('backup createdAt is invalid');
    if (!/^[a-f0-9]{64}$/.test(manifest.integrity || '')) throw new BackupValidationError('manifest integrity is invalid');

    const database = assertPlainObject(artifact.database, 'database');
    assertExactKeys(database, ['encoding', 'sha256', 'bytes', 'data'], 'database');
    if (database.encoding !== 'base64' || !/^[a-f0-9]{64}$/.test(database.sha256 || '')) {
        throw new BackupValidationError('database metadata is invalid');
    }
    const databaseBytes = canonicalBase64(database.data, 'database.data');
    if (databaseBytes.length !== database.bytes || sha256(databaseBytes) !== database.sha256) {
        throw new BackupValidationError('database integrity check failed');
    }

    const files = assertPlainObject(artifact.files, 'files');
    const normalizedFiles = {};
    for (const [name, entryValue] of Object.entries(files)) {
        if (!RESTORABLE_FILES.includes(name)) throw new BackupValidationError(`file ${name} is not restorable`);
        const entry = assertPlainObject(entryValue, `files.${name}`);
        assertExactKeys(entry, ['sha256', 'bytes', 'data'], `files.${name}`);
        if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw new BackupValidationError(`files.${name}.sha256 is invalid`);
        const bytes = safeJsonBytes(entry.data, `files.${name}.data`);
        if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
            throw new BackupValidationError(`files.${name} integrity check failed`);
        }
        normalizedFiles[name] = bytes;
    }
    const environment = assertPlainObject(artifact.environment, 'environment');
    assertExactKeys(environment, ['restorable', 'values'], 'environment');
    if (environment.restorable !== false) throw new BackupValidationError('environment must be explicitly non-restorable');
    const environmentValues = assertPlainObject(environment.values, 'environment.values');
    for (const [key, entryValue] of Object.entries(environmentValues)) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) throw new BackupValidationError(`environment key ${key} is invalid`);
        const entry = assertPlainObject(entryValue, `environment.values.${key}`);
        if (entry.secret === true) {
            assertExactKeys(entry, ['secret', 'configured'], `environment.values.${key}`);
            if (typeof entry.configured !== 'boolean') throw new BackupValidationError(`environment.values.${key}.configured is invalid`);
        } else {
            assertExactKeys(entry, ['secret', 'value'], `environment.values.${key}`);
            if (entry.secret !== false || typeof entry.value !== 'string') throw new BackupValidationError(`environment.values.${key} is invalid`);
        }
    }

    const integrityMaterial = JSON.stringify({
        format: manifest.format,
        backupVersion: manifest.backupVersion,
        applicationVersion: manifest.applicationVersion,
        createdAt: manifest.createdAt,
        database: database.sha256,
        files: Object.fromEntries(Object.entries(normalizedFiles).sort().map(([name, bytes]) => [name, sha256(bytes)])),
        environment: sha256(JSON.stringify(environment))
    });
    if (sha256(integrityMaterial) !== manifest.integrity) throw new BackupValidationError('manifest integrity check failed');
    return { artifact, databaseBytes, files: normalizedFiles };
}

function writeFileDurably(file, bytes, mode = 0o600) {
    const descriptor = fs.openSync(file, 'wx', mode);
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
}

function writeJsonDurably(file, value) {
    writeFileDurably(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function syncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(file);
        input.on('data', chunk => hash.update(chunk));
        input.once('error', reject);
        input.once('end', () => resolve(hash.digest('hex')));
    });
}

async function writeArchiveEntry(stream, name, file) {
    const stat = fs.statSync(file);
    const header = Buffer.from(`${JSON.stringify({ name, bytes: stat.size })}\n`);
    if (!stream.write(header)) await new Promise(resolve => stream.once('drain', resolve));
    for await (const chunk of fs.createReadStream(file)) {
        if (!stream.write(chunk)) await new Promise(resolve => stream.once('drain', resolve));
    }
}

function archiveSafeName(name) {
    return name === 'smarthub.db' || RESTORABLE_FILES.includes(name);
}

function restoreTargets(dataDir) {
    return ['smarthub.db', ...RESTORABLE_FILES].map(name => ({ name, target: path.join(dataDir, name) }));
}

function rollbackTransaction(dataDir, transaction) {
    const backupDirectory = path.resolve(dataDir, transaction.backupDirectory);
    if (!backupDirectory.startsWith(`${path.resolve(dataDir)}${path.sep}`)) throw new Error('unsafe restore backup path');
    for (const { name, target } of restoreTargets(dataDir)) {
        const backup = path.join(backupDirectory, name);
        const temp = `${target}.restore-rollback`;
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (transaction.present.includes(name)) {
            fs.copyFileSync(backup, temp, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(temp, 0o600);
            fs.renameSync(temp, target);
        } else {
            try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(path.join(dataDir, `smarthub.db${suffix}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    syncDirectory(dataDir);
}

function recoverInterruptedRestore(dataDir) {
    const transactionFile = path.join(dataDir, TRANSACTION_FILE_NAME);
    let transaction;
    try { transaction = JSON.parse(fs.readFileSync(transactionFile, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    rollbackTransaction(dataDir, transaction);
    fs.unlinkSync(transactionFile);
    syncDirectory(dataDir);
    return true;
}

function applyPendingRestore(options) {
    const dataDir = path.resolve(options.dataDir);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    recoverInterruptedRestore(dataDir);
    const pendingDirectory = path.join(dataDir, PENDING_DIR_NAME);
    const pendingManifestFile = path.join(pendingDirectory, 'pending.json');
    let pending;
    try { pending = JSON.parse(fs.readFileSync(pendingManifestFile, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return { applied: false };
        throw error;
    }
    if (!pending || pending.version !== 1 || !Array.isArray(pending.files)) throw new Error('invalid pending restore metadata');
    const stagedDatabase = path.join(pendingDirectory, 'smarthub.db');
    validateDatabaseFile(stagedDatabase, { maxBytes: pending.databaseMaxBytes || MAX_DATABASE_BYTES });
    if (sha256(fs.readFileSync(stagedDatabase)) !== pending.databaseSha256) throw new Error('pending database integrity check failed');
    for (const name of pending.files) {
        if (!RESTORABLE_FILES.includes(name)) throw new Error(`unsafe pending restore file ${name}`);
        const bytes = fs.readFileSync(path.join(pendingDirectory, name));
        JSON.parse(bytes.toString('utf8'));
        if (sha256(bytes) !== pending.fileSha256[name]) throw new Error(`pending file integrity check failed: ${name}`);
    }

    const backupRoot = path.join(dataDir, BACKUP_DIR_NAME);
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const backupDirectory = fs.mkdtempSync(path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
    fs.chmodSync(backupDirectory, 0o700);
    const targets = restoreTargets(dataDir);
    const present = [];
    for (const { name, target } of targets) {
        try {
            const stat = fs.statSync(target);
            if (!stat.isFile()) throw new Error(`${name} is not a regular file`);
            if (name === 'smarthub.db') checkpointDatabaseForRollback(target);
            fs.copyFileSync(target, path.join(backupDirectory, name), fs.constants.COPYFILE_EXCL);
            fs.chmodSync(path.join(backupDirectory, name), 0o600);
            present.push(name);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    syncDirectory(backupDirectory);
    const transaction = {
        version: 1,
        backupDirectory: path.relative(dataDir, backupDirectory),
        present,
        startedAt: new Date().toISOString()
    };
    const transactionFile = path.join(dataDir, TRANSACTION_FILE_NAME);
    writeJsonDurably(transactionFile, transaction);
    syncDirectory(dataDir);
    try {
        const candidates = [{ name: 'smarthub.db', source: stagedDatabase }]
            .concat(pending.files.map(name => ({ name, source: path.join(pendingDirectory, name) })));
        for (const { name, source } of candidates) {
            const target = path.join(dataDir, name);
            const temp = `${target}.restore-new`;
            try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(temp, 0o600);
            const descriptor = fs.openSync(temp, 'r');
            try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
            fs.renameSync(temp, target);
        }
        for (const suffix of ['-wal', '-shm']) {
            try { fs.unlinkSync(path.join(dataDir, `smarthub.db${suffix}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        syncDirectory(dataDir);
        validateDatabaseFile(path.join(dataDir, 'smarthub.db'));
        fs.rmSync(pendingDirectory, { recursive: true });
        fs.unlinkSync(transactionFile);
        syncDirectory(dataDir);
        return { applied: true, backupDirectory };
    } catch (error) {
        rollbackTransaction(dataDir, transaction);
        try { fs.unlinkSync(transactionFile); } catch { }
        throw error;
    }
}

function createConfigBackupService(options) {
    const dataDir = path.resolve(options.dataDir);
    const envFile = path.resolve(options.envFile);
    const appVersion = String(options.appVersion);
    const database = options.database;
    if (!database || typeof database.backup !== 'function') throw new TypeError('database.backup is required');

    async function exportBackup() {
        const tempDirectory = fs.mkdtempSync(path.join(dataDir, '.backup-export-'));
        fs.chmodSync(tempDirectory, 0o700);
        const databaseFile = path.join(tempDirectory, 'smarthub.db');
        try {
            await database.backup(databaseFile);
            validateDatabaseFile(databaseFile, { maxBytes: MAX_DATABASE_BYTES });
            const databaseBytes = fs.readFileSync(databaseFile);
            const files = {};
            for (const name of RESTORABLE_FILES) {
                const file = path.join(dataDir, name);
                try {
                    const stat = fs.statSync(file);
                    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) throw new Error(`${name} is not a safe config file`);
                    const bytes = fs.readFileSync(file);
                    JSON.parse(bytes.toString('utf8'));
                    files[name] = { sha256: sha256(bytes), bytes: bytes.length, data: bytes.toString('utf8') };
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
            const createdAt = new Date().toISOString();
            const artifact = {
                manifest: {
                    format: BACKUP_FORMAT,
                    backupVersion: BACKUP_VERSION,
                    applicationVersion: appVersion,
                    createdAt,
                    integrity: ''
                },
                database: {
                    encoding: 'base64',
                    sha256: sha256(databaseBytes),
                    bytes: databaseBytes.length,
                    data: databaseBytes.toString('base64')
                },
                files,
                environment: maskedEnvironment(envFile)
            };
            artifact.manifest.integrity = sha256(JSON.stringify({
                format: artifact.manifest.format,
                backupVersion: artifact.manifest.backupVersion,
                applicationVersion: artifact.manifest.applicationVersion,
                createdAt: artifact.manifest.createdAt,
                database: artifact.database.sha256,
                files: Object.fromEntries(Object.entries(files).sort().map(([name, entry]) => [name, entry.sha256])),
                environment: sha256(JSON.stringify(artifact.environment))
            }));
            if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_BACKUP_BYTES) {
                throw new BackupValidationError('generated backup exceeds the supported size limit', { httpStatus: 413, code: 'backup_too_large' });
            }
            return artifact;
        } finally { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
    }

    function stageRestore(raw, confirmation) {
        if (confirmation !== RESTORE_CONFIRMATION) {
            throw new BackupValidationError('restore confirmation is required', { code: 'confirmation_required' });
        }
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
        if (bytes.length === 0 || bytes.length > MAX_BACKUP_BYTES) throw new BackupValidationError('backup payload is empty or too large');
        let parsed;
        try { parsed = JSON.parse(bytes.toString('utf8')); }
        catch { throw new BackupValidationError('backup payload is not valid JSON'); }
        const validated = validateArtifact(parsed, appVersion);
        const pendingDirectory = path.join(dataDir, PENDING_DIR_NAME);
        if (fs.existsSync(pendingDirectory)) {
            throw new BackupValidationError('a restore is already pending', { httpStatus: 409, code: 'restore_pending' });
        }
        const stagingDirectory = fs.mkdtempSync(path.join(dataDir, '.restore-stage-'));
        fs.chmodSync(stagingDirectory, 0o700);
        try {
            writeFileDurably(path.join(stagingDirectory, 'smarthub.db'), validated.databaseBytes);
            validateDatabaseFile(path.join(stagingDirectory, 'smarthub.db'));
            const fileSha256 = {};
            for (const [name, fileBytes] of Object.entries(validated.files)) {
                writeFileDurably(path.join(stagingDirectory, name), fileBytes);
                fileSha256[name] = sha256(fileBytes);
            }
            writeJsonDurably(path.join(stagingDirectory, 'pending.json'), {
                version: 1,
                stagedAt: new Date().toISOString(),
                sourceCreatedAt: validated.artifact.manifest.createdAt,
                databaseSha256: sha256(validated.databaseBytes),
                files: Object.keys(validated.files).sort(),
                fileSha256
            });
            syncDirectory(stagingDirectory);
            fs.renameSync(stagingDirectory, pendingDirectory);
            syncDirectory(dataDir);
        } catch (error) {
            fs.rmSync(stagingDirectory, { recursive: true, force: true });
            throw error;
        }
        return { staged: true, restartRequired: true, secretsRestored: false };
    }

    async function exportBackupV2({ outputFile, maxBytes = resolveBackupMaxBytes(process.env.SMARTHUB_BACKUP_MAX_BYTES) } = {}) {
        const destination = path.resolve(outputFile || path.join(
            process.env.SMARTHUB_BACKUP_DIR ? path.resolve(process.env.SMARTHUB_BACKUP_DIR) : dataDir,
            `smarthub-${new Date().toISOString().replace(/[:.]/gu, '-')}.backup`
        ));
        const tempDirectory = fs.mkdtempSync(path.join(dataDir, '.backup-v2-'));
        fs.chmodSync(tempDirectory, 0o700);
        const databaseFile = path.join(tempDirectory, 'smarthub.db');
        try {
            await database.backup(databaseFile);
            validateDatabaseFile(databaseFile, { maxBytes });
            const entries = [{ name: 'smarthub.db', file: databaseFile }];
            for (const name of RESTORABLE_FILES) {
                const file = path.join(dataDir, name);
                try {
                    const stat = fs.statSync(file);
                    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) throw new BackupValidationError(`${name} is not a safe config file`);
                    JSON.parse(fs.readFileSync(file, 'utf8'));
                    entries.push({ name, file });
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
            const manifestEntries = [];
            for (const entry of entries) {
                const stat = fs.statSync(entry.file);
                manifestEntries.push({ name: entry.name, bytes: stat.size, sha256: await sha256File(entry.file) });
            }
            const manifestMaterial = {
                format: BACKUP_FORMAT, backupVersion: 2, applicationVersion: appVersion,
                createdAt: new Date().toISOString(), entries: manifestEntries,
                environment: maskedEnvironment(envFile)
            };
            const manifest = { ...manifestMaterial, integrity: sha256(JSON.stringify(manifestMaterial)) };
            fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
            const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
            await new Promise(async (resolve, reject) => {
                output.once('error', reject);
                try {
                    const header = Buffer.from(`SMARTHUB-BACKUP-V2\n${Buffer.byteLength(JSON.stringify(manifest))}\n${JSON.stringify(manifest)}\n`);
                    if (!output.write(header)) await new Promise(done => output.once('drain', done));
                    for (const entry of entries) await writeArchiveEntry(output, entry.name, entry.file);
                    if (!output.write(Buffer.from('END\n'))) await new Promise(done => output.once('drain', done));
                    output.end(resolve);
                } catch (error) { reject(error); output.destroy(); }
            });
            const stat = fs.statSync(destination);
            if (stat.size > maxBytes) throw new BackupValidationError('generated v2 backup exceeds the configured size limit', { httpStatus: 413, code: 'backup_too_large' });
            return { file: destination, manifest, bytes: stat.size, mediaType: BACKUP_V2_MEDIA_TYPE };
        } catch (error) {
            try { fs.unlinkSync(destination); } catch { }
            throw error;
        } finally {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        }
    }

    async function stageRestoreV2File(file, confirmation, { maxBytes = resolveBackupMaxBytes(process.env.SMARTHUB_BACKUP_MAX_BYTES) } = {}) {
        if (confirmation !== RESTORE_CONFIRMATION) throw new BackupValidationError('restore confirmation is required', { code: 'confirmation_required' });
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new BackupValidationError('v2 backup is empty or too large');
        const pendingDirectory = path.join(dataDir, PENDING_DIR_NAME);
        if (fs.existsSync(pendingDirectory)) throw new BackupValidationError('a restore is already pending', { httpStatus: 409, code: 'restore_pending' });
        const stagingDirectory = fs.mkdtempSync(path.join(dataDir, '.restore-v2-'));
        fs.chmodSync(stagingDirectory, 0o700);
        const handle = await fs.promises.open(file, 'r');
        let offset = 0;
        let currentOutput = null;
        const readExactly = async length => {
            const result = Buffer.allocUnsafe(length);
            let read = 0;
            while (read < length) {
                const current = await handle.read(result, read, length - read, offset);
                if (!current.bytesRead) throw new BackupValidationError('truncated v2 backup');
                read += current.bytesRead;
                offset += current.bytesRead;
            }
            return result;
        };
        const readLine = async maxLength => {
            const chunks = [];
            let total = 0;
            while (total < maxLength) {
                const byte = await readExactly(1);
                total += 1;
                if (byte[0] === 10) return Buffer.concat(chunks).toString('utf8');
                chunks.push(byte);
            }
            throw new BackupValidationError('v2 archive header line is too long');
        };
        try {
            if ((await readLine(64)) !== 'SMARTHUB-BACKUP-V2') throw new BackupValidationError('unsupported v2 backup header', { code: 'unsupported_backup' });
            const manifestBytes = Number(await readLine(32));
            if (!Number.isSafeInteger(manifestBytes) || manifestBytes <= 0 || manifestBytes > 2 * 1024 * 1024) throw new BackupValidationError('v2 manifest is invalid');
            const manifest = JSON.parse((await readExactly(manifestBytes)).toString('utf8'));
            await readLine(1); // manifest newline
            if (manifest.format !== BACKUP_FORMAT || manifest.backupVersion !== 2
                || manifest.applicationVersion?.split('.')[0] !== appVersion.split('.')[0]) {
                throw new BackupValidationError('unsupported or incompatible v2 backup', { code: 'incompatible_version' });
            }
            if (!Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > RESTORABLE_FILES.length + 1
                || !/^[a-f0-9]{64}$/u.test(manifest.integrity || '')
                || !Number.isFinite(Date.parse(manifest.createdAt))) throw new BackupValidationError('v2 manifest is invalid');
            const manifestNames = new Set();
            for (const entry of manifest.entries) {
                assertPlainObject(entry, 'manifest entry');
                assertExactKeys(entry, ['name', 'bytes', 'sha256'], 'manifest entry');
                if (!archiveSafeName(entry.name) || manifestNames.has(entry.name)
                    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maxBytes
                    || !/^[a-f0-9]{64}$/u.test(entry.sha256 || '')) throw new BackupValidationError('v2 manifest entry is invalid');
                manifestNames.add(entry.name);
            }
            if (!manifestNames.has('smarthub.db')) throw new BackupValidationError('v2 manifest is missing the database');
            const expectedMaterial = { format: manifest.format, backupVersion: manifest.backupVersion, applicationVersion: manifest.applicationVersion, createdAt: manifest.createdAt, entries: manifest.entries, environment: manifest.environment };
            if (sha256(JSON.stringify(expectedMaterial)) !== manifest.integrity) throw new BackupValidationError('v2 manifest integrity check failed');
            const expected = new Map(manifest.entries.map(entry => [entry.name, entry]));
            const seen = new Set();
            for (;;) {
                const entryLine = await readLine(512);
                if (entryLine === 'END') break;
                let entry;
                try { entry = JSON.parse(entryLine); } catch { throw new BackupValidationError('v2 entry header is invalid'); }
                if (!archiveSafeName(entry.name) || seen.has(entry.name) || !expected.has(entry.name)) throw new BackupValidationError('v2 archive contains an unsafe or unexpected file');
                if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maxBytes) throw new BackupValidationError('v2 entry size is invalid');
                const destinationFile = path.join(stagingDirectory, entry.name);
                const output = fs.createWriteStream(destinationFile, { flags: 'wx', mode: 0o600 });
                currentOutput = output;
                let outputError = null;
                output.on('error', error => { outputError = error; });
                const hash = crypto.createHash('sha256');
                let remaining = entry.bytes;
                while (remaining > 0) {
                    const chunk = await readExactly(Math.min(1024 * 1024, remaining));
                    remaining -= chunk.length;
                    hash.update(chunk);
                    if (!output.write(chunk)) await new Promise(done => output.once('drain', done));
                }
                if (outputError) throw outputError;
                await new Promise((resolve, reject) => {
                    if (outputError) return reject(outputError);
                    output.once('error', reject);
                    output.end(resolve);
                });
                const expectedEntry = expected.get(entry.name);
                if (expectedEntry.bytes !== entry.bytes || expectedEntry.sha256 !== hash.digest('hex')) throw new BackupValidationError(`v2 checksum mismatch for ${entry.name}`);
                seen.add(entry.name);
                currentOutput = null;
            }
            await handle.close();
            if (offset !== stat.size) throw new BackupValidationError('v2 backup contains trailing bytes');
            if (!seen.has('smarthub.db') || [...expected.keys()].some(name => !seen.has(name))) throw new BackupValidationError('v2 backup is missing a manifest entry');
            validateDatabaseFile(path.join(stagingDirectory, 'smarthub.db'), { maxBytes });
            const fileSha256 = {};
            for (const name of seen) if (name !== 'smarthub.db') fileSha256[name] = await sha256File(path.join(stagingDirectory, name));
            writeJsonDurably(path.join(stagingDirectory, 'pending.json'), {
                version: 1, stagedAt: new Date().toISOString(), sourceCreatedAt: manifest.createdAt,
                databaseSha256: await sha256File(path.join(stagingDirectory, 'smarthub.db')),
                databaseMaxBytes: maxBytes,
                files: [...seen].filter(name => name !== 'smarthub.db').sort(), fileSha256
            });
            syncDirectory(stagingDirectory);
            fs.renameSync(stagingDirectory, pendingDirectory);
            syncDirectory(dataDir);
            return { staged: true, restartRequired: true, secretsRestored: false, backupVersion: 2 };
        } catch (error) {
            try { currentOutput?.destroy(); } catch { }
            try { await handle.close(); } catch { }
            fs.rmSync(stagingDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    async function createScheduledBackup({ directory, retentionCount = 7 } = {}) {
        const targetDirectory = path.resolve(directory || process.env.SMARTHUB_BACKUP_DIR || path.join(dataDir, 'backups'));
        fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
        const outputFile = path.join(targetDirectory, `smarthub-${new Date().toISOString().replace(/[:.]/gu, '-')}.backup`);
        const result = await exportBackupV2({ outputFile });
        const files = fs.readdirSync(targetDirectory).filter(name => name.endsWith('.backup')).sort().reverse();
        for (const name of files.slice(Math.max(Number(retentionCount) || 7, 1))) {
            try { fs.unlinkSync(path.join(targetDirectory, name)); } catch { }
        }
        return result;
    }

    function status() {
        return { pending: fs.existsSync(path.join(dataDir, PENDING_DIR_NAME, 'pending.json')) };
    }

    return { exportBackup, stageRestore, exportBackupV2, stageRestoreV2File, createScheduledBackup, status };
}

module.exports = {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    BACKUP_MEDIA_TYPE,
    BACKUP_V2_MEDIA_TYPE,
    RESTORE_CONFIRMATION,
    MAX_BACKUP_BYTES,
    MAX_V2_MAX_BYTES,
    resolveBackupMaxBytes,
    RESTORABLE_FILES,
    BackupValidationError,
    applyPendingRestore,
    createConfigBackupService,
    validateArtifact
};

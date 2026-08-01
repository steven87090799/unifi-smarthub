const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createHistoryDb } = require('../db');
const {
    BACKUP_FORMAT,
    BackupValidationError,
    applyPendingRestore,
    createConfigBackupService
} = require('../server/services/config-backup');

function tempDir(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-backup-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function write(file, value, mode = 0o600) {
    fs.writeFileSync(file, value, { mode });
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function integrityFor(artifact) {
    return sha256(JSON.stringify({
        format: artifact.manifest.format,
        backupVersion: artifact.manifest.backupVersion,
        applicationVersion: artifact.manifest.applicationVersion,
        createdAt: artifact.manifest.createdAt,
        database: artifact.database.sha256,
        files: Object.fromEntries(Object.entries(artifact.files).sort().map(([name, entry]) => [name, entry.sha256])),
        environment: sha256(JSON.stringify(artifact.environment))
    }));
}

async function fixture(t) {
    const directory = tempDir(t);
    const envFile = path.join(directory, '.env');
    write(envFile, [
        'PANEL_PASSWORD=top-secret',
        'UNIFI_API_KEY=another-secret',
        'UNIFI_DEVICE_SSH_PASSWORD=device-secret',
        'UNIFI_DEVICE_SSH_TARGET_IDS=aa:bb:cc:dd:ee:ff',
        'UNIFI_DEVICE_SSH_HOST_KEYS=aa:bb:cc:dd:ee:ff=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'WEB_PUSH_PRIVATE_KEY=web-push-private-material',
        'WIIM_IP=192.0.2.55',
        'UPS_SOURCE=ppb'
    ].join('\n') + '\n');
    write(path.join(directory, 'app-settings.json'), JSON.stringify({ watcherSec: 45 }));
    write(path.join(directory, 'ui-preferences.json'), JSON.stringify({ theme: 'dark' }));
    const database = createHistoryDb(directory);
    database.insertPoint('trend', { t: new Date().toISOString(), clients: 3 });
    database.flush();
    const service = createConfigBackupService({ dataDir: directory, envFile, appVersion: '3.0.0', database });
    const artifact = await service.exportBackup();
    return { directory, envFile, database, service, artifact };
}

test('export produces a consistent SQLite snapshot and never exports live env secrets', async t => {
    const f = await fixture(t);
    t.after(() => f.database.close());
    assert.equal(f.artifact.manifest.format, BACKUP_FORMAT);
    assert.equal(f.artifact.manifest.applicationVersion, '3.0.0');
    assert.match(f.artifact.manifest.integrity, /^[a-f0-9]{64}$/);
    assert.equal(f.artifact.environment.restorable, false);
    assert.deepEqual(f.artifact.environment.values.PANEL_PASSWORD, { secret: true, configured: true });
    assert.deepEqual(f.artifact.environment.values.UNIFI_API_KEY, { secret: true, configured: true });
    assert.deepEqual(f.artifact.environment.values.UNIFI_DEVICE_SSH_PASSWORD, { secret: true, configured: true });
    assert.deepEqual(f.artifact.environment.values.UNIFI_DEVICE_SSH_TARGET_IDS, { secret: true, configured: true });
    assert.deepEqual(f.artifact.environment.values.UNIFI_DEVICE_SSH_HOST_KEYS, { secret: true, configured: true });
    assert.deepEqual(f.artifact.environment.values.WEB_PUSH_PRIVATE_KEY, { secret: true, configured: true });
    assert.deepEqual(f.artifact.environment.values.WIIM_IP, { secret: false, value: '192.0.2.55' });
    assert.doesNotMatch(JSON.stringify(f.artifact), /top-secret|another-secret|device-secret|aa:bb:cc:dd:ee:ff|web-push-private-material/);
    assert.equal(f.artifact.files['app-settings.json'].data, JSON.stringify({ watcherSec: 45 }));

    const snapshot = path.join(f.directory, 'exported.db');
    fs.writeFileSync(snapshot, Buffer.from(f.artifact.database.data, 'base64'));
    const db = new Database(snapshot, { readonly: true });
    assert.equal(db.pragma('quick_check')[0].quick_check, 'ok');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM history WHERE series='trend'").get().count, 1);
    db.close();
});

test('v2 backup streams a large snapshot, stages restore, and rejects truncation or checksum tampering', async t => {
    const source = await fixture(t);
    const backupFile = path.join(source.directory, 'smarthub-v2.backup');
    const exported = await source.service.exportBackupV2({ outputFile: backupFile, maxBytes: 80 * 1024 * 1024 });
    assert.equal(exported.mediaType, 'application/vnd.unifi-smarthub.backup+stream');
    assert.ok(exported.bytes > 0);
    assert.match(fs.readFileSync(backupFile, 'utf8', { encoding: 'utf8', flag: 'r' }).slice(0, 20), /^SMARTHUB-BACKUP-V2/u);

    const destination = tempDir(t);
    write(path.join(destination, '.env'), 'PANEL_PASSWORD=destination-secret\n');
    const destinationDb = createHistoryDb(destination);
    const destinationService = createConfigBackupService({
        dataDir: destination,
        envFile: path.join(destination, '.env'),
        appVersion: '3.0.0',
        database: destinationDb
    });
    destinationDb.close();
    assert.deepEqual(await destinationService.stageRestoreV2File(backupFile, 'RESTORE'), {
        staged: true, restartRequired: true, secretsRestored: false, backupVersion: 2
    });
    const applied = applyPendingRestore({ dataDir: destination });
    assert.equal(applied.applied, true);
    const restored = new Database(path.join(destination, 'smarthub.db'), { readonly: true });
    assert.equal(restored.pragma('quick_check')[0].quick_check, 'ok');
    restored.close();
    source.database.close();

    const truncated = path.join(source.directory, 'truncated.backup');
    fs.copyFileSync(backupFile, truncated);
    fs.truncateSync(truncated, fs.statSync(truncated).size - 1);
    await assert.rejects(() => source.service.stageRestoreV2File(truncated, 'RESTORE'), /truncated|checksum|trailing/u);

    const corrupted = path.join(source.directory, 'corrupted.backup');
    const bytes = fs.readFileSync(backupFile);
    const sqliteOffset = bytes.indexOf(Buffer.from('SQLite format 3\u0000'));
    assert.ok(sqliteOffset > 0);
    bytes[sqliteOffset + 32] ^= 0x01;
    fs.writeFileSync(corrupted, bytes, { mode: 0o600 });
    await assert.rejects(() => source.service.stageRestoreV2File(corrupted, 'RESTORE'), /checksum mismatch/u);
});

test('v2 backup accepts a database larger than the legacy 43 MiB envelope', async t => {
    const directory = tempDir(t);
    const envFile = path.join(directory, '.env');
    write(envFile, 'PANEL_PASSWORD=large-db-secret\n');
    let database = createHistoryDb(directory);
    database.close();
    const raw = new Database(path.join(directory, 'smarthub.db'));
    raw.exec('CREATE TABLE large_backup_fixture (payload BLOB NOT NULL)');
    const insert = raw.prepare('INSERT INTO large_backup_fixture (payload) VALUES (?)');
    const payload = Buffer.alloc(1024 * 1024, 7);
    const transaction = raw.transaction(() => {
        for (let index = 0; index < 50; index += 1) insert.run(payload);
    });
    transaction();
    raw.close();
    database = createHistoryDb(directory);
    const service = createConfigBackupService({ dataDir: directory, envFile, appVersion: '3.0.0', database });
    const outputFile = path.join(directory, 'large-v2.backup');
    const result = await service.exportBackupV2({ outputFile, maxBytes: 80 * 1024 * 1024 });
    assert.ok(result.bytes > 43 * 1024 * 1024);
    database.close();
});

test('optional scheduled backup helper writes v2 files and bounds retention', async t => {
    const f = await fixture(t);
    t.after(() => f.database.close());
    const directory = path.join(f.directory, 'scheduled-backups');
    for (let index = 0; index < 3; index += 1) {
        await f.service.createScheduledBackup({ directory, retentionCount: 2 });
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.backup'));
    assert.equal(files.length, 2);
    assert.ok(files.every(name => fs.statSync(path.join(directory, name)).size > 0));
});

test('restore rejects missing confirmation, incompatible versions, corruption, and duplicate pending work', async t => {
    const f = await fixture(t);
    t.after(() => f.database.close());
    const raw = Buffer.from(JSON.stringify(f.artifact));
    assert.throws(() => f.service.stageRestore(raw, ''), error => error instanceof BackupValidationError && error.code === 'confirmation_required');

    const incompatible = structuredClone(f.artifact);
    incompatible.manifest.applicationVersion = '4.0.0';
    incompatible.manifest.integrity = integrityFor(incompatible);
    assert.throws(() => f.service.stageRestore(Buffer.from(JSON.stringify(incompatible)), 'RESTORE'), /incompatible/);

    const corrupt = structuredClone(f.artifact);
    corrupt.database.data = `${corrupt.database.data.slice(0, -4)}AAAA`;
    assert.throws(() => f.service.stageRestore(Buffer.from(JSON.stringify(corrupt)), 'RESTORE'), /integrity/);

    const tamperedMetadata = structuredClone(f.artifact);
    tamperedMetadata.environment.values.WIIM_IP.value = '203.0.113.99';
    assert.throws(() => f.service.stageRestore(Buffer.from(JSON.stringify(tamperedMetadata)), 'RESTORE'), /manifest integrity/);

    const nonObjectSettings = structuredClone(f.artifact);
    const nonObjectData = '[]';
    nonObjectSettings.files['app-settings.json'] = {
        data: nonObjectData,
        bytes: Buffer.byteLength(nonObjectData),
        sha256: sha256(nonObjectData)
    };
    nonObjectSettings.manifest.integrity = integrityFor(nonObjectSettings);
    assert.throws(
        () => f.service.stageRestore(Buffer.from(JSON.stringify(nonObjectSettings)), 'RESTORE'),
        /files\.app-settings\.json\.data must be an object/
    );

    assert.deepEqual(f.service.stageRestore(raw, 'RESTORE'), { staged: true, restartRequired: true, secretsRestored: false });
    assert.deepEqual(f.service.status(), { pending: true });
    assert.throws(() => f.service.stageRestore(raw, 'RESTORE'), error => error instanceof BackupValidationError && error.httpStatus === 409);
});

test('validated restore applies only on restart, retains secrets, and keeps a pre-restore rollback copy', async t => {
    const source = await fixture(t);
    const raw = Buffer.from(JSON.stringify(source.artifact));
    source.database.close();

    const destination = tempDir(t);
    const destinationEnv = path.join(destination, '.env');
    write(destinationEnv, 'PANEL_PASSWORD=destination-secret\nWIIM_IP=198.51.100.7\n');
    write(path.join(destination, 'app-settings.json'), JSON.stringify({ watcherSec: 99 }));
    const destinationDb = createHistoryDb(destination);
    destinationDb.insertPoint('trend', { t: new Date().toISOString(), clients: 99 });
    destinationDb.flush();
    const service = createConfigBackupService({
        dataDir: destination,
        envFile: destinationEnv,
        appVersion: '3.0.0',
        database: destinationDb
    });
    service.stageRestore(raw, 'RESTORE');
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'app-settings.json'))).watcherSec, 99);
    destinationDb.close();

    const result = applyPendingRestore({ dataDir: destination });
    assert.equal(result.applied, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'app-settings.json'))).watcherSec, 45);
    assert.match(fs.readFileSync(destinationEnv, 'utf8'), /destination-secret/);
    assert.equal(fs.existsSync(path.join(destination, '.restore-pending')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.backupDirectory, 'app-settings.json'))).watcherSec, 99);

    const restored = new Database(path.join(destination, 'smarthub.db'), { readonly: true });
    assert.equal(restored.pragma('quick_check')[0].quick_check, 'ok');
    assert.equal(restored.prepare("SELECT json_extract(data, '$.clients') clients FROM history WHERE series='trend' ORDER BY ts DESC LIMIT 1").get().clients, 3);
    restored.close();
});

test('startup rolls back an interrupted multi-file restore before opening SQLite', t => {
    const directory = tempDir(t);
    const originalDb = createHistoryDb(directory);
    originalDb.insertPoint('trend', { t: new Date().toISOString(), clients: 7 });
    originalDb.flush();
    originalDb.close();
    write(path.join(directory, 'app-settings.json'), JSON.stringify({ watcherSec: 7 }));
    const backupDirectory = path.join(directory, 'restore-backups', 'interrupted');
    fs.mkdirSync(backupDirectory, { recursive: true });
    fs.copyFileSync(path.join(directory, 'smarthub.db'), path.join(backupDirectory, 'smarthub.db'));
    fs.copyFileSync(path.join(directory, 'app-settings.json'), path.join(backupDirectory, 'app-settings.json'));
    write(path.join(directory, 'app-settings.json'), JSON.stringify({ watcherSec: 999 }));
    write(path.join(directory, '.restore-transaction.json'), JSON.stringify({
        version: 1,
        backupDirectory: path.relative(directory, backupDirectory),
        present: ['smarthub.db', 'app-settings.json'],
        startedAt: new Date().toISOString()
    }));

    assert.deepEqual(applyPendingRestore({ dataDir: directory }), { applied: false });
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'app-settings.json'))).watcherSec, 7);
    assert.equal(fs.existsSync(path.join(directory, '.restore-transaction.json')), false);
    const db = new Database(path.join(directory, 'smarthub.db'), { readonly: true });
    assert.equal(db.pragma('quick_check')[0].quick_check, 'ok');
    db.close();
});

test('production startup owns the DATA_DIR lock before applying restore and opens SQLite afterward', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const lockOwned = source.indexOf('instanceLock = acquireInstanceLock({ lockFile: LOCK_FILE, legacyLockFile: LEGACY_LOCK_FILE })');
    const restore = source.indexOf('const restoreResult = applyPendingRestore');
    const database = source.indexOf('historyDb = createHistoryDb');
    assert.ok(lockOwned > 0 && restore > lockOwned && database > restore);
});

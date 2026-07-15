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
    assert.deepEqual(f.artifact.environment.values.WIIM_IP, { secret: false, value: '192.0.2.55' });
    assert.doesNotMatch(JSON.stringify(f.artifact), /top-secret|another-secret/);
    assert.equal(f.artifact.files['app-settings.json'].data, JSON.stringify({ watcherSec: 45 }));

    const snapshot = path.join(f.directory, 'exported.db');
    fs.writeFileSync(snapshot, Buffer.from(f.artifact.database.data, 'base64'));
    const db = new Database(snapshot, { readonly: true });
    assert.equal(db.pragma('quick_check')[0].quick_check, 'ok');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM history WHERE series='trend'").get().count, 1);
    db.close();
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
    const lockOwned = source.indexOf("process.on('exit', () => { try { if (parseInt(fs.readFileSync(LOCK_FILE");
    const restore = source.indexOf('const restoreResult = applyPendingRestore');
    const database = source.indexOf('historyDb = createHistoryDb');
    assert.ok(lockOwned > 0 && restore > lockOwned && database > restore);
});

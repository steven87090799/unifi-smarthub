'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    JSON_FILE_MODE,
    JsonFileError,
    readJsonObjectFile,
    writeJsonObjectAtomically
} = require('../server/storage/json-file-store');

const ORIGINAL = '{"enabled":false,"revision":1}\n';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-json-store-'));
    const file = path.join(directory, 'settings.json');
    fs.writeFileSync(file, ORIGINAL, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, file };
}

function fault(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function withFsOverrides(overrides) {
    return new Proxy(fs, {
        get(target, property) {
            if (Object.hasOwn(overrides, property)) return overrides[property];
            return Reflect.get(target, property);
        }
    });
}

function assertOriginalIntact({ directory, file }) {
    assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), []);
}

test('bounded reader normalizes an existing regular settings file to private mode', t => {
    const f = fixture(t);
    assert.deepEqual(readJsonObjectFile(f.file), { enabled: false, revision: 1 });
    assert.equal(fs.statSync(f.file).mode & 0o777, JSON_FILE_MODE);
});

test('atomic JSON replacement is private, complete, parseable, and leaves no temporary file', t => {
    const f = fixture(t);
    const result = writeJsonObjectAtomically(f.file, { enabled: true, revision: 2 });
    assert.deepEqual(result, { committed: true, durable: true, bytes: 39 });
    assert.deepEqual(readJsonObjectFile(f.file), { enabled: true, revision: 2 });
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{\n  "enabled": true,\n  "revision": 2\n}\n');
    assert.equal(fs.statSync(f.file).mode & 0o777, JSON_FILE_MODE);
    assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.includes('.tmp-')), []);
});

test('serialization and size failures occur before the accepted file is touched', t => {
    const f = fixture(t);
    const circular = {};
    circular.self = circular;
    assert.throws(
        () => writeJsonObjectAtomically(f.file, circular),
        error => error instanceof JsonFileError && error.code === 'JSON_FILE_SERIALIZE_FAILED'
    );
    assert.throws(
        () => writeJsonObjectAtomically(f.file, { value: 'too-large' }, { maxBytes: 8 }),
        error => error instanceof JsonFileError && error.code === 'JSON_FILE_TOO_LARGE'
    );
    assert.throws(() => writeJsonObjectAtomically(f.file, []), /plain object/);
    assertOriginalIntact(f);
});

test('partial temporary write failure preserves the accepted file and cleans up', t => {
    const f = fixture(t);
    let calls = 0;
    const injectedFs = withFsOverrides({
        writeSync(descriptor, buffer, offset, length, position) {
            calls += 1;
            if (calls === 1) return fs.writeSync(descriptor, buffer, offset, Math.min(length, 5), position);
            throw fault('EIO', 'injected partial write failure');
        }
    });
    assert.throws(
        () => writeJsonObjectAtomically(f.file, { enabled: true }, { fs: injectedFs }),
        error => error.code === 'JSON_FILE_WRITE_FAILED' && error.cause?.code === 'EIO'
    );
    assertOriginalIntact(f);
});

test('temporary file fsync and rename failures preserve the accepted file', t => {
    const f = fixture(t);
    const fsyncFailure = withFsOverrides({
        fsyncSync: () => { throw fault('EIO', 'injected file fsync failure'); }
    });
    assert.throws(
        () => writeJsonObjectAtomically(f.file, { enabled: true }, { fs: fsyncFailure }),
        error => error.code === 'JSON_FILE_WRITE_FAILED' && error.cause?.code === 'EIO'
    );
    assertOriginalIntact(f);

    const renameFailure = withFsOverrides({
        renameSync: () => { throw fault('EIO', 'injected rename failure'); }
    });
    assert.throws(
        () => writeJsonObjectAtomically(f.file, { enabled: true }, { fs: renameFailure }),
        error => error.code === 'JSON_FILE_RENAME_FAILED' && error.cause?.code === 'EIO'
    );
    assertOriginalIntact(f);
});

test('directory fsync failure reports an explicit visible but durability-unknown commit', t => {
    const f = fixture(t);
    let fsyncCalls = 0;
    const injectedFs = withFsOverrides({
        fsyncSync(descriptor) {
            fsyncCalls += 1;
            if (fsyncCalls === 1) return fs.fsyncSync(descriptor);
            throw fault('EIO', 'injected directory fsync failure');
        }
    });
    assert.throws(
        () => writeJsonObjectAtomically(f.file, { enabled: true, revision: 2 }, { fs: injectedFs }),
        error => error.code === 'JSON_FILE_DIRECTORY_SYNC_FAILED'
            && error.committed === true
            && error.ambiguous === true
            && error.outcome === 'committed_durability_unknown'
    );
    assert.deepEqual(readJsonObjectFile(f.file), { enabled: true, revision: 2 });
    assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.includes('.tmp-')), []);
});

test('bounded JSON object reader rejects empty, oversized, symlink, malformed, and non-object state', t => {
    const f = fixture(t);
    const symlink = path.join(f.directory, 'linked.json');
    fs.symlinkSync(f.file, symlink);
    assert.throws(() => readJsonObjectFile(symlink), error => error.code === 'JSON_FILE_NOT_REGULAR');

    fs.writeFileSync(f.file, '');
    assert.throws(() => readJsonObjectFile(f.file), error => error.code === 'JSON_FILE_EMPTY');
    fs.writeFileSync(f.file, 'not-json');
    assert.throws(() => readJsonObjectFile(f.file), error => error.code === 'JSON_FILE_INVALID');
    fs.writeFileSync(f.file, '[]');
    assert.throws(() => readJsonObjectFile(f.file), error => error.code === 'JSON_FILE_INVALID');
    fs.writeFileSync(f.file, '{"large":true}\n');
    assert.throws(() => readJsonObjectFile(f.file, { maxBytes: 4 }), error => error.code === 'JSON_FILE_TOO_LARGE');
});

test('production settings routes use atomic storage and publish cloned state after persistence', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const directWriter of [
        'fs.writeFileSync(APP_SETTINGS_FILE',
        'fs.writeFileSync(UI_PREFERENCES_FILE',
        'fs.writeFileSync(CLIENT_ALIAS_FILE',
        'fs.writeFileSync(SEC_FILE',
        'fs.writeFileSync(NOTIF_FILE'
    ]) assert.doesNotMatch(source, new RegExp(directWriter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(source, /const next = \{ \.\.\.uiPreferences, \.\.\.incoming \};[\s\S]*writeJsonObjectAtomically\(UI_PREFERENCES_FILE, next\);[\s\S]*uiPreferences = next;/u);
    assert.match(source, /const s = \{ \.\.\.loadSecSettings\(\), autoDefense: input\.autoDefense \};[\s\S]*saveSecSettings\(s\);/u);
    assert.match(source, /const s = \{ \.\.\.loadNotifSettings\(\), \.\.\.input \};[\s\S]*saveNotifSettings\(s\);/u);
    assert.match(source, /const next = \{ \.\.\.appSettings, \.\.\.input \};[\s\S]*saveAppSettings\(next\);/u);
});

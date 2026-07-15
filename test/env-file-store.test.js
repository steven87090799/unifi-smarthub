'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_ENV_FILE_BYTES,
    assertEnvFileReady,
    loadEnvFile,
    parseDesiredEnvFile,
    rewriteEnvFileAtomically,
    upsertEnvAssignment
} = require('../server/storage/env-file-store');

const ROOT = path.resolve(__dirname, '..');
const ORIGINAL = 'PANEL_PASSWORD=keep-me\nWIIM_IP=192.0.2.10\n';

function fixture(t, mode = 0o600) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-env-store-'));
    const envFile = path.join(directory, 'settings.env');
    fs.writeFileSync(envFile, ORIGINAL, { mode });
    fs.chmodSync(envFile, mode);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, envFile };
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

function assertOriginalIntact({ directory, envFile }) {
    assert.equal(fs.readFileSync(envFile, 'utf8'), ORIGINAL);
    assert.deepEqual(
        fs.readdirSync(directory).filter(name => name.includes('.tmp-')),
        [],
        'failed rewrite left a temporary file behind'
    );
}

test('env assignment upsert collapses duplicate active and commented authority', () => {
    const original = [
        'WIIM_IP=192.0.2.10',
        '# WIIM_IP=192.0.2.11',
        'OTHER=value',
        'WIIM_IP=192.0.2.12'
    ].join('\n') + '\n';
    const updated = upsertEnvAssignment(original, 'WIIM_IP', 'WIIM_IP=203.0.113.55');
    assert.equal((updated.match(/^\s*WIIM_IP=/gm) || []).length, 1);
    assert.equal((updated.match(/^#?\s*WIIM_IP=/gm) || []).length, 1);
    assert.equal(require('dotenv').parse(updated).WIIM_IP, '203.0.113.55');
    assert.match(updated, /^OTHER=value$/m);
});

test('production env validation normalizes a regular read-write file to 0600', t => {
    const { envFile } = fixture(t, 0o644);
    assert.equal(assertEnvFileReady(envFile), envFile);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
});

test('production env validation rejects missing, non-regular, symlink, and inaccessible paths', t => {
    const { directory, envFile } = fixture(t);
    assert.throws(
        () => assertEnvFileReady(path.join(directory, 'missing.env')),
        error => error.code === 'ENV_FILE_UNAVAILABLE'
    );
    assert.throws(
        () => assertEnvFileReady(directory),
        error => error.code === 'ENV_FILE_NOT_REGULAR'
    );

    const symlink = path.join(directory, 'linked.env');
    fs.symlinkSync(envFile, symlink);
    assert.throws(
        () => assertEnvFileReady(symlink),
        error => error.code === 'ENV_FILE_NOT_REGULAR'
    );

    const inaccessibleFs = withFsOverrides({
        accessSync: () => { throw fault('EACCES', 'injected access failure'); }
    });
    assert.throws(
        () => assertEnvFileReady(envFile, { fs: inaccessibleFs }),
        error => error.code === 'ENV_FILE_NOT_READ_WRITE'
    );

    const unwritableDirectoryFs = withFsOverrides({
        accessSync(target) {
            if (target === directory) throw fault('EACCES', 'injected directory access failure');
            return fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
        }
    });
    assert.throws(
        () => assertEnvFileReady(envFile, { fs: unwritableDirectoryFs }),
        error => error.code === 'ENV_FILE_DIRECTORY_NOT_WRITABLE'
    );
});

test('env validation rejects empty and oversized files before parsing', t => {
    const { directory, envFile } = fixture(t);
    fs.writeFileSync(envFile, '');
    assert.throws(() => assertEnvFileReady(envFile), error => error.code === 'ENV_FILE_EMPTY');

    fs.writeFileSync(envFile, Buffer.alloc(MAX_ENV_FILE_BYTES + 1, 0x41));
    assert.throws(() => assertEnvFileReady(envFile), error => error.code === 'ENV_FILE_TOO_LARGE');
    assert.equal(fs.statSync(envFile).size, MAX_ENV_FILE_BYTES + 1);
    assert.equal(fs.readdirSync(directory).some(name => name.includes('.tmp-')), false);
});

test('safe env loader validates before parsing and preserves externally supplied values', t => {
    const { envFile } = fixture(t, 0o644);
    const environment = { WIIM_IP: '198.51.100.10' };
    const result = loadEnvFile(envFile, { environment, required: true });

    assert.equal(result.loaded, true);
    assert.equal(result.parsed.PANEL_PASSWORD, 'keep-me');
    assert.equal(environment.PANEL_PASSWORD, 'keep-me');
    assert.equal(environment.WIIM_IP, '198.51.100.10');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
});

test('atomic rewrite flushes a same-directory 0600 replacement and exposes desired env parsing', t => {
    const { directory, envFile } = fixture(t, 0o644);
    const replacement = rewriteEnvFileAtomically(envFile, content => content.replace(
        'WIIM_IP=192.0.2.10',
        'WIIM_IP=192.0.2.55'
    ));

    assert.equal(fs.readFileSync(envFile, 'utf8'), replacement);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.equal(parseDesiredEnvFile(envFile).WIIM_IP, '192.0.2.55');
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), []);
});

test('read failure never becomes an empty config rewrite', t => {
    const state = fixture(t);
    const failingFs = withFsOverrides({
        readSync: () => { throw fault('EIO', 'injected read failure'); }
    });

    assert.throws(
        () => rewriteEnvFileAtomically(state.envFile, () => 'WIIM_IP=198.51.100.1\n', { fs: failingFs }),
        error => error.code === 'ENV_FILE_READ_FAILED'
    );
    assertOriginalIntact(state);
});

test('partial temporary write failure preserves the original and cleans up', t => {
    const state = fixture(t);
    let injected = false;
    const failingFs = withFsOverrides({
        writeSync(descriptor, buffer, offset, length, position) {
            if (!injected) {
                injected = true;
                fs.writeSync(descriptor, buffer, offset, Math.min(length, 7), position);
                throw fault('ENOSPC', 'injected partial write failure');
            }
            return fs.writeSync(descriptor, buffer, offset, length, position);
        }
    });

    assert.throws(
        () => rewriteEnvFileAtomically(state.envFile, () => 'WIIM_IP=198.51.100.2\n', { fs: failingFs }),
        error => error.code === 'ENV_FILE_WRITE_FAILED'
    );
    assertOriginalIntact(state);
});

test('temporary file fsync failure preserves the original and cleans up', t => {
    const state = fixture(t);
    const failingFs = withFsOverrides({
        fsyncSync: () => { throw fault('EIO', 'injected file fsync failure'); }
    });

    assert.throws(
        () => rewriteEnvFileAtomically(state.envFile, () => 'WIIM_IP=198.51.100.3\n', { fs: failingFs }),
        error => error.code === 'ENV_FILE_WRITE_FAILED'
    );
    assertOriginalIntact(state);
});

test('rename failure preserves the original and cleans up', t => {
    const state = fixture(t);
    const failingFs = withFsOverrides({
        renameSync: () => { throw fault('EBUSY', 'injected bind-mount rename failure'); }
    });

    assert.throws(
        () => rewriteEnvFileAtomically(state.envFile, () => 'WIIM_IP=198.51.100.4\n', { fs: failingFs }),
        error => error.code === 'ENV_FILE_RENAME_FAILED'
    );
    assertOriginalIntact(state);
});

test('directory fsync failure is reported as committed and outcome-ambiguous', t => {
    const state = fixture(t);
    const replacement = 'PANEL_PASSWORD=keep-me\nWIIM_IP=203.0.113.44\n';
    let fsyncCalls = 0;
    const failingFs = withFsOverrides({
        fsyncSync(descriptor) {
            fsyncCalls += 1;
            if (fsyncCalls === 2) throw fault('EIO', 'injected directory fsync failure');
            return fs.fsyncSync(descriptor);
        }
    });

    assert.throws(
        () => rewriteEnvFileAtomically(state.envFile, () => replacement, { fs: failingFs }),
        error => error.code === 'ENV_FILE_DIRECTORY_SYNC_FAILED'
            && error.committed === true
            && error.ambiguous === true
            && error.outcome === 'committed_durability_unknown'
    );
    assert.equal(fs.readFileSync(state.envFile, 'utf8'), replacement);
    assert.deepEqual(fs.readdirSync(state.directory).filter(name => name.includes('.tmp-')), []);
});

test('production server startup refuses a missing ENV_FILE before listening', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-env-startup-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const missing = path.join(directory, 'missing.env');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_ENV: 'production',
            SMARTHUB_ENV_FILE: missing
        },
        encoding: 'utf8',
        timeout: 5_000
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ENV_FILE_UNAVAILABLE/);
});

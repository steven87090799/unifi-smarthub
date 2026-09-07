'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runPreflight, validateSqlite } = require('../scripts/production-preflight');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-production-preflight-'));
    const config = path.join(root, 'config');
    const data = path.join(root, 'data');
    fs.mkdirSync(config, { mode: 0o700 });
    fs.mkdirSync(data, { mode: 0o700 });
    const database = new Database(path.join(data, 'smarthub.db'));
    database.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT)');
    database.close();
    const secret = 'preflight-secret-do-not-print';
    const envFile = path.join(config, '.env');
    fs.writeFileSync(envFile, [
        `PANEL_PASSWORD=${secret}`,
        'PANEL_REQUIRE_HTTPS=true',
        'PANEL_ALLOW_INSECURE_HTTP=false',
        'SMARTHUB_INTERNET_PROXY_MODE=disabled',
        ''
    ].join('\n'), { mode: 0o600 });
    return { root, config, data, envFile, secret };
}

function environment(f) {
    return {
        NODE_ENV: 'production',
        SMARTHUB_ENV_FILE: f.envFile,
        DATA_DIR: f.data,
        PANEL_PASSWORD: f.secret,
        PANEL_REQUIRE_HTTPS: 'true',
        PANEL_ALLOW_INSECURE_HTTP: 'false',
        SMARTHUB_INTERNET_PROXY_MODE: 'disabled'
    };
}

test('production preflight validates config/data write probes and leaves no probe files or config changes', () => {
    const f = fixture();
    try {
        const before = crypto.createHash('sha256').update(fs.readFileSync(f.envFile)).digest('hex');
        const result = runPreflight({ env: environment(f), nodeVersion: '24.18.0' });
        assert.equal(result.ok, true);
        assert.equal(result.sqlite, 'passed');
        assert.equal(fs.readdirSync(f.config).some(name => name.startsWith('.smarthub-production-preflight-')), false);
        assert.equal(fs.readdirSync(f.data).some(name => name.startsWith('.smarthub-production-preflight-')), false);
        const after = crypto.createHash('sha256').update(fs.readFileSync(f.envFile)).digest('hex');
        assert.equal(after, before);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight rejects an env file that the process cannot read and write', () => {
    const f = fixture();
    try {
        const guardedFs = {
            ...fs,
            accessSync(file, mode) {
                if (file === f.envFile && mode === (fs.constants.R_OK | fs.constants.W_OK)) {
                    const error = new Error('read-only fixture');
                    error.code = 'EACCES';
                    throw error;
                }
                return fs.accessSync(file, mode);
            }
        };
        assert.throws(
            () => runPreflight({ env: environment(f), nodeVersion: '24.18.0', fs: guardedFs }),
            error => error.check === 'config-env-file'
        );
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight never skips a missing SQLite database', () => {
    const f = fixture();
    try {
        fs.unlinkSync(path.join(f.data, 'smarthub.db'));
        assert.throws(
            () => runPreflight({ env: environment(f), nodeVersion: '24.18.0' }),
            error => error.check === 'sqlite-quick-check'
        );
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('SQLite preflight rejects unreadable or corrupt databases and offline writer locks', () => {
    const f = fixture();
    const dbFile = path.join(f.data, 'smarthub.db');
    try {
        const guardedFs = {
            ...fs,
            accessSync(file, mode) {
                if (file === dbFile && mode === (fs.constants.R_OK | fs.constants.W_OK)) {
                    const error = new Error('read-only database fixture');
                    error.code = 'EACCES';
                    throw error;
                }
                return fs.accessSync(file, mode);
            }
        };
        assert.throws(() => validateSqlite(f.data, { fs: guardedFs }), error => error.check === 'sqlite-quick-check');

        fs.writeFileSync(dbFile, 'not sqlite', { mode: 0o600 });
        assert.throws(() => validateSqlite(f.data), error => error.check === 'sqlite-quick-check');

        fs.unlinkSync(dbFile);
        const replacement = new Database(dbFile);
        replacement.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
        replacement.exec('BEGIN IMMEDIATE');
        try {
            assert.throws(
                () => validateSqlite(f.data, { offline: true, databaseFactory: (file, options) => new Database(file, { ...options, timeout: 50 }) }),
                error => error.check === 'sqlite-quick-check'
            );
        } finally {
            replacement.exec('ROLLBACK');
            replacement.close();
        }
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight fails when config cannot perform the atomic write probe', () => {
    const f = fixture();
    try {
        fs.chmodSync(f.config, 0o500);
        assert.throws(
            () => runPreflight({ env: environment(f), nodeVersion: '24.18.0' }),
            error => error.check === 'config-env-file'
        );
    } finally {
        fs.chmodSync(f.config, 0o700);
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('preflight output contract contains no environment file contents', () => {
    const f = fixture();
    try {
        const result = runPreflight({ env: environment(f), nodeVersion: '24.18.0' });
        const output = JSON.stringify(result);
        assert.doesNotMatch(output, new RegExp(f.secret, 'u'));
        assert.doesNotMatch(output, /PANEL_PASSWORD=[^,}]+/u);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight rejects invalid trusted proxy and Internet proxy modes', () => {
    const f = fixture();
    try {
        assert.throws(
            () => runPreflight({ env: { ...environment(f), PANEL_TRUSTED_PROXIES: '*' }, nodeVersion: '24.18.0' }),
            error => error.check === 'panel-trusted-proxies'
        );
        assert.throws(
            () => runPreflight({ env: { ...environment(f), SMARTHUB_INTERNET_PROXY_MODE: 'all' }, nodeVersion: '24.18.0' }),
            error => error.check === 'internet-proxy-mode'
        );
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight rejects ambiguous panel transport flags', () => {
    const f = fixture();
    try {
        assert.throws(
            () => runPreflight({ env: { ...environment(f), PANEL_REQUIRE_HTTPS: 'yes' }, nodeVersion: '24.18.0' }),
            error => error.check === 'panel-transport'
        );
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight enforces a non-placeholder panel password of at least 16 characters', () => {
    const f = fixture();
    try {
        for (const password of ['', '1', '123456789012345']) {
            assert.throws(
                () => runPreflight({ env: { ...environment(f), PANEL_PASSWORD: password }, nodeVersion: '24.18.0' }),
                error => error.check === 'panel-password'
            );
        }
        assert.doesNotThrow(() => runPreflight({
            env: { ...environment(f), PANEL_PASSWORD: '1234567890abcdef' },
            nodeVersion: '24.18.0'
        }));
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight rejects known and example password placeholders', () => {
    const f = fixture();
    try {
        for (const password of [
            'password', 'admin', 'administrator', 'changeme', 'change-me', '123456', '12345678',
            'your_password', 'your_panel_password', 'example', 'test', 'ci-only-strong-test-password',
            '<set-a-password>', '${PANEL_PASSWORD}'
        ]) {
            assert.throws(
                () => runPreflight({ env: { ...environment(f), PANEL_PASSWORD: password }, nodeVersion: '24.18.0' }),
                error => error.check === 'panel-password',
                password
            );
        }
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('production preflight validates a configured readonly password independently and requires separation', () => {
    const f = fixture();
    try {
        const strongAdmin = '1234567890abcdef';
        assert.doesNotThrow(() => runPreflight({
            env: {
                ...environment(f), PANEL_PASSWORD: strongAdmin,
                PANEL_READONLY_PASSWORD: 'fedcba0987654321'
            },
            nodeVersion: '24.18.0'
        }));
        assert.throws(
            () => runPreflight({
                env: { ...environment(f), PANEL_PASSWORD: strongAdmin, PANEL_READONLY_PASSWORD: '123456789012345' },
                nodeVersion: '24.18.0'
            }),
            error => error.check === 'panel-readonly-password'
        );
        assert.throws(
            () => runPreflight({
                env: { ...environment(f), PANEL_PASSWORD: strongAdmin, PANEL_READONLY_PASSWORD: strongAdmin },
                nodeVersion: '24.18.0'
            }),
            error => error.check === 'panel-readonly-password'
        );
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

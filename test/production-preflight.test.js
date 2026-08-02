'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runPreflight } = require('../scripts/production-preflight');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-production-preflight-'));
    const config = path.join(root, 'config');
    const data = path.join(root, 'data');
    fs.mkdirSync(config, { mode: 0o700 });
    fs.mkdirSync(data, { mode: 0o700 });
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
        assert.equal(result.sqlite, 'skipped-no-database');
        assert.equal(fs.readdirSync(f.config).some(name => name.startsWith('.smarthub-production-preflight-')), false);
        assert.equal(fs.readdirSync(f.data).some(name => name.startsWith('.smarthub-production-preflight-')), false);
        const after = crypto.createHash('sha256').update(fs.readFileSync(f.envFile)).digest('hex');
        assert.equal(after, before);
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
            error => error.check === 'config-directory-write'
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

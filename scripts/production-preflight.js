'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');
const {
    MAX_CA_BYTES,
    readCaFile,
    strictBoolean
} = require('../server/integrations/tls-policy');
const { parseTrustedProxies } = require('../server/middleware/panel-security');
const { resolveInternetProxyMode } = require('../server/integrations/http-egress-policy');
const { createBuildIdentity } = require('../observability/build-identity');
const { readEnvFile } = require('../server/storage/env-file-store');
const packageJson = require('../package.json');

const DEFAULT_ENV_FILE = path.resolve(process.env.SMARTHUB_ENV_FILE || path.join(__dirname, '..', 'config', '.env'));
const CA_FIELDS = Object.freeze([
    'UNIFI_CONTROLLER_CA_FILE',
    'UNIFI_NETWORK_CA_FILE',
    'NAS_CA_FILE',
    'NAS_MONITOR_CA_FILE',
    'PPB_CA_FILE',
    'ADGUARD_CA_FILE'
]);
const PROBE_PREFIX = '.smarthub-production-preflight-';

class ProductionPreflightError extends Error {
    constructor(check, message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ProductionPreflightError';
        this.check = check;
    }
}

function fail(check, message, cause) {
    throw new ProductionPreflightError(check, message, cause);
}

function assertDirectory(directory, check) {
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) { fail(check, 'directory is unavailable', error); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(check, 'directory must be a regular directory');
}

function assertPrivateFile(file, check) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { fail(check, 'file is unavailable', error); }
    if (stat.isSymbolicLink() || !stat.isFile()) fail(check, 'file must be a regular non-symlink file');
    if ((stat.mode & 0o777) !== 0o600) fail(check, 'file permissions must be exactly 0600');
    if (stat.size <= 0) fail(check, 'file must not be empty');
}

function writeAll(descriptor, value) {
    const buffer = Buffer.from(value, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
        const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset, null);
        if (!Number.isInteger(written) || written <= 0) fail('probe-write', 'probe write made no progress');
        offset += written;
    }
}

function probeDirectory(directory, check) {
    try { fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK); }
    catch (error) { fail(check, 'directory is not writable by the current process', error); }

    const temporary = path.join(directory, `${PROBE_PREFIX}${process.pid}-${crypto.randomUUID()}`);
    const renamed = `${temporary}.renamed`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        writeAll(descriptor, 'smarthub-production-preflight\n');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, renamed);
        fs.unlinkSync(renamed);
    } catch (error) {
        fail(check, 'temporary file fsync/atomic rename/unlink probe failed', error);
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { }
        }
        for (const file of [temporary, renamed]) {
            try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') { /* cleanup is best effort */ } }
        }
    }
    return 'passed';
}

function validateAllowedOrigins(value) {
    if (value === undefined || value === null || String(value).trim() === '') return;
    for (const entry of String(value).split(',')) {
        const raw = entry.trim();
        if (!raw) continue;
        let origin;
        try { origin = new URL(raw); }
        catch (error) { fail('panel-allowed-origins', 'PANEL_ALLOWED_ORIGINS contains an invalid origin', error); }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.origin === 'null') {
            fail('panel-allowed-origins', 'PANEL_ALLOWED_ORIGINS must contain HTTP(S) origins without credentials');
        }
    }
}

function validateNodeEngine(nodeVersion = process.versions.node) {
    const range = String(packageJson.engines?.node || '');
    const match = range.match(/>=\s*(\d+)\.(\d+)\.(\d+)\s*<\s*(\d+)/u);
    if (!match) fail('node-engine', 'package.json node engine range is not supported by preflight');
    const [, minMajorText, minMinorText, minPatchText, maxMajorText] = match;
    const [major, minor, patch] = String(nodeVersion).split('.').map(Number);
    const minMajor = Number(minMajorText);
    const minMinor = Number(minMinorText);
    const minPatch = Number(minPatchText);
    const maxMajor = Number(maxMajorText);
    const below = major < minMajor || (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)));
    if (below || major >= maxMajor) fail('node-engine', 'running Node.js version is outside package.json engines');
}

function validateSqlite(dataDirectory) {
    const file = path.join(dataDirectory, 'smarthub.db');
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
        if (error?.code === 'ENOENT') return 'skipped-no-database';
        fail('sqlite-quick-check', 'SQLite database is unavailable', error);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('sqlite-quick-check', 'SQLite database must be a regular file');
    let database;
    try {
        database = new Database(file, { readonly: true, fileMustExist: true });
        const result = database.pragma('quick_check');
        if (result.length !== 1 || result[0].quick_check !== 'ok') fail('sqlite-quick-check', 'SQLite quick_check did not return ok');
    } catch (error) {
        if (error instanceof ProductionPreflightError) throw error;
        fail('sqlite-quick-check', 'SQLite quick_check failed', error);
    } finally {
        try { database?.close(); } catch { }
    }
    return 'passed';
}

function runPreflight({ env = process.env, nodeVersion = process.versions.node } = {}) {
    validateNodeEngine(nodeVersion);
    if (env.NODE_ENV !== 'production') fail('node-environment', 'NODE_ENV must be production');

    const envFile = path.resolve(env.SMARTHUB_ENV_FILE || DEFAULT_ENV_FILE);
    const configDirectory = path.dirname(envFile);
    assertDirectory(configDirectory, 'config-directory');
    assertPrivateFile(envFile, 'config-env-file');

    let rawEnv;
    try { rawEnv = readEnvFile(envFile); }
    catch (error) { fail('config-env-read', 'config/.env cannot be read safely', error); }
    const parsed = dotenv.parse(rawEnv);
    const effective = { ...parsed, ...env };

    if (typeof effective.PANEL_PASSWORD !== 'string' || effective.PANEL_PASSWORD.length === 0) {
        fail('panel-password', 'PANEL_PASSWORD must be configured');
    }
    if (effective.PANEL_READONLY_PASSWORD && effective.PANEL_READONLY_PASSWORD === effective.PANEL_PASSWORD) {
        fail('panel-readonly-password', 'PANEL_READONLY_PASSWORD must differ from PANEL_PASSWORD');
    }
    let requireHttps;
    let allowInsecureHttp;
    try {
        requireHttps = strictBoolean(effective.PANEL_REQUIRE_HTTPS, 'PANEL_REQUIRE_HTTPS', true);
        allowInsecureHttp = strictBoolean(effective.PANEL_ALLOW_INSECURE_HTTP, 'PANEL_ALLOW_INSECURE_HTTP', false);
    } catch (error) {
        fail('panel-transport', 'production panel transport flags are invalid', error);
    }
    if (!requireHttps || allowInsecureHttp) fail('panel-transport', 'production preflight requires HTTPS and disallows insecure HTTP');
    try { parseTrustedProxies(effective.PANEL_TRUSTED_PROXIES); }
    catch (error) { fail('panel-trusted-proxies', 'PANEL_TRUSTED_PROXIES is invalid', error); }
    validateAllowedOrigins(effective.PANEL_ALLOWED_ORIGINS);
    try { resolveInternetProxyMode(effective.SMARTHUB_INTERNET_PROXY_MODE); }
    catch (error) { fail('internet-proxy-mode', 'Internet proxy mode is invalid', error); }

    const configProbe = probeDirectory(configDirectory, 'config-directory-write');
    const dataDirectory = path.resolve(effective.DATA_DIR || '/app/data');
    assertDirectory(dataDirectory, 'data-directory');
    probeDirectory(dataDirectory, 'data-directory-write');

    for (const field of CA_FIELDS) {
        const file = String(effective[field] || '').trim();
        if (!file) continue;
        if (!path.isAbsolute(file)) fail(`ca-${field}`, `${field} must be an absolute path`);
        if (file.length > 4096) fail(`ca-${field}`, `${field} path is too long`);
        try { readCaFile(file, { field }); }
        catch (error) { fail(`ca-${field}`, `${field} is not a safe readable CA file (maximum ${MAX_CA_BYTES} bytes)`, error); }
    }

    const buildIdentityRequired = effective.BUILD_IDENTITY_REQUIRED === 'true';
    if (effective.BUILD_IDENTITY_REQUIRED !== undefined && !['true', 'false'].includes(String(effective.BUILD_IDENTITY_REQUIRED))) {
        fail('build-identity-required', 'BUILD_IDENTITY_REQUIRED must be true or false');
    }
    if (buildIdentityRequired) {
        try { createBuildIdentity(effective, { requireClean: true }); }
        catch (error) { fail('build-identity', 'a complete clean build identity is required', error); }
    }

    return Object.freeze({
        ok: true,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
        gid: typeof process.getgid === 'function' ? process.getgid() : null,
        envFile,
        configProbe,
        sqlite: validateSqlite(dataDirectory),
        checks: Object.freeze([
            'node-engine', 'node-environment', 'panel-password', 'panel-transport',
            'config-env-file', 'config-directory-write', 'data-directory-write',
            'internet-proxy-mode', 'ca-files', 'sqlite-quick-check', 'build-identity'
        ])
    });
}

function main() {
    try {
        const result = runPreflight();
        process.stdout.write(`production-preflight PASS uid=${result.uid ?? 'unknown'} gid=${result.gid ?? 'unknown'} checks=${result.checks.length}\n`);
    } catch (error) {
        const check = error instanceof ProductionPreflightError ? error.check : 'unknown';
        const message = error instanceof ProductionPreflightError ? error.message : 'preflight failed';
        process.stderr.write(`production-preflight FAIL check=${check} reason=${message}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    CA_FIELDS,
    ProductionPreflightError,
    main,
    probeDirectory,
    runPreflight,
    validateAllowedOrigins,
    validateNodeEngine,
    validateSqlite
};

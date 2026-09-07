'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    isTrustedLanEndpoint,
    parseTrustedLanHosts,
    resolveIntegrationTlsPolicy,
    resolveTrustedLanTarget,
    strictBoolean
} = require('../server/integrations/trusted-lan-policy');

const PRIVATE_TARGETS = [
    '127.0.0.1', 'localhost', '10.0.0.1', '172.16.0.1', '172.31.255.254',
    '192.168.1.1', '169.254.1.1', '::1', 'fc00::1', 'fd12:3456::1',
    'fe80::1', 'host.docker.internal'
];

function exampleEnvironment() {
    const source = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    return Object.fromEntries(source.split(/\r?\n/u).flatMap(line => {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
        return match ? [[match[1], match[2]]] : [];
    }));
}

test('Trusted LAN classification accepts only the bounded private target set', () => {
    for (const endpoint of PRIVATE_TARGETS) assert.equal(isTrustedLanEndpoint(endpoint, { enabled: true }), true, endpoint);
    assert.equal(isTrustedLanEndpoint('nas.home.lan', { enabled: true, trustedHosts: 'nas.home.lan, adguard.home.lan' }), true);
    assert.equal(isTrustedLanEndpoint('NAS.HOME.LAN.', { enabled: true, trustedHosts: 'nas.home.lan' }), true);
    for (const endpoint of [
        '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', 'api.ui.com',
        'api.telegram.org', 'discord.com', 'example.com', 'evilhost.docker.internal.example',
        'local-attacker.example', 'https://api.ui.com/v1'
    ]) assert.equal(isTrustedLanEndpoint(endpoint, { enabled: true }), false, endpoint);
    assert.equal(isTrustedLanEndpoint('nas.home.lan.evil', { enabled: true, trustedHosts: 'nas.home.lan' }), false);
    assert.equal(isTrustedLanEndpoint('nas.home.lan', { enabled: false, trustedHosts: 'nas.home.lan' }), false);
});

test('Trusted LAN classification is disabled when the master switch is omitted', () => {
    const target = resolveTrustedLanTarget({ endpoint: '192.168.1.50' });
    assert.equal(target.enabled, false);
    assert.equal(target.trusted, false);
    assert.equal(target.source, null);
});

test('Trusted LAN host allowlist is exact and rejects wildcard or ambiguous entries', () => {
    assert.deepEqual(parseTrustedLanHosts('nas.home.lan, adguard.home.lan'), ['nas.home.lan', 'adguard.home.lan']);
    for (const value of ['*.home.lan', 'nas.home.lan evil', 'nas..home.lan', '8.8.8.8']) {
        assert.throws(() => parseTrustedLanHosts(value), /exact hostnames|wildcard|whitespace/u);
    }
    assert.throws(() => strictBoolean('TRUE'), /exactly true or false/u);
});

test('Trusted LAN TLS and HTTP policy remains strict for public endpoints', () => {
    const fields = {
        url: 'URL', verify: 'TLS_VERIFY', insecure: 'TLS_INSECURE',
        ca: 'CA_FILE', allowHttp: 'ALLOW_INSECURE_HTTP'
    };
    const privateHttps = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.20:8443', integration: 'nas', env: { TRUSTED_LAN_MODE: 'true' }, fields
    });
    assert.equal(privateHttps.verify, false);
    assert.equal(privateHttps.insecure, true);
    assert.equal(privateHttps.mode, 'trusted-lan-insecure');

    const privateHttp = resolveIntegrationTlsPolicy({
        url: 'http://192.168.1.20:8080', integration: 'nas', env: { TRUSTED_LAN_MODE: 'true' }, fields
    });
    assert.equal(privateHttp.protocol, 'http:');
    assert.equal(privateHttp.allowInsecureHttp, true);

    const publicHttps = resolveIntegrationTlsPolicy({
        url: 'https://example.com', integration: 'nas', env: { TRUSTED_LAN_MODE: 'true' }, fields
    });
    assert.equal(publicHttps.verify, true);
    assert.equal(publicHttps.insecure, false);
    assert.equal(publicHttps.mode, 'verified');
    assert.throws(() => resolveIntegrationTlsPolicy({
        url: 'http://8.8.8.8', integration: 'nas', env: { TRUSTED_LAN_MODE: 'true' }, fields
    }), /non-loopback HTTP/u);

    const strict = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.20:8443', integration: 'nas', env: { TRUSTED_LAN_MODE: 'false' }, fields
    });
    assert.equal(strict.mode, 'verified');
    assert.throws(() => resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.20:8443', integration: 'nas',
        env: { TRUSTED_LAN_MODE: 'false', TLS_VERIFY: 'false', TLS_INSECURE: 'false' },
        fields
    }), /requires explicit/u);
});

test('Trusted LAN master switch derives private compatibility only after explicit opt-in', () => {
    const fields = {
        verify: 'NAS_TLS_VERIFY', insecure: 'NAS_TLS_INSECURE',
        ca: 'NAS_CA_FILE', allowHttp: 'NAS_ALLOW_INSECURE_HTTP'
    };
    const example = exampleEnvironment();
    const safeDefault = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.50:9443', integration: 'nas', env: example, fields
    });
    assert.equal(safeDefault.mode, 'verified');
    assert.equal(safeDefault.verify, true);
    assert.equal(safeDefault.insecure, false);
    assert.equal(safeDefault.allowInsecureHttp, false);
    assert.equal(safeDefault.trustedLanApplied, false);

    const enabled = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.50:9443', integration: 'nas', env: { ...example, TRUSTED_LAN_MODE: 'true' }, fields
    });
    assert.equal(enabled.mode, 'trusted-lan-insecure');
    assert.equal(enabled.verify, false);
    assert.equal(enabled.insecure, true);
    assert.equal(enabled.allowInsecureHttp, true);
    assert.equal(enabled.trustedLanApplied, true);

    const disabled = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.50:9443', integration: 'nas', env: { ...example, TRUSTED_LAN_MODE: 'false' }, fields
    });
    assert.equal(disabled.mode, 'verified');
    assert.equal(disabled.verify, true);
    assert.equal(disabled.insecure, false);
    assert.equal(disabled.allowInsecureHttp, false);
    assert.equal(disabled.trustedLanApplied, false);
});

test('manual insecure flags remain explicit and are never labelled as Trusted LAN', () => {
    const policy = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.50:9443', integration: 'nas',
        env: {
            TRUSTED_LAN_MODE: 'true', NAS_TLS_VERIFY: 'false',
            NAS_TLS_INSECURE: 'true', NAS_ALLOW_INSECURE_HTTP: 'true'
        },
        fields: {
            verify: 'NAS_TLS_VERIFY', insecure: 'NAS_TLS_INSECURE',
            ca: 'NAS_CA_FILE', allowHttp: 'NAS_ALLOW_INSECURE_HTTP'
        }
    });
    assert.equal(policy.mode, 'explicitly-insecure');
    assert.equal(policy.trustedLan, true);
    assert.equal(policy.trustedLanApplied, false);
});

test('explicit private CA remains private-ca and wins over Trusted LAN defaults', () => {
    const policy = resolveIntegrationTlsPolicy({
        url: 'https://192.168.1.20:8443', integration: 'nas',
        env: { TRUSTED_LAN_MODE: 'true', NAS_CA_FILE: '/run/secrets/nas-ca.pem' },
        fields: { ca: 'NAS_CA_FILE' },
        fileSystem: {
            lstatSync: () => ({ isFile: () => true, size: 8 }),
            openSync: () => 1,
            fstatSync: () => ({ isFile: () => true, size: 8 }),
            readFileSync: () => Buffer.from('ca-bytes'),
            closeSync: () => {}
        }
    });
    assert.equal(policy.mode, 'private-ca');
    assert.equal(policy.verify, true);
    assert.equal(policy.insecure, false);
});

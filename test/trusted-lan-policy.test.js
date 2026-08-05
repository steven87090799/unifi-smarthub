'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    fingerprintFromKey,
    normalizeFingerprint,
    resolveHostKeyPolicy
} = require('../server/integrations/ssh-host-key-policy');

test('SSH host identity policy matches, rejects rotation, and fails closed when unconfigured', () => {
    const key = Buffer.from('fixture-host-key');
    const fingerprint = fingerprintFromKey(key);
    const configured = resolveHostKeyPolicy({ fingerprint, field: 'UCG_SSH_HOST_KEY' });
    assert.equal(configured.configured, true);
    assert.equal(configured.verifier(key), true);
    assert.equal(configured.verifier(Buffer.from('rotated-host-key')), false);
    assert.equal(normalizeFingerprint(`${fingerprint}=`), fingerprint);
    assert.equal(resolveHostKeyPolicy({ field: 'LINUX_SSH_HOST_KEY' }).error, 'host_key_not_configured');
    assert.equal(resolveHostKeyPolicy({ allowUnpinned: true }).warning, true);
    assert.throws(() => resolveHostKeyPolicy({ allowUnpinned: 'yes' }), /exactly true or false/u);
});

test('Trusted LAN SSH permits only private unpinned targets and preserves configured pinning', () => {
    const privatePolicy = resolveHostKeyPolicy({
        host: '192.168.1.20', trustedLanMode: true, field: 'UCG_SSH_HOST_KEY'
    });
    assert.equal(privatePolicy.warning, true);
    assert.equal(privatePolicy.verifier(Buffer.from('any-key')), true);
    assert.equal(resolveHostKeyPolicy({
        host: '8.8.8.8', trustedLanMode: true, field: 'UCG_SSH_HOST_KEY'
    }).error, 'host_key_not_configured');
    assert.equal(resolveHostKeyPolicy({
        host: 'public.example', trustedLanMode: true, allowUnpinned: true, field: 'UCG_SSH_HOST_KEY'
    }).error, 'trusted_lan_target_required');
    const fingerprint = fingerprintFromKey(Buffer.from('pinned-key'));
    const pinned = resolveHostKeyPolicy({
        host: '8.8.8.8', trustedLanMode: true, fingerprint, field: 'UCG_SSH_HOST_KEY'
    });
    assert.equal(pinned.configured, true);
    assert.equal(pinned.verifier(Buffer.from('rotated-key')), false);
});

test('SSH Trusted LAN mode normalizes string booleans before target policy decisions', () => {
    assert.equal(resolveHostKeyPolicy({
        host: '192.168.1.20', trustedLanMode: 'false', allowUnpinned: false,
        field: 'UCG_SSH_HOST_KEY'
    }).error, 'host_key_not_configured');
    assert.equal(resolveHostKeyPolicy({
        host: '192.168.1.20', trustedLanMode: 'true', allowUnpinned: false,
        field: 'UCG_SSH_HOST_KEY'
    }).warning, true);
    assert.equal(resolveHostKeyPolicy({
        host: '8.8.8.8', trustedLanMode: 'true', allowUnpinned: false,
        field: 'UCG_SSH_HOST_KEY'
    }).error, 'host_key_not_configured');

    const fingerprint = fingerprintFromKey(Buffer.from('public-pinned-key'));
    const pinned = resolveHostKeyPolicy({
        host: '8.8.8.8', trustedLanMode: 'true', allowUnpinned: false,
        fingerprint, field: 'UCG_SSH_HOST_KEY'
    });
    assert.equal(pinned.configured, true);
    assert.equal(pinned.verifier(Buffer.from('public-pinned-key')), true);

    const explicitLegacy = resolveHostKeyPolicy({
        host: '8.8.8.8', trustedLanMode: 'false', allowUnpinned: true,
        field: 'UCG_SSH_HOST_KEY'
    });
    assert.equal(explicitLegacy.warning, true);
    assert.equal(explicitLegacy.error, undefined);
});

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

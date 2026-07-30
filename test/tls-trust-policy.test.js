'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTlsAgent, exactBoolean, readPrivateCa } = require('../server/services/tls-trust-policy');

function fakeFs(content = Buffer.from('CA')) {
    return {
        lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: content.length }),
        readFileSync: () => content
    };
}
class FakeAgent { constructor(options) { this.options = options; } }

test('TLS trust defaults to verification and only exact true opts into insecure mode', () => {
    const secure = createTlsAgent({}, 'UNIFI', { fileSystem: fakeFs(), httpsModule: { Agent: FakeAgent } });
    assert.equal(secure.insecure, false);
    assert.equal(secure.agent.options.rejectUnauthorized, true);
    const insecure = createTlsAgent({ UNIFI_TLS_INSECURE: 'true' }, 'UNIFI', { fileSystem: fakeFs(), httpsModule: { Agent: FakeAgent } });
    assert.equal(insecure.agent.options.rejectUnauthorized, false);
    assert.throws(() => exactBoolean('TRUE', 'UNIFI_TLS_INSECURE'), /true or false/u);
});

test('TLS custom CA is bounded, absolute, and never accepts symlink authority', () => {
    assert.deepEqual(readPrivateCa('/app/config/ca.pem', 'UNIFI_CA_FILE', fakeFs()), Buffer.from('CA'));
    assert.throws(() => readPrivateCa('relative.pem', 'UNIFI_CA_FILE', fakeFs()), /absolute/u);
    const symlinkFs = { ...fakeFs(), lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true, size: 2 }) };
    assert.throws(() => readPrivateCa('/app/config/ca.pem', 'UNIFI_CA_FILE', symlinkFs), /regular/u);
});

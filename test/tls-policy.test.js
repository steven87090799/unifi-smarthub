'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const axios = require('axios');
const {
    createHttpsAgent,
    destroyAgent,
    resolveTlsPolicy
} = require('../server/integrations/tls-policy');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function close(server) { return new Promise(resolve => server.close(resolve)); }

test('controller and NAS TLS policy uses a real local HTTPS server for verify, private CA, insecure, and rebuild paths', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-tls-policy-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const keyFile = path.join(directory, 'server-key.pem');
    const certFile = path.join(directory, 'server-cert.pem');
    const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
        '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign'
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || 'openssl certificate generation failed');
    const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);
    t.after(() => close(server));
    const url = `https://127.0.0.1:${port}`;

    for (const fields of [
        { url: 'UNIFI_CONTROLLER_URL', verify: 'UNIFI_CONTROLLER_TLS_VERIFY', insecure: 'UNIFI_CONTROLLER_TLS_INSECURE', ca: 'UNIFI_CONTROLLER_CA_FILE', allowHttp: 'UNIFI_CONTROLLER_ALLOW_INSECURE_HTTP' },
        { url: 'NAS_URL', verify: 'NAS_TLS_VERIFY', insecure: 'NAS_TLS_INSECURE', ca: 'NAS_CA_FILE', allowHttp: 'NAS_ALLOW_INSECURE_HTTP' }
    ]) {
        const secureDefault = resolveTlsPolicy({ url, fields });
        const secureAgent = createHttpsAgent(secureDefault);
        await assert.rejects(
            axios.get(url, { httpsAgent: secureAgent, proxy: false }),
            /self-signed|certificate|DEPTH_ZERO_SELF_SIGNED_CERT/u
        );
        destroyAgent(secureAgent);

        const privateCa = resolveTlsPolicy({ url, caFile: certFile, fields });
        const privateCaAgent = createHttpsAgent(privateCa);
        assert.deepEqual((await axios.get(url, { httpsAgent: privateCaAgent, proxy: false })).data, { ok: true });
        destroyAgent(privateCaAgent);

        const explicitlyInsecure = resolveTlsPolicy({ url, insecure: 'true', fields });
        const insecureAgent = createHttpsAgent(explicitlyInsecure);
        assert.deepEqual((await axios.get(url, { httpsAgent: insecureAgent, proxy: false })).data, { ok: true });
        destroyAgent(insecureAgent);

        const invalidCa = path.join(directory, `${fields.ca}-invalid.pem`);
        fs.writeFileSync(invalidCa, 'not a certificate\n', { mode: 0o600 });
        const invalidCaAgent = createHttpsAgent(resolveTlsPolicy({ url, caFile: invalidCa, fields }));
        await assert.rejects(axios.get(url, { httpsAgent: invalidCaAgent, proxy: false }), /certificate|PEM|CA/u);
        destroyAgent(invalidCaAgent);
    }

    assert.throws(() => resolveTlsPolicy({ url, verify: 'false', fields: { verify: 'TLS_VERIFY', insecure: 'TLS_INSECURE' } }), /requires explicit/u);
    assert.throws(() => resolveTlsPolicy({ url: 'http://192.0.2.10:443', fields: { url: 'UNIFI_CONTROLLER_URL', allowHttp: 'UNIFI_CONTROLLER_ALLOW_INSECURE_HTTP' } }), /non-loopback HTTP/u);
    const oldAgent = createHttpsAgent(resolveTlsPolicy({ url, caFile: certFile }));
    const newAgent = createHttpsAgent(resolveTlsPolicy({ url, caFile: certFile }));
    destroyAgent(oldAgent);
    destroyAgent(newAgent);
});

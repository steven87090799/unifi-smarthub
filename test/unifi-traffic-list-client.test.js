'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    EMPTY_LIST_SENTINEL,
    UniFiTrafficListError,
    createUniFiTrafficListClient,
    readConfiguration
} = require('../server/integrations/unifi-traffic-list-client');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const LIST_ID = '22222222-2222-4222-8222-222222222222';
const ENV = Object.freeze({
    UNIFI_CONTROLLER_URL: 'https://192.168.1.1',
    UNIFI_NETWORK_API_KEY: 'integration-key',
    UNIFI_NETWORK_SITE_ID: SITE_ID,
    UNIFI_THREAT_BLOCK_LIST_ID: LIST_ID,
    UNIFI_THREAT_BLOCK_LIST_NAME: 'SmartHub Threat Blocks'
});

function list(items) {
    return {
        id: LIST_ID,
        name: 'SmartHub Threat Blocks',
        type: 'IPV4_ADDRESSES',
        items: items.map(value => ({ type: 'IP_ADDRESS', value }))
    };
}

test('configuration derives the official local Integration API base and fails closed on missing identity', () => {
    assert.deepEqual(readConfiguration(ENV), {
        configured: true,
        missing: [],
        baseUrl: 'https://192.168.1.1/proxy/network/integration',
        apiKey: 'integration-key',
        siteId: SITE_ID,
        listId: LIST_ID,
        listName: 'SmartHub Threat Blocks',
        tlsVerify: true,
        tlsInsecure: false,
        caFile: '',
        allowInsecureHttp: false
    });
    const missing = readConfiguration({ UNIFI_CONTROLLER_URL: 'https://192.168.1.1' });
    assert.equal(missing.configured, false);
    assert.deepEqual(missing.missing.sort(), [
        'UNIFI_NETWORK_API_KEY', 'UNIFI_NETWORK_SITE_ID', 'UNIFI_THREAT_BLOCK_LIST_ID'
    ].sort());
});

test('configuration rejects credential-bearing remote plaintext and ambiguous URLs while TLS verification is explicit', () => {
    for (const url of [
        'http://192.168.1.1/proxy/network/integration',
        'https://192.168.1.1/proxy/network/integration?key=leak',
        'https://192.168.1.1/proxy/network/integration#fragment'
    ]) {
        const configuration = readConfiguration({ ...ENV, UNIFI_NETWORK_API_URL: url });
        assert.equal(configuration.configured, false);
        assert.ok(configuration.missing.includes('UNIFI_NETWORK_API_URL'));
    }
    const loopback = readConfiguration({
        ...ENV,
        UNIFI_NETWORK_API_URL: 'https://127.0.0.1:8080',
        UNIFI_NETWORK_TLS_VERIFY: 'false',
        UNIFI_NETWORK_TLS_INSECURE: 'true'
    });
    assert.equal(loopback.configured, true);
    assert.equal(loopback.tlsVerify, false);
    assert.equal(loopback.tlsInsecure, true);
    const remoteHttp = readConfiguration({
        ...ENV,
        UNIFI_NETWORK_API_URL: 'http://192.168.1.1',
        UNIFI_NETWORK_ALLOW_INSECURE_HTTP: 'true'
    });
    assert.equal(remoteHttp.configured, true);
    assert.equal(remoteHttp.allowInsecureHttp, true);
    const invalidTls = readConfiguration({ ...ENV, UNIFI_NETWORK_TLS_VERIFY: 'FALSE' });
    assert.equal(invalidTls.configured, false);
    assert.ok(invalidTls.missing.includes('UNIFI_NETWORK_TLS_VERIFY'));
});

test('replace performs a full official PUT, retains the empty-list sentinel, and is idempotent', async () => {
    const requests = [];
    let remote = list([EMPTY_LIST_SENTINEL]);
    const client = createUniFiTrafficListClient({
        getEnvironment: () => ENV,
        transport: async request => {
            requests.push(request);
            assert.equal(request.headers['X-API-Key'], 'integration-key');
            assert.equal(request.tlsVerify, true);
            if (request.method === 'PUT') remote = { id: LIST_ID, ...request.data };
            return { data: remote };
        }
    });
    const changed = await client.replace(['8.8.8.8']);
    assert.equal(changed.changed, true);
    assert.deepEqual(requests.map(request => request.method), ['GET', 'PUT']);
    assert.match(requests[0].url, new RegExp(`/v1/sites/${SITE_ID}/traffic-matching-lists/${LIST_ID}$`));
    assert.deepEqual(requests[1].data, {
        type: 'IPV4_ADDRESSES',
        name: 'SmartHub Threat Blocks',
        items: [EMPTY_LIST_SENTINEL, '8.8.8.8'].sort().map(value => ({ type: 'IP_ADDRESS', value }))
    });
    requests.length = 0;
    const unchanged = await client.replace(['8.8.8.8', '8.8.8.8']);
    assert.equal(unchanged.changed, false);
    assert.deepEqual(requests.map(request => request.method), ['GET']);
});

test('replace rejects wrong list identity, unsafe matcher types, and classifies transient transport failure', async () => {
    for (const remote of [
        { ...list([EMPTY_LIST_SENTINEL]), name: 'Manual list' },
        { ...list([EMPTY_LIST_SENTINEL]), items: [{ type: 'SUBNET', value: '8.8.8.0/24' }] }
    ]) {
        const client = createUniFiTrafficListClient({
            getEnvironment: () => ENV,
            transport: async () => ({ data: remote })
        });
        await assert.rejects(client.replace(['8.8.8.8']), error => (
            error instanceof UniFiTrafficListError && ['list_identity_mismatch', 'unsafe_list_contents'].includes(error.code)
        ));
    }
    const unavailable = createUniFiTrafficListClient({
        getEnvironment: () => ENV,
        transport: async () => {
            const error = new Error('unavailable');
            error.response = { status: 503 };
            throw error;
        }
    });
    await assert.rejects(unavailable.replace([]), error => (
        error instanceof UniFiTrafficListError && error.code === 'upstream_http_503' && error.retryable === true
    ));
});

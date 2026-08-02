'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createWiimClient,
    DEFAULT_FRESH_CACHE_MS,
    DEFAULT_MAX_STALE_MS,
    parseWiimTemperatures
} = require('../server/services/wiim-client');

const deferred = () => {
    let resolve;
    const promise = new Promise(next => { resolve = next; });
    return { promise, resolve };
};

test('parallel WiiM status requests share one per-command in-flight request', async () => {
    const gate = deferred();
    let calls = 0;
    const client = createWiimClient({
        getIp: () => '192.168.1.20',
        request: async () => {
            calls += 1;
            await gate.promise;
            return { state: 'play' };
        }
    });
    const requests = [
        client.get('getStatusEx'),
        client.get('getStatusEx', { forceRefresh: true }),
        client.get('getStatusEx')
    ];
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(client.inflightCount(), 1);
    gate.resolve();
    const results = await Promise.all(requests);
    assert.equal(calls, 1);
    assert.equal(new Set(results.map(result => result.sampleId)).size, 1);
    assert.equal(results[0].fetchedAt, results[1].fetchedAt);
    assert.equal(client.inflightCount(), 0);
});

test('reset fences an old IP in-flight response from the new cache and health state', async () => {
    const oldGate = deferred();
    let ip = '192.168.1.20';
    const hosts = [];
    const client = createWiimClient({
        getIp: () => ip,
        request: async request => {
            hosts.push(request.host);
            if (request.host === '192.168.1.20') {
                await oldGate.promise;
                return { ip: 'old', state: 'play' };
            }
            return { ip: 'new', state: 'play' };
        }
    });

    const oldRequest = client.get('getStatusEx');
    await Promise.resolve();
    ip = '192.168.1.21';
    client.reset();
    const newResult = await client.get('getStatusEx');
    oldGate.resolve();
    const oldResult = await oldRequest;

    assert.equal(oldResult.data, '{"ip":"old","state":"play"}');
    assert.equal(newResult.data, '{"ip":"new","state":"play"}');
    assert.deepEqual(hosts, ['192.168.1.20', '192.168.1.21']);
    assert.equal(client.peek('getStatusEx').data, newResult.data);
    assert.equal(client.health('getStatusEx').lastErrorAt, null);
    assert.equal(client.generation(), 1);
});

test('offline status keeps the old sample but never reports the device online', async () => {
    let now = 0;
    let offline = false;
    const client = createWiimClient({
        getIp: () => '192.168.1.20',
        now: () => now,
        freshCacheMs: 10,
        maxStaleMs: 100,
        request: async () => {
            if (offline) throw new Error('device offline');
            return { state: 'play' };
        }
    });
    const live = await client.get('getStatusEx');
    now = 20;
    offline = true;
    const stale = await client.get('getStatusEx', { allowStale: true });
    assert.equal(stale.source, 'stale_cache');
    assert.equal(stale.data, live.data);
    assert.equal(client.health('getStatusEx').online, false);
    assert.equal(client.health('getStatusEx').consecutiveFailures, 1);
    now = 200;
    assert.equal(client.peek('getStatusEx').source, 'unreachable');
});

test('WiiM client returns explicit not_configured and live results', async () => {
    let calls = 0;
    const client = createWiimClient({
        getIp: () => null,
        request: async () => { calls += 1; return { volume: 12 }; }
    });
    assert.equal((await client.get('getStatusEx')).source, 'not_configured');
    assert.equal(calls, 0);

    let now = 1000;
    const live = createWiimClient({
        getIp: () => '192.168.1.20',
        now: () => now,
        request: async request => {
            assert.equal(request.protocol, 'https:');
            assert.equal(request.host, '192.168.1.20');
            return { volume: 12 };
        }
    });
    const result = await live.get('getStatusEx');
    assert.equal(result.source, 'live');
    assert.equal(result.stale, false);
    assert.equal(result.data, '{"volume":12}');
    assert.equal(result.lastSuccessAt, 1000);
});

test('fresh and bounded stale cache states never masquerade as live or mutate success', async () => {
    let now = 1000;
    let calls = 0;
    const client = createWiimClient({
        getIp: () => '192.168.1.20',
        now: () => now,
        freshCacheMs: 10,
        maxStaleMs: 100,
        request: async request => {
            calls += 1;
            if (request.command === 'setPlayerCmd:stop') throw new Error('offline');
            if (calls === 1) return { state: 'play' };
            throw new Error('offline');
        }
    });
    assert.equal((await client.get('getStatusEx')).source, 'live');
    now = 1005;
    assert.equal((await client.get('getStatusEx')).source, 'fresh_cache');
    now = 1050;
    const stale = await client.get('getStatusEx');
    assert.equal(stale.source, 'stale_cache');
    assert.equal(stale.stale, true);
    assert.equal(stale.data, '{"state":"play"}');
    now = 1200;
    assert.equal((await client.get('getStatusEx', { allowStale: false })).source, 'unreachable');
    assert.equal((await client.get('setPlayerCmd:stop')).source, 'unreachable');
    assert.equal(client.cacheSize(), 0);
});

test('peek never exposes WiiM cache beyond the bounded stale window', async () => {
    let now = 0;
    const client = createWiimClient({
        getIp: () => '192.168.1.20',
        now: () => now,
        freshCacheMs: 10,
        maxStaleMs: 100,
        request: async () => ({ state: 'play' })
    });
    await client.get('getStatusEx');
    now = 50;
    assert.equal(client.peek('getStatusEx').source, 'stale_cache');
    now = 101;
    assert.equal(client.peek('getStatusEx').source, 'unreachable');
    assert.equal(client.cacheSize(), 0);
});

test('expired cache is discarded and explicit HTTP fallback is observable', async () => {
    let now = 0;
    const protocols = [];
    const client = createWiimClient({
        getIp: () => '192.168.1.20',
        now: () => now,
        maxStaleMs: DEFAULT_MAX_STALE_MS,
        getAllowInsecureHttp: () => true,
        request: async request => {
            protocols.push(request.protocol);
            if (request.protocol === 'https:') throw new Error('TLS unavailable');
            return 'ok';
        }
    });
    const result = await client.get('getStatusEx');
    assert.equal(result.source, 'live');
    assert.deepEqual(protocols, ['https:', 'http:']);
    now = DEFAULT_FRESH_CACHE_MS + DEFAULT_MAX_STALE_MS + 1;
    const expired = await client.get('getStatusEx', { allowStale: false });
    assert.equal(expired.source, 'live');
});

test('temperature parser rejects malformed/null values and preserves one valid field', () => {
    assert.deepEqual(parseWiimTemperatures('{"temperature_cpu":"42.5","temperature_tmp102":null}'), { cpu: 42.5, board: null });
    assert.deepEqual(parseWiimTemperatures({ temperature_cpu: '', temperature_tmp102: 'Infinity' }), { cpu: null, board: null });
    assert.deepEqual(parseWiimTemperatures({ temperature_cpu: true, temperature_tmp102: 'abc' }), { cpu: null, board: null });
    assert.deepEqual(parseWiimTemperatures({ temperature_cpu: 'NaN', temperature_tmp102: 39 }), { cpu: null, board: 39 });
    assert.throws(() => parseWiimTemperatures('{malformed'), /JSON|Expected/u);
});

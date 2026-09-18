'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWiimClient, parseWiimTemperatures } = require('../server/services/wiim-client');
const { createNasRequestRunner } = require('../server/services/nas-request-retry');
const { isNasLoginSupersededError } = require('../server/services/nas-token-generation');
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('P1 obsolete WiiM success cannot become a new temperature history point', async () => {
    const old = deferred(); let ip = '192.0.2.10'; const written = [];
    const client = createWiimClient({ getIp: () => ip, request: () => ip === '192.0.2.10' ? old.promise : { temperature_cpu: 40 } });
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('async function pollWiimTemp()');
    const end = source.indexOf('registerBackendSampler(', start);
    const context = vm.createContext({
        wiimIP: ip, wiimGet: command => client.get(command), wiimHistorySamples: new Set(),
        parseWiimTemperatures, sysLog() {}, logRecoverableFailure() {}, ERROR_CODES: {},
        appSettings: { historyKeepDays: 30 }, HISTORY_HARD_CAP: 100000,
        historyDb: { insertPoint: (...args) => written.push(args) }
    });
    vm.runInContext(source.slice(start, end) + ';globalThis.poll = pollWiimTemp;', context);
    const pending = context.poll();
    ip = '192.0.2.11'; context.wiimIP = ip; client.reset();
    old.resolve({ temperature_cpu: 99 }); await pending;
    assert.equal(written.length, 0, 'the former device must not populate the current history');
    await context.poll();
    assert.equal(written.length, 1);
    assert.equal(written[0][1].cpu, 40);
});

test('P1 obsolete WiiM failure cannot start a fallback request using changed transport settings', async () => {
    const old = deferred(); let ip = '192.0.2.10'; const calls = [];
    const client = createWiimClient({
        getIp: () => ip, getAllowInsecureHttp: () => true,
        request: request => { calls.push(request); return request.protocol === 'https:' ? old.promise : { temperature_cpu: 99 }; }
    });
    const pending = client.get('getStatusEx'); ip = '192.0.2.11'; client.reset();
    old.reject(new Error('ECONNRESET'));
    const result = await pending;
    assert.equal(calls.length, 1);
    assert.equal(result.source, 'unreachable');
    assert.equal(result.data, null);
    assert.equal(client.inflightCount(), 0);
});

for (const failure of [false, true]) {
    test(`P1 NAS ${failure ? 'failure' : 'success'} from an old client is fenced and recovers with one bounded read`, async () => {
        let generation = 1; let calls = 0; let successes = 0; let failures = 0; let clears = 0;
        const old = deferred();
        const runner = createNasRequestRunner({
            getRequestGeneration: () => generation,
            getToken: async () => 'fixture-token', getLease: token => ({ token, generation }),
            request: () => { calls += 1; return calls === 1 ? old.promise : { value: 'new-nas' }; },
            validateResponse: value => value,
            isTokenRejectedError: () => false, isSupersededError: isNasLoginSupersededError,
            clearTokenIfCurrent: () => { clears += 1; },
            recordSuccess: () => { successes += 1; }, recordFailure: () => { failures += 1; }
        });
        const pending = runner.run('/nas/read');
        await Promise.resolve(); generation += 1;
        if (failure) old.reject(new Error('old host unavailable')); else old.resolve({ value: 'old-nas' });
        assert.deepEqual(await pending, { value: 'new-nas' });
        assert.equal(calls, 2); assert.equal(successes, 1); assert.equal(failures, 0); assert.equal(clears, 0);
    });
}

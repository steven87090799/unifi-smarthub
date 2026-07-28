'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('legacy settings migration reads raw stored values and never overwrites canonical settings', () => {
    const start = source.indexOf('function migrateLegacyAppSettings');
    const end = source.indexOf('\nfunction normalizeAppSettings', start);
    const context = {};
    vm.runInNewContext(`${source.slice(start, end)}; globalThis.migrate = migrateLegacyAppSettings;`, context);
    assert.deepEqual({ ...context.migrate({ trendActiveSec: 7, trendIdleSec: 601, activeWindowSec: 31, upsSampleSec: 11 }) }, {
        trendActiveSec: 7, trendIdleSec: 601, activeWindowSec: 31, upsSampleSec: 11,
        deviceActiveBackendSampleSec: 7, deviceIdleBackendSampleSec: 601, activeLeaseSec: 31, upsIdleBackendSampleSec: 11
    });
    assert.equal(context.migrate({ trendActiveSec: 7, deviceActiveBackendSampleSec: 5 }).deviceActiveBackendSampleSec, 5);
});

test('NAS login singleflight shares one request and clears after success or failure', async () => {
    const start = source.indexOf("let nasToken = '', nasTokenExpiry = 0, nasLoginPromise = null;");
    const end = source.indexOf('\nasync function nasGet', start);
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'pkcs1', format: 'pem' });
    let loginCalls = 0;
    const context = {
        crypto,
        Buffer,
        process: { env: { NAS_USER: 'admin', NAS_PASSWORD: 'password' } },
        sysLog: () => {},
        deepFind: (object, keys) => keys.map(key => object[key]).find(value => value !== undefined),
        nasClient: {
            post: async (url) => {
                if (url.includes('verify/check')) throw new Error('legacy');
                loginCalls += 1;
                await new Promise(resolve => setTimeout(resolve, 10));
                return { data: { token: 'shared-token' } };
            },
            get: async () => ({ data: { public_key: publicPem } })
        },
        setTimeout
    };
    vm.runInNewContext(`${source.slice(start, end)}; globalThis.getNasToken = getNasToken;`, context);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => context.getNasToken()));
    assert.deepEqual(tokens, Array(8).fill('shared-token'));
    assert.equal(loginCalls, 1);
});

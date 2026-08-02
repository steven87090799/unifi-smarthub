'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const { createInternetAxiosConfig, createLanAxiosConfig } = require('../server/integrations/http-egress-policy');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

test('LAN requests bypass ambient proxy while Internet requests retain proxy semantics', async t => {
    let proxyRequests = 0;
    const target = http.createServer((_req, res) => {
        res.end('target');
    });
    const proxy = http.createServer((_req, res) => {
        proxyRequests += 1;
        res.end('proxy');
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);
    t.after(async () => {
        await close(target);
        await close(proxy);
    });

    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
    const previous = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    try {
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) process.env[key] = proxyUrl;
        process.env.NO_PROXY = '';
        process.env.no_proxy = '';

        const lan = await axios.get(`http://127.0.0.1:${targetPort}/lan`, createLanAxiosConfig({ timeout: 2000 }));
        assert.equal(lan.data, 'target');
        assert.equal(proxyRequests, 0, 'LAN request unexpectedly used the ambient proxy');

        const internet = await axios.get('http://public-egress.invalid/internet', createInternetAxiosConfig({ timeout: 2000 }));
        assert.equal(internet.data, 'proxy');
        assert.equal(proxyRequests, 1, 'Internet request did not retain ambient proxy semantics');
    } finally {
        for (const key of proxyKeys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
});

test('egress helpers reject non-object configuration and keep Internet config unforced', () => {
    assert.equal(createLanAxiosConfig({ timeout: 1 }).proxy, false);
    assert.equal(Object.hasOwn(createInternetAxiosConfig({ timeout: 1 }), 'proxy'), false);
    assert.throws(() => createLanAxiosConfig(null), /config must be an object/u);
    assert.throws(() => createInternetAxiosConfig([]), /config must be an object/u);
});

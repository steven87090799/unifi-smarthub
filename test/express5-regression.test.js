'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { parseExactQuery } = require('../server/policies/query-input-policy');

const root = path.join(__dirname, '..');
const productionSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mockSource = fs.readFileSync(path.join(root, 'server-mock.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

function request(harness, requestPath, { method = 'GET', headers = {}, body } = {}) {
    const target = new URL(harness.origin);
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const requestHeaders = { ...headers };
    if (payload && requestHeaders['content-length'] === undefined) requestHeaders['content-length'] = String(payload.length);
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: target.hostname,
            port: Number(target.port),
            method,
            path: requestPath,
            headers: requestHeaders
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.once('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        request.once('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

async function createHarness() {
    const app = express();
    app.set('query parser', 'extended');
    let lateErrorCount = 0;

    // Raw restore uploads must be bounded before the JSON parser is reached.
    app.use('/restore', express.raw({ type: 'application/octet-stream', limit: 32 }));
    app.use(express.json({ limit: 64, strict: true }));

    app.get('/query/:id', (req, res, next) => {
        try {
            const query = parseExactQuery(req.query, { limit: value => Number(value) });
            return res.json({ id: req.params.id, query });
        } catch (error) {
            if (Number.isInteger(error?.httpStatus)) {
                return res.status(error.httpStatus).json({ error: error.message });
            }
            return next(error);
        }
    });
    app.post('/json', (req, res) => res.json({ ok: true, body: req.body }));
    app.post('/restore', (req, res) => res.json({ bytes: req.body.length }));
    app.get('/async-rejected', async () => {
        throw new Error('async route failure');
    });
    app.get('/async-after-response', async (_req, res) => {
        res.status(200).send('once');
        await Promise.resolve();
        throw new Error('late route failure');
    });

    app.use((error, _req, res, next) => {
        if (res.headersSent) {
            lateErrorCount += 1;
            return;
        }
        const isTooLarge = error && (error.type === 'entity.too.large' || error.status === 413);
        const isJsonError = error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError);
        const isMalformedUrl = error instanceof URIError || error?.code === 'ERR_HTTP_INVALID_URI';
        return res.status(isTooLarge ? 413 : isJsonError || isMalformedUrl ? 400 : 500).json({
            error: isTooLarge ? 'body too large' : isMalformedUrl ? 'Invalid request URL' : 'request failed'
        });
    });

    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        request: (requestPath, options) => request({ origin: `http://127.0.0.1:${server.address().port}` }, requestPath, options),
        lateErrorCount: () => lateErrorCount,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

test('Express 5 lockfile and bootstrap preserve strict query, body, URL, and async error contracts', async t => {
    assert.match(packageJson.dependencies.express, /^\^5\./u);
    assert.equal(packageLock.packages['node_modules/express'].version, '5.2.1');
    assert.equal(packageLock.packages['node_modules/qs'].version, '6.16.0');
    assert.equal(packageLock.packages['node_modules/body-parser'].version, '2.3.0');

    for (const source of [productionSource, mockSource]) {
        assert.match(source, /app\.set\('query parser', 'extended'\)/u);
        assert.match(source, /if \(res\.headersSent\) return (?:_next|next)\(error\)/u);
        assert.match(source, /Invalid request URL/u);
    }
    assert.match(productionSource, /express\.raw\(\{ type: BACKUP_MEDIA_TYPE, limit: MAX_BACKUP_BYTES \}\)/u);
    assert.match(productionSource, /express\.json\(\{ limit: '256kb', strict: true \}\)/u);
    assert.match(productionSource, /app\.use\(panelSecurity\.requireHttpsTransport\);[\s\S]*app\.use\(panelSecurity\.authenticate\);[\s\S]*app\.use\(panelSecurity\.protectWrites\);/u);
    assert.doesNotMatch(productionSource, /app\.(?:get|post|put|patch|delete)\(['"][^'"]*[?*][^'"]*['"]/u);

    const harness = await createHarness();
    t.after(harness.close);

    let response = await harness.request('/query/%65ncoded?limit=20');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { id: 'encoded', query: { limit: 20 } });

    for (const requestPath of [
        '/query/item?limit=1&limit=2',
        '/query/item?limit%5B%5D=1',
        '/query/item?constructor%5Bprototype%5D%5Bpolluted%5D=yes',
        '/query/item?unknown=1'
    ]) {
        response = await harness.request(requestPath);
        assert.equal(response.status, 400, requestPath);
    }
    assert.equal(Object.prototype.polluted, undefined);

    response = await harness.request('/query/%E0%A4%A?limit=20');
    assert.equal(response.status, 400);

    response = await harness.request('/json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: 'x'.repeat(128) })
    });
    assert.equal(response.status, 413);

    response = await harness.request('/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(64, 0x61)
    });
    assert.equal(response.status, 413);

    response = await harness.request('/async-rejected');
    assert.equal(response.status, 500);

    response = await harness.request('/async-after-response');
    assert.equal(response.status, 200);
    assert.equal(response.body, 'once');
    assert.equal(harness.lateErrorCount(), 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULTS,
    ERROR_CODES,
    SiteManagerClientError,
    createSiteManagerClient,
    parseRetryAfter
} = require('../server/integrations/site-manager-client');

function page(data, nextToken, extra = {}) {
    const payload = { ...extra, data };
    if (arguments.length >= 2) payload.nextToken = nextToken;
    return { status: 200, headers: {}, data: payload };
}

function rateLimited(retryAfter) {
    const headers = retryAfter === undefined ? {} : { 'retry-after': retryAfter };
    return { status: 429, headers, data: { message: 'limited' } };
}

function scriptedTransport(steps) {
    const calls = [];
    return {
        calls,
        async get(endpoint, config) {
            calls.push({ endpoint, config });
            if (steps.length === 0) throw new Error('unexpected transport call');
            const step = steps.shift();
            if (typeof step === 'function') return step(endpoint, config);
            if (step instanceof Error) throw step;
            return step;
        }
    };
}

function expectCode(code) {
    return error => error instanceof SiteManagerClientError && error.code === code;
}

test('single-page list uses pageSize 500, passes timeout, and preserves response fields', async () => {
    const transport = scriptedTransport([
        page([{ id: 'site-1' }], null, { traceId: 'trace-1', httpStatusCode: 200 })
    ]);
    const client = createSiteManagerClient({ transport });

    const result = await client.listSites();

    assert.deepEqual(result, {
        traceId: 'trace-1',
        httpStatusCode: 200,
        data: [{ id: 'site-1' }],
        nextToken: null
    });
    assert.deepEqual(transport.calls, [{
        endpoint: '/sites',
        config: { params: { pageSize: 500 }, timeout: DEFAULTS.timeoutMs }
    }]);
});

test('multiple pages accumulate in order and each continuation token is requested once', async () => {
    const transport = scriptedTransport([
        page([{ id: 1 }, { id: 2 }], 'token-a', { traceId: 'first-page' }),
        page([{ id: 3 }], 'token-b', { traceId: 'second-page' }),
        page([{ id: 4 }], null, { traceId: 'last-page' })
    ]);
    const client = createSiteManagerClient({ transport, pageSize: 2 });

    const result = await client.listDevices({ params: { siteId: 'abc' } });

    assert.deepEqual(result, {
        traceId: 'first-page',
        data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
        nextToken: null
    });
    assert.deepEqual(transport.calls.map(call => call.config.params), [
        { siteId: 'abc', pageSize: 2 },
        { siteId: 'abc', pageSize: 2, nextToken: 'token-a' },
        { siteId: 'abc', pageSize: 2, nextToken: 'token-b' }
    ]);
});

test('an empty final page terminates pagination without discarding prior items', async () => {
    const transport = scriptedTransport([
        page([{ id: 1 }], 'last'),
        page([])
    ]);
    const client = createSiteManagerClient({ transport });

    const result = await client.listHosts();

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(transport.calls.length, 2);
});

test('named list methods and the generic list endpoint share the same paginator', async () => {
    const transport = scriptedTransport([
        page([]),
        page([]),
        page([]),
        page([{ ok: true }], null, { custom: 'kept' })
    ]);
    const client = createSiteManagerClient({ transport });

    await client.listSites();
    await client.listDevices();
    await client.listHosts();
    assert.deepEqual(await client.listEndpoint('/sd-wan-configs'), { custom: 'kept', data: [{ ok: true }], nextToken: null });
    assert.deepEqual(transport.calls.map(call => call.endpoint), [
        '/sites', '/devices', '/hosts', '/sd-wan-configs'
    ]);
});

test('malformed continuation tokens fail before another page request', async () => {
    const malformed = ['', ' token', 'token\nsmuggled', 12, {}, []];
    for (const token of malformed) {
        const transport = scriptedTransport([page([{ id: 1 }], token)]);
        const client = createSiteManagerClient({ transport });
        await assert.rejects(client.listSites(), error => {
            assert.equal(error.code, ERROR_CODES.MALFORMED_TOKEN);
            assert.equal(error.metadata.page, 1);
            return true;
        });
        assert.equal(transport.calls.length, 1);
    }
});

test('repeated and cyclic continuation tokens are rejected without fetching a duplicate page', async () => {
    const repeated = scriptedTransport([
        page([{ id: 1 }], 'same'),
        page([{ id: 2 }], 'same')
    ]);
    await assert.rejects(
        createSiteManagerClient({ transport: repeated }).listSites(),
        expectCode(ERROR_CODES.REPEATED_TOKEN)
    );
    assert.equal(repeated.calls.length, 2);

    const cyclic = scriptedTransport([
        page([{ id: 1 }], 'a'),
        page([{ id: 2 }], 'b'),
        page([{ id: 3 }], 'a')
    ]);
    await assert.rejects(
        createSiteManagerClient({ transport: cyclic }).listSites(),
        expectCode(ERROR_CODES.REPEATED_TOKEN)
    );
    assert.equal(cyclic.calls.length, 3);
});

test('page safety bound stops before the first disallowed request', async () => {
    const transport = scriptedTransport([
        page([{ id: 1 }], 'continue'),
        page([{ id: 2 }], 'still-more')
    ]);
    const client = createSiteManagerClient({ transport, maxPages: 2 });

    await assert.rejects(client.listSites(), error => {
        assert.equal(error.code, ERROR_CODES.MAX_PAGES);
        assert.deepEqual(error.metadata, {
            endpoint: '/sites',
            page: 2,
            maxPages: 2,
            itemsCollected: 2
        });
        return true;
    });
    assert.equal(transport.calls.length, 2);
});

test('item safety bound rejects an overflowing page without requesting another page', async () => {
    const transport = scriptedTransport([
        page([{ id: 1 }, { id: 2 }], 'continue'),
        page([{ id: 3 }, { id: 4 }], null)
    ]);
    const client = createSiteManagerClient({ transport, maxItems: 3 });

    await assert.rejects(client.listSites(), error => {
        assert.equal(error.code, ERROR_CODES.MAX_ITEMS);
        assert.equal(error.metadata.itemsCollected, 2);
        assert.equal(error.metadata.pageItems, 2);
        return true;
    });
    assert.equal(transport.calls.length, 2);
});

test('Retry-After parser accepts seconds and HTTP-date, rejects invalid values, and caps delays', () => {
    const nowMs = Date.UTC(2026, 6, 15, 0, 0, 0);
    assert.deepEqual(parseRetryAfter('3', { nowMs, maxDelayMs: 10_000 }), {
        delayMs: 3_000,
        source: 'seconds',
        capped: false
    });
    assert.deepEqual(parseRetryAfter('99', { nowMs, maxDelayMs: 5_000 }), {
        delayMs: 5_000,
        source: 'seconds',
        capped: true
    });
    assert.deepEqual(parseRetryAfter('Wed, 15 Jul 2026 00:00:05 GMT', { nowMs, maxDelayMs: 10_000 }), {
        delayMs: 5_000,
        source: 'http-date',
        capped: false
    });
    assert.deepEqual(parseRetryAfter('Tue, 14 Jul 2026 23:59:59 GMT', { nowMs }), {
        delayMs: 0,
        source: 'http-date',
        capped: false
    });
    for (const invalid of [undefined, '', '-1', '1.5', 'tomorrow', '2026-07-15T00:00:05Z']) {
        assert.equal(parseRetryAfter(invalid, { nowMs }), null);
    }
});

test('429 with Retry-After seconds sleeps for the requested duration then succeeds', async () => {
    const delays = [];
    const transport = scriptedTransport([
        rateLimited('2'),
        page([{ id: 1 }], null)
    ]);
    const client = createSiteManagerClient({
        transport,
        sleep: async delay => delays.push(delay),
        random: () => { throw new Error('valid Retry-After must not use jitter'); }
    });

    assert.deepEqual(await client.listSites(), { data: [{ id: 1 }], nextToken: null });
    assert.deepEqual(delays, [2_000]);
    assert.equal(transport.calls.length, 2);
});

test('429 HTTP-date uses the injected clock and supports rejected transport responses', async () => {
    const nowMs = Date.UTC(2026, 6, 15, 0, 0, 0);
    const delays = [];
    const rejection = new Error('axios-style status failure');
    rejection.response = rateLimited('Wed, 15 Jul 2026 00:00:04 GMT');
    const transport = scriptedTransport([rejection, page([], null)]);
    const client = createSiteManagerClient({
        transport,
        clock: { now: () => nowMs },
        sleep: async delay => delays.push(delay)
    });

    assert.deepEqual(await client.listSites(), { data: [], nextToken: null });
    assert.deepEqual(delays, [4_000]);
});

test('invalid Retry-After falls back to deterministic exponential jitter', async () => {
    const delays = [];
    const transport = scriptedTransport([
        rateLimited('invalid'),
        rateLimited(),
        page([], null)
    ]);
    const client = createSiteManagerClient({
        transport,
        maxRetries: 2,
        baseDelayMs: 100,
        jitterRatio: 0.2,
        maxRetryDelayMs: 1_000,
        random: () => 0.75,
        sleep: async delay => delays.push(delay)
    });

    await client.listSites();
    assert.deepEqual(delays, [110, 220]);
});

test('fallback jitter is bounded by maxRetryDelayMs even at its deterministic maximum', async () => {
    const delays = [];
    const transport = scriptedTransport([
        rateLimited('bad'),
        rateLimited('bad'),
        page([], null)
    ]);
    const client = createSiteManagerClient({
        transport,
        maxRetries: 2,
        baseDelayMs: 80,
        maxRetryDelayMs: 100,
        jitterRatio: 1,
        random: () => 1,
        sleep: async delay => delays.push(delay)
    });

    await client.listSites();
    assert.deepEqual(delays, [100, 100]);
});

test('repeated 429 exhausts a bounded budget and exposes stable terminal metadata', async () => {
    const delays = [];
    const transport = scriptedTransport([
        rateLimited('1'),
        rateLimited('1'),
        rateLimited('1')
    ]);
    const client = createSiteManagerClient({
        transport,
        maxRetries: 2,
        sleep: async delay => delays.push(delay)
    });

    await assert.rejects(client.listSites(), error => {
        assert.equal(error.code, ERROR_CODES.RATE_LIMITED);
        assert.equal(error.metadata.status, 429);
        assert.equal(error.metadata.attempts, 3);
        assert.equal(error.metadata.retries, 2);
        assert.equal(error.metadata.page, 1);
        assert.equal(error.metadata.itemsCollected, 0);
        return true;
    });
    assert.equal(transport.calls.length, 3);
    assert.deepEqual(delays, [1_000, 1_000]);
});

test('timeout during pagination is not retried and retains page progress metadata', async () => {
    const timeout = new Error('request timed out');
    timeout.code = 'ECONNABORTED';
    const transport = scriptedTransport([
        page([{ id: 1 }], 'next'),
        timeout
    ]);
    const client = createSiteManagerClient({ transport, timeoutMs: 1_234 });

    await assert.rejects(client.listSites(), error => {
        assert.equal(error.code, ERROR_CODES.TIMEOUT);
        assert.equal(error.metadata.timeoutMs, 1_234);
        assert.equal(error.metadata.page, 2);
        assert.equal(error.metadata.itemsCollected, 1);
        assert.equal(error.metadata.hasPageToken, true);
        return true;
    });
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[1].config.timeout, 1_234);
});

test('timeout and non-429 transport/HTTP failures receive no automatic retry', async () => {
    const timeout = new Error('timeout');
    timeout.code = 'ETIMEDOUT';
    const timeoutTransport = scriptedTransport([timeout]);
    await assert.rejects(
        createSiteManagerClient({ transport: timeoutTransport }).get('/hosts'),
        expectCode(ERROR_CODES.TIMEOUT)
    );
    assert.equal(timeoutTransport.calls.length, 1);

    const networkFailure = new Error('socket closed');
    networkFailure.code = 'ECONNRESET';
    const networkTransport = scriptedTransport([networkFailure]);
    await assert.rejects(
        createSiteManagerClient({ transport: networkTransport }).get('/hosts'),
        expectCode(ERROR_CODES.TRANSPORT)
    );
    assert.equal(networkTransport.calls.length, 1);

    const httpTransport = scriptedTransport([{ status: 503, headers: {}, data: {} }]);
    await assert.rejects(
        createSiteManagerClient({ transport: httpTransport }).get('/hosts'),
        error => error.code === ERROR_CODES.HTTP && error.metadata.status === 503
    );
    assert.equal(httpTransport.calls.length, 1);
});

test('configuration and generic endpoint guards reject unsafe or unbounded inputs', async () => {
    const transport = scriptedTransport([]);
    for (const pageSize of [0, 501, 1.5, '500']) {
        assert.throws(() => createSiteManagerClient({ transport, pageSize }), /pageSize/);
    }
    for (const endpoint of ['https://api.ui.com/v1/sites', '//evil.test/sites', '/sites?x=1', '/../sites', '/sites\n']) {
        await assert.rejects(
            Promise.resolve().then(() => createSiteManagerClient({ transport }).list(endpoint)),
            /relative API path/
        );
    }
    await assert.rejects(
        Promise.resolve().then(() => createSiteManagerClient({ transport }).list('/sites', { params: { nextToken: 'owned' } })),
        /must not override managed/
    );
});

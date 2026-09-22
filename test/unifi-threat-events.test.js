'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectUnifiThreatEvents, normalizeThreatEvent } = require('../server/integrations/unifi-threat-events');
const unsupported = () => Object.assign(new Error('legacy unavailable'), {
    response: { status: 400, data: { meta: { msg: 'api.err.InvalidObject' } } }
});
const event = { id: 'event-1', timestamp: 1790000000000, key: 'THREAT_BLOCKED_V2',
    message_raw: 'Intrusion from {IP}', severity: 'HIGH', parameters: { IP: { name: '203.0.113.9' } } };

test('preserves working legacy alarms without an extra request', async () => {
    const alarms = [{ key: 'ips:alert', msg: 'IPS Alert' }];
    assert.equal(await collectUnifiThreatEvents({ get: async () => ({ data: { data: alarms } }),
        post: () => assert.fail('unexpected fallback') }, { cookie: 'session' }), alarms);
});

test('falls back only for unsupported endpoints and paginates the fixed window', async () => {
    const calls = [];
    const result = await collectUnifiThreatEvents({ get: async () => { throw unsupported(); },
        post: async (url, body, options) => {
            calls.push({ url, body, options });
            return { data: { data: [{ ...event, id: String(body.pageNumber) }],
                page_number: body.pageNumber, total_page_count: 2 } };
        }
    }, { cookie: 'session', now: 1790000000000 });
    assert.equal(result.length, 2);
    assert.equal(calls[0].url, '/proxy/network/v2/api/site/default/system-log/threat-alert');
    assert.deepEqual(calls[0].body.threatTypes, ['THREAT']);
    assert.equal(calls[1].body.timestampFrom, calls[0].body.timestampFrom);
    assert.equal(calls[0].options.headers.Cookie, 'session');
    assert.equal(result[0].src_ip, '203.0.113.9');
    assert.equal(result[0].key, 'ips:alert');
});

test('a verified empty v2 page is a valid zero-threat result', async () => {
    assert.deepEqual(await collectUnifiThreatEvents({ get: async () => { throw unsupported(); },
        post: async () => ({ data: { data: [], page_number: 0, total_page_count: 0 } }) }), []);
});

for (const status of [400, 401, 403, 429, 500, undefined]) {
    test(`does not hide upstream failure ${status}`, async () => {
        const error = Object.assign(new Error('upstream failure'), { response: { status } });
        await assert.rejects(collectUnifiThreatEvents({ get: async () => { throw error; },
            post: () => assert.fail('must not fall back') }), e => e === error);
    });
}

for (const body of [{}, { data: [] }, { data: [], page_number: 1, total_page_count: 1 },
    { data: [], page_number: 0, total_page_count: 2 },
    { data: [event], page_number: 0, total_page_count: 6 },
    { data: [{}], page_number: 0, total_page_count: 1 }]) {
    test(`rejects invalid or incomplete pages: ${JSON.stringify(body)}`, async () => {
        await assert.rejects(collectUnifiThreatEvents({ get: async () => { throw unsupported(); },
            post: async () => ({ data: body }) }));
    });
}

test('does not claim detection-only or unclassified events were blocked', () => {
    assert.equal(normalizeThreatEvent({ ...event, key: 'THREAT_DETECTED_V2' }).action_taken, 'DETECTED');
    const unknown = normalizeThreatEvent({ ...event, key: 'NEW_EVENT', parameters: {} });
    assert.equal(unknown.action_taken, 'UNKNOWN');
    assert.equal(unknown.src_ip, null);
    assert.equal(normalizeThreatEvent(event).msg, 'Intrusion from 203.0.113.9');
});

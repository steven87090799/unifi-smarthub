'use strict';

const { isIP } = require('node:net');
const LEGACY_PATH = '/proxy/network/api/s/default/list/alarm';
const V2_PATH = '/proxy/network/v2/api/site/default/system-log/threat-alert';
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

function legacyEndpointUnavailable(error) {
    const response = error?.response;
    return response?.status === 404 || response?.status === 405
        || (response?.status === 400 && response.data?.meta?.msg === 'api.err.InvalidObject');
}

function normalizeThreatEvent(event) {
    if (!event || typeof event !== 'object' || typeof event.id !== 'string'
        || !Number.isFinite(event.timestamp) || event.timestamp <= 0
        || !Number.isFinite(new Date(event.timestamp).getTime())) {
        throw new Error('Invalid UniFi threat event');
    }
    const parameters = event.parameters || {};
    const message = typeof event.message === 'string' ? event.message
        : String(event.message_raw || event.title_raw || event.key || '').replace(/\{(\w+)\}/g,
            (match, key) => parameters[key]?.name || parameters[key]?.id || match);
    const candidate = parameters.IP?.ip || parameters.IP?.name || parameters.IP?.id;
    const key = String(event.key || '');
    return {
        _id: event.id,
        key: 'ips:alert',
        time: event.timestamp,
        datetime: new Date(event.timestamp).toISOString(),
        msg: message,
        src_ip: typeof candidate === 'string' && isIP(candidate) ? candidate : null,
        severity: typeof event.severity === 'string' ? event.severity : 'UNKNOWN',
        action_taken: /(?:^|_)BLOCKED(?:_|$)/.test(key) ? 'BLOCKED'
            : /(?:^|_)(?:DETECTED|ALERT)(?:_|$)/.test(key) ? 'DETECTED' : 'UNKNOWN',
        target_device: parameters.CONSOLE_WITH_DEVICE_NAME?.name || parameters.CONSOLE_NAME?.name || 'Unknown',
        source_api: 'system-log/threat-alert'
    };
}

async function collectUnifiThreatEvents(client, { cookie, now = Date.now() } = {}) {
    const options = { headers: { Cookie: cookie } };
    try {
        const response = await client.get(LEGACY_PATH, options);
        if (!Array.isArray(response.data?.data)) throw new Error('Invalid UniFi legacy alarm response');
        return response.data.data;
    } catch (error) {
        // Authentication, transport and arbitrary server failures must remain visible.
        if (!legacyEndpointUnavailable(error)) throw error;
    }
    const events = new Map();
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const response = await client.post(V2_PATH, {
            timestampFrom: now - 30 * 24 * 60 * 60 * 1000,
            timestampTo: now,
            threatTypes: ['THREAT'],
            pageSize: PAGE_SIZE,
            pageNumber
        }, options);
        const body = response.data;
        if (!Array.isArray(body?.data) || !Number.isInteger(body.total_page_count)
            || body.total_page_count < 0 || body.page_number !== pageNumber
            || body.data.length > PAGE_SIZE) throw new Error('Invalid UniFi threat page');
        if (body.total_page_count > MAX_PAGES) throw new Error('UniFi threat result exceeds pagination limit');
        for (const event of body.data) {
            const normalized = normalizeThreatEvent(event);
            events.set(normalized._id, normalized);
        }
        if (pageNumber + 1 >= body.total_page_count) return [...events.values()];
        if (!body.data.length) throw new Error('Incomplete UniFi threat pagination');
    }
    throw new Error('Incomplete UniFi threat pagination');
}

module.exports = { collectUnifiThreatEvents, normalizeThreatEvent };

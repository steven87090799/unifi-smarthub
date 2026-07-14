'use strict';

const DEFAULTS = Object.freeze({
    pageSize: 500,
    maxPages: 100,
    maxItems: 50_000,
    maxRetries: 3,
    timeoutMs: 8_000,
    baseDelayMs: 250,
    maxRetryDelayMs: 30_000,
    jitterRatio: 0.2
});

const LIMITS = Object.freeze({
    maxPageSize: 500,
    maxTokenLength: 4_096,
    maxEndpointLength: 512,
    maxRetries: 20,
    maxPages: 10_000,
    maxItems: 1_000_000
});

const ERROR_CODES = Object.freeze({
    RATE_LIMITED: 'SITE_MANAGER_RATE_LIMITED',
    TIMEOUT: 'SITE_MANAGER_TIMEOUT',
    TRANSPORT: 'SITE_MANAGER_TRANSPORT_ERROR',
    HTTP: 'SITE_MANAGER_HTTP_ERROR',
    INVALID_RESPONSE: 'SITE_MANAGER_INVALID_RESPONSE',
    MALFORMED_TOKEN: 'SITE_MANAGER_MALFORMED_TOKEN',
    REPEATED_TOKEN: 'SITE_MANAGER_REPEATED_TOKEN',
    MAX_PAGES: 'SITE_MANAGER_MAX_PAGES',
    MAX_ITEMS: 'SITE_MANAGER_MAX_ITEMS'
});

class SiteManagerClientError extends Error {
    constructor(message, { code, metadata = {}, cause } = {}) {
        super(message);
        this.name = 'SiteManagerClientError';
        this.code = code || ERROR_CODES.TRANSPORT;
        this.metadata = Object.freeze({ ...metadata });
        if (cause !== undefined) this.cause = cause;
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function integerOption(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function numberOption(name, value, { min = 0, max = Number.MAX_VALUE } = {}) {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new TypeError(`${name} must be a finite number between ${min} and ${max}`);
    }
    return value;
}

function normalizeEndpoint(endpoint) {
    if (
        typeof endpoint !== 'string'
        || endpoint.length < 2
        || endpoint.length > LIMITS.maxEndpointLength
        || !endpoint.startsWith('/')
        || endpoint.startsWith('//')
        || /[\u0000-\u001f\u007f\\?#]/.test(endpoint)
        || endpoint.split('/').includes('..')
    ) {
        throw new TypeError('endpoint must be a bounded relative API path without query or fragment data');
    }
    return endpoint;
}

function normalizeParams(params, { allowPagination = false } = {}) {
    if (!isPlainObject(params)) throw new TypeError('params must be a plain object');
    if (!allowPagination && (Object.hasOwn(params, 'nextToken') || Object.hasOwn(params, 'pageSize'))) {
        throw new TypeError('params must not override managed nextToken or pageSize fields');
    }
    return { ...params };
}

function normalizeClock(clock) {
    const now = typeof clock === 'function' ? clock : clock && clock.now;
    if (typeof now !== 'function') throw new TypeError('clock must be a function or expose now()');
    return () => {
        const timestamp = now.call(clock);
        if (!Number.isFinite(timestamp)) throw new TypeError('clock must return a finite timestamp');
        return timestamp;
    };
}

function readHeader(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') {
        const value = headers.get(name);
        if (value !== null && value !== undefined) return value;
    }
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
    }
    return undefined;
}

/**
 * Parse RFC Retry-After delay-seconds or an IMF-fixdate. The returned delay is
 * always bounded so an upstream response cannot strand a worker indefinitely.
 */
function parseRetryAfter(value, { nowMs = Date.now(), maxDelayMs = DEFAULTS.maxRetryDelayMs } = {}) {
    if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
    numberOption('maxDelayMs', maxDelayMs);
    if (Array.isArray(value)) value = value[0];
    if (typeof value !== 'string' && typeof value !== 'number') return null;

    const text = String(value).trim();
    if (!text) return null;

    let unboundedDelayMs;
    let source;
    if (/^\d+$/.test(text)) {
        const seconds = Number(text);
        if (!Number.isSafeInteger(seconds)) return null;
        unboundedDelayMs = seconds * 1_000;
        if (!Number.isSafeInteger(unboundedDelayMs)) return null;
        source = 'seconds';
    } else {
        const imfFixdate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
        if (!imfFixdate.test(text)) return null;
        const timestamp = Date.parse(text);
        if (!Number.isFinite(timestamp)) return null;
        unboundedDelayMs = Math.max(0, timestamp - nowMs);
        source = 'http-date';
    }

    return Object.freeze({
        delayMs: Math.min(unboundedDelayMs, maxDelayMs),
        source,
        capped: unboundedDelayMs > maxDelayMs
    });
}

function responseStatus(response) {
    const value = response && response.status;
    return Number.isInteger(value) ? value : null;
}

function isTimeout(error) {
    return Boolean(error && (
        error.code === 'ECONNABORTED'
        || error.code === 'ETIMEDOUT'
        || error.code === 'UND_ERR_CONNECT_TIMEOUT'
        || error.code === 'UND_ERR_HEADERS_TIMEOUT'
    ));
}

function validatePageToken(value, page) {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > LIMITS.maxTokenLength
        || value !== value.trim()
        || /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new SiteManagerClientError('Site Manager returned a malformed pagination token', {
            code: ERROR_CODES.MALFORMED_TOKEN,
            metadata: { page, tokenType: value === null ? 'null' : typeof value }
        });
    }
    return value;
}

function withPaginationMetadata(error, metadata) {
    if (!(error instanceof SiteManagerClientError)) return error;
    return new SiteManagerClientError(error.message, {
        code: error.code,
        metadata: { ...error.metadata, ...metadata },
        cause: error
    });
}

function createSiteManagerClient(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('options must be a plain object');

    const transport = options.transport;
    const invokeGet = typeof transport === 'function'
        ? transport
        : transport && typeof transport.get === 'function'
            ? transport.get.bind(transport)
            : null;
    if (!invokeGet) throw new TypeError('transport must be a function or expose get()');

    const now = normalizeClock(options.clock || Date.now);
    const sleep = options.sleep || (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    const random = options.random || Math.random;
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
    if (typeof random !== 'function') throw new TypeError('random must be a function');

    const defaults = Object.freeze({
        pageSize: integerOption('pageSize', options.pageSize ?? DEFAULTS.pageSize, { min: 1, max: LIMITS.maxPageSize }),
        maxPages: integerOption('maxPages', options.maxPages ?? DEFAULTS.maxPages, { min: 1, max: LIMITS.maxPages }),
        maxItems: integerOption('maxItems', options.maxItems ?? DEFAULTS.maxItems, { min: 0, max: LIMITS.maxItems }),
        maxRetries: integerOption('maxRetries', options.maxRetries ?? DEFAULTS.maxRetries, { min: 0, max: LIMITS.maxRetries }),
        timeoutMs: integerOption('timeoutMs', options.timeoutMs ?? DEFAULTS.timeoutMs, { min: 1 }),
        baseDelayMs: integerOption('baseDelayMs', options.baseDelayMs ?? DEFAULTS.baseDelayMs, { min: 0 }),
        maxRetryDelayMs: integerOption('maxRetryDelayMs', options.maxRetryDelayMs ?? DEFAULTS.maxRetryDelayMs, { min: 0 }),
        jitterRatio: numberOption('jitterRatio', options.jitterRatio ?? DEFAULTS.jitterRatio, { min: 0, max: 1 })
    });

    function fallbackDelay(retryIndex, requestOptions) {
        const randomValue = random();
        if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
            throw new TypeError('random() must return a number between 0 and 1');
        }
        const exponential = requestOptions.baseDelayMs * (2 ** Math.min(retryIndex, 30));
        const factor = 1 + ((randomValue * 2) - 1) * requestOptions.jitterRatio;
        return Math.max(0, Math.min(requestOptions.maxRetryDelayMs, Math.round(exponential * factor)));
    }

    function requestSettings(requestOptions) {
        if (!isPlainObject(requestOptions)) throw new TypeError('request options must be a plain object');
        return {
            timeoutMs: integerOption('timeoutMs', requestOptions.timeoutMs ?? defaults.timeoutMs, { min: 1 }),
            maxRetries: integerOption('maxRetries', requestOptions.maxRetries ?? defaults.maxRetries, { min: 0, max: LIMITS.maxRetries }),
            baseDelayMs: integerOption('baseDelayMs', requestOptions.baseDelayMs ?? defaults.baseDelayMs, { min: 0 }),
            maxRetryDelayMs: integerOption('maxRetryDelayMs', requestOptions.maxRetryDelayMs ?? defaults.maxRetryDelayMs, { min: 0 }),
            jitterRatio: numberOption('jitterRatio', requestOptions.jitterRatio ?? defaults.jitterRatio, { min: 0, max: 1 })
        };
    }

    async function get(endpoint, requestOptions = {}) {
        endpoint = normalizeEndpoint(endpoint);
        const params = normalizeParams(requestOptions.params || {}, { allowPagination: true });
        const settings = requestSettings(requestOptions);
        let retryCount = 0;
        let lastDelayMs = null;
        let lastDelaySource = null;

        for (;;) {
            let response;
            let failure;
            try {
                response = await invokeGet(endpoint, { params: { ...params }, timeout: settings.timeoutMs });
            } catch (error) {
                failure = error;
                response = error && error.response;
            }

            const status = responseStatus(response);
            if (status === 429) {
                if (retryCount >= settings.maxRetries) {
                    throw new SiteManagerClientError('Site Manager rate limit retry budget was exhausted', {
                        code: ERROR_CODES.RATE_LIMITED,
                        metadata: {
                            endpoint,
                            status: 429,
                            attempts: retryCount + 1,
                            retries: retryCount,
                            maxRetries: settings.maxRetries,
                            lastDelayMs,
                            lastDelaySource
                        },
                        cause: failure
                    });
                }

                const parsed = parseRetryAfter(readHeader(response && response.headers, 'retry-after'), {
                    nowMs: now(),
                    maxDelayMs: settings.maxRetryDelayMs
                });
                const delayMs = parsed ? parsed.delayMs : fallbackDelay(retryCount, settings);
                lastDelayMs = delayMs;
                lastDelaySource = parsed ? parsed.source : 'exponential-jitter';
                retryCount += 1;
                await sleep(delayMs);
                continue;
            }

            if (failure) {
                if (isTimeout(failure)) {
                    throw new SiteManagerClientError('Site Manager request timed out', {
                        code: ERROR_CODES.TIMEOUT,
                        metadata: { endpoint, attempts: retryCount + 1, timeoutMs: settings.timeoutMs },
                        cause: failure
                    });
                }
                if (status !== null) {
                    throw new SiteManagerClientError('Site Manager returned an HTTP error', {
                        code: ERROR_CODES.HTTP,
                        metadata: { endpoint, attempts: retryCount + 1, status },
                        cause: failure
                    });
                }
                throw new SiteManagerClientError('Site Manager transport failed', {
                    code: ERROR_CODES.TRANSPORT,
                    metadata: { endpoint, attempts: retryCount + 1 },
                    cause: failure
                });
            }

            if (status !== null && status >= 400) {
                throw new SiteManagerClientError('Site Manager returned an HTTP error', {
                    code: ERROR_CODES.HTTP,
                    metadata: { endpoint, attempts: retryCount + 1, status }
                });
            }
            if (!response || typeof response !== 'object') {
                throw new SiteManagerClientError('Site Manager transport returned no response object', {
                    code: ERROR_CODES.INVALID_RESPONSE,
                    metadata: { endpoint, attempts: retryCount + 1 }
                });
            }
            return response;
        }
    }

    async function listEndpoint(endpoint, listOptions = {}) {
        endpoint = normalizeEndpoint(endpoint);
        if (!isPlainObject(listOptions)) throw new TypeError('list options must be a plain object');

        const params = normalizeParams(listOptions.params || {});
        const pageSize = integerOption('pageSize', listOptions.pageSize ?? defaults.pageSize, { min: 1, max: LIMITS.maxPageSize });
        const maxPages = integerOption('maxPages', listOptions.maxPages ?? defaults.maxPages, { min: 1, max: LIMITS.maxPages });
        const maxItems = integerOption('maxItems', listOptions.maxItems ?? defaults.maxItems, { min: 0, max: LIMITS.maxItems });
        const requestOverrides = {
            timeoutMs: listOptions.timeoutMs,
            maxRetries: listOptions.maxRetries,
            baseDelayMs: listOptions.baseDelayMs,
            maxRetryDelayMs: listOptions.maxRetryDelayMs,
            jitterRatio: listOptions.jitterRatio
        };

        const items = [];
        const seenTokens = new Set();
        let firstPayload = null;
        let pageCount = 0;
        let nextToken;
        let finalPayload;

        for (;;) {
            const pageParams = { ...params, pageSize };
            if (nextToken !== undefined) pageParams.nextToken = nextToken;

            let response;
            try {
                response = await get(endpoint, { ...requestOverrides, params: pageParams });
            } catch (error) {
                throw withPaginationMetadata(error, {
                    page: pageCount + 1,
                    itemsCollected: items.length,
                    hasPageToken: nextToken !== undefined
                });
            }

            pageCount += 1;
            const payload = response.data;
            if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
                throw new SiteManagerClientError('Site Manager list response must contain a data array', {
                    code: ERROR_CODES.INVALID_RESPONSE,
                    metadata: { endpoint, page: pageCount, itemsCollected: items.length }
                });
            }
            if (items.length + payload.data.length > maxItems) {
                throw new SiteManagerClientError('Site Manager item safety bound was exceeded', {
                    code: ERROR_CODES.MAX_ITEMS,
                    metadata: {
                        endpoint,
                        page: pageCount,
                        maxItems,
                        itemsCollected: items.length,
                        pageItems: payload.data.length
                    }
                });
            }

            if (firstPayload === null) firstPayload = payload;
            finalPayload = payload;
            items.push(...payload.data);

            if (!Object.hasOwn(payload, 'nextToken') || payload.nextToken === null) break;
            const candidate = validatePageToken(payload.nextToken, pageCount);
            if (seenTokens.has(candidate)) {
                throw new SiteManagerClientError('Site Manager repeated a pagination token', {
                    code: ERROR_CODES.REPEATED_TOKEN,
                    metadata: { endpoint, page: pageCount, itemsCollected: items.length }
                });
            }
            if (pageCount >= maxPages) {
                throw new SiteManagerClientError('Site Manager page safety bound was exceeded', {
                    code: ERROR_CODES.MAX_PAGES,
                    metadata: { endpoint, page: pageCount, maxPages, itemsCollected: items.length }
                });
            }
            seenTokens.add(candidate);
            nextToken = candidate;
        }

        const result = { ...firstPayload, data: items };
        if (Object.hasOwn(finalPayload, 'nextToken')) result.nextToken = finalPayload.nextToken;
        else delete result.nextToken;
        return result;
    }

    return Object.freeze({
        get,
        list: listEndpoint,
        listEndpoint,
        listSites: options => listEndpoint('/sites', options),
        listDevices: options => listEndpoint('/devices', options),
        listHosts: options => listEndpoint('/hosts', options)
    });
}

module.exports = {
    DEFAULTS,
    ERROR_CODES,
    LIMITS,
    SiteManagerClientError,
    createSiteManagerClient,
    parseRetryAfter
};

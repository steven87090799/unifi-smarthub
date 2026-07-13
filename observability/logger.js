'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');
const { ERROR_CODES } = require('./error-codes');

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 });
const SENSITIVE_KEY = /(pass(word)?|api[_-]?key|token|authorization|cookie|session|secret|webhook|private[_-]?key)/i;

function maskSecret(value) {
    const text = String(value ?? '');
    if (!text) return '[REDACTED]';
    if (text.length <= 4) return '[REDACTED]';
    return `${text.slice(0, 4)}${'*'.repeat(Math.min(12, Math.max(4, text.length - 4)))}`;
}

function maskString(input, knownSecrets = []) {
    let value = String(input);
    for (const secret of knownSecrets) {
        if (secret && secret.length >= 4) value = value.split(secret).join(maskSecret(secret));
    }
    value = value
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, '$1 [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, token => maskSecret(token))
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, token => maskSecret(token))
        .replace(/((?:pass(?:word)?|api[_-]?key|token|authorization|cookie|session|secret)=)([^&\s]+)/gi,
            (_match, prefix, secret) => `${prefix}${maskSecret(secret)}`);
    return value;
}

function maskSensitive(value, options = {}, seen = new WeakSet()) {
    const knownSecrets = options.knownSecrets || [];
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return maskString(value, knownSecrets);
    if (value instanceof Error) {
        return {
            type: value.name,
            message: maskString(value.message, knownSecrets),
            stack: value.stack ? maskString(value.stack, knownSecrets) : undefined,
            code: value.code
        };
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        const output = value.map(item => maskSensitive(item, options, seen));
        seen.delete(value);
        return output;
    }
    if (typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            output[key] = SENSITIVE_KEY.test(key)
                ? maskSecret(item)
                : maskSensitive(item, options, seen);
        }
        seen.delete(value);
        return output;
    }
    return maskString(value, knownSecrets);
}

function normalizeLevel(level) {
    const normalized = String(level || 'INFO').toUpperCase();
    return Object.hasOwn(LEVELS, normalized) ? normalized : 'INFO';
}

function localTimestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function createLogger(options = {}) {
    const context = new AsyncLocalStorage();
    const level = normalizeLevel(options.level || process.env.LOG_LEVEL);
    const format = (options.json === true || String(process.env.LOG_JSON).toLowerCase() === 'true' || String(options.format || process.env.LOG_FORMAT).toLowerCase() === 'json') ? 'json' : 'console';
    const service = options.service || 'smarthub';
    const sink = options.sink || (line => console.log(line));
    const env = options.env || process.env;
    const knownSecrets = Object.entries(env)
        .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === 'string' && value.length >= 4)
        .map(([, value]) => value);

    function enabled(candidate) {
        return LEVELS[normalizeLevel(candidate)] >= LEVELS[level];
    }

    function write(candidate, event = {}) {
        const logLevel = normalizeLevel(candidate);
        if (!enabled(logLevel)) return null;
        const inherited = context.getStore() || {};
        // fields 先展開，保留欄位後寫入，避免呼叫端意外覆寫 level/code/context。
        const raw = {
            ...event.fields,
            timestamp: new Date().toISOString(),
            level: logLevel,
            service: event.service || service,
            module: event.module || inherited.module || 'app',
            function: event.function || inherited.function || 'unknown',
            pid: process.pid,
            worker_id: event.worker_id || inherited.worker_id || 'main',
            request_id: event.request_id || inherited.request_id,
            trace_id: event.trace_id || inherited.trace_id,
            task_id: event.task_id || inherited.task_id,
            http_status: event.http_status,
            status_code: event.code,
            error_code: logLevel === 'ERROR' || logLevel === 'CRITICAL' ? event.code : undefined,
            message: event.message || ''
        };
        if (event.error) raw.error = event.error;
        const record = maskSensitive(raw, { knownSecrets });
        for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];

        if (format === 'json') {
            sink(JSON.stringify(record));
        } else {
            const tags = [`PID=${record.pid}`, `WORKER=${record.worker_id}`];
            if (record.request_id) tags.push(`REQ=${record.request_id}`);
            if (record.trace_id) tags.push(`TRACE=${record.trace_id}`);
            if (record.task_id) tags.push(`TASK=${record.task_id}`);
            if (record.http_status != null) tags.push(`HTTP=${record.http_status}`);
            if (record.status_code) tags.push(`CODE=${record.status_code}`);
            const reserved = new Set(['timestamp', 'level', 'service', 'module', 'function', 'pid', 'worker_id', 'request_id', 'trace_id', 'task_id', 'http_status', 'status_code', 'error_code', 'message', 'error']);
            const extra = Object.entries(record)
                .filter(([key]) => !reserved.has(key))
                .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
            if (record.error) extra.push(`error=${record.error.type || 'Error'}:${record.error.message || record.error}`);
            if (record.error && record.error.stack) extra.push(`stack=${record.error.stack.replace(/\n/g, '\\n')}`);
            sink(`${localTimestamp()} | ${record.level} | ${String(record.service).toUpperCase()} | ${record.module} | ${record.function} | ${tags.join(' | ')} | ${record.message}${extra.length ? ` | ${extra.join(' | ')}` : ''}`);
        }
        return record;
    }

    const logger = {
        level,
        format,
        enabled,
        write,
        debug: event => write('DEBUG', event),
        info: event => write('INFO', event),
        warning: event => write('WARNING', event),
        error: event => write('ERROR', event),
        critical: event => write('CRITICAL', event),
        runWithContext(values, fn) {
            return context.run({ ...(context.getStore() || {}), ...values }, fn);
        },
        getContext() { return { ...(context.getStore() || {}) }; },
        requestMiddleware() {
            return (req, res, next) => {
                const supplied = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
                const requestId = supplied || randomUUID();
                const traceId = String(req.headers['x-trace-id'] || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || requestId;
                const started = process.hrtime.bigint();
                res.setHeader('X-Request-ID', requestId);
                context.run({ request_id: requestId, trace_id: traceId }, () => {
                    if (req.path.startsWith('/api/') && process.env.DEBUG_HTTP !== '0') {
                        write('DEBUG', {
                            module: 'http', function: 'request', code: ERROR_CODES.API_REQUEST_START,
                            message: 'API request started', fields: { method: req.method, path: req.path }
                        });
                    }
                    res.on('finish', () => {
                        if (!req.path.startsWith('/api/') || process.env.DEBUG_HTTP === '0') return;
                        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
                        const event = {
                            module: 'http', function: 'response', code: ERROR_CODES.API_REQUEST_COMPLETE,
                            http_status: res.statusCode, message: 'API request completed',
                            fields: { method: req.method, path: req.path, duration_ms: Number(durationMs.toFixed(1)) },
                            request_id: requestId, trace_id: traceId
                        };
                        if (res.statusCode >= 500) write('ERROR', event);
                        else if (res.statusCode >= 400) write('WARNING', event);
                        else write('DEBUG', event);
                    });
                    next();
                });
            };
        }
    };
    return logger;
}

module.exports = { LEVELS, createLogger, maskSecret, maskString, maskSensitive };

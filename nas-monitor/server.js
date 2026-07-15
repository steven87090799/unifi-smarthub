'use strict';

const crypto = require('crypto');
const http = require('http');
const { createRuntimeBuildIdentity } = require('./build-identity');

const SAFE_URL_BASE = 'http://nas-monitor.invalid';
const CANONICAL_CONTAINER_ID = /^[a-f0-9]{64}$/;
const LABEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const KNOWN_WEAK_KEYS = new Set([
    'changeme',
    'change-me',
    'default',
    'password',
    'secret',
    'smarthub-local-monitor',
    'your_nas_monitor_api_key'
]);

const DEFAULTS = Object.freeze({
    port: 8000,
    socketPath: '/var/run/docker.sock',
    requestBodyBytes: 1024,
    maxDockerConcurrency: 6,
    maxDockerQueue: 64,
    maxConnections: 128,
    listWorkerConcurrency: 4,
    maxContainers: 128,
    maxListResponseBytes: 3 * 1024 * 1024,
    actionStopSeconds: 10,
    listCacheMs: 2000,
    shutdownGraceMs: 15000,
    serverRequestTimeoutMs: 20000,
    serverHeadersTimeoutMs: 10000,
    serverKeepAliveTimeoutMs: 5000,
    timeouts: Object.freeze({
        health: 2000,
        list: 4000,
        inspect: 2500,
        stats: 3500,
        logs: 5000,
        action: 15000
    }),
    responseCaps: Object.freeze({
        health: 64 * 1024,
        list: 1024 * 1024,
        inspect: 512 * 1024,
        stats: 512 * 1024,
        logs: 1024 * 1024,
        action: 64 * 1024
    })
});

class PublicError extends Error {
    constructor(status, code, details = {}) {
        super(code);
        this.name = 'PublicError';
        this.status = status;
        this.code = code;
        Object.assign(this, details);
    }
}

class DockerError extends Error {
    constructor(code, details = {}) {
        super(code);
        this.name = 'DockerError';
        this.code = code;
        Object.assign(this, details);
    }
}

function parseBoundedInteger(raw, fallback, minimum, maximum, name) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const text = String(raw);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`invalid ${name}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid ${name}`);
    return value;
}

function parseEnabled(raw) {
    if (raw === undefined || raw === null || raw === '') return false;
    return String(raw).toLowerCase() === 'true';
}

function validateApiKey(key) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(key)) throw new Error('invalid NAS monitor API key');
    if (KNOWN_WEAK_KEYS.has(key.toLowerCase()) || new Set(key).size < 10) throw new Error('invalid NAS monitor API key');
    return key;
}

function parseIdAllowlist(raw) {
    if (!raw) return new Set();
    const values = String(raw).split(',').map(value => value.trim()).filter(Boolean);
    if (!values.length || values.some(value => !CANONICAL_CONTAINER_ID.test(value))) {
        throw new Error('invalid NAS monitor action ID allowlist');
    }
    return new Set(values);
}

function parseLabelAllowlist(raw) {
    if (!raw) return [];
    return String(raw).split(',').map(selector => {
        const separator = selector.indexOf('=');
        const key = separator > 0 ? selector.slice(0, separator).trim() : '';
        const value = separator > 0 ? selector.slice(separator + 1).trim() : '';
        if (!LABEL_KEY.test(key) || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
            throw new Error('invalid NAS monitor action label allowlist');
        }
        return Object.freeze({ key, value });
    });
}

function buildConfig(env = process.env, overrides = {}) {
    const mutationsEnabled = overrides.mutationsEnabled ?? parseEnabled(env.NAS_MONITOR_MUTATIONS_ENABLED);
    const actionIds = overrides.actionIds instanceof Set
        ? new Set(overrides.actionIds)
        : parseIdAllowlist(overrides.actionIds ?? env.NAS_MONITOR_ACTION_ALLOW_IDS);
    const actionLabels = Array.isArray(overrides.actionLabels)
        ? overrides.actionLabels.map(selector => ({ ...selector }))
        : parseLabelAllowlist(overrides.actionLabels ?? env.NAS_MONITOR_ACTION_ALLOW_LABELS);
    const logsEnabled = overrides.logsEnabled ?? parseEnabled(env.NAS_MONITOR_LOGS_ENABLED);
    const logIds = overrides.logIds instanceof Set
        ? new Set(overrides.logIds)
        : parseIdAllowlist(overrides.logIds ?? env.NAS_MONITOR_LOG_ALLOW_IDS);
    const logLabels = Array.isArray(overrides.logLabels)
        ? overrides.logLabels.map(selector => ({ ...selector }))
        : parseLabelAllowlist(overrides.logLabels ?? env.NAS_MONITOR_LOG_ALLOW_LABELS);
    for (const id of actionIds) {
        if (!CANONICAL_CONTAINER_ID.test(id)) throw new Error('invalid NAS monitor action ID allowlist');
    }
    for (const selector of actionLabels) {
        if (!selector || !LABEL_KEY.test(selector.key) || typeof selector.value !== 'string' || !selector.value || selector.value.length > 256) {
            throw new Error('invalid NAS monitor action label allowlist');
        }
    }
    if (mutationsEnabled && actionIds.size === 0 && actionLabels.length === 0) {
        throw new Error('NAS monitor mutations require an action allowlist');
    }
    for (const id of logIds) {
        if (!CANONICAL_CONTAINER_ID.test(id)) throw new Error('invalid NAS monitor log ID allowlist');
    }
    for (const selector of logLabels) {
        if (!selector || !LABEL_KEY.test(selector.key) || typeof selector.value !== 'string' || !selector.value || selector.value.length > 256) {
            throw new Error('invalid NAS monitor log label allowlist');
        }
    }
    if (logsEnabled && logIds.size === 0 && logLabels.length === 0) {
        throw new Error('NAS monitor logs require a log allowlist');
    }

    const timeouts = { ...DEFAULTS.timeouts, ...(overrides.timeouts || {}) };
    const responseCaps = { ...DEFAULTS.responseCaps, ...(overrides.responseCaps || {}) };
    for (const [name, value] of Object.entries(timeouts)) {
        if (!Number.isInteger(value) || value < 10 || value > 120000) throw new Error(`invalid ${name} timeout`);
    }
    for (const [name, value] of Object.entries(responseCaps)) {
        if (!Number.isInteger(value) || value < 16 || value > 16 * 1024 * 1024) throw new Error(`invalid ${name} response cap`);
    }

    const hostname = String(overrides.hostname ?? env.HOSTNAME ?? '').toLowerCase();
    if (hostname && !/^[a-f0-9]{12,64}$/.test(hostname)) {
        // Non-Docker hostnames cannot identify the broker container and are ignored.
    }

    const socketPath = String(overrides.socketPath ?? env.DOCKER_SOCKET ?? DEFAULTS.socketPath);
    if (!socketPath.startsWith('/') || socketPath.length > 512 || /[\x00-\x1f\x7f]/.test(socketPath)) {
        throw new Error('invalid Docker socket path');
    }
    const actionStopSeconds = parseBoundedInteger(
        overrides.actionStopSeconds ?? env.NAS_MONITOR_ACTION_STOP_SECONDS,
        DEFAULTS.actionStopSeconds, overrides.actionStopSeconds !== undefined ? 0 : 1, 30, 'action stop seconds'
    );
    if (timeouts.action < actionStopSeconds * 1000 + 10) {
        throw new Error('action timeout must exceed Docker stop grace');
    }

    return Object.freeze({
        port: parseBoundedInteger(overrides.port ?? env.PORT, DEFAULTS.port, 0, 65535, 'port'),
        socketPath,
        apiKey: validateApiKey(overrides.apiKey ?? env.NAS_MONITOR_API_KEY ?? ''),
        mutationsEnabled,
        actionIds,
        actionLabels,
        logsEnabled,
        logIds,
        logLabels,
        selfHostname: /^[a-f0-9]{12,64}$/.test(hostname) ? hostname : '',
        requestBodyBytes: parseBoundedInteger(overrides.requestBodyBytes, DEFAULTS.requestBodyBytes, 0, 64 * 1024, 'request body cap'),
        maxDockerConcurrency: parseBoundedInteger(overrides.maxDockerConcurrency ?? env.NAS_MONITOR_MAX_DOCKER_CONCURRENCY, DEFAULTS.maxDockerConcurrency, 1, 32, 'Docker concurrency'),
        maxDockerQueue: parseBoundedInteger(overrides.maxDockerQueue ?? env.NAS_MONITOR_MAX_DOCKER_QUEUE, DEFAULTS.maxDockerQueue, 0, 1024, 'Docker queue'),
        maxConnections: parseBoundedInteger(overrides.maxConnections ?? env.NAS_MONITOR_MAX_CONNECTIONS, DEFAULTS.maxConnections, 1, 1024, 'connection limit'),
        listWorkerConcurrency: parseBoundedInteger(overrides.listWorkerConcurrency ?? env.NAS_MONITOR_LIST_WORKERS, DEFAULTS.listWorkerConcurrency, 1, 16, 'list worker concurrency'),
        maxContainers: parseBoundedInteger(overrides.maxContainers ?? env.NAS_MONITOR_MAX_CONTAINERS, DEFAULTS.maxContainers, 1, 1000, 'container limit'),
        maxListResponseBytes: parseBoundedInteger(overrides.maxListResponseBytes ?? env.NAS_MONITOR_MAX_LIST_RESPONSE_BYTES, DEFAULTS.maxListResponseBytes, 64 * 1024, 4 * 1024 * 1024 - 4096, 'list response cap'),
        actionStopSeconds,
        listCacheMs: parseBoundedInteger(overrides.listCacheMs ?? env.NAS_MONITOR_LIST_CACHE_MS, DEFAULTS.listCacheMs, 0, 60000, 'list cache'),
        shutdownGraceMs: parseBoundedInteger(overrides.shutdownGraceMs ?? env.NAS_MONITOR_SHUTDOWN_GRACE_MS, DEFAULTS.shutdownGraceMs, 100, 60000, 'shutdown grace'),
        serverRequestTimeoutMs: parseBoundedInteger(overrides.serverRequestTimeoutMs, DEFAULTS.serverRequestTimeoutMs, 1000, 120000, 'server request timeout'),
        serverHeadersTimeoutMs: parseBoundedInteger(overrides.serverHeadersTimeoutMs, DEFAULTS.serverHeadersTimeoutMs, 1000, 120000, 'server headers timeout'),
        serverKeepAliveTimeoutMs: parseBoundedInteger(overrides.serverKeepAliveTimeoutMs, DEFAULTS.serverKeepAliveTimeoutMs, 100, 60000, 'server keep-alive timeout'),
        timeouts: Object.freeze(timeouts),
        responseCaps: Object.freeze(responseCaps)
    });
}

function createSemaphore(limit, maximumQueue) {
    let active = 0;
    const queue = [];
    const acquire = () => new Promise((resolve, reject) => {
        if (active < limit) {
            active += 1;
            resolve();
        } else if (queue.length >= maximumQueue) {
            reject(new DockerError('docker_busy'));
        } else {
            queue.push(resolve);
        }
    });
    const release = () => {
        const next = queue.shift();
        if (next) next();
        else active -= 1;
    };
    return {
        async run(task) {
            await acquire();
            try { return await task(); } finally { release(); }
        }
    };
}

function safeString(value, maximum = 512) {
    return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function json(res, status, body, extraHeaders = {}) {
    if (res.writableEnded || res.destroyed) return;
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
    });
    res.end(payload);
}

function requestHeaderCount(req, name) {
    let count = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (String(req.rawHeaders[index]).toLowerCase() === name) count += 1;
    }
    return count;
}

function secureEqual(candidate, expected) {
    const left = crypto.createHash('sha256').update(String(candidate)).digest();
    const right = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(left, right);
}

function authorized(req, apiKey) {
    if (requestHeaderCount(req, 'x-api-key') > 1 || requestHeaderCount(req, 'authorization') > 1) return false;
    const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (xApiKey && authorization) return false;
    let candidate = xApiKey;
    if (authorization) {
        const match = /^Bearer ([\x21-\x7e]{1,256})$/.exec(authorization);
        candidate = match ? match[1] : authorization.slice(0, 256);
        return !!match && secureEqual(candidate, apiKey);
    }
    return !!candidate && candidate.length <= 256 && secureEqual(candidate, apiKey);
}

function parseRequestUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || /[\\\x00-\x20\x7f]/.test(rawUrl)) {
        throw new PublicError(400, 'invalid_request');
    }
    let url;
    try { url = new URL(rawUrl, SAFE_URL_BASE); } catch { throw new PublicError(400, 'invalid_request'); }
    if (url.origin !== SAFE_URL_BASE || url.hash) throw new PublicError(400, 'invalid_request');
    Object.defineProperty(url, 'rawRequestTarget', { value: rawUrl });
    return url;
}

function assertNoQuery(url) {
    if (url.rawRequestTarget.includes('?')) throw new PublicError(400, 'invalid_request');
}

function assertEmptyBody(req, config) {
    const rejectBody = (status, code) => {
        req.resume();
        throw new PublicError(status, code, { closeConnection: true });
    };
    if (requestHeaderCount(req, 'content-length') > 1 || requestHeaderCount(req, 'transfer-encoding') > 0) {
        rejectBody(400, 'invalid_request');
    }
    const contentLength = req.headers['content-length'];
    if (contentLength === undefined) return;
    if (!/^(0|[1-9][0-9]*)$/.test(String(contentLength))) rejectBody(400, 'invalid_request');
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > config.requestBodyBytes) rejectBody(413, 'request_too_large');
    if (length !== 0) rejectBody(400, 'invalid_request');
}

function parseLogLines(url) {
    if (!url.search) return 200;
    const match = /^\?lines=([1-9][0-9]{0,3})$/.exec(url.search);
    if (!match) throw new PublicError(400, 'invalid_request');
    const value = Number(match[1]);
    if (value < 1 || value > 1000) throw new PublicError(400, 'invalid_request');
    return value;
}

function canonicalId(raw) {
    if (!CANONICAL_CONTAINER_ID.test(raw)) throw new PublicError(400, 'invalid_request');
    return raw;
}

function dockerLogText(buffer) {
    const parts = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const size = buffer.readUInt32BE(offset + 4);
        if (size > buffer.length - offset - 8) break;
        parts.push(buffer.subarray(offset + 8, offset + 8 + size).toString('utf8'));
        offset += 8 + size;
    }
    return parts.length && offset === buffer.length ? parts.join('') : buffer.toString('utf8');
}

function cpuPercent(stats) {
    const cpuDelta = safeNumber(stats?.cpu_stats?.cpu_usage?.total_usage) - safeNumber(stats?.precpu_stats?.cpu_usage?.total_usage);
    const systemDelta = safeNumber(stats?.cpu_stats?.system_cpu_usage) - safeNumber(stats?.precpu_stats?.system_cpu_usage);
    const cpus = safeNumber(stats?.cpu_stats?.online_cpus || stats?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1);
    return systemDelta > 0 && cpuDelta > 0 ? Number((cpuDelta / systemDelta * cpus * 100).toFixed(2)) : 0;
}

function networkBytes(stats, key) {
    if (!stats?.networks || typeof stats.networks !== 'object') return 0;
    return Object.values(stats.networks).slice(0, 64).reduce((sum, network) => sum + safeNumber(network?.[key]), 0);
}

function blockBytes(stats, operation) {
    const rows = Array.isArray(stats?.blkio_stats?.io_service_bytes_recursive)
        ? stats.blkio_stats.io_service_bytes_recursive.slice(0, 512)
        : [];
    return rows.reduce((sum, row) => String(row?.op || '').toLowerCase() === operation ? sum + safeNumber(row?.value) : sum, 0);
}

function createNasMonitor(options = {}) {
    const env = options.env || process.env;
    const buildIdentity = createRuntimeBuildIdentity(env);
    const config = buildConfig(env, options.config || {});
    const logger = options.logger || console;
    const httpModule = options.httpModule || http;
    const dockerSemaphore = createSemaphore(config.maxDockerConcurrency, config.maxDockerQueue);
    const sockets = new Set();
    const dockerRequests = new Set();
    let shuttingDown = false;
    let closePromise = null;
    let listInFlight = null;
    let listCache = null;
    let listCacheAt = 0;

    function rawDockerRequest(method, path, { timeoutMs, maxBytes }) {
        if (shuttingDown) return Promise.reject(new DockerError('docker_shutdown'));
        if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)) {
            return Promise.reject(new DockerError('docker_invalid_request'));
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let response;
            let bytes = 0;
            const chunks = [];
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                dockerRequests.delete(request);
                if (error) reject(error);
                else resolve(result);
            };
            const request = httpModule.request({
                socketPath: config.socketPath,
                path,
                method,
                agent: false,
                headers: { Host: 'docker.invalid', Connection: 'close' }
            }, incoming => {
                response = incoming;
                const declaredLength = Number(incoming.headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
                    finish(new DockerError('docker_response_too_large'));
                    incoming.destroy();
                    request.destroy();
                    return;
                }
                incoming.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > maxBytes) {
                        finish(new DockerError('docker_response_too_large'));
                        incoming.destroy();
                        request.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                incoming.on('aborted', () => finish(new DockerError('docker_connection_failed')));
                incoming.on('error', () => finish(new DockerError('docker_connection_failed')));
                incoming.on('end', () => {
                    const body = Buffer.concat(chunks, bytes);
                    if (incoming.statusCode >= 400) {
                        return finish(new DockerError('docker_http_status', { dockerStatus: incoming.statusCode }));
                    }
                    return finish(null, { status: incoming.statusCode || 0, body });
                });
            });
            dockerRequests.add(request);
            const timer = setTimeout(() => {
                finish(new DockerError('docker_timeout'));
                if (response) response.destroy();
                request.destroy();
            }, timeoutMs);
            timer.unref?.();
            request.on('error', () => finish(new DockerError('docker_connection_failed')));
            request.end();
        });
    }

    function dockerRequest(method, path, limits) {
        return dockerSemaphore.run(() => rawDockerRequest(method, path, limits));
    }

    async function dockerJson(method, path, limits) {
        const { body } = await dockerRequest(method, path, limits);
        if (!body.length) return {};
        try { return JSON.parse(body.toString('utf8')); } catch { throw new DockerError('docker_invalid_response'); }
    }

    async function safeDockerJson(method, path, limits) {
        try { return await dockerJson(method, path, limits); } catch { return null; }
    }

    function summarizeContainer(container, inspect, stats) {
        const memUsage = safeNumber(stats?.memory_stats?.usage);
        const memLimit = safeNumber(stats?.memory_stats?.limit);
        const portEntries = inspect?.NetworkSettings?.Ports && typeof inspect.NetworkSettings.Ports === 'object'
            ? Object.entries(inspect.NetworkSettings.Ports).slice(0, 64)
            : [];
        const ports = portEntries.flatMap(([containerPort, bindings]) =>
            Array.isArray(bindings) && bindings.length
                ? bindings.slice(0, 8).map(binding => ({
                    container: safeString(containerPort, 64),
                    host: safeString(binding?.HostPort, 16),
                    host_ip: safeString(binding?.HostIp, 64)
                }))
                : [{ container: safeString(containerPort, 64), host: '', host_ip: '' }]
        ).slice(0, 64);
        const networkEntries = inspect?.NetworkSettings?.Networks && typeof inspect.NetworkSettings.Networks === 'object'
            ? Object.entries(inspect.NetworkSettings.Networks).slice(0, 32)
            : [];
        const networks = networkEntries.map(([name, network]) => ({
            name: safeString(name, 128),
            ip_address: safeString(network?.IPAddress, 64),
            gateway: safeString(network?.Gateway, 64)
        }));
        const mounts = (Array.isArray(inspect?.Mounts) ? inspect.Mounts : []).slice(0, 32).map(mount => ({
            type: safeString(mount?.Type, 32),
            destination: safeString(mount?.Destination, 256),
            read_write: mount?.RW !== false
        }));
        const labels = inspect?.Config?.Labels && typeof inspect.Config.Labels === 'object' ? inspect.Config.Labels : {};
        const names = Array.isArray(container.Names) ? container.Names : [];
        const allowedActions = config.mutationsEnabled
            && inspect?.Id === container.Id
            && !isProtectedContainer(container.Id, inspect)
            && isAllowlisted(container.Id, inspect)
            ? ['start', 'stop', 'restart']
            : [];
        const logsAllowed = config.logsEnabled
            && inspect?.Id === container.Id
            && !isProtectedContainer(container.Id, inspect)
            && isLogAllowlisted(container.Id, inspect);
        return {
            id: container.Id,
            name: safeString(String(names[0] || container.Id.slice(0, 12)).replace(/^\//, ''), 256),
            image: safeString(container.Image, 512),
            image_id: safeString(inspect?.Image || container.ImageID, 256),
            state: safeString(container.State, 32),
            status: safeString(container.Status, 256),
            health: safeString(inspect?.State?.Health?.Status, 32),
            created_at: safeString(inspect?.Created || (container.Created ? new Date(safeNumber(container.Created) * 1000).toISOString() : ''), 64),
            started_at: safeString(inspect?.State?.StartedAt, 64),
            finished_at: safeString(inspect?.State?.FinishedAt, 64),
            restart_count: safeNumber(inspect?.RestartCount),
            restart_policy: safeString(inspect?.HostConfig?.RestartPolicy?.Name || 'no', 64),
            oom_killed: !!inspect?.State?.OOMKilled,
            platform: safeString(inspect?.Platform, 64),
            driver: safeString(inspect?.Driver, 64),
            compose_project: safeString(labels['com.docker.compose.project'], 128),
            compose_service: safeString(labels['com.docker.compose.service'], 128),
            allowed_actions: allowedActions,
            logs_allowed: logsAllowed,
            ports,
            networks,
            mounts,
            cpu_percent: stats ? cpuPercent(stats) : 0,
            mem_usage_mb: Number((memUsage / 1048576).toFixed(1)),
            mem_limit_mb: Number((memLimit / 1048576).toFixed(1)),
            pids: safeNumber(stats?.pids_stats?.current),
            network_rx_bytes: networkBytes(stats, 'rx_bytes'),
            network_tx_bytes: networkBytes(stats, 'tx_bytes'),
            block_read_bytes: blockBytes(stats, 'read'),
            block_write_bytes: blockBytes(stats, 'write'),
            details_partial: !inspect || (container.State === 'running' && !stats)
        };
    }

    async function buildContainerList() {
        const rows = await dockerJson('GET', '/containers/json?all=1', {
            timeoutMs: config.timeouts.list,
            maxBytes: config.responseCaps.list
        });
        if (!Array.isArray(rows)) throw new DockerError('docker_invalid_response');
        if (rows.length > config.maxContainers) throw new PublicError(503, 'container_limit_exceeded');
        if (rows.some(container => !container || !CANONICAL_CONTAINER_ID.test(container.Id))) {
            throw new DockerError('docker_invalid_response');
        }

        const output = new Array(rows.length);
        let cursor = 0;
        const worker = async () => {
            while (cursor < rows.length) {
                const index = cursor;
                cursor += 1;
                const container = rows[index];
                const id = container.Id;
                const inspect = await safeDockerJson('GET', `/containers/${id}/json`, {
                    timeoutMs: config.timeouts.inspect,
                    maxBytes: config.responseCaps.inspect
                });
                const stats = container.State === 'running'
                    ? await safeDockerJson('GET', `/containers/${id}/stats?stream=false&one-shot=true`, {
                        timeoutMs: config.timeouts.stats,
                        maxBytes: config.responseCaps.stats
                    })
                    : null;
                output[index] = summarizeContainer(container, inspect, stats);
            }
        };
        await Promise.all(Array.from({ length: Math.min(config.listWorkerConcurrency, rows.length) }, () => worker()));
        return output;
    }

    function listContainers() {
        const now = Date.now();
        if (listCache && now - listCacheAt <= config.listCacheMs) return Promise.resolve(listCache);
        if (listInFlight) return listInFlight;
        listInFlight = buildContainerList().then(containers => {
            listCache = containers;
            listCacheAt = Date.now();
            return containers;
        }).finally(() => { listInFlight = null; });
        return listInFlight;
    }

    function invalidateListCache() {
        listCache = null;
        listCacheAt = 0;
    }

    function boundedListPayload(containers) {
        const selected = [];
        const total = containers.length;
        let used = Buffer.byteLength(JSON.stringify({ containers: [], total, truncated: true }));
        for (const container of containers) {
            const bytes = Buffer.byteLength(JSON.stringify(container)) + (selected.length ? 1 : 0);
            if (used + bytes > config.maxListResponseBytes) break;
            selected.push(container);
            used += bytes;
        }
        const payload = { containers: selected, total, truncated: selected.length < total };
        while (selected.length && Buffer.byteLength(JSON.stringify(payload)) > config.maxListResponseBytes) {
            selected.pop();
            payload.truncated = true;
        }
        return payload;
    }

    function isProtectedContainer(id, inspect) {
        const inspectId = typeof inspect?.Id === 'string' ? inspect.Id : id;
        const labels = inspect?.Config?.Labels && typeof inspect.Config.Labels === 'object' ? inspect.Config.Labels : {};
        const selfByHostname = !!config.selfHostname && inspectId.startsWith(config.selfHostname);
        return selfByHostname
            || labels['com.docker.compose.service'] === 'nas-monitor'
            || labels['com.unifi.smarthub.nas-monitor.protected'] === 'true';
    }

    function isAllowlisted(id, inspect) {
        if (config.actionIds.has(id)) return true;
        const labels = inspect?.Config?.Labels && typeof inspect.Config.Labels === 'object' ? inspect.Config.Labels : {};
        return config.actionLabels.some(selector => labels[selector.key] === selector.value);
    }

    function isLogAllowlisted(id, inspect) {
        if (config.logIds.has(id)) return true;
        const labels = inspect?.Config?.Labels && typeof inspect.Config.Labels === 'object' ? inspect.Config.Labels : {};
        return config.logLabels.some(selector => labels[selector.key] === selector.value);
    }

    async function enforceLogPolicy(id) {
        if (!config.logsEnabled) throw new PublicError(403, 'logs_disabled');
        let inspect;
        try {
            inspect = await dockerJson('GET', `/containers/${id}/json`, {
                timeoutMs: config.timeouts.inspect,
                maxBytes: config.responseCaps.inspect
            });
        } catch (error) {
            if (error?.code === 'docker_busy' || error?.code === 'docker_shutdown') throw error;
            throw new PublicError(502, 'log_policy_unavailable');
        }
        if (!inspect || typeof inspect !== 'object' || inspect.Id !== id || !CANONICAL_CONTAINER_ID.test(inspect.Id)) {
            throw new PublicError(502, 'log_policy_unavailable');
        }
        if (isProtectedContainer(id, inspect) || !isLogAllowlisted(id, inspect)) {
            throw new PublicError(403, 'logs_not_allowed');
        }
    }

    async function enforceActionPolicy(id) {
        if (!config.mutationsEnabled) throw new PublicError(403, 'mutations_disabled');
        let inspect;
        try {
            inspect = await dockerJson('GET', `/containers/${id}/json`, {
                timeoutMs: config.timeouts.inspect,
                maxBytes: config.responseCaps.inspect
            });
        } catch {
            throw new PublicError(502, 'action_policy_unavailable');
        }
        if (!inspect || typeof inspect !== 'object' || !CANONICAL_CONTAINER_ID.test(inspect.Id) || inspect.Id !== id) {
            throw new PublicError(502, 'action_policy_unavailable');
        }
        if (isProtectedContainer(id, inspect) || !isAllowlisted(id, inspect)) {
            throw new PublicError(403, 'action_not_allowed');
        }
    }

    function dockerErrorResponse(error) {
        if (error instanceof PublicError) return { status: error.status, body: { error: error.code } };
        switch (error?.code) {
            case 'docker_timeout': return { status: 504, body: { error: 'docker_timeout' } };
            case 'docker_response_too_large': return { status: 502, body: { error: 'docker_response_too_large' } };
            case 'docker_invalid_response': return { status: 502, body: { error: 'docker_invalid_response' } };
            case 'docker_busy': return { status: 503, body: { error: 'docker_busy' } };
            case 'docker_shutdown': return { status: 503, body: { error: 'shutting_down' } };
            default: return { status: 502, body: { error: 'docker_unavailable' } };
        }
    }

    const server = http.createServer(async (req, res) => {
        try {
            if (shuttingDown) return json(res, 503, { error: 'shutting_down' }, { Connection: 'close' });
            const url = parseRequestUrl(req.url);
            assertEmptyBody(req, config);
            if (req.method === 'GET' && url.pathname === '/health') {
                assertNoQuery(url);
                try {
                    await dockerJson('GET', '/version', {
                        timeoutMs: config.timeouts.health,
                        maxBytes: config.responseCaps.health
                    });
                    return json(res, 200, {
                        status: 'healthy',
                        docker: true,
                        mode: 'docker_only',
                        build: buildIdentity
                    });
                } catch {
                    return json(res, 503, { status: 'unhealthy', docker: false, build: buildIdentity });
                }
            }
            if (!authorized(req, config.apiKey)) {
                return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="nas-monitor"' });
            }
            if (req.method === 'GET' && url.pathname === '/api/capabilities') {
                assertNoQuery(url);
                return json(res, 200, {
                    docker: true,
                    history: false,
                    alerts: false,
                    stream: false,
                    mutations: config.mutationsEnabled,
                    logs: config.logsEnabled
                });
            }
            if (req.method === 'GET' && url.pathname === '/api/docker/containers') {
                assertNoQuery(url);
                return json(res, 200, boundedListPayload(await listContainers()));
            }
            const actionMatch = /^\/api\/docker\/containers\/([^/]+)\/(start|stop|restart)$/.exec(url.pathname);
            if (req.method === 'POST' && actionMatch) {
                assertNoQuery(url);
                const id = canonicalId(actionMatch[1]);
                const action = actionMatch[2];
                await enforceActionPolicy(id);
                invalidateListCache();
                const actionPath = action === 'start'
                    ? `/containers/${id}/start`
                    : `/containers/${id}/${action}?t=${config.actionStopSeconds}`;
                try {
                    await dockerRequest('POST', actionPath, {
                        timeoutMs: config.timeouts.action,
                        maxBytes: config.responseCaps.action
                    });
                } catch (error) {
                    const definitive = error?.code === 'docker_http_status';
                    const notSent = error?.code === 'docker_shutdown' || error?.code === 'docker_busy';
                    if (notSent) {
                        return json(res, 503, { error: error.code === 'docker_shutdown' ? 'shutting_down' : 'docker_busy', action, ambiguous: false });
                    }
                    return json(res, definitive ? 502 : 504, {
                        error: definitive ? 'action_failed' : 'action_result_unknown',
                        action,
                        ambiguous: !definitive
                    });
                }
                return json(res, 200, { ok: true, id, action, ambiguous: false });
            }
            const logMatch = /^\/api\/docker\/containers\/([^/]+)\/logs$/.exec(url.pathname);
            if (req.method === 'GET' && logMatch) {
                const id = canonicalId(logMatch[1]);
                const tail = parseLogLines(url);
                await enforceLogPolicy(id);
                const { body } = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`, {
                    timeoutMs: config.timeouts.logs,
                    maxBytes: config.responseCaps.logs
                });
                return json(res, 200, { logs: dockerLogText(body) });
            }
            return json(res, 404, { error: 'not_found' });
        } catch (error) {
            const response = dockerErrorResponse(error);
            if (!(error instanceof PublicError) && !(error instanceof DockerError)) {
                logger.error?.('NAS monitor request failed', { error: error?.name || 'Error' });
            }
            return json(res, response.status, response.body, (response.status >= 500 || error?.closeConnection) ? { Connection: 'close' } : {});
        }
    });

    server.requestTimeout = config.serverRequestTimeoutMs;
    server.headersTimeout = Math.min(config.serverHeadersTimeoutMs, config.serverRequestTimeoutMs);
    server.keepAliveTimeout = config.serverKeepAliveTimeoutMs;
    server.maxHeadersCount = 64;
    server.maxConnections = config.maxConnections;
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    function listen({ port = config.port, host = '0.0.0.0' } = {}) {
        if (shuttingDown) return Promise.reject(new Error('NAS monitor is shutting down'));
        return new Promise((resolve, reject) => {
            const onError = error => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve(server.address());
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, host);
        });
    }

    function close({ graceMs = config.shutdownGraceMs } = {}) {
        if (closePromise) return closePromise;
        shuttingDown = true;
        closePromise = new Promise(resolve => {
            let settled = false;
            const finish = forced => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (forced) {
                    for (const request of dockerRequests) request.destroy();
                    for (const socket of sockets) socket.destroy();
                }
                resolve({ forced });
            };
            const timer = setTimeout(() => finish(true), graceMs);
            timer.unref?.();
            if (!server.listening) return finish(false);
            server.close(() => finish(false));
            server.closeIdleConnections?.();
        });
        return closePromise;
    }

    function startupLog(port = config.port) {
        const listeningPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : config.port;
        return JSON.stringify({
            level: 'info',
            event: 'nas_monitor_started',
            port: listeningPort,
            build: buildIdentity
        });
    }

    return Object.freeze({ server, config, buildIdentity, listen, close, startupLog });
}

async function runMain() {
    let monitor;
    try {
        monitor = createNasMonitor();
        const address = await monitor.listen();
        console.log(monitor.startupLog(typeof address === 'object' ? address.port : DEFAULTS.port));
    } catch {
        console.error('NAS Docker Monitor configuration or startup failed');
        process.exitCode = 1;
        return;
    }

    let stopping = false;
    const stop = async signal => {
        if (stopping) return;
        stopping = true;
        console.log(`NAS Docker Monitor received ${signal}; draining requests`);
        const result = await monitor.close();
        if (result.forced) console.error('NAS Docker Monitor shutdown deadline reached');
        process.exit(result.forced ? 1 : 0);
    };
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
}

if (require.main === module) void runMain();

module.exports = {
    CANONICAL_CONTAINER_ID,
    DockerError,
    PublicError,
    buildConfig,
    createNasMonitor,
    dockerLogText,
    validateApiKey
};

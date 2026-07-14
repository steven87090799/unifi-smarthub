'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 8000);
const API_KEY = process.env.NAS_MONITOR_API_KEY || '';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function authorized(req) {
    if (!API_KEY) return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return req.headers['x-api-key'] === API_KEY || bearer === API_KEY;
}

function dockerRequest(method, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: DOCKER_SOCKET, path, method }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                if (res.statusCode >= 400) return reject(new Error(`Docker API ${res.statusCode}: ${body.toString('utf8').slice(0, 300)}`));
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function dockerJson(method, path) {
    const { body } = await dockerRequest(method, path);
    return body.length ? JSON.parse(body.toString('utf8')) : {};
}

function dockerLogText(buffer) {
    const parts = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const size = buffer.readUInt32BE(offset + 4);
        if (offset + 8 + size > buffer.length) break;
        parts.push(buffer.subarray(offset + 8, offset + 8 + size).toString('utf8'));
        offset += 8 + size;
    }
    return parts.length ? parts.join('') : buffer.toString('utf8');
}

function cpuPercent(stats) {
    const cpuDelta = Number(stats.cpu_stats?.cpu_usage?.total_usage || 0) - Number(stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = Number(stats.cpu_stats?.system_cpu_usage || 0) - Number(stats.precpu_stats?.system_cpu_usage || 0);
    const cpus = Number(stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1);
    return systemDelta > 0 && cpuDelta > 0 ? Number((cpuDelta / systemDelta * cpus * 100).toFixed(2)) : 0;
}

function networkBytes(stats, key) {
    return Object.values(stats?.networks || {}).reduce((sum, network) => sum + Number(network?.[key] || 0), 0);
}

function blockBytes(stats, operation) {
    return (stats?.blkio_stats?.io_service_bytes_recursive || []).reduce((sum, row) =>
        String(row?.op || '').toLowerCase() === operation ? sum + Number(row?.value || 0) : sum, 0);
}

async function listContainers() {
    const rows = await dockerJson('GET', '/containers/json?all=1');
    return Promise.all(rows.map(async container => {
        let stats = null;
        let inspect = null;
        try { inspect = await dockerJson('GET', `/containers/${encodeURIComponent(container.Id)}/json`); } catch { }
        if (container.State === 'running') {
            try { stats = await dockerJson('GET', `/containers/${encodeURIComponent(container.Id)}/stats?stream=false&one-shot=true`); } catch { }
        }
        const memUsage = Number(stats?.memory_stats?.usage || 0);
        const memLimit = Number(stats?.memory_stats?.limit || 0);
        const ports = Object.entries(inspect?.NetworkSettings?.Ports || {}).flatMap(([containerPort, bindings]) =>
            Array.isArray(bindings) && bindings.length
                ? bindings.map(binding => ({ container: containerPort, host: binding.HostPort || '', host_ip: binding.HostIp || '' }))
                : [{ container: containerPort, host: '', host_ip: '' }]
        );
        const networks = Object.entries(inspect?.NetworkSettings?.Networks || {}).map(([name, network]) => ({
            name,
            ip_address: network?.IPAddress || '',
            gateway: network?.Gateway || ''
        }));
        const mounts = (inspect?.Mounts || []).map(mount => ({
            type: mount.Type || '',
            destination: mount.Destination || '',
            read_write: mount.RW !== false
        }));
        const labels = inspect?.Config?.Labels || {};
        return {
            id: container.Id,
            name: String(container.Names?.[0] || container.Id.slice(0, 12)).replace(/^\//, ''),
            image: container.Image,
            image_id: inspect?.Image || container.ImageID || '',
            state: container.State,
            status: container.Status,
            health: inspect?.State?.Health?.Status || '',
            created_at: inspect?.Created || (container.Created ? new Date(container.Created * 1000).toISOString() : ''),
            started_at: inspect?.State?.StartedAt || '',
            finished_at: inspect?.State?.FinishedAt || '',
            restart_count: Number(inspect?.RestartCount || 0),
            restart_policy: inspect?.HostConfig?.RestartPolicy?.Name || 'no',
            oom_killed: !!inspect?.State?.OOMKilled,
            platform: inspect?.Platform || '',
            driver: inspect?.Driver || '',
            compose_project: labels['com.docker.compose.project'] || '',
            compose_service: labels['com.docker.compose.service'] || '',
            ports,
            networks,
            mounts,
            cpu_percent: stats ? cpuPercent(stats) : 0,
            mem_usage_mb: Number((memUsage / 1048576).toFixed(1)),
            mem_limit_mb: Number((memLimit / 1048576).toFixed(1)),
            pids: Number(stats?.pids_stats?.current || 0),
            network_rx_bytes: networkBytes(stats, 'rx_bytes'),
            network_tx_bytes: networkBytes(stats, 'tx_bytes'),
            block_read_bytes: blockBytes(stats, 'read'),
            block_write_bytes: blockBytes(stats, 'write')
        };
    }));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
        try {
            await dockerJson('GET', '/version');
            return json(res, 200, { status: 'healthy', docker: true, mode: 'docker_only' });
        } catch (error) {
            return json(res, 503, { status: 'unhealthy', error: error.message });
        }
    }
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    try {
        if (req.method === 'GET' && url.pathname === '/api/capabilities') {
            return json(res, 200, { docker: true, history: false, alerts: false, stream: false });
        }
        if (req.method === 'GET' && url.pathname === '/api/docker/containers') {
            return json(res, 200, { containers: await listContainers() });
        }
        const actionMatch = url.pathname.match(/^\/api\/docker\/containers\/([^/]+)\/(start|stop|restart)$/);
        if (req.method === 'POST' && actionMatch) {
            await dockerRequest('POST', `/containers/${encodeURIComponent(actionMatch[1])}/${actionMatch[2]}`);
            return json(res, 200, { ok: true, action: actionMatch[2] });
        }
        const logMatch = url.pathname.match(/^\/api\/docker\/containers\/([^/]+)\/logs$/);
        if (req.method === 'GET' && logMatch) {
            const tail = Math.min(1000, Math.max(1, Number(url.searchParams.get('lines') || 200)));
            const { body } = await dockerRequest('GET', `/containers/${encodeURIComponent(logMatch[1])}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
            return json(res, 200, { logs: dockerLogText(body) });
        }
        return json(res, 404, { error: 'not_found' });
    } catch (error) {
        return json(res, 502, { error: error.message });
    }
});

server.listen(PORT, '0.0.0.0', () => console.log(`NAS Docker Monitor listening on ${PORT}`));

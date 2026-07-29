'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');

const MAX_CA_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 5000;

function strictBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new TypeError('PPB TLS flags must be true or false');
}

function readPrivateCa(fsModule, caFile) {
    if (!caFile) return null;
    if (!fsModule.realpathSync || !fsModule.lstatSync || !fsModule.readFileSync) {
        throw new TypeError('PPB CA file access is unavailable');
    }
    if (!require('node:path').isAbsolute(caFile)) {
        throw new Error('PPB_CA_FILE must be an absolute path');
    }
    let stat;
    try { stat = fsModule.lstatSync(caFile); }
    catch (error) { throw new Error(`PPB CA file cannot be read: ${error.message}`); }
    if (stat.isSymbolicLink()) throw new Error('PPB CA file must not be a symlink');
    if (!stat.isFile()) throw new Error('PPB CA path must be a regular file');
    if (stat.size <= 0 || stat.size > MAX_CA_BYTES) throw new Error('PPB CA file size is invalid');
    try { return fsModule.readFileSync(caFile); }
    catch (error) { throw new Error(`PPB CA file cannot be read: ${error.message}`); }
}

function normalizeConfig(raw, fsModule) {
    const config = raw && typeof raw === 'object' ? raw : {};
    const tlsInsecure = strictBoolean(config.tlsInsecure, false);
    if (config.tlsVerify !== undefined && !strictBoolean(config.tlsVerify, true) && !tlsInsecure) {
        throw new Error('Use PPB_TLS_INSECURE=true to explicitly disable certificate verification');
    }
    const caFile = String(config.caFile || '');
    const ca = readPrivateCa(fsModule, caFile);
    const key = crypto.createHash('sha256')
        .update(JSON.stringify([
            String(config.host || ''),
            String(config.httpPort || '3052'),
            tlsInsecure,
            caFile
        ]))
        .update(ca || Buffer.alloc(0))
        .digest('hex');
    return {
        host: String(config.host || '127.0.0.1'),
        httpPort: String(config.httpPort || '3052'),
        user: String(config.user || ''),
        password: String(config.password || ''),
        tlsInsecure,
        ca,
        key
    };
}

function createPpbClient({
    axios,
    getConfig,
    logger = null,
    fsModule = fs,
    httpsModule = https
} = {}) {
    if (!axios || typeof axios.get !== 'function' || typeof axios.post !== 'function') {
        throw new TypeError('axios-compatible client is required');
    }
    if (typeof getConfig !== 'function') throw new TypeError('getConfig is required');

    let token = null;
    let httpsPort = null;
    let agent = null;
    let agentKey = null;
    let closed = false;
    const warnedInsecureKeys = new Set();

    function currentConfig() {
        if (closed) throw new Error('PPB client is closed');
        const config = normalizeConfig(getConfig(), fsModule);
        if (!config.user || !config.password) throw new Error('ppb_not_configured');
        return config;
    }

    function destroyAgent() {
        if (!agent) return;
        const target = agent;
        agent = null;
        agentKey = null;
        try { target.destroy(); } catch { }
    }

    function ensureAgent(config) {
        if (agent && agentKey === config.key) return agent;
        destroyAgent();
        agent = new httpsModule.Agent({
            keepAlive: true,
            rejectUnauthorized: !config.tlsInsecure,
            ...(config.ca ? { ca: config.ca } : {})
        });
        agentKey = config.key;
        token = null;
        httpsPort = null;
        if (config.tlsInsecure && !warnedInsecureKeys.has(config.key)) {
            warnedInsecureKeys.add(config.key);
            logger?.warn?.({
                module: 'integration.ppb',
                function: 'createAgent',
                code: 'PPB_TLS_INSECURE',
                message: 'PPB TLS certificate verification is disabled'
            });
        }
        return agent;
    }

    async function discoverPort(config) {
        if (httpsPort) return httpsPort;
        const response = await axios.get(`http://${config.host}:${config.httpPort}/local/`, {
            maxRedirects: 0,
            validateStatus: () => true,
            timeout: DISCOVERY_TIMEOUT_MS
        });
        const location = String(response?.headers?.location || '');
        const match = /^https:\/\/[^/:]+:(\d+)\/?/u.exec(location);
        if (!match) throw new Error(`PowerPanel Business service was not discovered (${config.host}:${config.httpPort})`);
        httpsPort = match[1];
        return httpsPort;
    }

    async function login(config, port, httpsAgent) {
        const response = await axios.post(
            `https://${config.host}:${port}/local/rest/v1/login/verify`,
            { userName: config.user, password: config.password },
            {
                httpsAgent,
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: () => true
            }
        );
        if (response.status !== 200 || response.data === undefined || response.data === null) {
            throw new Error(`PPB login failed (${response.status})`);
        }
        token = response.data;
        return token;
    }

    async function get(pathname) {
        if (typeof pathname !== 'string' || !/^\/local\/rest\/v1\/[A-Za-z0-9/_-]+$/u.test(pathname)) {
            throw new TypeError('PPB API path is invalid');
        }
        const config = currentConfig();
        const httpsAgent = ensureAgent(config);
        const port = await discoverPort(config);
        if (!token) await login(config, port, httpsAgent);
        const request = () => axios.get(`https://${config.host}:${port}${pathname}`, {
            headers: { Authorization: token },
            httpsAgent,
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true
        });
        let response = await request();
        if (response.status === 401 || response.status === 403) {
            token = null;
            await login(config, port, httpsAgent);
            response = await request();
        }
        if (response.status !== 200) throw new Error(`PPB API ${response.status}`);
        return response.data;
    }

    function reset() {
        token = null;
        httpsPort = null;
        ensureAgent(normalizeConfig(getConfig(), fsModule));
    }

    function close() {
        if (closed) return;
        closed = true;
        token = null;
        httpsPort = null;
        destroyAgent();
    }

    function snapshot() {
        return {
            state: closed ? 'closed' : agent ? 'ready' : 'idle',
            agentActive: !!agent,
            tokenActive: !!token,
            tlsVerification: agent ? agent.options?.rejectUnauthorized !== false : null
        };
    }

    // Validate CA/TLS policy and create the reusable agent during startup so a
    // broken trust configuration fails closed before the service begins work.
    ensureAgent(normalizeConfig(getConfig(), fsModule));

    return Object.freeze({ close, get, reset, snapshot });
}

module.exports = {
    DISCOVERY_TIMEOUT_MS,
    MAX_CA_BYTES,
    REQUEST_TIMEOUT_MS,
    createPpbClient,
    normalizeConfig
};

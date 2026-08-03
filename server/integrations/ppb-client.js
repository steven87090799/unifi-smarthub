'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { createLanAxiosConfig } = require('./http-egress-policy');
const { readCaFile } = require('./tls-policy');

const MAX_CA_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 5000;
const PPB_REQUEST_SUPERSEDED_CODE = 'PPB_REQUEST_SUPERSEDED';
const PPB_CLIENT_CLOSED_CODE = 'PPB_CLIENT_CLOSED';

class PpbRequestSupersededError extends Error {
    constructor() {
        super('PPB request was superseded by a configuration change');
        this.name = 'PpbRequestSupersededError';
        this.code = PPB_REQUEST_SUPERSEDED_CODE;
    }
}

class PpbClientClosedError extends Error {
    constructor() {
        super('PPB client is closed');
        this.name = 'PpbClientClosedError';
        this.code = PPB_CLIENT_CLOSED_CODE;
    }
}

function isPpbRequestSupersededError(error) {
    return error?.code === PPB_REQUEST_SUPERSEDED_CODE;
}

function strictBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new TypeError('PPB TLS flags must be true or false');
}

function readPrivateCa(fsModule, caFile) {
    if (!caFile) return null;
    if (!path.isAbsolute(caFile)) {
        throw new Error('PPB_CA_FILE must be an absolute path');
    }
    try { return readCaFile(caFile, { fileSystem: fsModule, field: 'PPB_CA_FILE' }); }
    catch (error) {
        if (error?.message?.includes('must not be a symlink')) throw new Error('PPB CA file must not be a symlink');
        if (error?.message?.includes('regular file')) throw new Error('PPB CA path must be a regular file');
        if (error?.message?.includes('no larger')) throw new Error('PPB CA file size is invalid');
        throw new Error('PPB CA file cannot be read');
    }
}

function normalizeConfig(raw, fsModule) {
    const config = raw && typeof raw === 'object' ? raw : {};
    const tlsInsecure = strictBoolean(config.tlsInsecure, false);
    const tlsVerify = strictBoolean(config.tlsVerify, true);
    if (!tlsVerify && !tlsInsecure) {
        throw new Error('Use PPB_TLS_INSECURE=true to explicitly disable certificate verification');
    }
    const caFile = String(config.caFile || '');
    const ca = readPrivateCa(fsModule, caFile);
    const user = String(config.user || '');
    const password = String(config.password || '');
    const key = crypto.createHash('sha256')
        .update(JSON.stringify([
            String(config.host || ''),
            String(config.httpPort || '3052'),
            user,
            crypto.createHash('sha256').update(password).digest('hex'),
            tlsVerify,
            tlsInsecure,
            caFile
        ]))
        .update(ca || Buffer.alloc(0))
        .digest('hex');
    return {
        host: String(config.host || '127.0.0.1'),
        httpPort: String(config.httpPort || '3052'),
        user,
        password,
        tlsVerify,
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
    let generation = 0;
    let activeConfigKey = null;
    let loginPromise = null;
    let loginLease = null;
    let closed = false;
    const warnedInsecureKeys = new Set();

    function assertOpen() {
        if (closed) throw new PpbClientClosedError();
    }

    function currentConfig() {
        assertOpen();
        const config = normalizeConfig(getConfig(), fsModule);
        if (!config.user || !config.password) throw new Error('ppb_not_configured');
        return config;
    }

    function isCurrentLease(lease) {
        return !closed
            && lease
            && lease.generation === generation
            && lease.configKey === activeConfigKey;
    }

    function assertCurrentLease(lease) {
        if (!isCurrentLease(lease)) throw new PpbRequestSupersededError();
    }

    async function withCurrentLease(lease, operation) {
        assertCurrentLease(lease);
        try {
            const result = await operation();
            assertCurrentLease(lease);
            return result;
        } catch (error) {
            if (isPpbRequestSupersededError(error)) throw error;
            if (!isCurrentLease(lease)) throw new PpbRequestSupersededError();
            throw error;
        }
    }

    function destroyAgent(target) {
        if (!target) return;
        try { target.destroy(); } catch { }
    }

    function createAgent(config) {
        const nextAgent = new httpsModule.Agent({
            keepAlive: true,
            rejectUnauthorized: !config.tlsInsecure,
            ...(config.ca ? { ca: config.ca } : {})
        });
        if (config.tlsInsecure && !warnedInsecureKeys.has(config.key)) {
            warnedInsecureKeys.add(config.key);
            logger?.warn?.({
                module: 'integration.ppb',
                function: 'createAgent',
                code: 'PPB_TLS_INSECURE',
                message: 'PPB TLS certificate verification is disabled'
            });
        }
        return nextAgent;
    }

    function replaceSession(config) {
        const oldAgent = agent;
        generation += 1;
        activeConfigKey = config.key;
        token = null;
        httpsPort = null;
        loginPromise = null;
        loginLease = null;
        agent = null;
        agentKey = null;
        destroyAgent(oldAgent);
        const nextAgent = createAgent(config);
        agent = nextAgent;
        agentKey = config.key;
        return nextAgent;
    }

    function ensureSession(config) {
        assertOpen();
        if (!agent || agentKey !== config.key || activeConfigKey !== config.key) {
            replaceSession(config);
        }
        return {
            lease: Object.freeze({ generation, configKey: activeConfigKey }),
            httpsAgent: agent
        };
    }

    async function discoverPort(config, lease) {
        assertCurrentLease(lease);
        if (httpsPort) return httpsPort;
        const response = await withCurrentLease(lease, () => axios.get(
            `http://${config.host}:${config.httpPort}/local/`,
            createLanAxiosConfig({
                maxRedirects: 0,
                validateStatus: () => true,
                timeout: DISCOVERY_TIMEOUT_MS
            })
        ));
        const location = String(response?.headers?.location || '');
        const match = /^https:\/\/[^/:]+:(\d+)\/?/u.exec(location);
        if (!match) throw new Error(`PowerPanel Business service was not discovered (${config.host}:${config.httpPort})`);
        assertCurrentLease(lease);
        httpsPort = match[1];
        return httpsPort;
    }

    async function login(config, port, httpsAgent, lease) {
        const response = await withCurrentLease(lease, () => axios.post(
            `https://${config.host}:${port}/local/rest/v1/login/verify`,
            { userName: config.user, password: config.password },
            createLanAxiosConfig({
                httpsAgent,
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: () => true
            })
        ));
        if (response.status !== 200 || response.data === undefined || response.data === null) {
            throw new Error(`PPB login failed (${response.status})`);
        }
        assertCurrentLease(lease);
        token = response.data;
        return token;
    }

    function loginForLease(config, port, httpsAgent, lease) {
        assertCurrentLease(lease);
        if (token) return Promise.resolve(token);
        if (loginPromise && loginLease?.generation === lease.generation && loginLease?.configKey === lease.configKey) {
            return loginPromise;
        }
        const flight = login(config, port, httpsAgent, lease);
        loginPromise = flight;
        loginLease = lease;
        const clearFlight = () => {
            if (loginPromise !== flight) return;
            loginPromise = null;
            loginLease = null;
        };
        void flight.then(clearFlight, clearFlight);
        return flight;
    }

    async function get(pathname) {
        if (typeof pathname !== 'string' || !/^\/local\/rest\/v1\/[A-Za-z0-9/_-]+$/u.test(pathname)) {
            throw new TypeError('PPB API path is invalid');
        }
        const config = currentConfig();
        const { lease, httpsAgent } = ensureSession(config);
        const port = await discoverPort(config, lease);
        const requestToken = await loginForLease(config, port, httpsAgent, lease);
        const request = tokenForRequest => withCurrentLease(lease, () => axios.get(
            `https://${config.host}:${port}${pathname}`,
            createLanAxiosConfig({
                headers: { Authorization: tokenForRequest },
                httpsAgent,
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: () => true
            })
        ));
        let response = await request(requestToken);
        if (response.status === 401 || response.status === 403) {
            assertCurrentLease(lease);
            if (token === requestToken) {
                token = null;
                if (loginLease?.generation === lease.generation && loginLease?.configKey === lease.configKey) {
                    loginPromise = null;
                    loginLease = null;
                }
            }
            const retryToken = await loginForLease(config, port, httpsAgent, lease);
            response = await request(retryToken);
        }
        if (response.status !== 200) throw new Error(`PPB API ${response.status}`);
        return response.data;
    }

    function reset() {
        assertOpen();
        replaceSession(normalizeConfig(getConfig(), fsModule));
    }

    function close() {
        if (closed) return;
        const oldAgent = agent;
        generation += 1;
        closed = true;
        activeConfigKey = null;
        token = null;
        httpsPort = null;
        loginPromise = null;
        loginLease = null;
        agent = null;
        agentKey = null;
        destroyAgent(oldAgent);
    }

    function snapshot() {
        return {
            state: closed ? 'closed' : agent ? 'ready' : 'idle',
            agentActive: !!agent,
            tokenActive: !!token,
            tlsVerification: agent ? agent.options?.rejectUnauthorized !== false : null,
            generation
        };
    }

    // Validate CA/TLS policy and create the reusable agent during startup so a
    // broken trust configuration fails closed before the service begins work.
    replaceSession(normalizeConfig(getConfig(), fsModule));

    return Object.freeze({ close, get, reset, snapshot });
}

module.exports = {
    DISCOVERY_TIMEOUT_MS,
    MAX_CA_BYTES,
    PPB_CLIENT_CLOSED_CODE,
    PPB_REQUEST_SUPERSEDED_CODE,
    REQUEST_TIMEOUT_MS,
    PpbClientClosedError,
    PpbRequestSupersededError,
    createPpbClient,
    isPpbRequestSupersededError,
    normalizeConfig
};

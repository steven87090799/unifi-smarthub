const crypto = require('crypto');
const net = require('net');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const NAMED_PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function positiveInteger(value, fallback, minimum = 1) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function parseTrustedProxies(value) {
    if (value == null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'false') return false;
    const raw = String(value).trim();
    if (/^(true|\*|\d+)$/i.test(raw)) {
        throw new Error('PANEL_TRUSTED_PROXIES must name explicit proxy IP/CIDR ranges; boolean and hop-count trust are forbidden');
    }
    const entries = raw.split(',').map(entry => entry.trim()).filter(Boolean);
    if (!entries.length) return false;
    for (const entry of entries) {
        if (NAMED_PROXY_RANGES.has(entry.toLowerCase())) continue;
        const slash = entry.lastIndexOf('/');
        const address = slash === -1 ? entry : entry.slice(0, slash);
        const prefix = slash === -1 ? null : entry.slice(slash + 1);
        const family = net.isIP(address);
        const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
        if (!family || (prefix != null && (!/^\d+$/.test(prefix) || Number(prefix) > maxPrefix))) {
            throw new Error(`Invalid trusted proxy range: ${entry}`);
        }
    }
    return entries.join(', ');
}

function normalizeOrigins(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split(',');
    return entries.map(entry => String(entry).trim()).filter(Boolean).map(entry => {
        const url = new URL(entry);
        if (!/^https?:$/.test(url.protocol) || url.origin === 'null') throw new Error(`Invalid allowed origin: ${entry}`);
        return url.origin;
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function secretEqual(actual, expected) {
    if (typeof expected !== 'string' || expected.length === 0 || typeof actual !== 'string') return false;
    return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function parseBasicCredentials(header) {
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
    const encoded = header.slice(6).trim();
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    let decoded;
    try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); }
    catch { return null; }
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function parseCookies(header) {
    if (typeof header !== 'string' || !header) return {};
    const cookies = {};
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (!name || Object.hasOwn(cookies, name)) continue;
        try { cookies[name] = decodeURIComponent(value); }
        catch { cookies[name] = value; }
    }
    return cookies;
}

function createPanelSecurity(options = {}) {
    const adminPassword = options.adminPassword || '';
    const readonlyPassword = options.readonlyPassword || '';
    const readonlyUsername = options.readonlyUsername || 'readonly';
    if (readonlyPassword && !adminPassword) throw new Error('PANEL_PASSWORD is required when PANEL_READONLY_PASSWORD is configured');
    if (readonlyPassword && secretEqual(readonlyPassword, adminPassword)) {
        throw new Error('PANEL_READONLY_PASSWORD must differ from PANEL_PASSWORD');
    }
    if (options.requireAdminPassword && !adminPassword) throw new Error('PANEL_PASSWORD is required in production');

    const now = typeof options.now === 'function' ? options.now : Date.now;
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    const getRequestId = typeof options.getRequestId === 'function' ? options.getRequestId : () => undefined;
    const maxFailures = positiveInteger(options.maxFailures, 5);
    const failureWindowMs = positiveInteger(options.failureWindowMs, 5 * 60 * 1000);
    const cooldownMs = positiveInteger(options.cooldownMs, 5 * 60 * 1000);
    const maxTrackedClients = positiveInteger(options.maxTrackedClients, 1000);
    const eventCooldownMs = positiveInteger(options.eventCooldownMs, 60 * 1000);
    const sessionIdleMs = positiveInteger(options.sessionIdleMs, 12 * 60 * 60 * 1000, 60 * 1000);
    const sessionRememberMs = positiveInteger(options.sessionRememberMs, 30 * 24 * 60 * 60 * 1000, sessionIdleMs);
    const maxSessions = positiveInteger(options.maxSessions, 1000);
    const requireHttps = options.requireHttps === true;
    const allowInsecureHttp = options.allowInsecureHttp === true;
    const sessionCookieName = String(options.sessionCookieName || 'smarthub_session');
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(sessionCookieName)) throw new Error('Invalid panel session cookie name');
    const publicMetadata = options.publicMetadata && typeof options.publicMetadata === 'object'
        ? Object.freeze({ ...options.publicMetadata }) : Object.freeze({});
    const csrfHeader = String(options.csrfHeader || 'x-smarthub-csrf').toLowerCase();
    const csrfToken = options.csrfToken || crypto.randomBytes(32).toString('base64url');
    const healthPaths = new Set(options.healthPaths || ['/health', '/healthz', '/health/ready']);
    const allowedOrigins = new Set(normalizeOrigins(options.allowedOrigins));
    const protectedSafePaths = new Set(options.protectedSafePaths || []);
    const failures = new Map();
    const eventLog = new Map();
    const sessions = new Map();

    function clientAddress(req) {
        return String(req.ip || req.socket?.remoteAddress || 'unknown');
    }

    function removeOldest(map, maximum) {
        while (map.size >= maximum) map.delete(map.keys().next().value);
    }

    function touch(map, key, value) {
        map.delete(key);
        map.set(key, value);
    }

    function pruneFailures(current = now()) {
        for (const [key, state] of failures) {
            const expiry = Math.max(state.blockedUntil || 0, (state.lastFailureAt || 0) + Math.max(failureWindowMs, cooldownMs));
            if (expiry <= current) failures.delete(key);
        }
        for (const [key, timestamp] of eventLog) {
            if (timestamp + eventCooldownMs <= current) eventLog.delete(key);
        }
    }

    function pruneSessions(current = now()) {
        for (const [key, session] of sessions) {
            if (session.expiresAt <= current) sessions.delete(key);
        }
    }

    function emit(type, req, fields = {}, force = false) {
        const current = now();
        const ip = clientAddress(req);
        const key = `${type}:${ip}`;
        const previous = eventLog.get(key) || 0;
        if (!force && current - previous < eventCooldownMs) return;
        if (!eventLog.has(key)) removeOldest(eventLog, maxTrackedClients);
        touch(eventLog, key, current);
        onEvent({ type, ip, method: req.method, path: req.path, ...fields });
    }

    function send(res, status, error, code, requestId, extra = {}) {
        res.locals.panelSecurityDenial = true;
        return res.status(status).json({ error, code, request_id: requestId, ...extra });
    }

    function resolveRole(credentials) {
        if (!credentials) return null;
        if (secretEqual(credentials.password, adminPassword)) return 'admin';
        if (readonlyPassword && credentials.username === readonlyUsername && secretEqual(credentials.password, readonlyPassword)) return 'readonly';
        return null;
    }

    function sessionKey(token) {
        return digest(token).toString('base64url');
    }

    function sessionFromRequest(req, current = now()) {
        pruneSessions(current);
        const token = parseCookies(req.headers.cookie)[sessionCookieName];
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,180}$/u.test(token)) return null;
        const key = sessionKey(token);
        const session = sessions.get(key);
        if (!session || session.expiresAt <= current) {
            sessions.delete(key);
            return null;
        }
        if (!session.remember) session.expiresAt = current + sessionIdleMs;
        touch(sessions, key, session);
        return { key, token, ...session };
    }

    function basicAuthentication(req) {
        const credentials = parseBasicCredentials(req.headers.authorization);
        const role = resolveRole(credentials);
        if (!role) return null;
        return {
            role,
            principal: role === 'readonly' ? readonlyUsername : (credentials.username || 'admin'),
            source: 'basic'
        };
    }

    function resolveAuthentication(req) {
        const session = sessionFromRequest(req);
        if (session) {
            return {
                auth: { role: session.role, principal: session.principal, source: 'session' },
                session
            };
        }
        const auth = basicAuthentication(req);
        return auth ? { auth, session: null } : null;
    }

    function credentialAttempt(req, credentials) {
        const current = now();
        pruneFailures(current);
        const key = clientAddress(req);
        const existing = failures.get(key);
        if (existing?.blockedUntil > current) {
            const retryAfter = Math.max(Math.ceil((existing.blockedUntil - current) / 1000), 1);
            return { ok: false, status: 429, retryAfter, event: 'auth_throttled' };
        }

        const role = resolveRole(credentials);
        if (role) {
            failures.delete(key);
            return {
                ok: true,
                role,
                principal: role === 'readonly' ? readonlyUsername : (credentials.username || 'admin')
            };
        }

        let state = existing;
        if (!state || current - state.firstFailureAt >= failureWindowMs) {
            state = { failures: 0, firstFailureAt: current, lastFailureAt: current, blockedUntil: 0 };
        }
        state.failures += 1;
        state.lastFailureAt = current;
        if (state.failures >= maxFailures) state.blockedUntil = current + cooldownMs;
        if (!failures.has(key)) removeOldest(failures, maxTrackedClients);
        touch(failures, key, state);
        if (state.blockedUntil > current) {
            const retryAfter = Math.max(Math.ceil(cooldownMs / 1000), 1);
            return { ok: false, status: 429, retryAfter, event: 'auth_lockout', forceEvent: true };
        }
        return { ok: false, status: 401, failures: state.failures, event: 'auth_failed' };
    }

    function applyAttemptFailure(req, res, result, { challenge = false } = {}) {
        if (challenge) res.set('WWW-Authenticate', 'Basic realm="SmartHub"');
        if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
        emit(result.event, req, result.retryAfter
            ? { retry_after_seconds: result.retryAfter }
            : { failures: result.failures }, result.forceEvent);
        if (result.status === 429) {
            return send(res, 429, 'Too many authentication failures',
                options.rateLimitCode || 'API-AUTH-429', getRequestId(),
                { retry_after_seconds: result.retryAfter });
        }
        return send(res, 401, 'Authentication required',
            options.authCode || 'API-AUTH-001', getRequestId());
    }

    function wantsLoginPage(req) {
        return req.method === 'GET'
            && !req.path.startsWith('/api/')
            && req.accepts(['html', 'json']) === 'html';
    }

    function loginReturnPath(req) {
        const value = String(req.originalUrl || '/');
        return /^\/(?!\/)/u.test(value) && !value.startsWith('/login') ? value : '/';
    }

    function authenticate(req, res, next) {
        if (healthPaths.has(req.path)) {
            req.panelAuth = { role: 'public', principal: 'health' };
            return next();
        }
        if (!adminPassword && !readonlyPassword) {
            req.panelAuth = { role: 'admin', principal: 'development', authenticationDisabled: true };
            return next();
        }

        const session = sessionFromRequest(req);
        if (session) {
            req.panelAuth = { role: session.role, principal: session.principal, source: 'session' };
            req.panelSession = session;
            return next();
        }

        const suppliedBasic = parseBasicCredentials(req.headers.authorization);
        if (suppliedBasic) {
            const result = credentialAttempt(req, suppliedBasic);
            if (!result.ok) return applyAttemptFailure(req, res, result, { challenge: true });
            req.panelAuth = { role: result.role, principal: result.principal, source: 'basic' };
            return next();
        }

        if (wantsLoginPage(req)) {
            res.set('Cache-Control', 'no-store');
            return res.redirect(302, `/login?return=${encodeURIComponent(loginReturnPath(req))}`);
        }
        return send(res, 401, 'Authentication required',
            options.authCode || 'API-AUTH-001', getRequestId());
    }

    function requireHttpsTransport(req, res, next) {
        if (!requireHttps || allowInsecureHttp || healthPaths.has(req.path) || req.secure === true) return next();
        return send(res, 400, 'HTTPS is required for the SmartHub panel',
            options.transportCode || 'API-HTTPS-001', getRequestId());
    }

    function cookieValue(token, req, { remember = false, maxAgeMs = 0, clear = false } = {}) {
        const parts = [
            `${sessionCookieName}=${clear ? '' : encodeURIComponent(token)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict'
        ];
        if (requireHttps || req.secure) parts.push('Secure');
        if (clear) {
            parts.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        } else if (remember) {
            parts.push(`Max-Age=${Math.max(Math.floor(maxAgeMs / 1000), 1)}`);
            parts.push(`Expires=${new Date(now() + maxAgeMs).toUTCString()}`);
        }
        return parts.join('; ');
    }

    function createSession(req, res, auth, remember) {
        pruneSessions();
        removeOldest(sessions, maxSessions);
        const token = crypto.randomBytes(32).toString('base64url');
        const ttlMs = remember ? sessionRememberMs : sessionIdleMs;
        const session = {
            role: auth.role,
            principal: auth.principal,
            csrfToken: crypto.randomBytes(32).toString('base64url'),
            createdAt: now(),
            expiresAt: now() + ttlMs,
            remember
        };
        sessions.set(sessionKey(token), session);
        res.set('Set-Cookie', cookieValue(token, req, { remember, maxAgeMs: ttlMs }));
        return session;
    }

    function sameOriginAllowed(req) {
        const suppliedOrigin = requestOrigin(req);
        return suppliedOrigin !== 'null'
            && suppliedOrigin !== 'invalid'
            && (!suppliedOrigin || expectedOrigins(req).has(suppliedOrigin));
    }

    function login(req, res) {
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        if (!sameOriginAllowed(req)) {
            emit('origin_denied', req, { origin_present: true });
            return send(res, 403, 'Request origin is not allowed',
                options.originCode || 'API-CSRF-002', getRequestId());
        }
        if (!req.is('application/json')) {
            return send(res, 415, 'JSON request body required',
                options.authCode || 'API-AUTH-001', getRequestId());
        }
        const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const remember = req.body?.remember === true;
        if (!username || username.length > 128 || !password || password.length > 512) {
            return send(res, 400, 'Username and password are required',
                options.authCode || 'API-AUTH-001', getRequestId());
        }
        const result = credentialAttempt(req, { username, password });
        if (!result.ok) return applyAttemptFailure(req, res, result);
        const session = createSession(req, res, result, remember);
        return res.json({
            ok: true,
            role: session.role,
            principal: session.principal,
            csrfToken: session.csrfToken,
            ...publicMetadata
        });
    }

    function status(req, res) {
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        if (!adminPassword && !readonlyPassword) {
            return res.json({
                authenticated: true,
                role: 'admin',
                principal: 'development',
                authenticationDisabled: true,
                ...publicMetadata
            });
        }
        const resolved = resolveAuthentication(req);
        return res.json({
            authenticated: Boolean(resolved),
            role: resolved?.auth.role || 'public',
            principal: resolved?.auth.principal || null,
            ...publicMetadata
        });
    }

    function logout(req, res) {
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        if (!sameOriginAllowed(req)) {
            emit('origin_denied', req, { origin_present: true });
            return send(res, 403, 'Request origin is not allowed',
                options.originCode || 'API-CSRF-002', getRequestId());
        }
        const token = parseCookies(req.headers.cookie)[sessionCookieName];
        if (typeof token === 'string') sessions.delete(sessionKey(token));
        res.set('Set-Cookie', cookieValue('', req, { clear: true }));
        return res.json({ ok: true });
    }

    function csrf(req, res) {
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        return res.json({
            csrfToken: req.panelSession?.csrfToken || csrfToken,
            role: req.panelAuth?.role || 'unknown'
        });
    }

    function requestOrigin(req) {
        const origin = req.get('origin');
        if (origin) return origin;
        const referer = req.get('referer');
        if (!referer) return null;
        try { return new URL(referer).origin; }
        catch { return 'invalid'; }
    }

    function expectedOrigins(req) {
        if (allowedOrigins.size) return allowedOrigins;
        const host = req.get('host');
        return new Set(host ? [`${req.protocol}://${host}`] : []);
    }

    function protectWrites(req, res, next) {
        const isApi = req.path === '/api' || req.path.startsWith('/api/');
        const needsProtection = isApi && (!SAFE_METHODS.has(req.method) || protectedSafePaths.has(req.path));
        if (!needsProtection) return next();
        if (req.panelAuth?.role !== 'admin') {
            emit('authorization_denied', req, { role: req.panelAuth?.role || 'unknown' });
            return send(res, 403, 'Admin role required', options.authorizationCode || 'API-AUTH-403', getRequestId());
        }
        const suppliedOrigin = requestOrigin(req);
        if (suppliedOrigin === 'null' || suppliedOrigin === 'invalid' || (suppliedOrigin && !expectedOrigins(req).has(suppliedOrigin))) {
            emit('origin_denied', req, { origin_present: Boolean(suppliedOrigin) });
            return send(res, 403, 'Request origin is not allowed', options.originCode || 'API-CSRF-002', getRequestId());
        }
        const suppliedToken = req.get(csrfHeader);
        const expectedToken = req.panelSession?.csrfToken || csrfToken;
        if (!secretEqual(suppliedToken, expectedToken)) {
            emit('csrf_denied', req, { token_present: Boolean(suppliedToken) });
            return send(res, 403, 'CSRF token is missing or invalid', options.csrfCode || 'API-CSRF-001', getRequestId());
        }
        return next();
    }

    function requireAdmin(req, res, next) {
        if (req.panelAuth?.role === 'admin') return next();
        emit('authorization_denied', req, { role: req.panelAuth?.role || 'unknown' });
        return send(res, 403, 'Admin role required', options.authorizationCode || 'API-AUTH-403', getRequestId());
    }

    return {
        authenticate,
        requireHttpsTransport,
        login,
        logout,
        status,
        csrf,
        protectWrites,
        requireAdmin,
        pruneFailures,
        pruneSessions,
        getState: () => ({
            failures: failures.size,
            sessions: sessions.size,
            eventKeys: eventLog.size,
            failureKeys: [...failures.keys()]
        })
    };
}

module.exports = { createPanelSecurity, parseTrustedProxies, parseBasicCredentials, parseCookies };

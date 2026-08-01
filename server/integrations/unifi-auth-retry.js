'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerEntries(headers) {
    if (!headers) return [];
    if (typeof headers.toJSON === 'function') return Object.entries(headers.toJSON());
    return Object.entries(headers);
}

function rebuildAuthRetryHeaders(headers, cookie, csrfToken) {
    const rebuilt = {};
    for (const [name, value] of headerEntries(headers)) {
        if (/^(?:x-csrf-token|cookie)$/iu.test(name)) continue;
        rebuilt[name] = value;
    }
    rebuilt.Cookie = cookie;
    if (csrfToken) rebuilt['x-csrf-token'] = csrfToken;
    return rebuilt;
}

function shouldRetryControllerRequest({ config, response }) {
    const pathName = String(config?.url || '');
    const authSpecific = response?.status === 401
        || (response?.status === 403 && /loginrequired|invalid.?session|csrf/i.test(JSON.stringify(response.data || '')));
    const method = String(config?.method || 'get').toUpperCase();
    const safeMethod = SAFE_METHODS.has(method);
    const authRejectedBeforeMutation = response?.status === 401;
    return Boolean(config && !config._smartHubAuthRetry && !pathName.includes('/api/auth/login')
        && authSpecific && (safeMethod || authRejectedBeforeMutation));
}

module.exports = { rebuildAuthRetryHeaders, shouldRetryControllerRequest };

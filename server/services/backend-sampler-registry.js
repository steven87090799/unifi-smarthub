'use strict';

function normalizedScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new TypeError('sampler scopes must be a non-empty array');
    }
    const values = [...new Set(scopes.map(scope => String(scope || '').trim()).filter(Boolean))];
    if (values.length === 0) throw new TypeError('sampler scopes must contain a value');
    return values;
}

function createBackendSamplerRegistry() {
    const entries = new Map();

    function register({ name, scopes, sampler }) {
        const key = String(name || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) {
            throw new TypeError('sampler name is invalid');
        }
        if (!sampler || typeof sampler.rebuild !== 'function' || typeof sampler.stop !== 'function') {
            throw new TypeError('sampler must provide rebuild and stop');
        }
        entries.get(key)?.sampler.stop();
        entries.set(key, Object.freeze({ name: key, scopes: normalizedScopes(scopes), sampler }));
        return sampler;
    }

    function rebuildMatching(scopes, { immediate }) {
        const requested = new Set(Array.isArray(scopes) ? scopes : []);
        const rebuilt = [];
        for (const entry of entries.values()) {
            if (!entry.scopes.some(scope => requested.has(scope))) continue;
            entry.sampler.rebuild({ immediate });
            rebuilt.push(entry.name);
        }
        return rebuilt;
    }

    function requestPromptSampling(scopes) {
        return rebuildMatching(scopes, { immediate: true });
    }

    function rebuildAll({ immediate = false } = {}) {
        const rebuilt = [];
        for (const entry of entries.values()) {
            entry.sampler.rebuild({ immediate });
            rebuilt.push(entry.name);
        }
        return rebuilt;
    }

    function stopAll() {
        for (const entry of entries.values()) entry.sampler.stop();
    }

    function snapshot() {
        const samplers = {};
        const scopes = new Set();
        for (const entry of entries.values()) {
            entry.scopes.forEach(scope => scopes.add(scope));
            samplers[entry.name] = {
                scopes: [...entry.scopes],
                ...(typeof entry.sampler.snapshot === 'function' ? entry.sampler.snapshot() : {})
            };
        }
        return { configuredScopes: [...scopes], samplers };
    }

    return Object.freeze({ register, rebuildAll, requestPromptSampling, snapshot, stopAll });
}

module.exports = { createBackendSamplerRegistry };

(function attachFrontendLifecycle(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SmartHubFrontendLifecycle = api;
}(typeof globalThis === 'object' ? globalThis : this, root => {
    'use strict';

    function createHydrationCoordinator({
        pages = {},
        runJob,
        isStaleResult = value => value?.stale === true,
        isSuccessfulResult = value => value !== undefined
            && value !== null
            && value !== false
            && value?.ok !== false
            && value?.stale !== true,
        onError = () => {}
    } = {}) {
        if (typeof runJob !== 'function') throw new TypeError('runJob is required');
        const loadedPages = new Set();
        const completedJobs = new Map();
        const inFlight = new Map();
        const generations = new Map();

        function hydratePage(page, { force = false, only = null, generation = 0 } = {}) {
            if (!force && loadedPages.has(page)) return Promise.resolve({ loaded: true, skipped: true, results: [] });
            if (inFlight.has(page)) {
                const pending = inFlight.get(page);
                if (generations.get(page) === generation) return pending;
                // Mark the older request stale before it resolves.  Its late
                // result must never mark the newly selected page complete.
                generations.set(page, generation);
                return pending.then(() => hydratePage(page, { force, only, generation }));
            }
            const requested = Array.isArray(only) ? only : [...(pages[page] || [])];
            const completed = completedJobs.get(page) || new Set();
            const jobs = requested.filter(key => force || !completed.has(key));
            if (!jobs.length) {
                loadedPages.add(page);
                return Promise.resolve({ loaded: true, skipped: true, results: [] });
            }
            let promise;
            promise = Promise.all(jobs.map(async key => {
                try {
                    const value = await runJob(key, { page, generation });
                    const ok = isSuccessfulResult(value) && !isStaleResult(value);
                    if (!ok && value?.error) {
                        try { onError(value.error, { page, key, generation, retryable: value.retryable !== false }); }
                        catch { /* diagnostics must not reject hydration */ }
                    }
                    return { key, ok, retryable: value?.retryable !== false, stale: value?.stale === true, value };
                } catch (error) {
                    try { onError(error, { page, key, generation }); } catch { /* diagnostics must not reject hydration */ }
                    return { key, ok: false, retryable: true, error };
                }
            })).then(results => {
                const staleGeneration = generations.get(page) !== generation;
                if (staleGeneration) {
                    return {
                        loaded: false,
                        stale: true,
                        results: results.map(result => ({ ...result, ok: false, stale: true })),
                        failures: results.map(result => ({ ...result, ok: false, stale: true }))
                    };
                }
                const nextCompleted = completedJobs.get(page) || new Set();
                results.filter(result => result.ok).forEach(result => nextCompleted.add(result.key));
                completedJobs.set(page, nextCompleted);
                const failures = results.filter(result => !result.ok);
                if (failures.length) loadedPages.delete(page);
                else loadedPages.add(page);
                return { loaded: failures.length === 0, results, failures };
            }).finally(() => {
                if (inFlight.get(page) === promise) {
                    inFlight.delete(page);
                    generations.delete(page);
                }
            });
            generations.set(page, generation);
            inFlight.set(page, promise);
            return promise;
        }

        return {
            hydratePage,
            isLoaded: page => loadedPages.has(page),
            isInFlight: page => inFlight.has(page),
            completedJobs: page => new Set(completedJobs.get(page) || []),
            reset: page => {
                if (page === undefined) {
                    loadedPages.clear(); completedJobs.clear(); inFlight.clear(); generations.clear();
                    return;
                }
                loadedPages.delete(page); completedJobs.delete(page); inFlight.delete(page); generations.delete(page);
            }
        };
    }

    function createScopedResource({ canStart, close = resource => resource?.close?.() } = {}) {
        if (typeof canStart !== 'function') throw new TypeError('canStart is required');
        let entry = null;
        function connect(generation, factory) {
            if (entry || !canStart(generation)) return false;
            const resource = factory(generation);
            entry = { generation, resource };
            return true;
        }
        function disconnect() {
            const current = entry;
            entry = null;
            if (current) close(current.resource);
        }
        return {
            connect,
            disconnect,
            get: () => entry?.resource || null,
            isCurrent: (resource, generation) => Boolean(entry && entry.resource === resource
                && entry.generation === generation && canStart(generation)),
            active: () => Boolean(entry)
        };
    }

    function createObserverRegistry({ createObserver = callback => new root.MutationObserver(callback) } = {}) {
        const entries = new Map();
        function disconnect(key) {
            const entry = entries.get(key);
            if (!entry) return;
            entry.observer.disconnect();
            entries.delete(key);
        }
        function observe(key, source, callback, options) {
            const current = entries.get(key);
            if (current?.src === source) return current;
            if (current) current.observer.disconnect();
            const observer = createObserver(callback);
            observer.observe(source, options);
            const entry = { observer, src: source };
            entries.set(key, entry);
            return entry;
        }
        return {
            get: key => entries.get(key),
            observe,
            disconnect,
            disconnectAll: () => [...entries.keys()].forEach(disconnect),
            size: () => entries.size
        };
    }

    function shouldSchedulePollJob({ isVisible, configured, hydrationPending, common, pageJobs = [], key } = {}) {
        if (!isVisible || !configured) return false;
        if (hydrationPending && !common) return false;
        return common || pageJobs.includes(key);
    }

    return Object.freeze({ createHydrationCoordinator, createScopedResource, createObserverRegistry, shouldSchedulePollJob });
}));

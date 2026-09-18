'use strict';

const vm = require('node:vm');
const { renderPwaServiceWorker } = require('../../server/services/pwa-service-worker');

function createWorkerHarness({ network, put, cacheName = 'smarthub-test', render = renderPwaServiceWorker } = {}) {
    const origin = 'https://smarthub.test';
    const handlers = {};
    const stores = new Map();
    const key = input => new URL(typeof input === 'string' ? input : input.url, origin).href;
    const cacheFor = name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
            async addAll(paths) { for (const path of paths) store.set(key(path), new Response(path)); },
            async put(request, response) {
                if (put) await put(request, response);
                store.set(key(request), response);
            },
            async match(request) { return store.get(key(request)); }
        };
    };
    const caches = {
        async open(name) { return cacheFor(name); },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); },
        async match(request) {
            for (const store of stores.values()) if (store.has(key(request))) return store.get(key(request));
        }
    };
    vm.runInNewContext(render(cacheName), {
        URL, Set, Promise, caches,
        fetch: network || (async () => new Response('network')),
        self: {
            location: { origin },
            addEventListener(name, handler) { handlers[name] = handler; },
            skipWaiting() {},
            clients: { async claim() {} }
        }
    });
    function dispatch(name, request) {
        const waits = [];
        let response;
        handlers[name]({
            request,
            waitUntil(promise) { waits.push(promise); },
            respondWith(promise) { response = promise; }
        });
        return {
            get response() { return response; },
            waits,
            async settled() {
                if (response) await response;
                await Promise.all(waits);
            }
        };
    }
    return {
        stores, caches, origin, dispatch,
        request(path, options = {}) {
            return { url: new URL(path, origin).href, method: 'GET', mode: 'cors', cache: 'default', ...options };
        }
    };
}

module.exports = { createWorkerHarness };

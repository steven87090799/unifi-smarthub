'use strict';

function createSseBackpressureManager(options = {}) {
    const maxClients = Number.isSafeInteger(options.maxClients) && options.maxClients > 0 ? options.maxClients : 100;
    const maxWritableLength = Number.isSafeInteger(options.maxWritableLength) && options.maxWritableLength > 0 ? options.maxWritableLength : 256 * 1024;
    const drainTimeoutMs = Number.isSafeInteger(options.drainTimeoutMs) && options.drainTimeoutMs > 0 ? options.drainTimeoutMs : 10_000;
    const clients = new Map();
    const onEvict = typeof options.onEvict === 'function' ? options.onEvict : () => {};

    function evict(res, reason) {
        const state = clients.get(res);
        if (!state) return;
        clients.delete(res);
        clearTimeout(state.timer);
        res.removeListener?.('drain', state.onDrain);
        res.removeListener?.('close', state.onClose);
        res.removeListener?.('error', state.onClose);
        try { res.end(); } catch { }
        onEvict(res, reason);
    }

    function add(res) {
        if (!res || typeof res.write !== 'function') throw new TypeError('SSE response must be writable');
        if (clients.size >= maxClients) return false;
        const state = {
            timer: null,
            onDrain: () => {
                clearTimeout(state.timer);
                state.timer = null;
            },
            onClose: () => evict(res, 'closed')
        };
        clients.set(res, state);
        res.on?.('drain', state.onDrain);
        res.once?.('close', state.onClose);
        res.once?.('error', state.onClose);
        return true;
    }

    function remove(res, reason = 'removed') {
        if (!clients.has(res)) return;
        const state = clients.get(res);
        clients.delete(res);
        clearTimeout(state.timer);
        res.removeListener?.('drain', state.onDrain);
        res.removeListener?.('close', state.onClose);
        res.removeListener?.('error', state.onClose);
        if (reason !== 'shutdown') {
            try { res.end(); } catch { }
        }
    }

    function broadcast(chunk) {
        for (const [res, state] of clients) {
            if (res.destroyed || res.writableEnded) {
                evict(res, 'dead');
                continue;
            }
            if (Number(res.writableLength || 0) > maxWritableLength) {
                evict(res, 'backpressure_limit');
                continue;
            }
            let accepted;
            try { accepted = res.write(chunk); }
            catch { evict(res, 'write_error'); continue; }
            if (!accepted || Number(res.writableLength || 0) > maxWritableLength) {
                if (Number(res.writableLength || 0) > maxWritableLength) {
                    evict(res, 'backpressure_limit');
                    continue;
                }
                if (!state.timer) state.timer = setTimeout(() => evict(res, 'drain_timeout'), drainTimeoutMs);
            }
        }
    }

    function closeAll() {
        for (const res of [...clients.keys()]) {
            const state = clients.get(res);
            if (!state) continue;
            clients.delete(res);
            clearTimeout(state.timer);
            res.removeListener?.('drain', state.onDrain);
            res.removeListener?.('close', state.onClose);
            res.removeListener?.('error', state.onClose);
            try { res.end(); } catch { }
        }
    }

    return Object.freeze({
        add,
        remove,
        broadcast,
        closeAll,
        has: res => clients.has(res),
        get size() { return clients.size; },
        snapshot: () => ({ clients: clients.size, max_clients: maxClients, max_writable_length: maxWritableLength, drain_timeout_ms: drainTimeoutMs })
    });
}

module.exports = { createSseBackpressureManager };

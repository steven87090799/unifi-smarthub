'use strict';

function createSseBackpressure({
    maxWritableLength = 256 * 1024,
    drainTimeoutMs = 15_000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onRemove = () => {}
} = {}) {
    const drains = new Map();

    function clearDrain(client) {
        const pending = drains.get(client);
        if (pending) {
            clearTimeoutFn(pending.timer);
            client.off?.('drain', pending.onDrain);
            drains.delete(client);
        }
    }

    function remove(client) {
        clearDrain(client);
        onRemove(client);
    }

    function close(client) {
        remove(client);
        if (!client.writableEnded && !client.destroyed) {
            try { client.end(); } catch { try { client.destroy(); } catch { } }
        }
    }

    function write(client, chunk) {
        if (!client || client.writableEnded || client.destroyed || client.writableLength > maxWritableLength) {
            close(client);
            return false;
        }
        let accepted;
        try { accepted = client.write(chunk); }
        catch { close(client); return false; }
        if (client.writableLength > maxWritableLength) {
            close(client);
            return false;
        }
        if (accepted !== false || drains.has(client)) return true;
        const onDrain = () => clearDrain(client);
        const timer = setTimeoutFn(() => close(client), drainTimeoutMs);
        drains.set(client, { onDrain, timer });
        client.once?.('drain', onDrain);
        return true;
    }

    return { write, remove, close };
}

module.exports = { createSseBackpressure };

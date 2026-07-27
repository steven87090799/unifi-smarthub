'use strict';

// Schedules the next collection only after the current one finishes.  This
// avoids a slow device API building up overlapping interval callbacks.
function createAdaptiveSampler({
    collect,
    getDelayMs,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onError = () => {}
}) {
    let timer = null;
    let running = false;
    let stopped = true;

    function clearScheduled() {
        if (!timer) return;
        clearTimeoutFn(timer);
        timer = null;
    }

    function schedule(delayMs = getDelayMs()) {
        clearScheduled();
        if (stopped) return;
        const delay = Math.max(0, Number(delayMs) || 0);
        timer = setTimeoutFn(() => {
            timer = null;
            void run();
        }, delay);
    }

    async function run() {
        if (stopped || running) return;
        running = true;
        try {
            await collect();
        } catch (error) {
            onError(error);
        } finally {
            running = false;
            if (!stopped) schedule();
        }
    }

    function start({ immediate = true } = {}) {
        stopped = false;
        schedule(immediate ? 0 : getDelayMs());
    }

    // Settings and activity changes use this path.  Clearing the old handle
    // first guarantees a repeated save cannot leave duplicate timers behind.
    function rebuild({ immediate = false } = {}) {
        stopped = false;
        schedule(immediate ? 0 : getDelayMs());
    }

    function stop() {
        stopped = true;
        clearScheduled();
    }

    return {
        start,
        rebuild,
        stop,
        run,
        snapshot: () => ({ running, scheduled: !!timer, stopped })
    };
}

module.exports = { createAdaptiveSampler };

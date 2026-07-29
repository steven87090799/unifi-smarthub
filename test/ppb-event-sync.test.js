'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPpbEventSync } = require('../server/services/ppb-event-sync');

function fakeDb({ state = null, existing = [] } = {}) {
    const events = new Map(existing.map(event => [event.externalId, event]));
    let syncState = state;
    return {
        events,
        getIntegrationSyncState(source) {
            return syncState?.source === source ? { ...syncState } : null;
        },
        upsertIntegrationSyncState(next) {
            syncState = { ...next };
            return { ...syncState };
        },
        recordUpsPowerEvent(event) {
            if (events.has(event.externalId)) return { created: false, event: events.get(event.externalId) };
            events.set(event.externalId, event);
            return { created: true, event };
        },
        listUpsPowerEvents() { return [...events.values()]; },
        state: () => syncState
    };
}

const event = (id, options = {}) => ({
    source: 'ppb',
    externalId: id,
    type: options.sag === false ? 'ppb_event' : 'voltage_sag',
    eventTs: options.eventTs ?? 1000,
    observedTs: options.observedTs ?? 2000,
    inputV: null,
    severity: options.sag === false ? 'info' : 'warning',
    description: `event ${id}`,
    sag: options.sag !== false
});

test('first successful PPB sync persists source state and never notifies history', async () => {
    const db = fakeDb();
    const notices = [];
    const sync = createPpbEventSync({
        db,
        fetchEvents: async () => [event('old-a'), event('old-b')],
        normalizeEvent: value => value,
        loadSettings: () => ({ enabled: true, triggerUpsSag: true }),
        notify: async (...args) => notices.push(args),
        now: () => 5000
    });
    const result = await sync.run();
    assert.equal(result.created, 2);
    assert.deepEqual(notices, []);
    assert.deepEqual(db.state(), {
        source: 'ppb',
        initializedAt: 5000,
        lastSuccessAt: 5000,
        lastExternalId: 'old-b',
        lastEventTs: 1000,
        updatedAt: 5000
    });
});

test('subsequent sync notifies only newly inserted sag events once across restart and reordering', async () => {
    const db = fakeDb({
        state: {
            source: 'ppb', initializedAt: 1000, lastSuccessAt: 1000,
            lastExternalId: 'old', lastEventTs: 1000, updatedAt: 1000
        },
        existing: [event('old')]
    });
    const notices = [];
    let values = [event('new', { eventTs: 2000 }), event('old')];
    const options = {
        db,
        fetchEvents: async () => values,
        normalizeEvent: value => value,
        loadSettings: () => ({ enabled: true, triggerUpsSag: true }),
        notify: async (...args) => notices.push(args),
        now: () => 6000
    };
    await createPpbEventSync(options).run();
    values = [event('old'), event('new', { eventTs: 2000 })];
    await createPpbEventSync(options).run();
    assert.equal(notices.length, 1);
    assert.match(notices[0][1], /event new/u);
});

test('distinct PPB event IDs at the same timestamp are both retained and notified exactly once', async () => {
    const db = fakeDb({
        state: {
            source: 'ppb', initializedAt: 1000, lastSuccessAt: 1000,
            lastExternalId: 'old', lastEventTs: 1000, updatedAt: 1000
        },
        existing: [event('old')]
    });
    const notices = [];
    let values = [event('same-time-a', { eventTs: 3000 }), event('same-time-b', { eventTs: 3000 })];
    const options = {
        db,
        fetchEvents: async () => values,
        normalizeEvent: value => value,
        loadSettings: () => ({ enabled: true, triggerUpsSag: true }),
        notify: async (...args) => notices.push(args),
        now: () => 7000
    };
    await createPpbEventSync(options).run();
    values = [...values].reverse();
    await createPpbEventSync(options).run();

    assert.deepEqual([...db.events.keys()].sort(), ['old', 'same-time-a', 'same-time-b']);
    assert.equal(notices.length, 2);
    assert.deepEqual(notices.map(item => item[1]).sort(), ['event same-time-a', 'event same-time-b']);
});

test('failed first sync does not initialize and legacy local or PPB rows do not change safe first-sync behavior', async () => {
    for (const existing of [
        [event('local', { sag: false })],
        [event('legacy-ppb')]
    ]) {
        const db = fakeDb({ existing });
        const failing = createPpbEventSync({
            db,
            fetchEvents: async () => { throw new Error('temporary PPB failure'); },
            normalizeEvent: value => value
        });
        await assert.rejects(failing.run(), /temporary PPB failure/u);
        assert.equal(db.state(), null);

        const notices = [];
        const succeeding = createPpbEventSync({
            db,
            fetchEvents: async () => [event('history-after-retry')],
            normalizeEvent: value => value,
            loadSettings: () => ({ enabled: true, triggerUpsSag: true }),
            notify: async (...args) => notices.push(args),
            now: () => 9000
        });
        await succeeding.run();
        assert.deepEqual(notices, []);
        assert.equal(db.state().initializedAt, 9000);
    }
});

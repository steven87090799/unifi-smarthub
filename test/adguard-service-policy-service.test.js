'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryDb } = require('../db');
const { parsePolicyRequest } = require('../server/policies/adguard-service-policy');
const {
    AdGuardServicePolicyError,
    createAdGuardServicePolicyService
} = require('../server/services/adguard-service-policy');

const CATALOG = [
    'youtube', 'tiktok', 'activision_blizzard', 'battle_net', 'blizzard_entertainment',
    'electronic_arts', 'epic_games', 'gog', 'io_interactive', 'leagueoflegends',
    'minecraft', 'nintendo', 'origin', 'playstation', 'riot_games', 'roblox',
    'rockstar_games', 'steam', 'ubisoft', 'valorant', 'wargaming',
    'warnerbrosgames', 'xboxlive'
].map(id => ({ id }));

function policy(deviceId, categories = ['youtube']) {
    return parsePolicyRequest({
        deviceId,
        categories,
        timeZone: 'Asia/Taipei',
        allowWindows: { mon: { start: '18:00', end: '20:00' } }
    });
}

function createFixture(t, { timestamp = Date.parse('2026-07-15T00:00:00.000Z') } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-adguard-policy-'));
    let db = createHistoryDb(dir);
    let now = timestamp;
    let configured = true;
    let failureFor = null;
    const updates = [];
    let clients = [{
        name: 'Living Room',
        ids: ['192.168.1.50', 'aa:bb:cc:dd:ee:ff'],
        tags: ['user_child'],
        use_global_settings: false,
        filtering_enabled: true,
        parental_enabled: true,
        safebrowsing_enabled: true,
        safesearch_enabled: false,
        use_global_blocked_services: true,
        blocked_services: ['facebook'],
        blocked_services_schedule: { time_zone: 'UTC' },
        upstreams: ['tls://dns.example'],
        ignore_querylog: false,
        ignore_statistics: false,
        whois_info: { secret: 'read-only' }
    }, {
        name: 'Tablet',
        ids: ['192.168.1.51'],
        use_global_settings: true,
        filtering_enabled: true,
        parental_enabled: false,
        safebrowsing_enabled: true,
        safesearch_enabled: true,
        use_global_blocked_services: true,
        blocked_services: [],
        blocked_services_schedule: {}
    }];
    const client = {
        configuration: () => ({ configured, transport: 'https', tlsVerified: true }),
        listClients: async () => ({ clients: { persistent: JSON.parse(JSON.stringify(clients)) } }),
        listServices: async () => CATALOG,
        updateClient: async (name, data) => {
            if (failureFor === name) {
                const error = new Error('controller offline');
                error.code = 'upstream_unavailable';
                error.retryable = true;
                throw error;
            }
            updates.push({ name, data: JSON.parse(JSON.stringify(data)) });
            clients = clients.map(entry => entry.name === name ? JSON.parse(JSON.stringify(data)) : entry);
        }
    };
    let service = createAdGuardServicePolicyService({ repository: db, client, now: () => now });
    t.after(() => {
        try { db.close(); } catch { }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return {
        get db() { return db; },
        get service() { return service; },
        get clients() { return clients; },
        updates,
        advance(ms) { now += ms; },
        setConfigured(value) { configured = value; },
        failFor(name) { failureFor = name; },
        reopen() {
            db.close();
            db = createHistoryDb(dir);
            service = createAdGuardServicePolicyService({ repository: db, client, now: () => now });
        }
    };
}

test('apply is durable and idempotent, preserves unrelated client fields, and removal restores baseline', async t => {
    const fixture = createFixture(t);
    const first = await fixture.service.upsert(policy('192.168.1.50', ['youtube', 'tiktok']));
    assert.equal(first.applied, true);
    assert.equal(first.created, true);
    assert.equal(fixture.updates.length, 1);
    const applied = fixture.updates[0].data;
    assert.equal(applied.use_global_blocked_services, false);
    assert.deepEqual(applied.blocked_services, ['tiktok', 'youtube']);
    assert.deepEqual(applied.blocked_services_schedule, {
        time_zone: 'Asia/Taipei', mon: { start: 64800000, end: 72000000 }
    });
    assert.deepEqual(applied.tags, ['user_child']);
    assert.deepEqual(applied.upstreams, ['tls://dns.example']);
    assert.equal(applied.parental_enabled, true);
    assert.equal(Object.hasOwn(applied, 'whois_info'), false);

    let rows = fixture.db.listAdguardServicePolicies();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].syncState, 'applied');
    assert.deepEqual(rows[0].baseline, {
        use_global_blocked_services: true,
        blocked_services: ['facebook'],
        blocked_services_schedule: { time_zone: 'UTC' }
    });

    const duplicate = await fixture.service.upsert(policy('192.168.1.50', ['tiktok', 'youtube']));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.changed, false);
    assert.equal(fixture.updates.length, 1);

    const removed = await fixture.service.remove(rows[0].id);
    assert.equal(removed.applied, true);
    assert.equal(fixture.updates.length, 2);
    assert.equal(fixture.updates[1].data.use_global_blocked_services, true);
    assert.deepEqual(fixture.updates[1].data.blocked_services, ['facebook']);
    assert.deepEqual(fixture.updates[1].data.blocked_services_schedule, { time_zone: 'UTC' });
    assert.equal(fixture.db.listAdguardServicePolicies().length, 0);
    assert.ok(fixture.db.listAdguardServicePolicyAudit().some(entry => entry.outcome === 'restored'));
});

test('upstream failure is isolated per device and retry metadata survives restart', async t => {
    const fixture = createFixture(t);
    fixture.db.upsertAdguardServicePolicy({
        id: '11111111-1111-4111-8111-111111111111', ...policy('192.168.1.50'), timestamp: Date.parse('2026-07-15T00:00:00Z')
    });
    fixture.db.upsertAdguardServicePolicy({
        id: '22222222-2222-4222-8222-222222222222', ...policy('192.168.1.51', ['tiktok']), timestamp: Date.parse('2026-07-15T00:00:00Z')
    });
    fixture.failFor('Living Room');
    const result = await fixture.service.reconcile({ force: true });
    assert.equal(result.applied, false);
    let rows = fixture.db.listAdguardServicePolicies();
    assert.equal(rows.find(row => row.deviceId === '192.168.1.50').syncState, 'error');
    assert.equal(rows.find(row => row.deviceId === '192.168.1.51').syncState, 'applied');
    assert.equal(rows.find(row => row.deviceId === '192.168.1.50').attemptCount, 1);
    assert.ok(rows.find(row => row.deviceId === '192.168.1.50').nextRetryTs > Date.parse('2026-07-15T00:00:00Z'));
    assert.ok(fixture.updates.some(update => update.name === 'Tablet'));
    const updatesBeforeBackoff = fixture.updates.length;
    const backoff = await fixture.service.reconcile();
    assert.equal(backoff.applied, false);
    assert.equal(backoff.reason, 'backoff');
    assert.equal(backoff.snapshot.reconcile.status, 'degraded');
    assert.equal(fixture.updates.length, updatesBeforeBackoff, 'applied policies must not amplify a peer retry loop');

    fixture.reopen();
    fixture.failFor(null);
    fixture.advance(6000);
    const recovered = await fixture.service.reconcile();
    assert.equal(recovered.applied, true);
    rows = fixture.db.listAdguardServicePolicies();
    assert.ok(rows.every(row => row.syncState === 'applied'));
    assert.ok(rows.every(row => row.attemptCount === 0));
});

test('missing configuration fails before persistence while removal remains durable during outage', async t => {
    const fixture = createFixture(t);
    fixture.setConfigured(false);
    await assert.rejects(fixture.service.upsert(policy('192.168.1.50')), error => (
        error instanceof AdGuardServicePolicyError && error.httpStatus === 503
    ));
    assert.equal(fixture.db.listAdguardServicePolicies().length, 0);

    fixture.setConfigured(true);
    await fixture.service.upsert(policy('192.168.1.50'));
    const id = fixture.db.listAdguardServicePolicies()[0].id;
    fixture.setConfigured(false);
    const removal = await fixture.service.remove(id);
    assert.equal(removal.applied, false);
    assert.equal(fixture.db.listAdguardServicePolicies()[0].desiredState, 'removed');
    fixture.setConfigured(true);
    await fixture.service.reconcile({ force: true });
    assert.equal(fixture.db.listAdguardServicePolicies().length, 0);
});

test('IP and MAC aliases cannot create competing policies for one persistent client', async t => {
    const fixture = createFixture(t);
    await fixture.service.upsert(policy('192.168.1.50', ['youtube']));
    await assert.rejects(fixture.service.upsert(policy('aa:bb:cc:dd:ee:ff', ['tiktok'])), error => (
        error instanceof AdGuardServicePolicyError
        && error.code === 'client_policy_conflict'
        && error.httpStatus === 409
    ));
    assert.equal(fixture.db.listAdguardServicePolicies().length, 1);
    assert.deepEqual(fixture.clients[0].blocked_services, ['youtube']);
});

test('reconciliation fails one conflicting legacy row closed instead of oscillating one client', async t => {
    const fixture = createFixture(t);
    const timestamp = Date.parse('2026-07-15T00:00:00Z');
    fixture.db.upsertAdguardServicePolicy({
        id: '33333333-3333-4333-8333-333333333333', ...policy('192.168.1.50', ['youtube']), timestamp
    });
    fixture.db.upsertAdguardServicePolicy({
        id: '44444444-4444-4444-8444-444444444444', ...policy('aa:bb:cc:dd:ee:ff', ['tiktok']), timestamp
    });
    const result = await fixture.service.reconcile({ force: true });
    assert.equal(result.applied, false);
    assert.equal(fixture.updates.length, 1);
    assert.deepEqual(fixture.clients[0].blocked_services, ['youtube']);
    const rows = fixture.db.listAdguardServicePolicies();
    assert.equal(rows[0].syncState, 'applied');
    assert.equal(rows[1].syncState, 'error');
    assert.equal(rows[1].lastError, 'client_policy_conflict');

    fixture.advance(6000);
    const retry = await fixture.service.reconcile();
    assert.equal(retry.applied, false);
    assert.equal(fixture.updates.length, 1, 'a due conflicting retry must not overwrite the established owner before drift reconciliation');
    assert.deepEqual(fixture.clients[0].blocked_services, ['youtube']);
    assert.equal(fixture.db.listAdguardServicePolicies()[1].lastError, 'client_policy_conflict');
});

test('client identity and service catalog mismatches become observable bounded policy errors', async t => {
    const fixture = createFixture(t);
    const missing = await fixture.service.upsert(policy('192.168.1.99'));
    assert.equal(missing.applied, false);
    const row = fixture.db.listAdguardServicePolicies()[0];
    assert.equal(row.syncState, 'error');
    assert.equal(row.lastError, 'client_not_found');
    assert.equal(fixture.service.snapshot().reconcile.status, 'degraded');
});

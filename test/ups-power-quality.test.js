'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryDb } = require('../db');
const {
    createUpsSagDetector,
    normalizePpbEvent
} = require('../server/services/ups-power-quality');

test('sag detector emits one start, tracks the minimum, and rearms only after hysteresis recovery', () => {
    let now = 1_000;
    const detector = createUpsSagDetector({ thresholdV: 105, now: () => now });
    assert.equal(detector.observe({ inputV: 110, onBattery: false }).type, null);
    const started = detector.observe({ inputV: 104.5, onBattery: false });
    assert.equal(started.type, 'sag_started');
    assert.equal(started.thresholdV, 105);
    now += 3_000;
    assert.equal(detector.observe({ inputV: 102, onBattery: false }).type, null);
    now += 3_000;
    assert.equal(detector.observe({ inputV: 106, onBattery: false }).type, null);
    now += 3_000;
    const recovered = detector.observe({ inputV: 108.2, onBattery: false });
    assert.equal(recovered.type, 'sag_recovered');
    assert.equal(recovered.minimumV, 102);
    assert.equal(recovered.durationMs, 9_000);
});

test('sag detector scales a 110V threshold for 220V systems and ignores battery input zero', () => {
    const detector = createUpsSagDetector({ thresholdV: 105, now: () => 10 });
    assert.equal(detector.observe({ inputV: 208, onBattery: false }).type, 'sag_started');
    const battery = createUpsSagDetector({ thresholdV: 105, now: () => 20 });
    assert.equal(battery.observe({ inputV: 0, onBattery: true }).type, null);
});

test('PPB events receive stable fallback identities and classify voltage-sag wording', () => {
    const first = normalizePpbEvent({ logTime24H: '2026-07-23 12:30:00', description: 'Utility Voltage Abnormal' }, { observedAt: 42 });
    const second = normalizePpbEvent({ logTime24H: '2026-07-23 12:30:00', description: 'Utility Voltage Abnormal' }, { observedAt: 99 });
    assert.equal(first.externalId, second.externalId);
    assert.equal(first.type, 'voltage_sag');
    assert.equal(first.sag, true);
    assert.equal(first.severity, 'warning');
});

test('UPS power-quality events are durable, deduplicated, and bounded on read', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-ups-power-quality-'));
    const db = createHistoryDb(dir);
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const entry = {
        source: 'ppb', externalId: 'event-1', type: 'voltage_sag', eventTs: 1000,
        observedTs: 1200, inputV: 102.5, severity: 'warning', description: 'Power Sag'
    };
    assert.equal(db.recordUpsPowerEvent(entry).created, true);
    assert.equal(db.recordUpsPowerEvent(entry).created, false);
    assert.equal(db.listUpsPowerEvents(500).length, 1);
    assert.equal(db.listUpsPowerEvents()[0].inputV, 102.5);
});

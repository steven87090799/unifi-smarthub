'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { presentUpsHealth } = require('../public/js/ups-presenter');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('frontend UPS presenter keeps healthy, degraded, offline, and unknown semantics distinct', () => {
    const healthy = presentUpsHealth({ fetchHealth: 'healthy', source: 'ppb', actualSource: 'ppb', dataIsStale: false });
    assert.deepEqual({ state: healthy.state, tone: healthy.tone, source: healthy.source }, { state: 'healthy', tone: 'healthy', source: 'ppb' });

    const degraded = presentUpsHealth({
        fetchHealth: 'degraded', source: 'ppb', actualSource: null,
        lastKnownSource: 'ppb', dataIsStale: true
    });
    assert.equal(degraded.tone, 'degraded');
    assert.equal(degraded.source, 'ppb');
    assert.equal(degraded.sourceLabel, 'PPB');

    const offline = presentUpsHealth({ fetchHealth: 'offline', source: 'unreachable', actualSource: null, lastKnownSource: 'ppb', dataIsStale: true });
    assert.deepEqual({ tone: offline.tone, source: offline.source }, { tone: 'offline', source: 'unreachable' });

    const unknown = presentUpsHealth({ fetchHealth: 'unknown', reconfiguring: true });
    assert.deepEqual({ tone: unknown.tone, label: unknown.label, source: unknown.source }, { tone: 'unknown', label: '設定更新中', source: 'unreachable' });
});

test('frontend UPS rendering uses the pure presenter instead of source reachability as the health signal', () => {
    assert.match(appSource, /presentUpsHealth\(status\)/u);
    assert.match(appSource, /renderUpsSidebar\(s\)/u);
    assert.match(appSource, /degraded: \{ dot: 'bg-amber-500'/u);
    assert.doesNotMatch(appSource, /s\.source && s\.source !== 'unreachable'/u);
});

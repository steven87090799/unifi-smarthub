'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { operationalDependency: health } = require('../observability/operational-dependency');
const now = 1_800_000_000_000;
test('idle sampling remains healthy until its bounded freshness deadline', () => {
 const base = { configured: true, lastSuccessAt: now - 600_000, now, staleAfterMs: 1_800_000 };
 assert.equal(health(base).status, 'healthy');
 assert.equal(health({...base, now: now + 1_200_001}).status, 'degraded');
});
test('recent success cannot hide a subsequent explicit failure', () => {
 const base = { configured: true, lastSuccessAt: now - 1000, now };
 assert.equal(health({...base, consecutiveFailures: 1}).status, 'degraded');
 assert.equal(health({...base, consecutiveFailures: 3}).status, 'critical');
 assert.equal(health({...base, consecutiveFailures: 0}).status, 'healthy');
});
test('missing evidence remains unknown and disabled integrations are not configured', () => {
 assert.equal(health({configured:true,now}).status, 'unknown');
 assert.equal(health({configured:false,now,consecutiveFailures:3}).status,'not_configured');
});
test('event-driven delivery does not expire but failed delivery is visible', () => {
 const base = {configured:true,now,lastSuccessAt:now-86400000,staleAfterMs:Infinity};
 assert.equal(health(base).status,'healthy');
 assert.equal(health({...base,consecutiveFailures:1}).status,'degraded');
});

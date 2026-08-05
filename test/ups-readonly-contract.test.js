'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function routeBody(pathname) {
    const start = source.indexOf(`app.get('${pathname}'`);
    const end = source.indexOf('\n});', start) + '\n});'.length;
    assert.ok(start >= 0, `missing route ${pathname}`);
    assert.ok(end > start, `missing route boundary after ${pathname}`);
    return source.slice(start, end);
}

test('UPS status and PPB event GET routes only read snapshots', () => {
    const status = routeBody('/api/ups/status');
    const events = routeBody('/api/ups/ppb-events');
    assert.doesNotMatch(status, /sampleUpsIfDue|sampleUps\(/u);
    assert.doesNotMatch(events, /syncPpbEventsIfDue|syncPpbEvents\(/u);
    assert.match(status, /upsFetchState\.snapshot\(\)/u);
    assert.match(events, /historyDb\.listUpsPowerEvents\(200\)/u);
});

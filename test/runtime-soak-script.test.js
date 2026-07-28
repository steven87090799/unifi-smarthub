'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runtime-soak.js'), 'utf8');

test('runtime soak reports terminal status and cleans every test-owned resource', () => {
    assert.match(source, /process\.on\('uncaughtException'/);
    assert.match(source, /process\.on\('unhandledRejection'/);
    assert.match(source, /process\.exitCode = 0/);
    assert.match(source, /process\.exitCode = 1/);
    assert.doesNotMatch(source, /process\.exit\(0\)/);
    assert.match(source, /HTTP server close/);
    assert.match(source, /SSE client cleanup/);
    assert.match(source, /history\.close\(\)/);
    assert.match(source, /sampler\.stop\(\)/);
    assert.match(source, /closeAllConnections/);
    assert.match(source, /Runtime soak passed/);
    assert.match(source, /Exit code:/);
});

test('runtime soak keeps diagnostics test-only and asserts bounded terminal resources', () => {
    assert.match(source, /process\._getActiveHandles\(\)/);
    assert.match(source, /process\._getActiveRequests\(\)/);
    assert.match(source, /browser sessions remained after cleanup/);
    assert.match(source, /SSE clients remained after cleanup/);
    assert.match(source, /slow collectors overlapped/);
    assert.match(source, /cleanup must coalesce concurrent runs/);
    assert.match(source, /heap did not return to a reasonable range/);
    assert.match(source, /RSS grew without a bounded limit/);
});

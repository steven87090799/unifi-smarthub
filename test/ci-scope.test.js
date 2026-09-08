'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChanges } = require('../scripts/ci-scope');

test('documentation-only changes use the lightweight repository gate', () => {
    assert.deepEqual(classifyChanges([
        'README.md',
        'docs/operations/CI.md',
        'SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html'
    ]), {
        changed_count: 3,
        docs_only: true,
        run_docs: true,
        run_tests: false,
        run_js: false,
        run_css: false,
        run_audit: false,
        run_runtime: false,
        run_current_secret_scan: true,
        run_history_secret_scan: false
    });
});

test('test-only changes keep tests but skip image and release work', () => {
    const scope = classifyChanges(['test/panel-security.test.js']);
    assert.equal(scope.docs_only, false);
    assert.equal(scope.run_tests, true);
    assert.equal(scope.run_js, true);
    assert.equal(scope.run_runtime, false);
    assert.equal(scope.run_audit, false);
    assert.equal(scope.run_history_secret_scan, false);
});

test('runtime and dependency changes retain the full security and image gate', () => {
    const scope = classifyChanges(['server/routes/panel-auth-routes.js', 'package-lock.json']);
    assert.equal(scope.run_tests, true);
    assert.equal(scope.run_js, true);
    assert.equal(scope.run_runtime, true);
    assert.equal(scope.run_audit, true);
    assert.equal(scope.run_history_secret_scan, true);
});

test('an empty change set is treated as a release or unknown scope', () => {
    const scope = classifyChanges([]);
    assert.equal(scope.docs_only, false);
    assert.equal(scope.run_tests, true);
    assert.equal(scope.run_runtime, true);
    assert.equal(scope.run_history_secret_scan, true);
});

test('unclassified changes fail closed into the full gate', () => {
    const scope = classifyChanges(['.dockerignore']);
    assert.equal(scope.docs_only, false);
    assert.equal(scope.run_tests, true);
    assert.equal(scope.run_js, true);
    assert.equal(scope.run_css, true);
    assert.equal(scope.run_audit, true);
    assert.equal(scope.run_runtime, true);
    assert.equal(scope.run_history_secret_scan, true);
});

test('root documentation extensions must match the complete filename', () => {
    const scope = classifyChanges(['README.md.bak']);
    assert.equal(scope.docs_only, false);
    assert.equal(scope.run_runtime, true);
});

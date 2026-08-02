'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('GitHub Actions CI is a bounded required-check candidate with all repository gates', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(workflow, /pull_request:/u);
    assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*-\s*main/u);
    assert.match(workflow, /contents:\s*read/u);
    assert.match(workflow, /timeout-minutes:/u);
    assert.match(workflow, /npm ci/u);
    assert.match(workflow, /npm test/u);
    assert.match(workflow, /npm run check:css/u);
    assert.match(workflow, /npm run check:js/u);
    assert.match(workflow, /npm audit --audit-level=low/u);
    assert.match(workflow, /docker compose[\s\S]+config --quiet/u);
    assert.match(workflow, /docker compose[\s\S]+build unifi-smarthub/u);
    assert.match(workflow, /uses:\s*actions\/checkout@[0-9a-f]{40}\s+# v7/u);
    assert.match(workflow, /uses:\s*actions\/setup-node@[0-9a-f]{40}\s+# v7/u);
    assert.match(workflow, /node-version-file:\s*\.nvmrc/u);
    assert.match(workflow, /Generate SBOM and scan built images/u);
    assert.match(workflow, /trivy@sha256:[0-9a-f]{64}/u);
    assert.match(workflow, /image --format json --output "[^"]+\.trivy\.json" --severity HIGH,CRITICAL/u);
    assert.match(workflow, /--ignore-unfixed --severity HIGH,CRITICAL/u);
    assert.match(workflow, /uses:\s*actions\/upload-artifact@[0-9a-f]{40}\s+# v4\.6\.2/u);
    assert.match(workflow, /Upload SBOM and vulnerability reports/u);
    assert.match(workflow, /SOAK_TEST_DURATION_MS=90000 SOAK_TEST_TICK_MS=20 npm run test:soak/u);
    assert.match(workflow, /git diff --check/u);
});

test('isolated runtime smoke is a bounded blocking gate after tests and image builds', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const smokeStep = workflow.match(
        /- name: Run isolated production runtime smoke test[\s\S]*?(?=\n\s+- name:|\s*$)/u
    );
    assert.ok(smokeStep, 'runtime smoke step is required');
    assert.match(smokeStep[0], /run:\s*npm run test:smoke/u);
    assert.match(smokeStep[0], /timeout-minutes:\s*5/u);
    assert.doesNotMatch(smokeStep[0], /continue-on-error/u);
    assert.ok(workflow.indexOf('npm run test:smoke') > workflow.indexOf('npm test'));
    assert.ok(workflow.indexOf('npm run test:smoke') > workflow.indexOf('build unifi-smarthub'));
    assert.doesNotMatch(workflow, /ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/u);
});

test('JavaScript syntax checker discovers source files and applies bounded exclusions', () => {
    const checker = fs.readFileSync(path.join(ROOT, 'scripts', 'check-js-syntax.js'), 'utf8');
    assert.match(checker, /node_modules/u);
    assert.match(checker, /\.production-verification/u);
    assert.match(checker, /node --check|--check/u);
    const packageJson = require('../package.json');
    assert.equal(packageJson.scripts['check:js'], 'node scripts/check-js-syntax.js');
});

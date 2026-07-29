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
    assert.match(workflow, /npm audit --audit-level=high/u);
    assert.match(workflow, /docker compose[\s\S]+config --quiet/u);
    assert.match(workflow, /docker compose[\s\S]+build unifi-smarthub/u);
    assert.match(workflow, /git diff --check/u);
});

test('JavaScript syntax checker discovers source files and applies bounded exclusions', () => {
    const checker = fs.readFileSync(path.join(ROOT, 'scripts', 'check-js-syntax.js'), 'utf8');
    assert.match(checker, /node_modules/u);
    assert.match(checker, /\.production-verification/u);
    assert.match(checker, /node --check|--check/u);
    const packageJson = require('../package.json');
    assert.equal(packageJson.scripts['check:js'], 'node scripts/check-js-syntax.js');
});

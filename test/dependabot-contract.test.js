'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('Dependabot keeps all update ecosystems visible and bounded', () => {
    const config = fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
    assert.doesNotMatch(config, /open-pull-requests-limit:\s*0/u);
    assert.equal((config.match(/package-ecosystem:/gu) || []).length, 4);
    assert.equal((config.match(/open-pull-requests-limit:\s*[1-9]\d*/gu) || []).length, 4);
    assert.equal((config.match(/interval:\s*weekly/gu) || []).length, 4);
    assert.equal((config.match(/groups:/gu) || []).length, 4);
    assert.equal((config.match(/version-update:semver-major/gu) || []).length, 4);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('Dependabot disables ordinary version-update PRs while retaining security policy ownership', () => {
    const config = fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
    assert.match(config, /Disable Dependabot version-update PRs/u);
    assert.match(config, /Dependabot alerts and security updates remain controlled separately/u);
    assert.equal((config.match(/package-ecosystem:/gu) || []).length, 4);
    assert.equal((config.match(/open-pull-requests-limit:\s*0/gu) || []).length, 4);
    assert.doesNotMatch(config, /open-pull-requests-limit:\s*[1-9]\d*/u);
    assert.equal((config.match(/interval:\s*weekly/gu) || []).length, 4);
    assert.doesNotMatch(config, /groups:/u);
    assert.doesNotMatch(config, /version-update:semver-major/u);
});

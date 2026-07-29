'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function numericVersion(version) {
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/u);
    assert.ok(match, `expected an exact semantic version, received ${version}`);
    return match.slice(1).map(Number);
}

function isAtLeast(actual, minimum) {
    const left = numericVersion(actual);
    const right = numericVersion(minimum);
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index];
    }
    return true;
}

test('the locked Express dependency tree contains one patched body-parser version', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const lockedBodyParsers = Object.entries(packageLock.packages)
        .filter(([location]) => /(?:^|\/)node_modules\/body-parser$/u.test(location));

    assert.equal(packageJson.dependencies['body-parser'], undefined, 'body-parser remains transitive through Express');
    assert.equal(packageJson.overrides?.['body-parser'], undefined, 'no override may mask the upstream dependency contract');
    assert.equal(lockedBodyParsers.length, 1, 'only one body-parser installation is expected');
    assert.ok(isAtLeast(lockedBodyParsers[0][1].version, '1.20.6'));
    assert.equal(require('body-parser/package.json').version, lockedBodyParsers[0][1].version);
});

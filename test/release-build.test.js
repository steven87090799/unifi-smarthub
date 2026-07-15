'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    assertReleaseTagsAvailable,
    assertCleanRepository,
    dockerBuildArgs,
    normalizeRepository,
    publishImageTags,
    releaseMetadata,
    repositoryChanges,
    verifyBuiltImage
} = require('../scripts/release-build');
const { toOciLabels } = require('../observability/build-identity');

const metadata = Object.freeze({
    version: '3.0.0',
    revision: 'abcdef0123456789abcdef0123456789abcdef01',
    created: '2026-07-15T00:00:00.000Z'
});

test('clean-tree gate counts staged, unstaged, and untracked porcelain records', () => {
    assert.deepEqual(repositoryChanges(''), []);
    const dirty = ' M server.js\nA  test/new.test.js\n?? scratch.txt\n';
    assert.equal(repositoryChanges(dirty).length, 3);
    assert.throws(() => assertCleanRepository(dirty), error =>
        error.code === 'RELEASE_SOURCE_DIRTY' && error.changeCount === 3 && !error.message.includes('server.js'));
    assert.doesNotThrow(() => assertCleanRepository(''));
});

test('release metadata requires a complete clean canonical identity', () => {
    const identity = releaseMetadata(metadata);
    assert.equal(identity.public.status, 'clean');
    assert.equal(identity.public.revision, metadata.revision);
    assert.throws(() => releaseMetadata({ ...metadata, revision: 'short' }), /complete and valid/);
});

test('Docker build arguments carry exact identity and strict gate only when requested', () => {
    const identity = releaseMetadata(metadata);
    const normal = dockerBuildArgs(identity);
    const strict = dockerBuildArgs(identity, { requireIdentity: true });
    assert.ok(normal.includes(`BUILD_REVISION=${metadata.revision}`));
    assert.equal(normal.includes('BUILD_IDENTITY_REQUIRED=true'), false);
    assert.ok(strict.includes('BUILD_IDENTITY_REQUIRED=true'));
});

test('release build enables the strict runtime identity gate for both images', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'release-build.js'), 'utf8');
    const calls = [...source.matchAll(/buildImage\(\{([\s\S]*?)\n\s*\}\);/g)].map(match => match[1]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => /requireIdentity:\s*true/.test(call)));
    assert.match(calls[1], /nas-monitor/);
});

test('image repository names are bounded and shell-independent', () => {
    assert.equal(normalizeRepository('', 'unifi-smarthub'), 'unifi-smarthub');
    assert.equal(normalizeRepository('registry.example/team/smarthub', 'fallback'), 'registry.example/team/smarthub');
    for (const value of ['../escape', 'repo;touch-pwned', '/absolute', 'repo/', 'x'.repeat(201)]) {
        assert.throws(() => normalizeRepository(value, 'fallback'), /invalid/);
    }
});

test('built-image verification rejects missing, dirty, and mismatched labels', () => {
    const identity = releaseMetadata(metadata);
    assert.equal(verifyBuiltImage(identity, toOciLabels(identity)).status, 'match');
    assert.throws(() => verifyBuiltImage(identity, {}), error => error.code === 'RELEASE_IMAGE_IDENTITY_FAILED');
    assert.throws(() => verifyBuiltImage(identity, {
        ...toOciLabels(identity),
        'org.opencontainers.image.revision': '1'.repeat(40)
    }), error => error.mismatches.includes('revision'));
});

test('revision release tags are immutable once published', () => {
    const images = ['unifi-smarthub:abcdef012345', 'unifi-smarthub-nas-monitor:abcdef012345'];
    assert.doesNotThrow(() => assertReleaseTagsAvailable(images, () => null));
    assert.throws(
        () => assertReleaseTagsAvailable(images, image => image === images[0] ? `sha256:${'a'.repeat(64)}` : null),
        error => error.code === 'RELEASE_TAG_EXISTS' && error.image === images[0]
    );
});

test('two-image publication rolls back a partial tag pair', () => {
    const calls = [];
    const pairs = [
        { source: `sha256:${'a'.repeat(64)}`, target: 'main:revision' },
        { source: `sha256:${'b'.repeat(64)}`, target: 'monitor:revision' }
    ];
    assert.throws(() => publishImageTags(pairs, (operation, source, target) => {
        calls.push([operation, source, target]);
        if (operation === 'tag' && target === 'monitor:revision') throw new Error('injected tag failure');
    }), /injected tag failure/);
    assert.deepEqual(calls, [
        ['tag', pairs[0].source, pairs[0].target],
        ['tag', pairs[1].source, pairs[1].target],
        ['remove', pairs[0].target, undefined]
    ]);
});

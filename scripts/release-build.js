#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuildIdentity, verifyImageLabels } = require('../observability/build-identity');

const ROOT = path.resolve(__dirname, '..');

function output(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd || ROOT,
        encoding: 'utf8',
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        env: options.env || process.env,
        maxBuffer: 16 * 1024 * 1024
    }).trim();
}

function repositoryChanges(statusOutput) {
    return String(statusOutput || '').split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
}

function assertCleanRepository(statusOutput) {
    const changes = repositoryChanges(statusOutput);
    if (changes.length) {
        const error = new Error(`Release source must be clean; ${changes.length} tracked or untracked path(s) differ from HEAD`);
        error.code = 'RELEASE_SOURCE_DIRTY';
        error.changeCount = changes.length;
        throw error;
    }
}

function normalizeRepository(value, fallback) {
    const repository = value || fallback;
    if (typeof repository !== 'string' || repository.length > 200
        || !/^[a-z0-9][a-z0-9._/-]*$/i.test(repository)
        || repository.includes('..') || repository.endsWith('/')) {
        throw new Error('Image repository name is invalid');
    }
    return repository;
}

function releaseMetadata({ version, revision, created }) {
    return createBuildIdentity({
        BUILD_VERSION: version,
        BUILD_REVISION: revision,
        BUILD_CREATED: created,
        BUILD_DIRTY: 'false'
    }, { requireClean: true });
}

function dockerBuildArgs(identity, { requireIdentity = false } = {}) {
    return [
        '--build-arg', `BUILD_VERSION=${identity.public.version}`,
        '--build-arg', `BUILD_REVISION=${identity.public.revision}`,
        '--build-arg', `BUILD_CREATED=${identity.public.created}`,
        '--build-arg', 'BUILD_DIRTY=false',
        ...(requireIdentity ? ['--build-arg', 'BUILD_IDENTITY_REQUIRED=true'] : [])
    ];
}

function verifyBuiltImage(identity, labels) {
    const verification = verifyImageLabels(identity, labels, { requireClean: true });
    if (!verification.ok) {
        const error = new Error(`Built image identity verification failed: ${verification.status}`);
        error.code = 'RELEASE_IMAGE_IDENTITY_FAILED';
        error.mismatches = verification.mismatches;
        throw error;
    }
    return verification;
}

function inspectLabels(image) {
    const serialized = output('docker', ['image', 'inspect', image, '--format', '{{json .Config.Labels}}']);
    let labels;
    try { labels = JSON.parse(serialized); }
    catch { throw new Error('Docker returned malformed image labels'); }
    return labels;
}

function inspectImageId(image) {
    const id = output('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error('Docker returned an invalid image ID');
    return id;
}

function inspectOptionalImageId(image) {
    const serialized = output('docker', ['image', 'ls', '--quiet', '--no-trunc', image]);
    if (!serialized) return null;
    const ids = serialized.split(/\r?\n/).filter(Boolean);
    if (ids.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(ids[0])) {
        throw new Error('Docker returned an ambiguous image reference');
    }
    return ids[0];
}

function assertReleaseTagsAvailable(images, resolveImageId = inspectOptionalImageId) {
    for (const image of images) {
        if (!resolveImageId(image)) continue;
        const error = new Error('Release image tag already exists and will not be retargeted');
        error.code = 'RELEASE_TAG_EXISTS';
        error.image = image;
        throw error;
    }
}

function dockerTagOperation(operation, source, target) {
    if (operation === 'tag') {
        execFileSync('docker', ['image', 'tag', source, target], { cwd: ROOT, stdio: 'inherit', env: process.env });
        return;
    }
    if (operation === 'remove') {
        execFileSync('docker', ['image', 'rm', source], { cwd: ROOT, stdio: 'inherit', env: process.env });
        return;
    }
    throw new TypeError('Unknown Docker tag operation');
}

function publishImageTags(pairs, operate = dockerTagOperation) {
    const published = [];
    try {
        for (const pair of pairs) {
            operate('tag', pair.source, pair.target);
            published.push(pair.target);
        }
    } catch (error) {
        const rollbackFailures = [];
        for (const target of published.reverse()) {
            try { operate('remove', target); }
            catch (rollbackError) { rollbackFailures.push(rollbackError); }
        }
        if (rollbackFailures.length) {
            const failure = new Error(`${error.message}; release tag rollback incomplete`, { cause: error });
            failure.code = 'RELEASE_PUBLISH_ROLLBACK_FAILED';
            failure.rollbackFailures = rollbackFailures.length;
            throw failure;
        }
        throw error;
    }
}

function buildImage({ context, dockerfile, image, identity, requireIdentity }) {
    execFileSync('docker', [
        'build', '--file', dockerfile, '--tag', image,
        ...dockerBuildArgs(identity, { requireIdentity }), context
    ], { cwd: ROOT, stdio: 'inherit', env: process.env });
    verifyBuiltImage(identity, inspectLabels(image));
    return inspectImageId(image);
}

function main() {
    assertCleanRepository(output('git', ['status', '--porcelain=v1', '--untracked-files=all']));
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const revision = output('git', ['rev-parse', '--verify', 'HEAD']);
    const created = new Date(output('git', ['show', '-s', '--format=%cI', 'HEAD'])).toISOString();
    const identity = releaseMetadata({ version: packageJson.version, revision, created });
    const shortRevision = identity.public.revision.slice(0, 12);
    const mainRepository = normalizeRepository(process.env.SMARTHUB_IMAGE_REPOSITORY, 'unifi-smarthub');
    const monitorRepository = normalizeRepository(process.env.NAS_MONITOR_IMAGE_REPOSITORY, 'unifi-smarthub-nas-monitor');
    const mainImage = `${mainRepository}:${shortRevision}`;
    const monitorImage = `${monitorRepository}:${shortRevision}`;
    const transactionId = crypto.randomUUID().replace(/-/g, '');
    const mainStagingImage = `${mainRepository}:${shortRevision}-staging-${transactionId}`;
    const monitorStagingImage = `${monitorRepository}:${shortRevision}-staging-${transactionId}`;
    assertReleaseTagsAvailable([mainImage, monitorImage, mainStagingImage, monitorStagingImage]);

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-release-'));
    let mainImageId;
    let monitorImageId;
    try {
        const archive = path.join(temporary, 'source.tar');
        const source = path.join(temporary, 'source');
        fs.mkdirSync(source);
        output('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD']);
        execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'inherit' });

        mainImageId = buildImage({
            context: source,
            dockerfile: path.join(source, 'Dockerfile'),
            image: mainStagingImage,
            identity,
            requireIdentity: true
        });
        monitorImageId = buildImage({
            context: path.join(source, 'nas-monitor'),
            dockerfile: path.join(source, 'nas-monitor', 'Dockerfile'),
            image: monitorStagingImage,
            identity,
            requireIdentity: true
        });

        // Recheck after both builds so a pre-existing revision tag is never
        // silently retargeted. Publication rolls back the first tag if the
        // second tag operation fails.
        assertReleaseTagsAvailable([mainImage, monitorImage]);
        publishImageTags([
            { source: mainImageId, target: mainImage },
            { source: monitorImageId, target: monitorImage }
        ]);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
        for (const stagingImage of [mainStagingImage, monitorStagingImage]) {
            try {
                if (inspectOptionalImageId(stagingImage)) dockerTagOperation('remove', stagingImage);
            } catch (error) {
                process.stderr.write(`release-build warning: staging tag cleanup failed for ${stagingImage}: ${error.message}\n`);
            }
        }
    }

    process.stdout.write(`${JSON.stringify({
        status: 'verified',
        version: identity.public.version,
        revision: identity.public.revision,
        created: identity.public.created,
        images: { main: mainImage, monitor: monitorImage },
        image_ids: { main: mainImageId, monitor: monitorImageId }
    })}\n`);
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        process.stderr.write(`release-build failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    assertReleaseTagsAvailable,
    assertCleanRepository,
    dockerBuildArgs,
    inspectImageId,
    normalizeRepository,
    publishImageTags,
    releaseMetadata,
    repositoryChanges,
    verifyBuiltImage
};

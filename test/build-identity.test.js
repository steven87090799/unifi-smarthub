'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BuildIdentityError,
    OCI_LABEL_KEYS,
    createBuildIdentity,
    toOciLabels,
    verifyImageLabels
} = require('../observability/build-identity');

const VALID_ENV = Object.freeze({
    BUILD_VERSION: '3.0.0-rc.1+prod',
    BUILD_REVISION: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    BUILD_CREATED: '2026-07-15T08:09:10.123456+08:00',
    BUILD_DIRTY: 'false'
});

test('normalizes a complete clean identity into public and structured-log fields', () => {
    const identity = createBuildIdentity(VALID_ENV, { requireClean: true });
    assert.deepEqual(identity.public, {
        version: '3.0.0-rc.1+prod',
        revision: 'abcdef0123456789abcdef0123456789abcdef01',
        created: '2026-07-15T00:09:10.123Z',
        dirty: false,
        status: 'clean',
        complete: true
    });
    assert.deepEqual(identity.logFields, {
        build_version: identity.public.version,
        build_revision: identity.public.revision,
        build_created: identity.public.created,
        build_dirty: false,
        build_identity_status: 'clean',
        build_identity_complete: true,
        build_identity_issues: []
    });
    assert.ok(Object.isFrozen(identity));
    assert.ok(Object.isFrozen(identity.public));
    assert.ok(Object.isFrozen(identity.logFields.build_identity_issues));
});

test('uses explicit unknown values for missing metadata without guessing package or source state', () => {
    const identity = createBuildIdentity({});
    assert.deepEqual(identity.public, {
        version: 'unknown', revision: 'unknown', created: 'unknown', dirty: null,
        status: 'incomplete', complete: false
    });
    assert.deepEqual(identity.issues, [
        'version_missing', 'revision_missing', 'created_missing', 'dirty_missing'
    ]);
});

test('rejects malformed, ambiguous and non-canonical values rather than coercing them', () => {
    const cases = [
        ['version', { ...VALID_ENV, BUILD_VERSION: 'v3.0.0' }],
        ['version', { ...VALID_ENV, BUILD_VERSION: '3.01.0' }],
        ['revision', { ...VALID_ENV, BUILD_REVISION: 'abcdef0' }],
        ['created', { ...VALID_ENV, BUILD_CREATED: '2026-02-30T00:00:00Z' }],
        ['created', { ...VALID_ENV, BUILD_CREATED: '2026-07-15 00:00:00Z' }],
        ['dirty', { ...VALID_ENV, BUILD_DIRTY: '0' }],
        ['dirty', { ...VALID_ENV, BUILD_DIRTY: 'False' }],
        ['dirty', { ...VALID_ENV, BUILD_DIRTY: false }]
    ];
    for (const [field, env] of cases) {
        const identity = createBuildIdentity(env);
        assert.equal(identity.public.status, 'invalid', `${field} should be invalid`);
        assert.ok(identity.issues.includes(`${field}_invalid`));
        assert.equal(identity.public[field], field === 'dirty' ? null : 'unknown');
    }
});

test('bounds every input before parsing and never returns rejected raw values', () => {
    const marker = 'sk-super-secret-material-never-expose';
    const identity = createBuildIdentity({
        PANEL_PASSWORD: marker,
        BUILD_VERSION: `${marker}${'x'.repeat(1000)}`,
        BUILD_REVISION: `${marker}${'a'.repeat(1000)}`,
        BUILD_CREATED: `${marker}${'0'.repeat(1000)}`,
        BUILD_DIRTY: `${marker}${'1'.repeat(1000)}`
    });
    const serialized = JSON.stringify(identity);
    assert.equal(identity.public.status, 'invalid');
    assert.doesNotMatch(serialized, /super-secret|never-expose/);
    assert.deepEqual(identity.issues, [
        'version_invalid', 'revision_invalid', 'created_invalid', 'dirty_invalid'
    ]);
});

test('required identity errors contain only safe field diagnostics', () => {
    const secret = 'sk-secret-revision-value';
    let caught;
    try {
        createBuildIdentity({ BUILD_REVISION: secret }, { requireComplete: true });
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof BuildIdentityError);
    assert.equal(caught.code, 'BUILD_IDENTITY_INVALID');
    assert.equal(caught.status, 'invalid');
    assert.doesNotMatch(JSON.stringify({
        name: caught.name, message: caught.message, code: caught.code,
        status: caught.status, issues: caught.issues
    }), /sk-secret|revision-value/);

    assert.throws(
        () => createBuildIdentity({ ...VALID_ENV, BUILD_DIRTY: 'true' }, { requireClean: true }),
        error => error instanceof BuildIdentityError && error.code === 'BUILD_IDENTITY_DIRTY'
    );
});

test('maps normalized runtime identity to exact OCI and SmartHub label keys', () => {
    const identity = createBuildIdentity(VALID_ENV);
    assert.deepEqual(toOciLabels(identity), {
        [OCI_LABEL_KEYS.version]: identity.public.version,
        [OCI_LABEL_KEYS.revision]: identity.public.revision,
        [OCI_LABEL_KEYS.created]: identity.public.created,
        [OCI_LABEL_KEYS.dirty]: 'false'
    });
});

test('verifies runtime metadata against normalized image labels and reports only field names', () => {
    const runtime = createBuildIdentity(VALID_ENV);
    const matching = verifyImageLabels(runtime, toOciLabels(runtime));
    assert.equal(matching.ok, true);
    assert.equal(matching.status, 'match');
    assert.deepEqual(matching.mismatches, []);

    const wrongRevision = '1'.repeat(40);
    const mismatched = verifyImageLabels(runtime, {
        ...toOciLabels(runtime),
        [OCI_LABEL_KEYS.revision]: wrongRevision
    });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.status, 'mismatch');
    assert.deepEqual(mismatched.mismatches, ['revision']);
});

test('image verification fails closed for missing, malformed and dirty identity', () => {
    const cleanRuntime = createBuildIdentity(VALID_ENV);
    const secret = 'secret-label-payload';
    const unverifiable = verifyImageLabels(cleanRuntime, {
        [OCI_LABEL_KEYS.version]: secret,
        unrelated_secret: secret
    });
    assert.equal(unverifiable.ok, false);
    assert.equal(unverifiable.status, 'unverifiable');
    assert.doesNotMatch(JSON.stringify(unverifiable), /secret-label-payload/);

    const dirtyRuntime = createBuildIdentity({ ...VALID_ENV, BUILD_DIRTY: 'true' });
    const labels = toOciLabels(dirtyRuntime);
    assert.deepEqual(
        { ok: verifyImageLabels(dirtyRuntime, labels).ok, status: verifyImageLabels(dirtyRuntime, labels).status },
        { ok: false, status: 'dirty' }
    );
    assert.equal(verifyImageLabels(dirtyRuntime, labels, { requireClean: false }).ok, true);

    const runtimeSecret = 'secret-runtime-object';
    assert.throws(
        () => verifyImageLabels({ public: { version: runtimeSecret } }, labels),
        error => error instanceof TypeError && !error.message.includes(runtimeSecret)
    );
});

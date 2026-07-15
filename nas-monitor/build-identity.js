'use strict';

const UNKNOWN = 'unknown';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CREATED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class MonitorBuildIdentityError extends Error {
    constructor(code) {
        super('NAS monitor build identity is invalid');
        this.name = 'MonitorBuildIdentityError';
        this.code = code;
    }
}

function field(source, name, maximum, validate, normalize = value => value) {
    const value = source?.[name];
    if (value === undefined || value === null || value === '') return { state: 'missing', value: null };
    if (typeof value !== 'string' || value.length > maximum || !validate(value)) {
        return { state: 'invalid', value: null };
    }
    return { state: 'valid', value: normalize(value) };
}

function validCreated(value) {
    if (!CREATED.test(value)) return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function createBuildIdentity(source = process.env, { requireClean = false } = {}) {
    const version = field(source, 'BUILD_VERSION', 64, value => SEMVER.test(value));
    const revision = field(source, 'BUILD_REVISION', 64, value => REVISION.test(value), value => value.toLowerCase());
    const created = field(source, 'BUILD_CREATED', 24, validCreated);
    const dirty = field(source, 'BUILD_DIRTY', 5, value => value === 'true' || value === 'false', value => value === 'true');
    const fields = { version, revision, created, dirty };
    const status = Object.values(fields).some(value => value.state === 'invalid') ? 'invalid'
        : Object.values(fields).some(value => value.state === 'missing') ? 'incomplete'
            : dirty.value ? 'dirty' : 'clean';
    const identity = Object.freeze({
        version: version.value ?? UNKNOWN,
        revision: revision.value ?? UNKNOWN,
        created: created.value ?? UNKNOWN,
        dirty: dirty.state === 'valid' ? dirty.value : null,
        status,
        complete: status === 'clean' || status === 'dirty'
    });
    if (requireClean && status !== 'clean') {
        const code = status === 'dirty' ? 'BUILD_IDENTITY_DIRTY'
            : status === 'incomplete' ? 'BUILD_IDENTITY_INCOMPLETE'
                : 'BUILD_IDENTITY_INVALID';
        throw new MonitorBuildIdentityError(code);
    }
    return identity;
}

function createRuntimeBuildIdentity(source = process.env) {
    const required = source?.BUILD_IDENTITY_REQUIRED;
    if (required !== undefined && required !== 'true' && required !== 'false') {
        throw new MonitorBuildIdentityError('BUILD_IDENTITY_POLICY_INVALID');
    }
    return createBuildIdentity(source, { requireClean: required === 'true' });
}

module.exports = {
    MonitorBuildIdentityError,
    createBuildIdentity,
    createRuntimeBuildIdentity
};

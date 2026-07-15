'use strict';

const UNKNOWN = 'unknown';

const OCI_LABEL_KEYS = Object.freeze({
    version: 'org.opencontainers.image.version',
    revision: 'org.opencontainers.image.revision',
    created: 'org.opencontainers.image.created',
    dirty: 'io.smarthub.build.dirty'
});

const FIELD_SPECS = Object.freeze({
    version: Object.freeze({ env: 'BUILD_VERSION', maxLength: 64 }),
    revision: Object.freeze({ env: 'BUILD_REVISION', maxLength: 64 }),
    created: Object.freeze({ env: 'BUILD_CREATED', maxLength: 40 }),
    dirty: Object.freeze({ env: 'BUILD_DIRTY', maxLength: 5 })
});

// SemVer 2.0.0 without a non-standard leading "v". Length is checked first so
// pathological input cannot make the expression do unbounded work.
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const NORMALIZED_IDENTITIES = new WeakSet();

class BuildIdentityError extends Error {
    constructor(code, status, issues) {
        super(code === 'BUILD_IDENTITY_DIRTY'
            ? 'A clean build identity is required'
            : 'A complete and valid build identity is required');
        this.name = 'BuildIdentityError';
        this.code = code;
        this.status = status;
        this.issues = Object.freeze([...issues]);
    }
}

function freeze(value) {
    if (!value || typeof value !== 'object') return value;
    if (Object.isFrozen(value)) return value;
    for (const item of Object.values(value)) freeze(item);
    return Object.freeze(value);
}

function rawField(source, field) {
    const value = source?.[FIELD_SPECS[field].env];
    if (value === undefined || value === null || value === '') {
        return { state: 'missing', value: null };
    }
    if (typeof value !== 'string' || value.length > FIELD_SPECS[field].maxLength) {
        return { state: 'invalid', value: null };
    }
    return { state: 'present', value };
}

function normalizeVersion(source) {
    const input = rawField(source, 'version');
    if (input.state !== 'present') return input;
    return SEMVER_PATTERN.test(input.value)
        ? { state: 'valid', value: input.value }
        : { state: 'invalid', value: null };
}

function normalizeRevision(source) {
    const input = rawField(source, 'revision');
    if (input.state !== 'present') return input;
    return REVISION_PATTERN.test(input.value)
        ? { state: 'valid', value: input.value.toLowerCase() }
        : { state: 'invalid', value: null };
}

function normalizeCreated(source) {
    const input = rawField(source, 'created');
    if (input.state !== 'present') return input;
    const match = RFC3339_PATTERN.exec(input.value);
    if (!match) return { state: 'invalid', value: null };

    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
    const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;

    if (year === 0 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59
        || offsetHour > 23 || offsetMinute > 59 || zone === '-00:00') {
        return { state: 'invalid', value: null };
    }

    const timestamp = Date.parse(input.value);
    if (!Number.isFinite(timestamp)) return { state: 'invalid', value: null };
    return { state: 'valid', value: new Date(timestamp).toISOString() };
}

function normalizeDirty(source) {
    const input = rawField(source, 'dirty');
    if (input.state !== 'present') return input;
    if (input.value === 'true') return { state: 'valid', value: true };
    if (input.value === 'false') return { state: 'valid', value: false };
    return { state: 'invalid', value: null };
}

function identityStatus(results) {
    if (Object.values(results).some(result => result.state === 'invalid')) return 'invalid';
    if (Object.values(results).some(result => result.state === 'missing')) return 'incomplete';
    return results.dirty.value ? 'dirty' : 'clean';
}

function createBuildIdentity(source = process.env, options = {}) {
    const safeSource = source && typeof source === 'object' ? source : {};
    const results = {
        version: normalizeVersion(safeSource),
        revision: normalizeRevision(safeSource),
        created: normalizeCreated(safeSource),
        dirty: normalizeDirty(safeSource)
    };
    const status = identityStatus(results);
    const issues = Object.entries(results)
        .filter(([, result]) => result.state !== 'valid')
        .map(([field, result]) => `${field}_${result.state}`);
    if (status === 'dirty') issues.push('dirty_true');

    const publicIdentity = freeze({
        version: results.version.value ?? UNKNOWN,
        revision: results.revision.value ?? UNKNOWN,
        created: results.created.value ?? UNKNOWN,
        dirty: results.dirty.state === 'valid' ? results.dirty.value : null,
        status,
        complete: status === 'clean' || status === 'dirty'
    });
    const logFields = freeze({
        build_version: publicIdentity.version,
        build_revision: publicIdentity.revision,
        build_created: publicIdentity.created,
        build_dirty: publicIdentity.dirty ?? UNKNOWN,
        build_identity_status: status,
        build_identity_complete: publicIdentity.complete,
        build_identity_issues: issues
    });
    const identity = freeze({ public: publicIdentity, logFields, issues });
    NORMALIZED_IDENTITIES.add(identity);

    if (options.requireComplete === true && !publicIdentity.complete) {
        const code = status === 'invalid' ? 'BUILD_IDENTITY_INVALID' : 'BUILD_IDENTITY_INCOMPLETE';
        throw new BuildIdentityError(code, status, issues);
    }
    if (options.requireClean === true && status !== 'clean') {
        const code = status === 'dirty' ? 'BUILD_IDENTITY_DIRTY'
            : status === 'invalid' ? 'BUILD_IDENTITY_INVALID'
                : 'BUILD_IDENTITY_INCOMPLETE';
        throw new BuildIdentityError(code, status, issues);
    }
    return identity;
}

function labelsToEnvironment(labels) {
    const safeLabels = labels && typeof labels === 'object' ? labels : {};
    return {
        BUILD_VERSION: safeLabels[OCI_LABEL_KEYS.version],
        BUILD_REVISION: safeLabels[OCI_LABEL_KEYS.revision],
        BUILD_CREATED: safeLabels[OCI_LABEL_KEYS.created],
        BUILD_DIRTY: safeLabels[OCI_LABEL_KEYS.dirty]
    };
}

function toOciLabels(identity) {
    if (!NORMALIZED_IDENTITIES.has(identity)) throw new TypeError('A normalized build identity is required');
    const value = identity.public;
    return freeze({
        [OCI_LABEL_KEYS.version]: value.version,
        [OCI_LABEL_KEYS.revision]: value.revision,
        [OCI_LABEL_KEYS.created]: value.created,
        [OCI_LABEL_KEYS.dirty]: value.dirty === null ? UNKNOWN : String(value.dirty)
    });
}

function verifyImageLabels(runtimeIdentity, labels, options = {}) {
    if (!NORMALIZED_IDENTITIES.has(runtimeIdentity)) throw new TypeError('A normalized runtime build identity is required');
    const imageIdentity = createBuildIdentity(labelsToEnvironment(labels));
    const fields = ['version', 'revision', 'created', 'dirty'];
    const mismatches = fields.filter(field => runtimeIdentity.public[field] !== imageIdentity.public[field]);
    const complete = runtimeIdentity.public.complete && imageIdentity.public.complete;
    const clean = runtimeIdentity.public.status === 'clean' && imageIdentity.public.status === 'clean';
    const requireClean = options.requireClean !== false;
    const matched = complete && mismatches.length === 0;
    const ok = matched && (!requireClean || clean);
    const status = !complete ? 'unverifiable'
        : mismatches.length ? 'mismatch'
            : requireClean && !clean ? 'dirty'
                : 'match';

    return freeze({
        ok,
        status,
        mismatches,
        runtime: runtimeIdentity.public,
        image: imageIdentity.public,
        require_clean: requireClean
    });
}

module.exports = {
    BuildIdentityError,
    OCI_LABEL_KEYS,
    createBuildIdentity,
    toOciLabels,
    verifyImageLabels
};

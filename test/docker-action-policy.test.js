'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DockerActionPolicyError,
    ambiguousDockerActionResult,
    containersFromPayload,
    isCanonicalDockerContainerId,
    normalizedAllowedActions,
    selectDockerActionTarget
} = require('../server/policies/docker-action-policy');

const id = 'a'.repeat(64);

test('container payload extraction accepts legacy arrays and bounded object shape', () => {
    const rows = [{ id }];
    assert.equal(containersFromPayload(rows), rows);
    assert.equal(containersFromPayload({ containers: rows }), rows);
    assert.deepEqual(containersFromPayload({ containers: {} }), []);
    assert.deepEqual(containersFromPayload(null), []);
});

test('allowed action metadata is exact, unique, and fail closed when absent', () => {
    assert.deepEqual(normalizedAllowedActions({ allowed_actions: ['restart', 'restart', 'delete', 1] }), ['restart']);
    assert.deepEqual(normalizedAllowedActions({}), []);
    assert.deepEqual(normalizedAllowedActions({}, { allowLegacy: true }), ['start', 'stop', 'restart']);
    assert.deepEqual(normalizedAllowedActions({ allowed_actions: 'restart' }, { allowLegacy: true }), []);
});

test('target selection requires an exact canonical id and explicit per-container capability', () => {
    const payload = { containers: [{ id, name: 'worker', allowed_actions: ['restart'] }] };
    assert.deepEqual(selectDockerActionTarget(payload, id, 'restart'), { id, name: 'worker', action: 'restart' });
    for (const [target, action] of [[id, 'stop'], ['worker', 'restart'], [id.slice(0, 12), 'restart']]) {
        assert.throws(() => selectDockerActionTarget(payload, target, action), DockerActionPolicyError);
    }
});

test('canonical ids match the broker exact lower-case 64-hex contract', () => {
    assert.equal(isCanonicalDockerContainerId(id), true);
    for (const target of [
        id.slice(0, 12),
        id.slice(0, 63),
        `${id}a`,
        id.toUpperCase(),
        'g'.repeat(64),
        `${'a'.repeat(63)}-`,
        '',
        null
    ]) {
        assert.equal(isCanonicalDockerContainerId(target), false);
        assert.throws(
            () => selectDockerActionTarget({ containers: [{ id: target, allowed_actions: ['restart'] }] }, target, 'restart'),
            error => error instanceof DockerActionPolicyError && error.code === 'DOCKER_TARGET_INVALID'
        );
    }
});

test('duplicate or noncanonical upstream ids fail closed', () => {
    const duplicate = { containers: [
        { id, allowed_actions: ['restart'] },
        { id, allowed_actions: ['restart'] }
    ] };
    assert.throws(() => selectDockerActionTarget(duplicate, id, 'restart'), /not found by canonical/);

    for (const upstreamId of [id.slice(0, 12), id.toUpperCase(), 'z'.repeat(64), 42, null]) {
        assert.throws(
            () => selectDockerActionTarget({ containers: [{ id: upstreamId, allowed_actions: ['restart'] }] }, id, 'restart'),
            error => error instanceof DockerActionPolicyError && error.code === 'DOCKER_TARGET_NOT_FOUND'
        );
    }
});

test('legacy mutation requires an explicit compatibility opt-in', () => {
    const legacy = [{ id, name: 'legacy' }];
    assert.throws(() => selectDockerActionTarget(legacy, id, 'restart'), /not allowed/);
    assert.deepEqual(selectDockerActionTarget(legacy, id, 'restart', { allowLegacy: true }), {
        id, name: 'legacy', action: 'restart'
    });
});

test('only the exact broker timeout contract is treated as an ambiguous action result', () => {
    const result = ambiguousDockerActionResult({ response: {
        status: 504,
        data: { error: 'action_result_unknown', ambiguous: true, action: 'restart', details: 'not forwarded' }
    } }, 'restart');
    assert.deepEqual(result, { error: 'action_result_unknown', ambiguous: true, action: 'restart' });
    for (const error of [
        { response: { status: 500, data: { error: 'action_result_unknown', ambiguous: true, action: 'restart' } } },
        { response: { status: 504, data: { error: 'action_result_unknown', ambiguous: false, action: 'restart' } } },
        { response: { status: 504, data: { error: 'docker_timeout', ambiguous: true, action: 'restart' } } },
        { response: { status: 504, data: { error: 'action_result_unknown', ambiguous: true, action: 'delete' } } }
    ]) assert.equal(ambiguousDockerActionResult(error, 'restart'), null);
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ERR_NETWORK']) {
        assert.deepEqual(ambiguousDockerActionResult({ code }, 'stop'), {
            error: 'action_result_unknown', ambiguous: true, action: 'stop'
        });
        assert.equal(
            ambiguousDockerActionResult({ code }, 'stop', { submitted: false }),
            null,
            'an inventory failure occurs before the Docker action is submitted'
        );
    }
    assert.equal(ambiguousDockerActionResult({ code: 'ECONNREFUSED' }, 'stop'), null);
});

'use strict';

const DOCKER_ACTIONS = Object.freeze(['start', 'stop', 'restart']);
const ACTION_SET = new Set(DOCKER_ACTIONS);
// Docker's canonical container ID representation, and the NAS monitor broker's
// accepted request form, is exactly 64 lower-case hexadecimal characters.
const CANONICAL_CONTAINER_ID = /^[a-f0-9]{64}$/u;

class DockerActionPolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DockerActionPolicyError';
        this.code = code;
    }
}

function containersFromPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.containers)) return payload.containers;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.data?.containers)) return payload.data.containers;
    return [];
}

function normalizedAllowedActions(container, { allowLegacy = false } = {}) {
    if (!container || typeof container !== 'object') return [];
    if (!Object.prototype.hasOwnProperty.call(container, 'allowed_actions')) {
        return allowLegacy ? [...DOCKER_ACTIONS] : [];
    }
    if (!Array.isArray(container.allowed_actions)) return [];
    return [...new Set(container.allowed_actions.filter(action => ACTION_SET.has(action)))];
}

function isCanonicalDockerContainerId(value) {
    return typeof value === 'string' && CANONICAL_CONTAINER_ID.test(value);
}

function ambiguousDockerActionResult(error, expectedAction, { submitted = true } = {}) {
    if (submitted !== true) return null;
    const status = error?.response?.status;
    const data = error?.response?.data;
    if (status === 504 && data && typeof data === 'object' && !Array.isArray(data)
        && data.error === 'action_result_unknown' && data.ambiguous === true
        && ACTION_SET.has(data.action) && (!expectedAction || data.action === expectedAction)) {
        return Object.freeze({ error: 'action_result_unknown', ambiguous: true, action: data.action });
    }
    const transportCodes = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ERR_NETWORK']);
    if (!error?.response && ACTION_SET.has(expectedAction) && transportCodes.has(error?.code)) {
        return Object.freeze({ error: 'action_result_unknown', ambiguous: true, action: expectedAction });
    }
    return null;
}

function selectDockerActionTarget(payload, requestedId, action, options = {}) {
    if (!isCanonicalDockerContainerId(requestedId)) {
        throw new DockerActionPolicyError('DOCKER_TARGET_INVALID', 'Docker target identifier is invalid');
    }
    if (!ACTION_SET.has(action)) {
        throw new DockerActionPolicyError('DOCKER_ACTION_INVALID', 'Docker action is invalid');
    }
    const targets = containersFromPayload(payload).filter(container =>
        container
        && typeof container === 'object'
        && isCanonicalDockerContainerId(container.id)
        && container.id === requestedId);
    if (targets.length !== 1) {
        throw new DockerActionPolicyError('DOCKER_TARGET_NOT_FOUND', 'Docker target was not found by canonical identifier');
    }
    const target = targets[0];
    if (!normalizedAllowedActions(target, options).includes(action)) {
        throw new DockerActionPolicyError('DOCKER_ACTION_NOT_ALLOWED', 'Docker action is not allowed for this target');
    }
    return { id: target.id, name: typeof target.name === 'string' ? target.name : target.id, action };
}

module.exports = {
    DOCKER_ACTIONS,
    DockerActionPolicyError,
    ambiguousDockerActionResult,
    containersFromPayload,
    isCanonicalDockerContainerId,
    normalizedAllowedActions,
    selectDockerActionTarget
};

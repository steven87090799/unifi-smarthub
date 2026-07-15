'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const mainDockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const monitorDockerfile = fs.readFileSync(path.join(ROOT, 'nas-monitor', 'Dockerfile'), 'utf8');
const monitorServer = fs.readFileSync(path.join(ROOT, 'nas-monitor', 'server.js'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');

test('Compose keeps the privileged monitor optional and cannot gate main startup', () => {
    assert.match(compose, /nas-monitor:\n\s+profiles: \["nas-monitor"\]/);
    assert.doesNotMatch(compose, /depends_on:/);
    assert.doesNotMatch(compose, /container_name:/);
    assert.match(compose, /stop_grace_period: 20s/g);
    assert.doesNotMatch(compose, /smarthub-local-monitor/);
});

test('main runtime mounts one dedicated config directory and snapshots the broker trust tuple', () => {
    const mainService = compose.slice(compose.indexOf('  unifi-smarthub:'), compose.indexOf('\n  nas-monitor:'));
    assert.doesNotMatch(mainService, /\n\s+env_file:/);
    assert.match(mainService, /SMARTHUB_ENV_FILE=\/app\/config\/\.env/);
    assert.match(mainService, /source: \$\{SMARTHUB_CONFIG_DIR:-\.\/config\}/);
    assert.match(mainService, /target: \/app\/config/);
    assert.doesNotMatch(mainService, /target: \/app\/\.env/);
    assert.match(mainService, /create_host_path: false/);
    for (const key of ['URL', 'API_KEY', 'MODE']) {
        assert.match(mainService, new RegExp(`NAS_MONITOR_${key}=\\$\\{NAS_MONITOR_${key}:-`));
    }
});

test('container health is readiness-based with bounded shutdown', () => {
    assert.match(mainDockerfile, /\/health\/ready/);
    assert.doesNotMatch(mainDockerfile, /127\.0\.0\.1:3000\/health['"]/);
    assert.match(mainDockerfile, /STOPSIGNAL SIGTERM/);
    assert.match(mainDockerfile, /setTimeout\(4000/);
});

test('monitor image and Compose apply defense-in-depth around host-root socket authority', () => {
    assert.match(monitorDockerfile, /ENTRYPOINT \["\/sbin\/tini", "--"\]/);
    assert.match(monitorDockerfile, /USER node/);
    for (const fragment of [
        'read_only: true',
        'cap_drop:',
        'no-new-privileges:true',
        'pids_limit: 64',
        'internal: true',
        'NAS_MONITOR_MUTATIONS_ENABLED=${NAS_MONITOR_MUTATIONS_ENABLED:-false}',
        'NAS_MONITOR_LOGS_ENABLED=${NAS_MONITOR_LOGS_ENABLED:-false}',
        'com.unifi.smarthub.nas-monitor.protected=true'
    ]) assert.ok(compose.includes(fragment), `missing ${fragment}`);
});

test('release images carry OCI source identity and build context excludes non-runtime state', () => {
    for (const dockerfile of [mainDockerfile, monitorDockerfile]) {
        assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$\{BUILD_REVISION\}/);
        assert.match(dockerfile, /io\.smarthub\.build\.dirty=\$\{BUILD_DIRTY\}/);
    }
    const monitorService = compose.slice(compose.indexOf('  nas-monitor:'));
    assert.doesNotMatch(monitorService, /- BUILD_(?:VERSION|REVISION|CREATED|DIRTY)=/);
    for (const excluded of ['.production-verification', 'config', 'test', 'nas-monitor']) {
        assert.match(dockerignore, new RegExp(`^${excluded.replace('.', '\\.')}\\s*$`, 'm'));
    }
    assert.match(monitorDockerfile, /BUILD_IDENTITY_REQUIRED/);
    assert.match(monitorDockerfile, /createRuntimeBuildIdentity\(process\.env\)/);
    assert.match(monitorServer, /build:\s*buildIdentity/);
    assert.match(monitorServer, /event:\s*'nas_monitor_started'/);
});

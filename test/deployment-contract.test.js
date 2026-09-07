'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const buildCompose = fs.readFileSync(path.join(ROOT, 'docker-compose.build.yml'), 'utf8');
const updater = fs.readFileSync(path.join(ROOT, 'scripts', 'update-nas.sh'), 'utf8');
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

test('runtime Compose is registry-only and local builds require an explicit overlay', () => {
    const mainService = compose.slice(compose.indexOf('  unifi-smarthub:'), compose.indexOf('\n  nas-monitor:'));
    const monitorService = compose.slice(compose.indexOf('  nas-monitor:'));
    assert.doesNotMatch(compose, /\n\s+build:/u);
    assert.match(mainService, /image: \$\{SMARTHUB_IMAGE:-\$\{SMARTHUB_IMAGE_REPOSITORY:-ghcr\.io\/steven87090799\/unifi-smarthub\}:\$\{SMARTHUB_IMAGE_TAG:-stable\}\}/u);
    assert.match(monitorService, /image: \$\{NAS_MONITOR_IMAGE:-\$\{NAS_MONITOR_IMAGE_REPOSITORY:-ghcr\.io\/steven87090799\/unifi-smarthub-nas-monitor\}:\$\{SMARTHUB_IMAGE_TAG:-stable\}\}/u);
    assert.match(buildCompose, /unifi-smarthub:\n\s+build:/u);
    assert.match(buildCompose, /nas-monitor:\n\s+build:/u);
    assert.match(buildCompose, /image: unifi-smarthub:dev/u);
    assert.match(buildCompose, /image: unifi-smarthub-nas-monitor:dev/u);
});

test('NAS updater pulls before preflight and never builds or deletes the data volume', () => {
    assert.match(updater, /--tag IMAGE_TAG/u);
    assert.match(updater, /SMARTHUB_IMAGE_TAG=/u);
    assert.match(updater, /compose config --quiet/u);
    assert.match(updater, /compose pull/u);
    assert.match(updater, /production-preflight\.js --offline/u);
    assert.match(updater, /compose up -d --no-build --pull never/u);
    assert.match(updater, /--profile nas-monitor/u);
    assert.match(updater, /Refusing --initialize because smarthub\.db already exists/u);
    assert.match(updater, /CURRENT_DATA_VOLUME/u);
    assert.match(updater, /Destination "\/app\/data"/u);
    assert.match(updater, /Data volume changed/u);
    assert.match(updater, /Refusing --initialize while an existing SmartHub container is present/u);
    assert.doesNotMatch(updater, /down\s+-v/u);
    assert.ok(updater.indexOf('compose pull') < updater.indexOf('production-preflight.js --offline'));
    assert.ok(updater.indexOf('production-preflight.js --offline') < updater.indexOf('compose up -d --no-build --pull never'));
});

test('runtime data and deployment config stay outside the replaceable image', () => {
    const mainService = compose.slice(compose.indexOf('  unifi-smarthub:'), compose.indexOf('\n  nas-monitor:'));
    assert.match(mainService, /- smarthub-data:\/app\/data/u);
    assert.match(mainService, /source: \$\{SMARTHUB_CONFIG_DIR:-\.\/config\}/u);
    assert.match(mainService, /target: \/app\/config/u);
    assert.match(updater, /compose up -d --no-build --pull never/u);
    assert.doesNotMatch(updater, /docker compose[\s\S]*down/u);
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
    assert.match(mainService, /\$\{SMARTHUB_HOST_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{SMARTHUB_HOST_PORT:-3000\}:3000/u);
    assert.match(mainService, /SMARTHUB_BIND_ADDRESS=0\.0\.0\.0/u);
    assert.match(mainService, /user: "1000:1000"/u);
    assert.match(mainService, /read_only: true/u);
    assert.match(mainService, /SMARTHUB_ENV_FILE=\/app\/config\/\.env/u);
});

test('production preflight is part of the fixed UID deployment contract', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const packageJson = require('../package.json');
    assert.equal(packageJson.scripts['preflight:production'], 'node scripts/production-preflight.js');
    assert.match(readme, /UID\/GID `?1000:1000/u);
    assert.match(readme, /production preflight/u);
    assert.match(readme, /chmod `?777.*`?666/u);
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

test('release identity metadata cannot invalidate stable dependency or payload layers', () => {
    const mainIdentity = mainDockerfile.indexOf('ARG BUILD_VERSION');
    assert.ok(mainIdentity > mainDockerfile.indexOf('npm ci --omit=dev'));
    assert.ok(mainIdentity > mainDockerfile.indexOf('COPY . .'));

    const monitorIdentity = monitorDockerfile.indexOf('ARG BUILD_VERSION');
    assert.ok(monitorIdentity > monitorDockerfile.indexOf('apk add --no-cache tini='));
    assert.ok(monitorIdentity > monitorDockerfile.indexOf('COPY --chown=node:node build-identity.js'));
});

test('Docker package inputs are explicitly versioned for the pinned Alpine base', () => {
    for (const fragment of ['tini=0.19.0-r3', 'nut=2.8.3-r4', 'libcrypto3=3.5.8-r0', 'libssl3=3.5.8-r0', 'tzdata=2026c-r0']) {
        assert.ok(mainDockerfile.includes(fragment), `missing ${fragment}`);
    }
    for (const fragment of ['python3=3.14.7-r1', 'make=4.4.1-r4', 'g++=15.2.0-r5']) {
        assert.ok(mainDockerfile.includes(fragment), `missing ${fragment}`);
    }
    for (const fragment of ['tini=0.19.0-r3', 'libcrypto3=3.5.8-r0', 'libssl3=3.5.8-r0']) {
        assert.ok(monitorDockerfile.includes(fragment), `missing monitor ${fragment}`);
    }
});

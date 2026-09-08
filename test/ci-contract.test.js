'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('GitHub Actions CI is a bounded required-check candidate with all repository gates', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const scope = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-scope.js'), 'utf8');
    const audit = fs.readFileSync(path.join(ROOT, 'docs', 'reports', 'PRODUCTION_FINALIZATION_AUDIT.md'), 'utf8');
    assert.match(workflow, /pull_request:/u);
    assert.match(workflow, /workflow_dispatch:/u);
    assert.match(workflow, /schedule:\s*\n\s*- cron:/u);
    assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*-\s*main/u);
    assert.match(workflow, /contents:\s*read/u);
    assert.match(workflow, /timeout-minutes:/u);
    assert.match(workflow, /npm ci/u);
    assert.match(workflow, /npm test/u);
    assert.match(workflow, /npm run check:css/u);
    assert.match(workflow, /npm run check:js/u);
    assert.match(workflow, /npm audit --audit-level=low/u);
    assert.match(workflow, /docker compose[\s\S]+config --quiet/u);
    assert.match(workflow, /docker compose[\s\S]+build unifi-smarthub/u);
    assert.match(workflow, /uses:\s*actions\/checkout@[0-9a-f]{40}\s+# v7/u);
    assert.match(workflow, /fetch-depth:\s*0/u);
    assert.match(workflow, /Determine validation scope/u);
    assert.match(workflow, /scripts\/ci-scope\.js/u);
    assert.match(workflow, /Scan current tree and selected Git history for secrets/u);
    assert.match(workflow, /gitleaks.*dir/u);
    assert.match(workflow, /gitleaks.*git/u);
    assert.match(workflow, /GITLEAKS_SHA256:\s*[0-9a-f]{64}/u);
    assert.match(workflow, /--redact/u);
    assert.match(workflow, /--exit-code 1/u);
    assert.match(workflow, /uses:\s*actions\/setup-node@[0-9a-f]{40}\s+# v7/u);
    assert.match(workflow, /node-version-file:\s*\.nvmrc/u);
    assert.match(workflow, /Generate SBOM and scan built images/u);
    assert.match(workflow, /trivy@sha256:[0-9a-f]{64}/u);
    assert.match(workflow, /image --format json --output "[^"]+\.trivy\.json" --severity HIGH,CRITICAL/u);
    assert.match(workflow, /image --exit-code 1 --severity HIGH,CRITICAL/u);
    assert.doesNotMatch(workflow, /--ignore-unfixed/u);
    assert.match(workflow, /Run isolated production preflight/u);
    assert.match(workflow, /scripts\/production-preflight\.js/u);
    assert.match(workflow, /scripts\/production-preflight\.js --offline/u);
    assert.match(workflow, /Initialize isolated SQLite volume for preflight/u);
    assert.match(workflow, /Generate exact-head release evidence/u);
    assert.match(workflow, /smartHub_image_id: process\.env\.SMART_HUB_IMAGE_ID/u);
    assert.match(workflow, /nas_monitor_image_id: process\.env\.NAS_MONITOR_IMAGE_ID/u);
    assert.match(workflow, /Validate release evidence/u);
    assert.match(workflow, /release-evidence\.json/u);
    assert.match(workflow, /RELEASE_HEAD_SHA="\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}"/u);
    assert.match(workflow, /head_sha: process\.env\.RELEASE_HEAD_SHA/u);
    assert.match(workflow, /trivy_blocking_policy: 'HIGH,CRITICAL including unfixed'/u);
    assert.match(workflow, /uses:\s*actions\/upload-artifact@[0-9a-f]{40}\s+# v7\.0\.1/u);
    assert.match(workflow, /name: smarthub-release-evidence-\$\{\{ github\.run_id \}\}/u);
    assert.match(workflow, /Upload SBOM and vulnerability reports/u);
    assert.doesNotMatch(audit, /^FINAL_HEAD=/mu);
    assert.doesNotMatch(audit, /^EXACT_HEAD=/mu);
    assert.doesNotMatch(audit, /^HOSTED_CI_RUN=/mu);
    assert.match(workflow, /SOAK_TEST_DURATION_MS=90000 SOAK_TEST_TICK_MS=20 npm run test:soak/u);
    assert.match(workflow, /RUNTIME_SMOKE_BASE_URL=http:\/\/127\.0\.0\.1:3000 npm run test:smoke/u);
    assert.match(workflow, /docker compose[\s\S]+up -d --no-build unifi-smarthub/u);
    assert.match(workflow, /docker compose[\s\S]+restart unifi-smarthub/u);
    assert.match(workflow, /down --volumes --remove-orphans/u);
    assert.match(workflow, /git diff --check/u);
    assert.match(workflow, /name: smarthub-ci-diagnostics-\$\{\{ github\.run_id \}\}/u);
    const evidence = workflow.slice(workflow.indexOf('- name: Generate exact-head release evidence'), workflow.indexOf('- name: Validate release evidence'));
    const validation = workflow.slice(workflow.indexOf('- name: Validate release evidence'), workflow.indexOf('- name: Upload SBOM and vulnerability reports'));
    const upload = workflow.slice(workflow.indexOf('- name: Upload SBOM and vulnerability reports'), workflow.indexOf('- name: Capture CI diagnostics on failure'));
    assert.match(evidence, /if: success\(\)/u);
    assert.match(validation, /if: success\(\)/u);
    assert.match(upload, /if: success\(\)/u);
    assert.doesNotMatch(evidence, /if: always\(\)/u);
    assert.ok(workflow.indexOf('Verify repository hygiene') < workflow.indexOf('Generate exact-head release evidence'));
    assert.ok(workflow.indexOf('Initialize isolated SQLite volume for preflight')
        < workflow.indexOf('Run isolated production preflight'));
    assert.ok(workflow.indexOf('Generate exact-head release evidence') < workflow.indexOf('Validate release evidence'));
    assert.ok(workflow.indexOf('Validate release evidence') < workflow.indexOf('Upload SBOM and vulnerability reports'));
    assert.match(scope, /run_history_secret_scan/u);
});

test('Gitleaks allowlist is explicit and limited to deterministic fixture values', () => {
    const config = fs.readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8');
    assert.match(config, /^\[allowlist\]/mu);
    for (const fixture of [
        '^0123456789abcdef0123456789abcdef$',
        '^1234567890abcdef$',
        '^fedcba0987654321$'
    ]) assert.match(config, new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    assert.doesNotMatch(config, /paths\s*=|test\/\.\*/u);
});

test('isolated production container smoke is a bounded blocking gate after image build', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const smokeStep = workflow.match(
        /- name: Run isolated production container runtime smoke test[\s\S]*?(?=\n\s+- name:|\s*$)/u
    );
    assert.ok(smokeStep, 'runtime smoke step is required');
    assert.match(smokeStep[0], /RUNTIME_SMOKE_BASE_URL=http:\/\/127\.0\.0\.1:3000 npm run test:smoke/u);
    assert.match(smokeStep[0], /CI_PANEL_REQUIRE_HTTPS=false/u);
    assert.match(smokeStep[0], /CI_PANEL_ALLOW_INSECURE_HTTP=false/u);
    assert.match(smokeStep[0], /timeout-minutes:\s*5/u);
    assert.doesNotMatch(smokeStep[0], /continue-on-error/u);
    assert.ok(workflow.indexOf('npm run test:smoke') > workflow.indexOf('npm test'));
    assert.ok(workflow.indexOf('npm run test:smoke') > workflow.indexOf('build unifi-smarthub'));
    assert.doesNotMatch(workflow, /ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/u);
});

test('successful main CI publishes private GHCR images from the exact CI head', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish-ghcr.yml'), 'utf8');
    assert.match(workflow, /workflow_run:/u);
    assert.match(workflow, /workflows:\s*\n\s*- SmartHub CI/u);
    assert.match(workflow, /conclusion == 'success'/u);
    assert.match(workflow, /workflow_run\.event == 'push'/u);
    assert.match(workflow, /actions\/runs\/\$\{SOURCE_RUN_ID\}\/artifacts/u);
    assert.match(workflow, /Skip unchanged runtime publication/u);
    assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
    assert.match(workflow, /fetch-depth: 0/u);
    assert.match(workflow, /git tag --points-at "\$REVISION"/u);
    assert.match(workflow, /packages:\s*write/u);
    assert.match(workflow, /registry: \$\{\{ env\.REGISTRY \}\}/u);
    assert.match(workflow, /secrets\.GITHUB_TOKEN/u);
    assert.match(workflow, /:sha-\$REVISION/u);
    assert.match(workflow, /release_tag=stable/u);
    assert.match(workflow, /\$MAIN_IMAGE:\$release_tag/u);
    assert.match(workflow, /\$MONITOR_IMAGE:\$release_tag/u);
    assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/u);
    assert.match(workflow, /BUILD_IDENTITY_REQUIRED=true/u);
    assert.match(workflow, /provenance: true/u);
    assert.match(workflow, /sbom: true/u);
    assert.match(workflow, /Scan exact published multi-arch image digests/u);
    assert.match(workflow, /steps\.build-main\.outputs\.digest/u);
    assert.match(workflow, /steps\.build-monitor\.outputs\.digest/u);
    assert.match(workflow, /docker pull --platform "\$platform" "\$reference"/u);
    assert.match(workflow, /image --exit-code 1 --severity HIGH,CRITICAL/u);
    assert.match(workflow, /smarthub-published-image-evidence-\$\{\{ github\.run_id \}\}/u);
    assert.match(workflow, /attestations:\s*write/u);
    assert.match(workflow, /id-token:\s*write/u);
    assert.match(workflow, /uses:\s*docker\/setup-buildx-action@[0-9a-f]{40}\s+# v3\.11\.1/u);
    assert.match(workflow, /uses:\s*docker\/login-action@[0-9a-f]{40}\s+# v3\.4\.0/u);
    assert.match(workflow, /uses:\s*docker\/build-push-action@[0-9a-f]{40}\s+# v6\.18\.0/u);
    assert.match(workflow, /if: steps\.publish-scope\.outputs\.run_runtime == 'true'/u);
});

test('JavaScript syntax checker discovers source files and applies bounded exclusions', () => {
    const checker = fs.readFileSync(path.join(ROOT, 'scripts', 'check-js-syntax.js'), 'utf8');
    assert.match(checker, /node_modules/u);
    assert.match(checker, /\.production-verification/u);
    assert.match(checker, /node --check|--check/u);
    const packageJson = require('../package.json');
    assert.equal(packageJson.scripts['check:js'], 'node scripts/check-js-syntax.js');
});

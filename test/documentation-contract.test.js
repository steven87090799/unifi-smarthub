'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('production documentation points operators to the immutable paired-image release contract', () => {
    const readme = read('README.md');
    const checklist = read('docs/operations/PRODUCTION-RELEASE-CHECKLIST.md');
    const envExample = read('.env.example');

    assert.match(readme, /docs\/operations\/PRODUCTION-RELEASE-CHECKLIST\.md/);
    assert.match(checklist, /npm run release:build/);
    assert.match(checklist, /SMARTHUB_IMAGE=unifi-smarthub:<12-char-revision>/);
    assert.match(checklist, /NAS_MONITOR_IMAGE=unifi-smarthub-nas-monitor:<12-char-revision>/);
    assert.match(checklist, /up -d --no-build --pull never/);
    assert.match(checklist, /docker compose --env-file config\/\.env config --quiet/);
    assert.match(checklist, /--profile nas-monitor config --quiet/);
    assert.match(envExample, /SMARTHUB_IMAGE=unifi-smarthub:0123456789ab/);
    assert.match(envExample, /NAS_MONITOR_IMAGE=unifi-smarthub-nas-monitor:0123456789ab/);
});

test('operator documentation does not restore superseded deployment authorities', () => {
    const observability = read('docs/operations/OBSERVABILITY.md');
    const releaseNotes = read('docs/reports/RELEASE-NOTES-v3.0.md');
    const architecture = read('docs/ARCHITECTURE.md');

    assert.doesNotMatch(observability, /Tailwind CDN/);
    assert.doesNotMatch(observability, /Docker \| 單一 `unifi-smarthub` service/);
    assert.doesNotMatch(releaseNotes, /docker compose up -d --build --force-recreate/);
    assert.doesNotMatch(architecture, /data\/trend-history\.json/);
    assert.doesNotMatch(architecture, /只引用 CDN 提供的 TailwindCSS/);
    assert.match(architecture, /不列完整 endpoint/);
});

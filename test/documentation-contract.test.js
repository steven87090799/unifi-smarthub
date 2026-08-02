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
    assert.match(readme, /SMARTHUB_INTERNET_PROXY_MODE/u);
    assert.match(readme, /sudo install -d -o 1000 -g 1000 -m 700 config/u);
    assert.match(readme, /production-preflight/u);
    assert.match(checklist, /Host-native Caddy\/Nginx/u);
    assert.match(checklist, /Dockerized Caddy\/Nginx/u);
    assert.match(checklist, /PANEL_TRUSTED_PROXIES/u);
});

test('operator documentation does not restore superseded deployment authorities', () => {
    const observability = read('docs/operations/OBSERVABILITY.md');
    const releaseNotes = read('docs/reports/RELEASE-NOTES-v3.0.md');
    const architecture = read('docs/reference/architecture.md');

    assert.doesNotMatch(observability, /Tailwind CDN/);
    assert.doesNotMatch(observability, /Docker \| 單一 `unifi-smarthub` service/);
    assert.doesNotMatch(releaseNotes, /docker compose up -d --build --force-recreate/);
    assert.doesNotMatch(architecture, /data\/trend-history\.json/);
    assert.doesNotMatch(architecture, /只引用 CDN 提供的 TailwindCSS/);
    assert.match(architecture, /不列完整 endpoint/);
});

function markdownFiles(relativeDir = '') {
    const directory = path.join(ROOT, relativeDir);
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const relativePath = path.posix.join(relativeDir, entry.name);
        if (entry.isDirectory()) {
            if (new Set(['.git', '.codex', '.production-verification', 'config', 'data', 'node_modules']).has(entry.name)) return [];
            return markdownFiles(relativePath);
        }
        return entry.isFile() && entry.name.endsWith('.md') ? [relativePath] : [];
    });
}

test('the complete operation manual links every maintained Markdown file', () => {
    const manual = read('SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html');
    const expected = markdownFiles().sort();
    const indexed = [...manual.matchAll(/data-doc-path="([^"]+)"/gu)].map(match => match[1]).sort();

    assert.deepEqual(indexed, expected);
    for (const file of expected) {
        assert.match(manual, new RegExp(`data-doc-path="${file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}" href="${file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'));
    }
});

test('Claude Code keeps a thin auto-loaded project entrypoint', () => {
    const claude = read('CLAUDE.md');

    assert.match(claude, /@AGENTS\.md/u);
    assert.match(claude, /@CONTEXT\.md/u);
    assert.match(claude, /@docs\/reference\/backend-map\.md/u);
    assert.match(claude, /@docs\/reference\/frontend-map\.md/u);
    assert.doesNotMatch(claude, /SERVER-MAP\.md|FRONTEND-MAP\.md|docs\/ARCHITECTURE\.md/u);
});

test('the operation manual matches the enforced production gates', () => {
    const manual = read('SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html');

    assert.match(manual, /npm ci/u);
    assert.match(manual, /npm run check:js/u);
    assert.match(manual, /npm test/u);
    assert.match(manual, /npm run check:css/u);
    assert.match(manual, /npm run test:smoke/u);
    assert.match(manual, /npm audit --audit-level=low/u);
    assert.match(manual, /docker compose --env-file config\/\.env build unifi-smarthub/u);
    assert.match(manual, /--profile nas-monitor build/u);
    assert.match(manual, /production-preflight/u);
    assert.match(manual, /SMARTHUB_INTERNET_PROXY_MODE/u);
    assert.doesNotMatch(manual, /npm audit --audit-level=high/u);
});

test('the manual chapter directory gives every chapter a summary and Markdown reference', () => {
    const manual = read('SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html');
    const chapterIds = [...manual.matchAll(/<section id="([^"]+)">/gu)].map(match => match[1]);
    const toc = manual.match(/<nav class="toc"[^>]*>([\s\S]*?)<\/nav>/u)?.[1] || '';

    assert.match(manual, /color-scheme:dark/u);
    assert.equal((toc.match(/class="toc-title"/gu) || []).length, chapterIds.length);
    assert.equal((toc.match(/class="toc-summary"/gu) || []).length, chapterIds.length);
    assert.equal((toc.match(/class="toc-ref"/gu) || []).length, chapterIds.length);

    for (const chapterId of chapterIds) {
        assert.match(toc, new RegExp(`href="#${chapterId}"`, 'u'));
    }
});

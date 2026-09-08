'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
    assert.match(checklist, /SMARTHUB_IMAGE=ghcr\.io\/steven87090799\/unifi-smarthub@sha256:<digest>/);
    assert.match(checklist, /NAS_MONITOR_IMAGE=ghcr\.io\/steven87090799\/unifi-smarthub-nas-monitor@sha256:<digest>/);
    assert.match(checklist, /up -d --no-build --pull never/);
    assert.match(checklist, /docker-compose\.build\.yml config --quiet/);
    assert.match(checklist, /--profile nas-monitor config --quiet/);
    assert.match(envExample, /SMARTHUB_IMAGE_REPOSITORY=ghcr\.io\/steven87090799\/unifi-smarthub/);
    assert.match(envExample, /NAS_MONITOR_IMAGE_REPOSITORY=ghcr\.io\/steven87090799\/unifi-smarthub-nas-monitor/);
    assert.match(envExample, /SMARTHUB_IMAGE_TAG=stable/);
    assert.match(readme, /scripts\/update-nas\.sh/);
    assert.match(readme, /scripts\/update-nas\.sh --tag v3\.0\.1/);
    assert.match(checklist, /scripts\/update-nas\.sh --tag v3\.0\.1/);
    assert.match(checklist, /publish-ghcr\.yml/);
    assert.match(readme, /SMARTHUB_INTERNET_PROXY_MODE/u);
    assert.match(readme, /sudo install -d -o 1000 -g 1000 -m 700 config/u);
    assert.match(readme, /production-preflight/u);
    const historyDbInitializer = /node -e "const \{ createHistoryDb \} = require\('\.\/db'\); const db = createHistoryDb\(process\.env\.DATA_DIR\); db\.close\(\);"/u;
    assert.match(readme, historyDbInitializer);
    assert.match(checklist, historyDbInitializer);
    assert.match(checklist, /既有資料庫跳過且不可覆蓋/u);
    const readmeBuild = readme.indexOf('docker-compose.build.yml build unifi-smarthub');
    const readmeInitialize = readme.indexOf('createHistoryDb');
    const readmePreflight = readme.indexOf('production-preflight.js --offline');
    const readmeStart = readme.indexOf('docker-compose.build.yml up -d --no-build --pull never');
    assert.ok(readmeBuild < readmeInitialize && readmeInitialize < readmePreflight && readmePreflight < readmeStart);
    const checklistBuild = checklist.indexOf('docker-compose.build.yml build unifi-smarthub');
    const checklistInitialize = checklist.indexOf('node -e "const { createHistoryDb }');
    const checklistPreflight = checklist.indexOf('production-preflight.js --offline');
    const checklistStart = checklist.indexOf('docker-compose.build.yml up -d --no-build --pull never');
    assert.ok(checklistBuild < checklistInitialize && checklistInitialize < checklistPreflight && checklistPreflight < checklistStart);
    assert.ok(checklist.indexOf('production-preflight.js --offline')
        < checklist.indexOf('up -d --no-build --pull never'));
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

test('Claude Code keeps a single low-context auto-loaded project entrypoint', () => {
    const claude = read('CLAUDE.md');

    assert.match(claude, /唯一 AI 初始入口/u);
    assert.match(claude, /CONTEXT\.md/u);
    assert.match(claude, /docs\/reference\/backend-map\.md/u);
    assert.match(claude, /docs\/reference\/frontend-map\.md/u);
    assert.match(claude, /git status --short --branch/u);
    assert.match(claude, /rg -n/u);
    assert.match(claude, /server-mock\.js/u);
    assert.match(claude, /public\/js\/app\.js/u);
    assert.match(claude, /100 KiB/u);
    assert.match(claude, /PRODUCTION-RELEASE-CHECKLIST\.md/u);
    assert.doesNotMatch(claude, /^@(?:AGENTS|CONTEXT|docs\/)/mu);
    assert.doesNotMatch(claude, /SERVER-MAP\.md|FRONTEND-MAP\.md|docs\/ARCHITECTURE\.md/u);
});

function ignorePatternMatches(pattern, file) {
    if (pattern.endsWith('/')) return file === pattern.slice(0, -1) || file.startsWith(pattern);
    if (!pattern.includes('*')) return file === pattern;
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\*/gu, '.*');
    return new RegExp(`^${escaped}$`, 'u').test(file);
}

test('AI ignore entrypoints stay synchronized and cover large tracked files', () => {
    const codexIgnore = read('.codexignore');
    const claudeIgnore = read('.claudeignore');
    assert.equal(claudeIgnore, codexIgnore);
    assert.match(codexIgnore, /^public\/js\/app\.js$/mu);
    assert.match(codexIgnore, /^SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW\.html$/mu);

    const patterns = codexIgnore.split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
    const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
        .toString('utf8').split('\0').filter(Boolean);
    const largeFiles = trackedFiles.filter(file => fs.statSync(path.join(ROOT, file)).size > 100 * 1024);

    for (const file of largeFiles) {
        assert.ok(patterns.some(pattern => ignorePatternMatches(pattern, file)), `${file} is not excluded from AI context`);
    }
});

test('the operation manual matches the enforced production gates', () => {
    const manual = read('SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html');

    assert.match(manual, /npm ci/u);
    assert.match(manual, /npm run check:js/u);
    assert.match(manual, /npm test/u);
    assert.match(manual, /npm run check:css/u);
    assert.match(manual, /npm run test:smoke/u);
    assert.match(manual, /npm audit --audit-level=low/u);
    assert.match(manual, /docker compose --env-file config\/\.env -f docker-compose\.yml -f docker-compose\.build\.yml build unifi-smarthub/u);
    assert.match(manual, /--profile nas-monitor build/u);
    assert.match(manual, /production-preflight/u);
    assert.match(manual, /fetchHealth/u);
    assert.match(manual, /configGeneration/u);
    assert.match(manual, /scripts\/update-nas\.sh/u);
    assert.match(manual, /read:packages/u);
    assert.ok(manual.indexOf('docker compose --env-file config/.env -f docker-compose.yml -f docker-compose.build.yml build unifi-smarthub')
        < manual.indexOf('production-preflight.js --offline'));
    assert.ok(manual.indexOf('production-preflight.js --offline')
        < manual.indexOf('up -d --no-build --pull never'));
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

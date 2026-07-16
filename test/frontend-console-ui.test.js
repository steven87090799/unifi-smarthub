const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const consoleCss = fs.readFileSync(path.join(root, 'frontend', 'console.css'), 'utf8');
const cssBuild = fs.readFileSync(path.join(root, 'scripts', 'build-frontend-css.js'), 'utf8');

test('authenticated console bundles its visual layer into the existing stylesheet request', () => {
    assert.doesNotMatch(html, /\/assets\/console\.css/u);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/tailwind\.css">/u);
    assert.match(cssBuild, /CONSOLE_SOURCE/u);
    assert.match(cssBuild, /appendFileSync\(destination/u);
    assert.doesNotMatch(consoleCss, /@import/u);
    assert.doesNotMatch(consoleCss, /url\((['"]?)https?:\/\//u);
});

test('console design system exposes the complete shared visual token contract', () => {
    for (const token of [
        'background-primary', 'background-secondary', 'background-elevated',
        'surface-glass', 'surface-solid', 'border-subtle', 'border-active',
        'text-primary', 'text-secondary', 'text-muted', 'accent-primary',
        'accent-secondary', 'status-operational', 'status-warning',
        'status-critical', 'status-unknown', 'focus-ring', 'overlay'
    ]) {
        assert.match(consoleCss, new RegExp(`--${token}:`));
    }
    assert.match(consoleCss, /@media \(prefers-reduced-motion: reduce\)/u);
    assert.match(consoleCss, /@media \(forced-colors: active\)/u);
    assert.match(consoleCss, /min-width: 320px/u);
});

test('all existing authenticated pages and navigation targets remain present and ordered', () => {
    const expected = [
        'overview', 'clients', 'security', 'wifi', 'cloud', 'ucg', 'nas',
        'wiim', 'ups', 'adguard', 'linuxhost', 'tools', 'notify', 'settings'
    ];
    const navigation = [...html.matchAll(/<button data-page="([^"]+)"/gu)].map(match => match[1]);
    assert.deepEqual(navigation, expected);
    for (const page of expected) assert.match(html, new RegExp(`id="page-${page}"`));
});

test('desktop sidebar collapse is local-only and cannot add network traffic', () => {
    const collapseBlock = html.match(
        /function setSidebarCollapsed\(collapsed\) \{[\s\S]*?\n        \}\n\n        function toggleSidebarCollapse/u
    )?.[0] || '';
    assert.match(collapseBlock, /sidebarCollapsed\.v1/u);
    assert.doesNotMatch(collapseBlock, /fetch\(|persistUiPreference|\/api\//u);
    assert.match(html, /id="sidebar-collapse-toggle"/u);
});

test('dialogs retain Escape behavior and add focus trapping without changing modal actions', () => {
    assert.match(html, /function getDialogFocusable\(modal\)/u);
    assert.match(html, /function trapDialogFocus\(event, modal\)/u);
    assert.match(html, /event\.key === 'Tab' && openDialog/u);
    assert.match(html, /if \(!document\.getElementById\('client-modal'\)\.classList\.contains\('hidden'\)\) closeClientDetail\(\)/u);
    assert.match(html, /else if \(!document\.getElementById\('smart-modal'\)\.classList\.contains\('hidden'\)\) closeDiskSmart\(\)/u);
    assert.match(html, /else if \(!document\.getElementById\('docker-log-modal'\)\.classList\.contains\('hidden'\)\) closeDockerLog\(\)/u);
    assert.match(html, /returnFocus\.focus\(\{ preventScroll: true \}\)/u);
    assert.match(html, /sidebar\._returnFocus = trigger \|\| document\.activeElement/u);
});

test('responsive console keeps table overflow local and touch controls usable', () => {
    assert.match(consoleCss, /\.table-scroll-region \{[\s\S]*?overflow-x: auto/u);
    assert.match(consoleCss, /@media \(max-width: 767px\)[\s\S]*?main table \{[\s\S]*?min-width: 620px/u);
    assert.match(consoleCss, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?min-height: 44px/u);
    assert.match(consoleCss, /#crit-alert-banner:not\(\.hidden\)/u);
    assert.match(consoleCss, /\.topbar-actions > button:not\(#crit-alert-banner\)/u);
});

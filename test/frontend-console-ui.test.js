const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const source = html + '\n' + app;
const consoleCss = fs.readFileSync(path.join(root, 'frontend', 'console.css'), 'utf8');
const cssBuild = fs.readFileSync(path.join(root, 'scripts', 'build-frontend-css.js'), 'utf8');

test('authenticated console bundles its visual layer into the existing stylesheet request', () => {
    assert.doesNotMatch(html, /\/assets\/console\.css/u);
    assert.match(source, /<link rel="stylesheet" href="\/assets\/tailwind\.css">/u);
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
    for (const page of expected) assert.match(source, new RegExp(`id="page-${page}"`));
});

test('desktop sidebar collapse is local-only and cannot add network traffic', () => {
    const collapseBlock = app.match(
        /function setSidebarCollapsed\(collapsed\) \{[\s\S]*?\n        \}\n\n        function toggleSidebarCollapse/u
    )?.[0] || '';
    assert.match(collapseBlock, /sidebarCollapsed\.v1/u);
    assert.doesNotMatch(collapseBlock, /fetch\(|persistUiPreference|\/api\//u);
    assert.match(source, /id="sidebar-collapse-toggle"/u);
});

test('dialogs retain Escape behavior and add focus trapping without changing modal actions', () => {
    assert.match(source, /function getDialogFocusable\(modal\)/u);
    assert.match(source, /function trapDialogFocus\(event, modal\)/u);
    assert.match(source, /event\.key === 'Tab' && openDialog/u);
    assert.match(source, /if \(!document\.getElementById\('client-modal'\)\.classList\.contains\('hidden'\)\) closeClientDetail\(\)/u);
    assert.match(source, /else if \(!document\.getElementById\('smart-modal'\)\.classList\.contains\('hidden'\)\) closeDiskSmart\(\)/u);
    assert.match(source, /else if \(!document\.getElementById\('docker-log-modal'\)\.classList\.contains\('hidden'\)\) closeDockerLog\(\)/u);
    assert.match(source, /returnFocus\.focus\(\{ preventScroll: true \}\)/u);
    assert.match(source, /sidebar\._returnFocus = trigger \|\| document\.activeElement/u);
    assert.doesNotMatch(consoleCss, /body > \.flex/u);
    assert.match(consoleCss, /#app-shell \{[\s\S]*?position: relative/u);
});

test('responsive console keeps table overflow local and touch controls usable', () => {
    assert.match(consoleCss, /\.table-scroll-region \{[\s\S]*?overflow-x: auto/u);
    assert.match(consoleCss, /@media \(max-width: 767px\)[\s\S]*?main table \{[\s\S]*?min-width: 620px/u);
    assert.match(consoleCss, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?min-height: 44px/u);
    assert.match(consoleCss, /#crit-alert-banner:not\(\.hidden\)/u);
    assert.match(consoleCss, /\.topbar-actions > button:not\(#crit-alert-banner\)/u);
    assert.match(consoleCss, /#cloud-status-badge,\s*#cloud-status-badge-mobile,\s*#cloud-status-badge-sec \{[\s\S]*?height: 28px/u);
    assert.doesNotMatch(consoleCss, /#cloud-status-badge\.hidden \{[\s\S]*?display: none/u);
    assert.match(source, /id="cloud-status-badge-mobile"[\s\S]*?site-manager-mobile-badge/u);
    assert.match(source, /\['cloud-status-badge', 'cloud-status-badge-mobile', 'cloud-status-badge-sec'\]/u);
    assert.match(consoleCss, /@media \(max-width: 767px\)[\s\S]*?#cloud-status-badge \{[\s\S]*?display: none !important/u);
    assert.match(consoleCss, /@media \(max-width: 767px\)[\s\S]*?#cloud-status-badge-mobile\.site-manager-mobile-badge \{[\s\S]*?display: inline-flex !important/u);
    assert.match(consoleCss, /\[class\*="rounded-full"\]\[class\*="overflow-hidden"\]\[class\*="bg-slate-"\] \{[\s\S]*?border: 0 !important/u);
    assert.doesNotMatch(consoleCss, /border-color: currentColor !important/u);
    assert.match(consoleCss, /@keyframes console-ambient-sweep/u);
    assert.match(consoleCss, /@keyframes console-progress-sheen/u);
    assert.match(consoleCss, /input\.sr-only\.peer \+ div::before \{[\s\S]*?transform 560ms/u);
    assert.match(consoleCss, /input\.sr-only\.peer \+ div::after \{[\s\S]*?linear-gradient\(145deg, #ffffff[\s\S]*?transform 560ms/u);
    assert.match(consoleCss, /input\.sr-only\.peer:checked \+ div/u);
    assert.match(consoleCss, /peer-checked:bg-blue-600/u);
    assert.match(consoleCss, /peer-checked:bg-emerald-600/u);
    assert.match(consoleCss, /peer-checked:bg-amber-600/u);
    assert.match(consoleCss, /div\[class~="w-12"\]::before \{[\s\S]*?translate3d\(24px/u);
    assert.match(consoleCss, /div\[class~="w-9"\]::before \{[\s\S]*?translate3d\(16px/u);
    assert.match(consoleCss, /div\[class~="w-12"\]::after \{[\s\S]*?translateX\(24px\)/u);
    assert.match(consoleCss, /div\[class~="w-9"\]::after \{[\s\S]*?translateX\(16px\)/u);
});

test('threat map lays out keyed labels without recreating every marker on refresh', () => {
    assert.match(source, /function layoutThreatMapLabels\(points\)/u);
    assert.match(source, /function mapBoxesOverlap\(a, b, padding = 3\)/u);
    assert.match(source, /const markerBoxes = points\.map/u);
    assert.match(source, /data\(layoutPoints, point => point\.country\)/u);
    assert.match(source, /attr\('class', 'map-leader'\)/u);
    assert.match(source, /attr\('class', 'map-label'\)/u);
    assert.match(source, /d3\.transition\('threat-map-layout'\)[\s\S]*?duration\(620\)/u);
    const mapUpdate = app.match(/function updateWorldMap\(\) \{[\s\S]*?\n        \}\n\n        const liveMetricAnimationState/u)?.[0] || '';
    assert.doesNotMatch(mapUpdate, /selectAll\('\*'\)\.remove/u);
    assert.match(source, /#threat-map \.map-label \{[\s\S]*?font-size: 8px !important/u);
});

test('UCG live telemetry interpolates values, bars, cores and chart without changing polling', () => {
    assert.match(source, /function animateLiveMetricNumber\(target, nextValue, options = \{\}\)/u);
    assert.match(source, /function setLiveMetricBar\(target, nextValue\)/u);
    assert.match(source, /function updateHardwareCoreRows\(values\)/u);
    assert.match(source, /function updateLiveChart\(chart\)[\s\S]*?duration: 900, easing: 'easeOutCubic'/u);
    assert.match(source, /requestAnimationFrame\(step\)/u);
    assert.match(consoleCss, /\.live-metric-bar \{[\s\S]*?width 900ms cubic-bezier/u);
    const hardwareFetch = app.match(/async function fetchHardware\(\) \{[\s\S]*?\n        \}/u)?.[0] || '';
    assert.match(hardwareFetch, /updateHardwareCoreRows\(data\.cores\)/u);
    assert.match(hardwareFetch, /updateLiveChart\(hwChart\)/u);
    assert.doesNotMatch(hardwareFetch, /grid\.innerHTML/u);
});

 test('NAS hydration reads each response body once and retains disk metadata', async () => {
    const vm = require('node:vm');
    const start = app.indexOf('const [ovRes, diskRes, volRes, upsRes]');
    const end = app.indexOf('const lite = ov.disksLite', start);
    const disks = [{ name: 'sda', model: 'Test disk' }];
    const payloads = [{ disksLite: [] }, { disks }, { volumes: [] }, { ups: {} }];
    const calls = [];
    const context = vm.createContext({
        nasDiskStatic: [],
        fetch: async url => { calls.push(url); return new Response(JSON.stringify(payloads.shift())); }
    });
    await vm.runInContext('(async () => {' + app.slice(start, end) + '})()', context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.nasDiskStatic)), disks);
    assert.equal(calls.length, 4);
});

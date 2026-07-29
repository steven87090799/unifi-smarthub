'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createPanelSecurity } = require('../server/middleware/panel-security');
const { registerPanelAuthRoutes } = require('../server/routes/panel-auth-routes');
const { createPublicSystemHealthService } = require('../server/services/public-system-health');
const { frontendStaticOptions } = require('../server/routes/frontend-asset-routes');
const { PWA_SHELL, renderPwaServiceWorker } = require('../server/services/pwa-service-worker');

const ROOT = path.resolve(__dirname, '..');
const loginHtml = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
const loginCss = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'login.css'), 'utf8');
const loginJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'login.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mockSource = fs.readFileSync(path.join(ROOT, 'server-mock.js'), 'utf8');

test('login page exposes complete accessible form and local-only assets', () => {
    assert.match(loginHtml, /<link rel="stylesheet" href="\/assets\/login\.css">/u);
    assert.match(loginHtml, /<script src="\/js\/login\.js" defer><\/script>/u);
    assert.doesNotMatch(loginHtml, /(?:src|href)="https?:\/\//iu);
    assert.match(loginHtml, /name="username"[\s\S]+autocomplete="username"/u);
    assert.match(loginHtml, /name="password"[\s\S]+autocomplete="current-password"/u);
    assert.match(loginHtml, /id="password-toggle"[\s\S]+aria-label="顯示密碼"[\s\S]+aria-pressed="false"/u);
    assert.match(loginHtml, /id="form-alert"[\s\S]+role="alert"[\s\S]+aria-live="assertive"/u);
    assert.match(loginHtml, /id="username-error" aria-live="polite"/u);
    assert.match(loginHtml, /id="password-error" aria-live="polite"/u);
    assert.match(loginHtml, /id="remember" name="remember" type="checkbox"/u);
    assert.match(loginHtml, /id="forgot-password"[\s\S]+aria-controls="security-help"/u);
    assert.match(loginHtml, /id="system-snapshot"[\s\S]+aria-labelledby="snapshot-title"/u);
    assert.match(loginHtml, /id="snapshot-announcement" aria-live="polite"/u);
    assert.doesNotMatch(loginHtml, /data-app-version/u);
});

test('liquid glass styling includes fallbacks, responsive safety, autofill, and reduced motion', () => {
    assert.match(loginCss, /backdrop-filter:\s*blur\(30px\)/u);
    assert.match(loginCss, /@supports not \(\(backdrop-filter/u);
    assert.match(loginCss, /input:-webkit-autofill/u);
    assert.match(loginCss, /env\(safe-area-inset-top\)/u);
    assert.match(loginCss, /@media \(max-width: 540px\)/u);
    assert.match(loginCss, /@media \(prefers-reduced-motion: reduce\)/u);
    assert.match(loginCss, /\.password-toggle\s*\{[\s\S]+width:\s*46px;[\s\S]+height:\s*46px;/u);
    assert.match(loginCss, /\.is-page-hidden \.liquid-scene/u);
    assert.match(loginCss, /\.system-snapshot/u);
    assert.doesNotMatch(loginHtml, /<canvas/iu);
});

test('login interactions cover validation, loading, success, password toggle, and safe return paths', () => {
    assert.match(loginJs, /function validateUsername/u);
    assert.match(loginJs, /function validatePassword/u);
    assert.match(loginJs, /if \(submitting\) return/u);
    assert.match(loginJs, /form\.addEventListener\('keydown', submitOnEnter\)/u);
    assert.match(loginJs, /form\.requestSubmit\(\)/u);
    assert.match(loginJs, /submitButton\.classList\.toggle\('is-loading'/u);
    assert.match(loginJs, /submitButton\.classList\.add\('is-success'/u);
    assert.match(loginJs, /passwordInput\.type = reveal \? 'text' : 'password'/u);
    assert.match(loginJs, /帳號或密碼不正確/u);
    assert.match(loginJs, /無法連線到登入服務/u);
    assert.match(loginJs, /\^\\\/\(\?!\\\/\)/u);
    assert.match(loginJs, /let publicSystemHealthRequest = null/u);
    assert.match(loginJs, /if \(!publicSystemHealthRequest\)/u);
    assert.equal((loginJs.match(/\/api\/public\/system-health/gu) || []).length, 1);
    assert.match(loginJs, /Date\.parse\(snapshotData\.snapshotAt\) \+ SNAPSHOT_MAX_AGE_MS/u);
    assert.match(loginJs, /window\.location\.reload\(\)/u);
    assert.doesNotMatch(loginJs, /EventSource|WebSocket|new Worker/u);
});

test('production and mock register the same panel auth routes and dashboard exposes logout', () => {
    assert.match(serverSource, /registerPanelAuthRoutes\(app, \{[\s\S]+security: panelSecurity,[\s\S]+publicSystemHealth/u);
    assert.match(mockSource, /registerPanelAuthRoutes\(app, \{[\s\S]+security: mockSecurity,[\s\S]+publicSystemHealth: mockPublicSystemHealth/u);
    assert.match(serverSource, /refreshPublicSystemHealthSnapshot\(\);[\s\S]+const s = loadNotifSettings\(\)/u);
    const publicSnapshotSource = serverSource
        .split('function refreshPublicSystemHealthSnapshot()')[1]
        .split('/* ===================== 重大事件警報')[0];
    assert.match(publicSnapshotSource, /publicSystemHealth\.update\(/u);
    assert.doesNotMatch(publicSnapshotSource, /await|axios\.|getLocalSession\(|fetchHardwareSSH\(|getNasToken\(|wiimGet\(/u);
    assert.match(dashboardHtml, /id="panel-logout"[\s\S]+data-handler-click=/u);
    assert.match(dashboardJs, /logoutPanel\(\)/u);
    assert.match(dashboardJs, /function redirectToPanelLogin/u);
});

test('public login assets work before authentication and protected HTML redirects to login', async t => {
    const app = express();
    const security = createPanelSecurity({
        adminPassword: 'panel-login-secret',
        csrfToken: 'panel-login-csrf',
        publicMetadata: { version: '3.0.0' }
    });
    const publicSystemHealth = createPublicSystemHealthService();
    publicSystemHealth.update([{ online: true }, { online: false }], Date.parse('2026-07-16T06:32:18.000Z'));
    registerPanelAuthRoutes(app, { rootDir: ROOT, security, publicSystemHealth });
    app.use(security.authenticate);
    app.use(express.static(path.join(ROOT, 'public'), frontendStaticOptions()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const asset of ['/login', '/assets/login.css', '/js/login.js', '/api/public/system-health']) {
        const response = await fetch(`${base}${asset}`);
        assert.equal(response.status, 200, asset);
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
    }
    const publicSnapshot = await (await fetch(`${base}/api/public/system-health`)).json();
    assert.deepEqual(publicSnapshot, {
        status: 'degraded',
        total: 2,
        online: 1,
        offline: 1,
        snapshotAt: '2026-07-16T06:32:18.000Z'
    });
    assert.equal((await fetch(`${base}/api/public/system-health`)).headers.get('cache-control'), 'private, max-age=0, no-store');
    const protectedPage = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(protectedPage.status, 302);
    assert.equal(protectedPage.headers.get('location'), '/login?return=%2F');
    const status = await (await fetch(`${base}/api/auth/status`)).json();
    assert.deepEqual(status, {
        authenticated: false, role: 'public', principal: null, version: '3.0.0'
    });
});

test('service worker keeps offline navigation on the public login shell instead of cached dashboard HTML', () => {
    assert.ok(PWA_SHELL.includes('/login'));
    assert.ok(PWA_SHELL.includes('/assets/login.css'));
    assert.ok(PWA_SHELL.includes('/js/login.js'));
    assert.ok(!PWA_SHELL.includes('/'));
    const source = renderPwaServiceWorker('smarthub-login-test');
    assert.match(source, /event\.request\.mode==='navigate'/u);
    assert.match(source, /caches\.match\('\/login'\)/u);
});

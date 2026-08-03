'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const {
    frontendStaticOptions,
    frontendVendorAssets,
    registerFrontendAssetRoutes
} = require('../server/routes/frontend-asset-routes');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mockServerSource = fs.readFileSync(path.join(ROOT, 'server-mock.js'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(ROOT, 'server', 'services', 'pwa-service-worker.js'), 'utf8');

test('production frontend has no third-party executable/data dependency or QR credential egress', () => {
    assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//iu);
    assert.doesNotMatch(html, /@import\s+url\(['"]?https?:\/\//iu);
    assert.doesNotMatch(html, /api\.qrserver\.com|cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com/iu);
    assert.match(appSource, /fetch\('\/api\/wifi\/qr'/u);
    assert.match(html, /SSID 與密碼不會送往第三方服務/u);
    assert.match(appSource, /dataset\.panelRole !== 'admin'/u);
    for (const asset of frontendVendorAssets(ROOT)) {
        assert.ok(`${html}\n${appSource}`.includes(asset.url), asset.url);
        assert.ok(serviceWorkerSource.includes(asset.url), `service worker precache: ${asset.url}`);
    }
    assert.match(serverSource, /PWA_CACHE_NAME[\s\S]+buildIdentity\.public\.revision/u);
    assert.match(serverSource, /renderPwaServiceWorker\(PWA_CACHE_NAME\)/u);
    assert.match(mockServerSource, /renderPwaServiceWorker/u);
    assert.match(html, /<script src="\/js\/web-push\.js"><\/script>/u);
    assert.match(html, /<script src="\/js\/ups-presenter\.js"><\/script>/u);
    assert.match(html, /<script src="\/js\/app\.js"><\/script>/u);
    assert.match(serviceWorkerSource, /'\/js\/web-push\.js'/u);
    assert.match(serviceWorkerSource, /'\/js\/ups-presenter\.js'/u);
    assert.match(serviceWorkerSource, /'\/js\/app\.js'/u);
});

test('locked vendor routes serve only the exact bounded same-origin assets', async t => {
    const app = express();
    const assets = registerFrontendAssetRoutes(app, { rootDir: ROOT });
    app.use(express.static(path.join(ROOT, 'public'), frontendStaticOptions()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const asset of assets) {
        const response = await fetch(`${base}${asset.url}`);
        assert.equal(response.status, 200, asset.url);
        assert.match(response.headers.get('cache-control') || '', /immutable/u);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.ok((await response.arrayBuffer()).byteLength >= 16);
    }
    assert.equal((await fetch(`${base}/vendor/chart.js/latest/chart.umd.js`)).status, 404);
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy') || '', /default-src 'self'/u);
    assert.match(shell.headers.get('content-security-policy') || '', /frame-ancestors 'none'/u);
    assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(shell.headers.get('x-frame-options'), 'DENY');
    await shell.arrayBuffer();
});

test('checked-in Tailwind output exactly matches the locked production build', () => {
    const result = spawnSync(process.execPath, ['scripts/build-frontend-css.js', '--check'], {
        cwd: ROOT, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

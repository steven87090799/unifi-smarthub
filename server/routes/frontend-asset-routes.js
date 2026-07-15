'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dependencies } = require('../../package.json');

const VENDOR_SPECS = Object.freeze([
    { packageName: 'chart.js', file: 'dist/chart.umd.js', publicName: 'chart.umd.js' },
    { packageName: 'd3', file: 'dist/d3.min.js', publicName: 'd3.min.js' },
    { packageName: 'topojson-client', file: 'dist/topojson-client.min.js', publicName: 'topojson-client.min.js' },
    { packageName: 'world-atlas', file: 'countries-110m.json', publicName: 'countries-110m.json' }
]);
const FRONTEND_CSP = [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'"
].join('; ');

function setFrontendSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', FRONTEND_CSP);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
}

function frontendStaticOptions() {
    return { setHeaders: setFrontendSecurityHeaders };
}

function frontendVendorAssets(rootDir) {
    return VENDOR_SPECS.map(spec => {
        const version = dependencies[spec.packageName];
        if (!/^\d+\.\d+\.\d+$/u.test(version || '')) {
            throw new Error(`frontend dependency ${spec.packageName} must use an exact version`);
        }
        const filePath = path.join(rootDir, 'node_modules', spec.packageName, spec.file);
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < 16 || stat.size > 2 * 1024 * 1024) {
            throw new Error(`frontend dependency asset ${spec.packageName}/${spec.file} is invalid`);
        }
        return Object.freeze({
            ...spec,
            version,
            filePath,
            url: `/vendor/${spec.packageName}/${version}/${spec.publicName}`
        });
    });
}

function registerFrontendAssetRoutes(app, { rootDir }) {
    if (!app || typeof app.get !== 'function') throw new TypeError('Express app is required');
    const assets = frontendVendorAssets(rootDir);
    for (const asset of assets) {
        app.get(asset.url, (_req, res, next) => {
            setFrontendSecurityHeaders(res);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.sendFile(asset.filePath, error => error ? next(error) : undefined);
        });
    }
    return assets;
}

module.exports = {
    FRONTEND_CSP,
    VENDOR_SPECS,
    frontendStaticOptions,
    frontendVendorAssets,
    registerFrontendAssetRoutes,
    setFrontendSecurityHeaders
};

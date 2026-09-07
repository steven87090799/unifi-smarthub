'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

test('connection settings UI renders backend transport modes without hard-coded public claims', () => {
    assert.match(html, /id="conn-TRUSTED_LAN_MODE"/u);
    assert.match(app, /transportModeLabel\(v\.transportMode\)/u);
    for (const mode of [
        'verified', 'private-ca', 'trusted-lan-insecure', 'explicitly-insecure',
        'explicit-insecure-http', 'unconfigured'
    ]) assert.match(app, new RegExp(`(?:'${mode}'|${mode}):`, 'u'), mode);
    assert.doesNotMatch(app, /公網整合仍使用 verified TLS/u);
});

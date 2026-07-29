'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FRONTEND_CSP } = require('../server/routes/frontend-asset-routes');
const { PWA_SHELL } = require('../server/services/pwa-service-worker');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('dashboard uses external scripts and contains no inline event handlers', () => {
    assert.doesNotMatch(html, /<script(?!\s+src=)[^>]*>/iu);
    assert.doesNotMatch(html, /\son(?:click|change|input|submit|keydown|keyup|focus|blur)\s*=/iu);
    assert.match(html, /<script src="\/js\/bootstrap\.js"><\/script>/u);
    assert.match(html, /<script src="\/js\/app\.js"><\/script>/u);
});

test('dashboard CSP blocks inline JavaScript and PWA shell versions every new script', () => {
    const scriptDirective = FRONTEND_CSP.split('; ').find(value => value.startsWith('script-src '));
    assert.equal(scriptDirective, "script-src 'self'");
    assert.doesNotMatch(FRONTEND_CSP, /unsafe-eval/u);
    assert.ok(PWA_SHELL.includes('/js/bootstrap.js'));
    assert.ok(PWA_SHELL.includes('/js/action-dispatcher.js'));
    assert.ok(PWA_SHELL.includes('/js/app.js'));
});

test('dynamic action fixtures remain escaped data and readonly dispatch cannot execute admin actions', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const dispatcherSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'action-dispatcher.js'), 'utf8');
    const window = {};
    new vm.Script(dispatcherSource).runInContext(vm.createContext({ window, Set, Object, String, TypeError }));
    const received = [];
    let role = 'admin';
    const dispatch = window.SmartHubActionDispatcher.create({
        getRole: () => role,
        adminActions: ['threat-block'],
        actions: { 'threat-block': data => received.push(data.ip) }
    });
    for (const payload of ["'", '"', '</button><script>', '<img src=x onerror=alert(1)>', "');alert(1);//"]) {
        const encoded = window.SmartHubActionDispatcher.escapeAttribute(payload);
        assert.doesNotMatch(encoded, /[<>"']/u);
        dispatch({ target: { closest: () => ({ dataset: { action: 'threat-block', ip: payload } }) } });
    }
    assert.deepEqual(received, ["'", '"', '</button><script>', '<img src=x onerror=alert(1)>', "');alert(1);//"]);
    role = 'readonly';
    dispatch({ target: { closest: () => ({ dataset: { action: 'threat-block', ip: 'blocked' } }) } });
    assert.equal(received.includes('blocked'), false);
    assert.doesNotMatch(appSource, /\beval\s*\(|\bnew Function\b|set(?:Timeout|Interval)\s*\(\s*['"]/u);
    assert.doesNotMatch(appSource, /onclick\s*=/iu);
});

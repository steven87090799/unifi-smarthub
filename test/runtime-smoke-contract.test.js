'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DISCOVERABLE_SCRIPT_PATTERN = /(?:^test-.*|[-_.]test)\.[cm]?js$/u;

test('runtime smoke uses the production entrypoint with isolated restart and cleanup boundaries', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const smokePath = path.join(ROOT, 'scripts', 'runtime-smoke.js');
    const source = fs.readFileSync(smokePath, 'utf8');

    assert.equal(packageJson.scripts['test:smoke'], 'node scripts/runtime-smoke.js');
    assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'runtime-smoke-test.js')), false);
    assert.equal(fs.existsSync(smokePath), true);
    assert.doesNotMatch(path.basename(smokePath), DISCOVERABLE_SCRIPT_PATTERN);
    assert.match(source, /server\.js/u);
    assert.doesNotMatch(source, /server-mock\.js/u);
    assert.match(source, /mkdtemp/u);
    assert.match(source, /DATA_DIR/u);
    assert.match(source, /SMARTHUB_ENV_FILE/u);
    assert.match(source, /unusedLoopbackPort/u);
    assert.match(source, /127\.0\.0\.1/u);
    assert.doesNotMatch(source, /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/u);
    assert.doesNotMatch(source, /docker\.sock/u);
    assert.match(source, /TELEGRAM_BOT_TOKEN:\s*''/u);
    assert.match(source, /WEB_PUSH_ENABLED:\s*'false'/u);
    assert.match(source, /SIGTERM/u);
    assert.match(source, /restart runtime/u);
    assert.match(source, /watcherSec:\s*41/u);
    assert.match(source, /finally/u);
    assert.match(source, /uncaughtException/u);
    assert.match(source, /unhandledRejection/u);
});

test('scripts contain no files that Node test discovery can execute accidentally', () => {
    const scriptFiles = fs.readdirSync(path.join(ROOT, 'scripts'));
    const accidentallyDiscoverable = scriptFiles.filter(file => DISCOVERABLE_SCRIPT_PATTERN.test(file));

    assert.deepEqual(accidentallyDiscoverable, []);
});

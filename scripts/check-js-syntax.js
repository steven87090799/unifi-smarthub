'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const EXCLUDED_SEGMENTS = new Set([
    '.git',
    '.production-verification',
    'config',
    'coverage',
    'data',
    'node_modules',
    'tmp'
]);
const EXCLUDED_PREFIXES = ['public/vendor/', 'test/tmp/'];

function repositoryJavaScriptFiles() {
    const result = spawnSync('git', [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.js'
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`Unable to discover repository JavaScript files: ${result.stderr.trim()}`);
    }
    return result.stdout.split('\n').map(value => value.trim()).filter(Boolean).filter(file => {
        const normalized = file.split(path.sep).join('/');
        if (EXCLUDED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false;
        return !normalized.split('/').some(segment => EXCLUDED_SEGMENTS.has(segment));
    }).sort();
}

const files = repositoryJavaScriptFiles();
if (files.length === 0) throw new Error('No JavaScript files were discovered');
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout);
        process.exitCode = 1;
        break;
    }
}
if (!process.exitCode) process.stdout.write(`JavaScript syntax passed: ${files.length} files\n`);

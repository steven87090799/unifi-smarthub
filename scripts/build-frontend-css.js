'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'public', 'assets', 'tailwind.css');
const check = process.argv.includes('--check');
const temporaryDirectory = check ? fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-tailwind-')) : null;
const destination = check ? path.join(temporaryDirectory, 'tailwind.css') : OUTPUT;

try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const result = spawnSync(process.execPath, [
        require.resolve('tailwindcss/lib/cli.js'),
        '-c', path.join(ROOT, 'tailwind.config.cjs'),
        '-i', path.join(ROOT, 'frontend', 'tailwind.input.css'),
        '-o', destination,
        '--minify'
    ], { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout || 'Tailwind build failed\n');
        process.exit(result.status || 1);
    }
    if (check) {
        assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(OUTPUT),
            'public/assets/tailwind.css is stale; run npm run build:css');
    }
} finally {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

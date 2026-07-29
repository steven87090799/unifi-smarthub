'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('connection restart badges clear authoritative fields before pending overlays', () => {
    const clearIndex = source.indexOf("for (const key of d.restartRequiredFields || [])");
    const pendingIndex = source.indexOf("for (const key of d.pendingRestartFields || [])");
    assert.ok(clearIndex >= 0, 'restart-required badges must be reset from each GET response');
    assert.ok(pendingIndex > clearIndex, 'pending fields must overlay the reset state');
    const resetBlock = source.slice(clearIndex, pendingIndex);
    assert.match(resetBlock, /badge\.innerHTML\s*=\s*''/);
});

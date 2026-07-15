const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('settings UI exposes explicit secret-safe backup and restart-staged restore controls', () => {
    assert.match(html, /id="backup-restore-state"/);
    assert.match(html, /id="config-restore-file"[^>]+onchange="stageConfigRestore\(this\)"/);
    assert.match(html, /onclick="downloadConfigBackup\(\)"/);
    assert.match(html, /絕不下載密碼、token 或 API key/);
    assert.match(html, /不會覆蓋目前的任何機密欄位/);
    assert.match(html, /pre-restore rollback copy/);
});

test('restore UI uses the dedicated media type, explicit confirmation, and never requests an automatic restart', () => {
    const start = html.indexOf('async function stageConfigRestore');
    const end = html.indexOf('async function runReportNow', start);
    assert.ok(start > 0 && end > start);
    const source = html.slice(start, end);
    assert.match(source, /confirmation !== 'RESTORE'/);
    assert.match(source, /application\/vnd\.unifi-smarthub\.backup\+json/);
    assert.match(source, /X-SmartHub-Restore-Confirmation/);
    assert.match(source, /await file\.arrayBuffer\(\)/);
    assert.doesNotMatch(source, /location\.reload|restartService|docker/i);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const production = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mock = fs.readFileSync(path.join(ROOT, 'server-mock.js'), 'utf8');
const docs = fs.readFileSync(path.join(ROOT, 'docs/integrations/unifi-network-api.md'), 'utf8');

test('dashboard renders live verified device telemetry and history for every managed device', () => {
    assert.match(html, /id="unifi-device-telemetry-cards"/);
    assert.match(html, /id="unifiDeviceTelemetryChart"/);
    assert.match(html, /device\.cpu\?\.sourceField/);
    assert.match(html, /device\.temperatureStatus/);
    assert.match(html, /內部最高溫度/);
    assert.match(html, /設備 SSH/);
    assert.match(html, /找不到已選取的設備/);
    assert.match(html, /Controller 顯示設備離線/);
    assert.match(html, /設定已更新，等待重新取樣/);
    assert.match(html, /資料已過期；Telemetry Snapshot 停止更新/);
    assert.match(html, /上次成功溫度/);
    assert.match(html, /unifi-device-ssh-target-reference/);
    assert.match(html, /UNIFI_DEVICE_SSH_TARGET_IDS/);
    assert.match(html, /\/api\/network\/devices\/telemetry/);
    assert.match(html, /\/api\/network\/devices\/telemetry\/history\?hours=/);
});

test('production and mock expose the same visible telemetry routes and notification settings', () => {
    for (const source of [production, mock]) {
        assert.match(source, /app\.get\('\/api\/network\/devices\/telemetry'/);
        assert.match(source, /app\.get\('\/api\/network\/devices\/telemetry\/history'/);
        assert.match(source, /triggerUnifiDeviceTemp/);
        assert.match(source, /unifiDeviceTempAlert/);
    }
    assert.match(production, /thermal-probe/);
    assert.match(mock, /thermal-probe/);
    assert.match(mock, /device_not_found/);
    assert.match(mock, /management_ip_changed_reconnected/);
    assert.match(mock, /snapshot_stale/);
    assert.match(mock, /controller_device_offline/);
});

test('integration contract documents capability-gated temperature truthfulness', () => {
    assert.match(docs, /has_temperature=true/);
    assert.match(docs, /has_temperature=false/);
    assert.match(docs, /不使用估算值/);
    assert.match(docs, /system-stats\.cpu/);
    assert.match(docs, /thermal_zone/);
});

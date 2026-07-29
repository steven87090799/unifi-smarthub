'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('security UI exposes admin-only expiring IPv4 block state and dedicated Integration API configuration', () => {
    assert.match(html, /id="threat-block-panel"/);
    assert.match(html, /只接受公網 IPv4/);
    assert.match(html, /系統會自動移除並重試同步/);
    for (const field of [
        'UNIFI_NETWORK_API_URL',
        'UNIFI_NETWORK_API_KEY',
        'UNIFI_NETWORK_TLS_VERIFY',
        'UNIFI_NETWORK_SITE_ID',
        'UNIFI_THREAT_BLOCK_LIST_ID',
        'UNIFI_THREAT_BLOCK_LIST_NAME'
    ]) assert.match(html, new RegExp(`id="conn-${field}"`));
    assert.match(html, /該清單不可人工混用/);
    assert.match(html, /true（預設；建議）/);
});

test('block and removal flows require a UI confirmation plus the exact server confirmation contract', () => {
    const addStart = app.indexOf('async function requestThreatBlock');
    const removeStart = app.indexOf('async function removeThreatBlock', addStart);
    const end = app.indexOf('function exportThreatsCSV', removeStart);
    assert.ok(addStart > 0 && removeStart > addStart && end > removeStart);
    const add = app.slice(addStart, removeStart);
    const remove = app.slice(removeStart, end);
    assert.match(add, /prompt\(/);
    assert.match(add, /expiresInMinutes < 15 \|\| expiresInMinutes > 43200/);
    assert.match(add, /confirm\(/);
    assert.match(add, /confirmation: 'BLOCK_EXTERNAL_IP'/);
    assert.ok(add.indexOf('confirm(') < add.indexOf("fetch('/api/security/threat-blocks'"));
    assert.match(remove, /confirm\(/);
    assert.match(remove, /method: 'DELETE'/);
    assert.match(remove, /confirmation: 'REMOVE_EXTERNAL_IP_BLOCK'/);
});

test('readonly users receive no block controls and remote block state is escaped before HTML rendering', () => {
    const renderStart = app.indexOf('function renderThreatTable');
    const end = app.indexOf('function exportThreatsCSV', renderStart);
    const source = app.slice(renderStart, end);
    assert.match(source, /dataset\.panelRole === 'admin'/);
    assert.match(source, /security\.role !== 'admin'/);
    assert.match(source, /escapeHtml\(block\.ip\)/);
    assert.match(source, /escapeActionData\(block\.id\)/);
});

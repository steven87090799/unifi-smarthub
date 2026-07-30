'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const {
    InputValidationError,
    NOTIFICATION_BOOLEAN_FIELDS,
    NOTIFICATION_NUMBER_FIELDS,
    UI_POLL_KEYS,
    WIIM_SOURCES,
    exactObject,
    parseAlias,
    parseAlertConfig,
    parseAppSettings,
    parseConnectionUpdates,
    parseDeviceRestriction,
    parseEmptyBody,
    parseNotificationSettings,
    parsePoePowerCycle,
    parseSingleBoolean,
    parseWifiUpdate,
    parseUiPreferences,
    quoteEnvValue,
    stringValue
} = require('../server/policies/write-input-policy');

function validationError(fn, field = undefined) {
    assert.throws(fn, error => {
        assert.ok(error instanceof InputValidationError);
        assert.equal(error.httpStatus, 400);
        assert.equal(error.code, 'API_VALIDATION_FAILED');
        if (field !== undefined) assert.equal(error.field, field);
        return true;
    });
}

test('exact-object validation rejects arrays, missing fields, and unknown fields', () => {
    for (const value of [null, [], 'body', 1]) validationError(() => exactObject(value, { allowed: ['ok'] }));
    validationError(() => exactObject({}, { allowed: ['ok'], required: ['ok'] }), 'ok');
    validationError(() => exactObject({ ok: true, surprise: true }, { allowed: ['ok'] }), 'surprise');
    assert.deepEqual(exactObject({ ok: true }, { allowed: ['ok'], required: ['ok'] }), { ok: true });
});

test('bounded strings reject control characters instead of silently stripping or truncating', () => {
    assert.equal(stringValue('  Living Room  ', { field: 'name', max: 40 }), 'Living Room');
    assert.equal(stringValue('', { field: 'name', min: 0, max: 40, allowEmpty: true }), '');
    for (const malicious of ['a\nb', 'a\rb', 'a\r\nb', 'a\0b', 'a\u007fb', 'a\u0085b']) {
        validationError(() => stringValue(malicious, { field: 'name', max: 40 }), 'name');
    }
    validationError(() => stringValue('x'.repeat(41), { field: 'name', max: 40 }), 'name');
});

test('alias input canonicalizes either-case MACs and enforces the exact name boundary', () => {
    assert.deepEqual(parseAlias({ mac: 'AA:bb:CC:dd:EE:ff', name: ' Speaker ' }), {
        mac: 'aa:bb:cc:dd:ee:ff',
        name: 'Speaker'
    });
    assert.equal(parseAlias({ mac: '00:11:22:33:44:55', name: '' }).name, '');
    assert.equal(parseAlias({ mac: '00:11:22:33:44:55', name: 'x'.repeat(40) }).name.length, 40);
    validationError(() => parseAlias({ mac: '00-11-22-33-44-55', name: 'x' }), 'mac');
    validationError(() => parseAlias({ mac: '00:11:22:33:44:55', name: 'x'.repeat(41) }), 'name');
    validationError(() => parseAlias({ mac: '00:11:22:33:44:55', name: 'ok', extra: 1 }), 'extra');
});

test('device, Wi-Fi, PoE, and boolean controls require JSON types and canonical identifiers', () => {
    assert.deepEqual(parseWifiUpdate('65c0a0b1:2', { enabled: false }), { id: '65c0a0b1:2', enabled: false });
    assert.deepEqual(parseDeviceRestriction({
        deviceId: 'AA:BB:CC:DD:EE:FF', blockState: true, deviceName: 'Phone'
    }), { deviceId: 'aa:bb:cc:dd:ee:ff', blockState: true, deviceName: 'Phone' });
    assert.deepEqual(parsePoePowerCycle({ switchMac: 'aa:bb:cc:dd:ee:ff', portIndex: 1 }), {
        switchMac: 'aa:bb:cc:dd:ee:ff', portIndex: 1
    });
    assert.deepEqual(parsePoePowerCycle({ switchMac: 'aa:bb:cc:dd:ee:ff', portIndex: 128 }).portIndex, 128);
    assert.deepEqual(parseSingleBoolean({ enabled: true }, 'enabled'), { enabled: true });

    for (const value of ['false', 0, 1, null]) validationError(() => parseWifiUpdate('id', { enabled: value }), 'enabled');
    for (const value of [0, -1, 1.5, 129, '1', Number.NaN, Infinity]) {
        validationError(() => parsePoePowerCycle({ switchMac: 'aa:bb:cc:dd:ee:ff', portIndex: value }), 'portIndex');
    }
    validationError(() => parseDeviceRestriction({ deviceId: 'aa:bb:cc:dd:ee:ff', blockState: 1 }), 'blockState');
    validationError(() => parseSingleBoolean({ enabled: false, extra: true }, 'enabled'), 'extra');
});

test('alert configuration accepts finite domain values and rejects ambiguous payloads', () => {
    assert.deepEqual(parseAlertConfig({ metric: 'disk.temp-1', threshold: 0, condition: 'below', enabled: true }), {
        metric: 'disk.temp-1', threshold: 0, condition: 'below', enabled: true
    });
    for (const threshold of [Number.NaN, Infinity, -Infinity, '50', 1_000_001, -1_000_001]) {
        validationError(() => parseAlertConfig({ metric: 'cpu', threshold, condition: 'above', enabled: true }), 'threshold');
    }
    validationError(() => parseAlertConfig({ metric: '../cpu', threshold: 50, condition: 'above', enabled: true }), 'metric');
    validationError(() => parseAlertConfig({ metric: 'cpu', threshold: 50, condition: 'over', enabled: true }), 'condition');
});

test('application settings enforce min, max, max+1, integer types, and unknown-field rejection', () => {
    const ranges = { interval: [5, 60], hour: [0, 23] };
    assert.deepEqual(parseAppSettings({
        interval: 5, hour: 23, reportEnabled: false, reportFreq: 'weekly'
    }, ranges), { interval: 5, hour: 23, reportEnabled: false, reportFreq: 'weekly' });
    validationError(() => parseAppSettings({ interval: 4 }, ranges), 'interval');
    validationError(() => parseAppSettings({ interval: 61 }, ranges), 'interval');
    validationError(() => parseAppSettings({ interval: 5.5 }, ranges), 'interval');
    validationError(() => parseAppSettings({ hour: -1 }, ranges), 'hour');
    validationError(() => parseAppSettings({ hour: 24 }, ranges), 'hour');
    validationError(() => parseAppSettings({ reportFreq: 'monthly' }, ranges), 'reportFreq');
    validationError(() => parseAppSettings({ unexpected: true }, ranges), 'unexpected');
});

test('notification settings validate every boolean and every numeric boundary', () => {
    const booleans = Object.fromEntries(NOTIFICATION_BOOLEAN_FIELDS.map((key, index) => [key, index % 2 === 0]));
    assert.deepEqual(parseNotificationSettings(booleans), booleans);
    for (const key of NOTIFICATION_BOOLEAN_FIELDS) {
        validationError(() => parseNotificationSettings({ [key]: 1 }), key);
    }

    for (const [key, range] of Object.entries(NOTIFICATION_NUMBER_FIELDS)) {
        assert.equal(parseNotificationSettings({ [key]: range.min })[key], range.min, `${key} min`);
        assert.equal(parseNotificationSettings({ [key]: range.max })[key], range.max, `${key} max`);
        const below = range.min - (range.step || 1);
        const above = range.max + (range.step || 1);
        validationError(() => parseNotificationSettings({ [key]: below }), key);
        validationError(() => parseNotificationSettings({ [key]: above }), key);
        validationError(() => parseNotificationSettings({ [key]: String(range.min) }), key);
        validationError(() => parseNotificationSettings({ [key]: Number.NaN }), key);
        validationError(() => parseNotificationSettings({ [key]: Infinity }), key);
        if (range.integer) validationError(() => parseNotificationSettings({ [key]: range.min + 0.5 }), key);
    }
    validationError(() => parseNotificationSettings({ linuxLoadAlert: 0.15 }), 'linuxLoadAlert');
});

test('notification channel and secret inputs are bounded and blank secrets preserve existing values', () => {
    assert.deepEqual(parseNotificationSettings({
        channel: 'telegram',
        chatId: '-1001234567890',
        webhookUrl: 'https://hooks.example.test/path?token=abc',
        botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi'
    }), {
        channel: 'telegram',
        chatId: '-1001234567890',
        webhookUrl: 'https://hooks.example.test/path?token=abc',
        botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi'
    });
    assert.deepEqual(parseNotificationSettings({ chatId: '', webhookUrl: ' ', botToken: '' }), { chatId: '' });
    validationError(() => parseNotificationSettings({ channel: 'Telegram' }), 'channel');
    validationError(() => parseNotificationSettings({ chatId: '1e3' }), 'chatId');
    validationError(() => parseNotificationSettings({ webhookUrl: 'javascript:alert(1)' }), 'webhookUrl');
    validationError(() => parseNotificationSettings({ webhookUrl: 'https://user:pass@example.test' }), 'webhookUrl');
    validationError(() => parseNotificationSettings({ botToken: 'bad' }), 'botToken');
    validationError(() => parseNotificationSettings({ enabled: true, unknown: true }), 'unknown');
});

test('UI preferences enforce per-key schemas and selector-safe identifiers', () => {
    const pollConfig = Object.fromEntries(UI_POLL_KEYS.map((key, index) => [key, index + 1]));
    const valid = {
        preferences: {
            theme: 'light',
            pollConfig,
            'layoutOrder.v1': {
                'page-overview': ['page-overview-b0', 'page-overview-b1'],
                __nav: ['nav-overview', 'nav-clients']
            },
            'pinnedBlocks.v1': ['page-nas-b0'],
            'wiimSrcOrder.v1': [...WIIM_SOURCES].reverse()
        }
    };
    assert.deepEqual(parseUiPreferences(valid), valid.preferences);
    assert.equal(parseUiPreferences({ preferences: { pollConfig: { hardware: 1, ups: 86400 } } }).pollConfig.ups, 86400);

    validationError(() => parseUiPreferences({ preferences: { theme: 'system' } }), 'theme');
    validationError(() => parseUiPreferences({ preferences: { pollConfig: { hardware: 0 } } }), 'pollConfig.hardware');
    validationError(() => parseUiPreferences({ preferences: { pollConfig: { hardware: 86401 } } }), 'pollConfig.hardware');
    validationError(() => parseUiPreferences({ preferences: { pollConfig: { surprise: 30 } } }), 'surprise');
    validationError(() => parseUiPreferences({ preferences: { 'pinnedBlocks.v1': ['ok-id', 'ok-id'] } }), 'pinnedBlocks.v1');
    validationError(() => parseUiPreferences({ preferences: { 'pinnedBlocks.v1': ['x\"] div'] } }), 'pinnedBlocks.v1[0]');
    validationError(() => parseUiPreferences({ preferences: { 'layoutOrder.v1': { '../page': ['safe-id'] } } }), 'layoutOrder.v1');
    validationError(() => parseUiPreferences({ preferences: { 'wiimSrcOrder.v1': WIIM_SOURCES.slice(1) } }), 'wiimSrcOrder.v1');
    validationError(() => parseUiPreferences({ preferences: { 'wiimSrcOrder.v1': [...WIIM_SOURCES.slice(0, 5), 'wifi'] } }), 'wiimSrcOrder.v1');
    validationError(() => parseUiPreferences({ preferences: { unknown: true } }), 'unknown');
});

test('empty-body actions accept only undefined or an empty plain object', () => {
    assert.deepEqual(parseEmptyBody(undefined), {});
    assert.deepEqual(parseEmptyBody({}), {});
    for (const body of [null, [], '', { surprise: true }]) validationError(() => parseEmptyBody(body));
});

test('connection updates reject .env injection, bad types, oversized values, and unknown fields', () => {
    const fields = [
        { key: 'SSH_PORT' },
        { key: 'UCG_SSH_HOST_KEY', secret: true },
        { key: 'LINUX_SSH_HOST_KEY', secret: true },
        { key: 'UNIFI_CONTROLLER_URL' },
        { key: 'UNIFI_NETWORK_API_URL' },
        { key: 'UNIFI_NETWORK_TLS_VERIFY' },
        { key: 'UNIFI_NETWORK_SITE_ID' },
        { key: 'UNIFI_THREAT_BLOCK_LIST_ID' },
        { key: 'UNIFI_THREAT_BLOCK_LIST_NAME' },
        { key: 'ADGUARD_URL' },
        { key: 'ADGUARD_ALLOW_INSECURE_HTTP' },
        { key: 'ADGUARD_TLS_VERIFY' },
        { key: 'ADGUARD_CA_FILE' },
        { key: 'UPS_SOURCE' },
        { key: 'NUT_HOST' },
        { key: 'NUT_UPS_NAME' },
        { key: 'PWRSTAT_PATH' },
        { key: 'PPB_TLS_VERIFY' },
        { key: 'PPB_TLS_INSECURE' },
        { key: 'PPB_CA_FILE' },
        { key: 'WAN_IFACE' },
        { key: 'PASSWORD', secret: true }
    ];
    assert.deepEqual(parseConnectionUpdates({
        SSH_PORT: '22',
        UCG_SSH_HOST_KEY: `SHA256:${'A'.repeat(43)}`,
        LINUX_SSH_HOST_KEY: `SHA256:${'B'.repeat(43)}`,
        UNIFI_CONTROLLER_URL: 'https://192.168.1.1:443',
        UNIFI_NETWORK_API_URL: 'https://192.168.1.1/proxy/network/integration',
        UNIFI_NETWORK_TLS_VERIFY: 'true',
        UNIFI_NETWORK_SITE_ID: '11111111-1111-4111-8111-111111111111',
        UNIFI_THREAT_BLOCK_LIST_ID: '22222222-2222-4222-8222-222222222222',
        UNIFI_THREAT_BLOCK_LIST_NAME: 'SmartHub Threat Blocks',
        ADGUARD_URL: 'https://adguard.internal:3000/',
        ADGUARD_ALLOW_INSECURE_HTTP: 'false',
        ADGUARD_TLS_VERIFY: 'true',
        ADGUARD_CA_FILE: '/app/config/adguard-ca.pem',
        UPS_SOURCE: 'ppb',
        PPB_TLS_VERIFY: 'true',
        PPB_TLS_INSECURE: 'false',
        PPB_CA_FILE: '/app/config/ppb-ca.pem',
        PASSWORD: ' spaces and # are data '
    }, fields), {
        SSH_PORT: '22',
        UCG_SSH_HOST_KEY: `SHA256:${'A'.repeat(43)}`,
        LINUX_SSH_HOST_KEY: `SHA256:${'B'.repeat(43)}`,
        UNIFI_CONTROLLER_URL: 'https://192.168.1.1:443',
        UNIFI_NETWORK_API_URL: 'https://192.168.1.1/proxy/network/integration',
        UNIFI_NETWORK_TLS_VERIFY: 'true',
        UNIFI_NETWORK_SITE_ID: '11111111-1111-4111-8111-111111111111',
        UNIFI_THREAT_BLOCK_LIST_ID: '22222222-2222-4222-8222-222222222222',
        UNIFI_THREAT_BLOCK_LIST_NAME: 'SmartHub Threat Blocks',
        ADGUARD_URL: 'https://adguard.internal:3000',
        ADGUARD_ALLOW_INSECURE_HTTP: 'false',
        ADGUARD_TLS_VERIFY: 'true',
        ADGUARD_CA_FILE: '/app/config/adguard-ca.pem',
        UPS_SOURCE: 'ppb',
        PPB_TLS_VERIFY: 'true',
        PPB_TLS_INSECURE: 'false',
        PPB_CA_FILE: '/app/config/ppb-ca.pem',
        PASSWORD: 'spaces and # are data'
    });
    assert.deepEqual(parseConnectionUpdates({ PASSWORD: '   ' }, fields), {});

    for (const injection of ['safe\nEVIL=1', 'safe\rEVIL=1', 'safe\r\nEVIL=1', 'safe\0EVIL=1']) {
        validationError(() => parseConnectionUpdates({ PASSWORD: injection }, fields), 'PASSWORD');
    }
    for (const port of ['0', '00', '01', '-1', '65536', '1.5', '1e3']) {
        validationError(() => parseConnectionUpdates({ SSH_PORT: port }, fields), 'SSH_PORT');
    }
    validationError(() => parseConnectionUpdates({ SSH_PORT: 22 }, fields), 'SSH_PORT');
    validationError(() => parseConnectionUpdates({ UNKNOWN: 'x' }, fields), 'UNKNOWN');
    validationError(() => parseConnectionUpdates({ PASSWORD: 'x'.repeat(4097) }, fields), 'PASSWORD');
    validationError(() => parseConnectionUpdates({ UNIFI_CONTROLLER_URL: 'ftp://host' }, fields), 'UNIFI_CONTROLLER_URL');
    validationError(() => parseConnectionUpdates({ UNIFI_CONTROLLER_URL: 'http://192.168.1.1' }, fields), 'UNIFI_CONTROLLER_URL');
    validationError(() => parseConnectionUpdates({ UNIFI_CONTROLLER_URL: 'https://user:pass@host' }, fields), 'UNIFI_CONTROLLER_URL');
    validationError(() => parseConnectionUpdates({ UNIFI_NETWORK_API_URL: 'file:///tmp/api' }, fields), 'UNIFI_NETWORK_API_URL');
    validationError(() => parseConnectionUpdates({ UNIFI_NETWORK_API_URL: 'http://192.168.1.1/proxy/network/integration' }, fields), 'UNIFI_NETWORK_API_URL');
    validationError(() => parseConnectionUpdates({ UNIFI_NETWORK_API_URL: 'https://192.168.1.1/proxy/network/integration?key=leak' }, fields), 'UNIFI_NETWORK_API_URL');
    validationError(() => parseConnectionUpdates({ UCG_SSH_HOST_KEY: 'SHA256:bad' }, fields), 'UCG_SSH_HOST_KEY');
    assert.equal(parseConnectionUpdates({ UNIFI_NETWORK_API_URL: 'http://127.0.0.1:8080' }, fields).UNIFI_NETWORK_API_URL, 'http://127.0.0.1:8080');
    validationError(() => parseConnectionUpdates({ UNIFI_NETWORK_TLS_VERIFY: 'TRUE' }, fields), 'UNIFI_NETWORK_TLS_VERIFY');
    validationError(() => parseConnectionUpdates({ ADGUARD_URL: 'https://adguard.internal/control' }, fields), 'ADGUARD_URL');
    validationError(() => parseConnectionUpdates({ ADGUARD_URL: 'https://adguard.internal?key=leak' }, fields), 'ADGUARD_URL');
    validationError(() => parseConnectionUpdates({ ADGUARD_ALLOW_INSECURE_HTTP: '1' }, fields), 'ADGUARD_ALLOW_INSECURE_HTTP');
    validationError(() => parseConnectionUpdates({ ADGUARD_TLS_VERIFY: 'FALSE' }, fields), 'ADGUARD_TLS_VERIFY');
    validationError(() => parseConnectionUpdates({ PPB_TLS_INSECURE: 'TRUE' }, fields), 'PPB_TLS_INSECURE');
    validationError(() => parseConnectionUpdates({ PPB_CA_FILE: 'relative.pem' }, fields), 'PPB_CA_FILE');
    validationError(() => parseConnectionUpdates({ UNIFI_NETWORK_SITE_ID: '../site' }, fields), 'UNIFI_NETWORK_SITE_ID');
    validationError(() => parseConnectionUpdates({ UNIFI_THREAT_BLOCK_LIST_ID: '0'.repeat(36) }, fields), 'UNIFI_THREAT_BLOCK_LIST_ID');
    validationError(() => parseConnectionUpdates({ UNIFI_THREAT_BLOCK_LIST_NAME: 'x'.repeat(129) }, fields), 'UNIFI_THREAT_BLOCK_LIST_NAME');
    for (const attack of ['host;touch', 'host$(id)', 'host`id`', 'host name', 'host/part']) {
        validationError(() => parseConnectionUpdates({ NUT_HOST: attack }, fields), 'NUT_HOST');
    }
    for (const attack of ['ups;touch', 'ups@host', '../ups', 'ups name']) {
        validationError(() => parseConnectionUpdates({ NUT_UPS_NAME: attack }, fields), 'NUT_UPS_NAME');
    }
    for (const attack of ['/bin/pwrstat;touch', 'pwrstat $(id)', '../pwrstat', '/bin//pwrstat']) {
        validationError(() => parseConnectionUpdates({ PWRSTAT_PATH: attack }, fields), 'PWRSTAT_PATH');
        validationError(() => parseConnectionUpdates({ ADGUARD_CA_FILE: attack }, fields), 'ADGUARD_CA_FILE');
    }
    validationError(() => parseConnectionUpdates({ WAN_IFACE: 'eth0;id' }, fields), 'WAN_IFACE');
});

test('quoted .env serialization round-trips spaces, hashes, equals, quotes, and backslashes', () => {
    for (const value of [
        'plain', 'spaces are data', 'hash#data', 'a=b', 'quote"data', 'back\\slash', '$HOME',
        "single'and#hash", 'single\'double"and#hash', "single'double\"and#hash"
    ]) {
        const serialized = `VALUE=${quoteEnvValue(value)}\n`;
        assert.equal(dotenv.parse(serialized).VALUE, value);
    }
    for (const value of ['x\ny', 'x\ry', 'x\0y']) validationError(() => quoteEnvValue(value));
    validationError(() => quoteEnvValue("all'\"`#delimiters"));
});

test('UniFi device SSH settings enforce canonical ports, usernames, MAC limits, fingerprints, and control rejection', () => {
    const fields = [
        { key: 'UNIFI_DEVICE_SSH_PORT' }, { key: 'UNIFI_DEVICE_SSH_USER' },
        { key: 'UNIFI_DEVICE_SSH_PASSWORD', secret: true },
        { key: 'UNIFI_DEVICE_SSH_TARGET_IDS', secret: true },
        { key: 'UNIFI_DEVICE_SSH_HOST_KEYS', secret: true }
    ];
    const fingerprint = `SHA256:${'A'.repeat(43)}`;
    assert.deepEqual(parseConnectionUpdates({
        UNIFI_DEVICE_SSH_PORT: '2222', UNIFI_DEVICE_SSH_USER: 'monitor-user',
        UNIFI_DEVICE_SSH_TARGET_IDS: 'AA:BB:CC:DD:EE:FF,aa:bb:cc:dd:ee:ff',
        UNIFI_DEVICE_SSH_HOST_KEYS: `AA:BB:CC:DD:EE:FF=${fingerprint}`
    }, fields), {
        UNIFI_DEVICE_SSH_PORT: '2222', UNIFI_DEVICE_SSH_USER: 'monitor-user',
        UNIFI_DEVICE_SSH_TARGET_IDS: 'aa:bb:cc:dd:ee:ff',
        UNIFI_DEVICE_SSH_HOST_KEYS: `aa:bb:cc:dd:ee:ff=${fingerprint}`
    });
    assert.throws(() => parseConnectionUpdates({ UNIFI_DEVICE_SSH_PORT: '022' }, fields));
    assert.throws(() => parseConnectionUpdates({ UNIFI_DEVICE_SSH_USER: 'root;id' }, fields));
    assert.throws(() => parseConnectionUpdates({ UNIFI_DEVICE_SSH_PASSWORD: 'bad\nvalue' }, fields));
    assert.throws(() => parseConnectionUpdates({ UNIFI_DEVICE_SSH_TARGET_IDS: Array.from({ length: 33 }, (_, index) => `02:00:00:00:00:${index.toString(16).padStart(2, '0')}`).join(',') }, fields));
    assert.throws(() => parseConnectionUpdates({ UNIFI_DEVICE_SSH_HOST_KEYS: 'aa:bb:cc:dd:ee:ff=SHA256:bad' }, fields));
});

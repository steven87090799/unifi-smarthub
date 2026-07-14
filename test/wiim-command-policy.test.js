'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ERROR_CODES,
    FIXED_READ_COMMANDS,
    FIXED_WRITE_COMMANDS,
    LIMITS,
    WiimCommandPolicyError,
    validateWiimCommand
} = require('../server/policies/wiim-command-policy');

const UI_FIXED_READ_COMMANDS = [
    'getPlayModeGainConfig',
    'EQGetBand',
    'getbtdiscoveryresult',
    'getbthistory',
    'getbtpairstatus',
    'Squeezelite:getState',
    'wlanGetConnectState',
    'getShutdown',
    'EQGetList',
    'EQGetStat',
    'getStatusEx',
    'getStaticIpInfo',
    'getPresetInfo'
];

const UI_FIXED_WRITE_COMMANDS = [
    'setPlayerCmd:prev',
    'setPlayerCmd:onepause',
    'setPlayerCmd:next',
    'setPlayerCmd:stop',
    'EQOn',
    'EQOff',
    'clearbtdiscoveryresult',
    'ConnectMasterAp:JoinGroupMaster:eth0',
    'Cast:EnableCast',
    'Cast:DisableCast',
    'reboot',
    'LED_SWITCH_SET:1',
    'LED_SWITCH_SET:0',
    'Button_Enable_SET:1',
    'Button_Enable_SET:0'
];

function expectRejected(command, code = ERROR_CODES.INVALID_PARAMETER) {
    assert.throws(
        () => validateWiimCommand(command),
        error => error instanceof WiimCommandPolicyError && error.code === code
    );
}

function expectCommand(command, expected = command) {
    const result = validateWiimCommand(command);
    assert.equal(result.command, expected);
    assert.equal(result.canonicalCommand, expected);
    return result;
}

test('the fixed read allowlist enumerates every parameter-free command used by the UI', () => {
    assert.deepEqual([...FIXED_READ_COMMANDS].sort(), [...UI_FIXED_READ_COMMANDS].sort());
    for (const command of UI_FIXED_READ_COMMANDS) {
        const result = expectCommand(command);
        assert.equal(result.kind, 'read', command);
        assert.equal(result.mutating, false, command);
        assert.equal(result.confirmationRequired, false, command);
    }
});

test('the fixed write allowlist enumerates every parameter-free command used by the UI', () => {
    assert.deepEqual([...FIXED_WRITE_COMMANDS].sort(), [...UI_FIXED_WRITE_COMMANDS].sort());
    for (const command of UI_FIXED_WRITE_COMMANDS) {
        const result = expectCommand(command);
        assert.equal(result.kind, 'write', command);
        assert.equal(result.mutating, true, command);
    }
});

test('fixed reboot and group teardown commands are explicitly high risk', () => {
    assert.deepEqual(
        Object.fromEntries(['reboot', 'ConnectMasterAp:JoinGroupMaster:eth0'].map(command => {
            const result = expectCommand(command);
            return [command, {
                highRisk: result.highRisk,
                confirmationRequired: result.confirmationRequired,
                risk: result.risk
            }];
        })),
        {
            reboot: { highRisk: true, confirmationRequired: true, risk: 'device-reboot' },
            'ConnectMasterAp:JoinGroupMaster:eth0': {
                highRisk: true,
                confirmationRequired: true,
                risk: 'network-group'
            }
        }
    );
});

test('all literal loop and source commands in the UI pass their parameter grammars', () => {
    const literalUiCommands = [
        'setPlayerCmd:loopmode:0',
        'setPlayerCmd:loopmode:-1',
        'setPlayerCmd:loopmode:1',
        'setPlayerCmd:loopmode:2',
        'setPlayerCmd:switchmode:wifi',
        'setPlayerCmd:switchmode:bluetooth',
        'setPlayerCmd:switchmode:line-in',
        'setPlayerCmd:switchmode:optical',
        'setPlayerCmd:switchmode:co-axial',
        'setPlayerCmd:switchmode:udisk'
    ];
    for (const command of literalUiCommands) assert.equal(expectCommand(command).kind, 'write', command);
});

test('volume, mute, seek, loop, source, and preset boundaries are strict', () => {
    for (const command of [
        'setPlayerCmd:vol:0', 'setPlayerCmd:vol:100',
        'setPlayerCmd:mute:0', 'setPlayerCmd:mute:1',
        'setPlayerCmd:seek:0', `setPlayerCmd:seek:${LIMITS.seekSeconds}`
    ]) expectCommand(command);
    for (let preset = 1; preset <= 12; preset += 1) expectCommand(`MCUKeyShortClick:${preset}`);

    for (const command of [
        'setPlayerCmd:vol:-1', 'setPlayerCmd:vol:101', 'setPlayerCmd:vol:01', 'setPlayerCmd:vol:1.5',
        'setPlayerCmd:mute:2', 'setPlayerCmd:mute:true',
        'setPlayerCmd:seek:-1', `setPlayerCmd:seek:${LIMITS.seekSeconds + 1}`, 'setPlayerCmd:seek:1e3',
        'setPlayerCmd:loopmode:3', 'setPlayerCmd:loopmode:+1',
        'setPlayerCmd:switchmode:PCUSB', 'setPlayerCmd:switchmode:wifi:reboot',
        'MCUKeyShortClick:0', 'MCUKeyShortClick:13', 'MCUKeyShortClick:01'
    ]) expectRejected(command);
});

test('audio numeric controls enforce documented ranges and canonical steps', () => {
    for (const command of [
        'setChannelBalance:-1', 'setChannelBalance:-0.95', 'setChannelBalance:0',
        'setChannelBalance:0.05', 'setChannelBalance:1',
        'setSpdifOutSwitchDelayMs:0', `setSpdifOutSwitchDelayMs:${LIMITS.spdifDelayMs}`
    ]) expectCommand(command);

    for (const command of [
        'setChannelBalance:-1.05', 'setChannelBalance:1.05', 'setChannelBalance:0.01',
        'setChannelBalance:-0', 'setChannelBalance:1.0',
        'setSpdifOutSwitchDelayMs:-1', `setSpdifOutSwitchDelayMs:${LIMITS.spdifDelayMs + 1}`,
        'setSpdifOutSwitchDelayMs:0500'
    ]) expectRejected(command);
});

test('Bluetooth discovery and MAC controls accept only bounded canonical values', () => {
    expectCommand('startbtdiscovery:1');
    expectCommand(`startbtdiscovery:${LIMITS.bluetoothDiscoverySeconds}`);
    expectCommand('connectbta2dpsynk:aa:bb:cc:dd:ee:ff', 'connectbta2dpsynk:AA:BB:CC:DD:EE:FF');
    expectCommand('disconnectbta2dpsynk:01:23:45:67:89:AB');

    for (const command of [
        'startbtdiscovery:0', `startbtdiscovery:${LIMITS.bluetoothDiscoverySeconds + 1}`,
        'startbtdiscovery:01', 'connectbta2dpsynk:AA-BB-CC-DD-EE-FF',
        'connectbta2dpsynk:AA:BB:CC:DD:EE', 'disconnectbta2dpsynk:GG:00:00:00:00:00'
    ]) expectRejected(command);
});

test('shutdown is bounded and group joins require private canonical IPv4 plus confirmation', () => {
    for (const command of ['setShutdown:0', `setShutdown:${LIMITS.shutdownSeconds}`]) {
        const result = expectCommand(command);
        assert.equal(result.confirmationRequired, true);
        assert.equal(result.risk, 'scheduled-shutdown');
    }
    for (const command of [
        'ConnectMasterAp:JoinGroupMaster:eth10.0.0.5',
        'ConnectMasterAp:JoinGroupMaster:eth172.31.4.9',
        'ConnectMasterAp:JoinGroupMaster:eth192.168.0.170'
    ]) {
        const result = expectCommand(command);
        assert.equal(result.confirmationRequired, true);
        assert.equal(result.risk, 'network-group');
    }

    for (const command of [
        'setShutdown:-1', `setShutdown:${LIMITS.shutdownSeconds + 1}`, 'setShutdown:01',
        'ConnectMasterAp:JoinGroupMaster:eth8.8.8.8',
        'ConnectMasterAp:JoinGroupMaster:eth192.168.001.10',
        'ConnectMasterAp:JoinGroupMaster:eth192.168.1.999'
    ]) expectRejected(command, command.startsWith('ConnectMasterAp:') ? ERROR_CODES.FORBIDDEN : ERROR_CODES.INVALID_PARAMETER);
});

test('timeSync accepts real calendar timestamps only', () => {
    expectCommand('timeSync:20000101000000');
    expectCommand('timeSync:20240229235959');
    expectCommand('timeSync:20991231235959');

    for (const command of [
        'timeSync:19991231235959', 'timeSync:21000101000000', 'timeSync:20230229000000',
        'timeSync:20241301000000', 'timeSync:20240101240000', 'timeSync:20240101000060',
        'timeSync:2024-01-01T00'
    ]) expectRejected(command);
});

test('HTTP(S) play and playlist commands preserve the validated URL exactly', () => {
    for (const command of [
        'setPlayerCmd:play:https://radio.example/live.mp3?quality=high&name=one%20two',
        'setPlayerCmd:play:http://192.168.1.20:8080/stream',
        'setPlayerCmd:playlist:https://radio.example/list.m3u8?token=a:b:1',
        'setPlayerCmd:playlist:http://192.168.1.20/list.asx:1'
    ]) expectCommand(command);

    for (const [command, code] of [
        ['setPlayerCmd:play:ftp://radio.example/live.mp3', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:play:javascript:alert(1)', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:play:https://user:secret@radio.example/live.mp3', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:play:https://radio.example/a b', ERROR_CODES.INVALID_CHARACTERS],
        ['setPlayerCmd:play:https://radio.example/%0dheader', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:play:https://radio.example/%250dheader', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:play:https:\\evil.example\\stream', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:playlist:https://radio.example/list.m3u:0', ERROR_CODES.INVALID_PARAMETER],
        ['setPlayerCmd:playlist:https://radio.example/list.m3u:01', ERROR_CODES.INVALID_PARAMETER]
    ]) expectRejected(command, code);

    expectRejected(
        `setPlayerCmd:play:https://radio.example/${'a'.repeat(LIMITS.streamUrlLength)}`,
        ERROR_CODES.INVALID_LENGTH
    );
});

test('encoded gain, EQ band, light, and EQ preset inputs match the current UI contracts', () => {
    const gain = '{"config":[{"gain":"0","mode":"10","name":"wifi"}],"enable":1,"max_gain":"10.0","min_gain":"-10.0"}';
    const eqBand = '{"EQBand":[{"index":0,"param_name":"band31hz","value":60}]}';
    const light = '{"auto_sense_enable":0,"default_bright":1,"disable":0}';

    expectCommand(`setPlayModeGainConfig:${encodeURIComponent(gain)}`);
    expectCommand(`EQSetBand:${encodeURIComponent(eqBand)}`);
    expectCommand(`setLightOperationBrightConfig:${encodeURIComponent(light)}`);
    expectCommand('EQLoad:Flat');
    expectCommand(`EQLoad:${encodeURIComponent('Bass Booster')}`);
    expectCommand(`EQLoad:${encodeURIComponent('人聲 1')}`);
});

test('encoded JSON controls reject raw, double-encoded, oversized, noncanonical, and out-of-schema values', () => {
    const validGain = '{"config":[{"gain":"0","mode":"10","name":"wifi"}],"enable":1,"max_gain":"10.0","min_gain":"-10.0"}';
    const badJsonValues = [
        ['setPlayModeGainConfig:', '{"config":[]}'],
        ['setPlayModeGainConfig:', '{"config":[{"gain":"30","mode":"10","name":"wifi"}],"enable":1,"max_gain":"10.0","min_gain":"-10.0"}'],
        ['setPlayModeGainConfig:', '{"config":[{"gain":"0","mode":"10","name":"wifi"}],"enable":"1","max_gain":"10.0","min_gain":"-10.0"}'],
        ['setPlayModeGainConfig:', '{"config":[{"gain":"0","mode":"10","name":"wifi","command":"reboot"}],"enable":1,"max_gain":"10.0","min_gain":"-10.0"}'],
        ['EQSetBand:', '{"EQBand":[{"index":32,"param_name":"band31hz","value":60}]}'],
        ['EQSetBand:', '{"EQBand":[{"index":0,"param_name":"band31hz","value":100}]}'],
        ['setLightOperationBrightConfig:', '{"auto_sense_enable":0,"default_bright":101,"disable":0}'],
        ['setLightOperationBrightConfig:', '{"auto_sense_enable":0,"default_bright":1,"disable":0,"network":"x"}']
    ];
    for (const [prefix, json] of badJsonValues) expectRejected(`${prefix}${encodeURIComponent(json)}`);

    expectRejected(`setPlayModeGainConfig:${validGain}`, ERROR_CODES.NON_CANONICAL_ENCODING);
    expectRejected(
        `setPlayModeGainConfig:${encodeURIComponent(encodeURIComponent(validGain))}`,
        ERROR_CODES.INVALID_PARAMETER
    );
    expectRejected(
        `setPlayModeGainConfig:${encodeURIComponent(`{"config":"${'x'.repeat(LIMITS.jsonLength)}"}`)}`,
        ERROR_CODES.INVALID_LENGTH
    );
    expectRejected(
        `EQSetBand:${encodeURIComponent('{ "EQBand":[] }')}`,
        ERROR_CODES.NON_CANONICAL_ENCODING
    );
    expectRejected('EQLoad:Bass%20Booster%2fReset', ERROR_CODES.NON_CANONICAL_ENCODING);
    expectRejected(`EQLoad:${encodeURIComponent('../Factory Reset')}`);
});

test('type, length, control-character, whitespace, case, and encoded-name bypasses fail closed', () => {
    for (const value of [undefined, null, 42, ['reboot'], Buffer.from('reboot'), new String('reboot')]) {
        expectRejected(value, ERROR_CODES.INVALID_TYPE);
    }
    expectRejected('', ERROR_CODES.INVALID_LENGTH);
    expectRejected('x'.repeat(LIMITS.commandLength + 1), ERROR_CODES.INVALID_LENGTH);

    for (const [command, code] of [
        [' reboot', ERROR_CODES.INVALID_CHARACTERS],
        ['reboot ', ERROR_CODES.INVALID_CHARACTERS],
        ['re\tboot', ERROR_CODES.INVALID_CHARACTERS],
        ['re\nboot', ERROR_CODES.INVALID_CHARACTERS],
        ['re\0boot', ERROR_CODES.INVALID_CHARACTERS],
        ['Reboot', ERROR_CODES.UNKNOWN],
        ['SETPLAYERCMD:VOL:10', ERROR_CODES.UNKNOWN],
        ['%72eboot', ERROR_CODES.NON_CANONICAL_ENCODING],
        ['reboot%00', ERROR_CODES.NON_CANONICAL_ENCODING],
        ['setPlayerCmd%3Avol%3A10', ERROR_CODES.NON_CANONICAL_ENCODING],
        ['setPlayerCmd:vol:%31%30', ERROR_CODES.INVALID_PARAMETER]
    ]) expectRejected(command, code);
});

test('reset, firmware, update, shutdown, arbitrary network config, malformed groups, and unknown commands are rejected', () => {
    for (const command of [
        'reset', 'factoryReset', 'restoreFactory', 'resetFactory',
        'firmware:update', 'update:firmware', 'otaUpdate', 'firmwareUpgrade',
        'shutdown', 'poweroff',
        'setStaticIpInfo:192.168.1.2', 'setNetwork:ssid:evil', 'wlanSetConnect:evil',
        'ConnectMasterAp:JoinGroupMaster:wlan192.168.1.2'
    ]) expectRejected(command, ERROR_CODES.FORBIDDEN);

    for (const command of ['getNewAudioOutputHardwareMode', 'setAlarmClock:1:payload', 'arbitrary:command']) {
        expectRejected(command, ERROR_CODES.UNKNOWN);
    }
});

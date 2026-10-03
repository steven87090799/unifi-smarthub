'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { connectionObservation } = require('../server/services/connection-observation');
const { parseHistoryHoursQuery } = require('../server/policies/query-input-policy');
const { presentUnifiDeviceTelemetry } = require('../server/services/unifi-device-telemetry');

test('connection transitions follow real samples, not two-second cache expiry or repeated watcher ticks', () => {
    const success = { lastSuccessAt: 1000, consecutiveFailures: 0, lastErrorAt: null, healthy: false };
    for (const now of [5000, 21000, 601000, 1201000]) assert.equal(connectionObservation(success, 600000, now), true);
    assert.equal(connectionObservation(success, 600000, 1802000), null);
    assert.equal(connectionObservation({ ...success, consecutiveFailures: 1, lastErrorAt: 3000 }, 600000, 4000), null);
    assert.equal(connectionObservation({ ...success, consecutiveFailures: 2, lastErrorAt: 3000 }, 600000, 4000), false);
    assert.equal(connectionObservation(null, 1000), null);
});
test('short UPS windows use bounded integer minutes without weakening legacy hour validation', () => {
    assert.deepEqual(parseHistoryHoursQuery({ minutes: '10' }), { hours: 1 / 6 });
    assert.deepEqual(parseHistoryHoursQuery({ minutes: '30' }), { hours: 0.5 });
    for (const query of [{ minutes: '0' }, { minutes: '1.5' }, { minutes: ['10','30'] }, { minutes: '525601' }, { minutes: '10', hours: '1' }, { hours: '0.5' }]) assert.throws(() => parseHistoryHoursQuery(query));
});
test('radio live statistics join configuration; missing capabilities stay unknown', () => {
    const d = presentUnifiDeviceTelemetry([{mac:'aa:bb:cc:dd:ee:ff',state:1,radio_table:[{name:'wifi0',radio:'ng',ht:20}],radio_table_stats:[{name:'wifi0',channel:6,cu_total:23,num_sta:4}]}]).devices[0];
    assert.equal(d.radios[0].channel, 6); assert.equal(d.radios[0].utilizationPercent, 23); assert.equal(d.radios[0].channelWidthMhz,20);
    const empty = presentUnifiDeviceTelemetry([{mac:'aa:bb:cc:dd:ee:01',state:1}]).devices[0];
    assert.equal(empty.clientCount,null); assert.equal(empty.uplink.state,null);
});
test('gateway SSH temperature retains its distinct source and original sample time', () => {
    const d = presentUnifiDeviceTelemetry([{mac:'aa:bb:cc:dd:ee:01',state:1,type:'udm'}], {directThermalByDevice:new Map([['aa:bb:cc:dd:ee:01',{status:'supported',source:'ucg_ssh',thermal:{maxTemperatureC:52,sampledAt:'2026-09-22T00:00:00Z'}}]])}).devices[0];
    assert.equal(d.temperature.value,52); assert.equal(d.temperature.source,'ucg_ssh'); assert.equal(d.temperature.sampledAt,'2026-09-22T00:00:00Z');
});
test('notification page hydration includes settings, and reports a failed fetch for retry', async () => {
    const app=fs.readFileSync(require.resolve('../public/js/app.js'),'utf8');
    assert.match(app,/notify: \['notifSettings', 'notifLog'\]/);
    const source=app.slice(app.indexOf('async function fetchNotifSettings()'),app.indexOf('async function saveNotifSettings()'));
    const context={ fetch:async()=>({ok:false}), console:{error(){}}, document:{getElementById(){throw new Error('must not reset form on failed request');}} };
    vm.createContext(context); vm.runInContext(source,context);
    assert.equal((await context.fetchNotifSettings()).retryable,true);
});

test('UPS history errors cannot masquerade as an empty successful chart', async () => {
    const app=fs.readFileSync(require.resolve('../public/js/app.js'),'utf8');
    const source=app.slice(app.indexOf('async function readUpsHistory('),app.indexOf('let upsHistoryGeneration'));
    let url;
    const context={fetch:async u=>{url=u;return {ok:true,json:async()=>({history:[{inV:112}]})}}};
    vm.createContext(context);vm.runInContext(source,context);
    assert.equal((await context.readUpsHistory(1/6)).length,1);assert.equal(url,'/api/ups/history?minutes=10');
    context.fetch=async()=>({ok:false,status:400,json:async()=>({error:'invalid'})});
    await assert.rejects(context.readUpsHistory(0.5),/HTTP 400/);
});

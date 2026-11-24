const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPoller}=require('../dmama-poller.cjs');
test('retains source timestamp and legitimate zero; excludes missing values and credentials',async()=>{
 let saved;
 const p=createPoller({collect:async()=>({stationId:'test',observedAt:'2026-10-22T00:00:00Z',token:'private',readings:{flow:0,pressure:2.1,missing:null,bad:NaN}}),persist:async s=>{saved=s;}});
 await p.tick();assert.equal(saved.observedAt,'2026-10-22T00:00:00Z');assert.deepEqual(saved.readings,{flow:0,pressure:2.1});assert.equal(saved.token,undefined);
});
test('failed fetch does not overwrite last sample or disclose upstream errors',async()=>{
 const states=[];let writes=0;
 const p=createPoller({collect:async()=>{throw Error('secret token');},persist:async()=>writes++,onStatus:s=>states.push(s)});
 await p.tick();assert.equal(writes,0);assert.deepEqual(states,[{state:'error'}]);
});
test('concurrent ticks share one request',async()=>{
 let release,calls=0;const pending=new Promise(r=>release=r);
 const p=createPoller({collect:async()=>{calls++;await pending;return null;},persist:async()=>{}});
 const a=p.tick(),b=p.tick();release();await Promise.all([a,b]);assert.equal(calls,1);
});
test('abort suppresses saving late response',async()=>{
 let release,writes=0;const pending=new Promise(r=>release=r);
 const p=createPoller({collect:async()=>{await pending;return {stationId:'test',observedAt:new Date().toISOString(),readings:{flow:1}};},persist:async()=>writes++});
 const a=p.tick(),stop=p.stop();release();await Promise.all([a,stop]);assert.equal(writes,0);
});

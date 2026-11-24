const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { validateSample, recordSample } = require('../lora');
const sample = { session: 42, sequence: 1, value: -12.34, rssi: -87, snr: 7.25, ageMs: 3000 };

test('numeric bounds, missing fields and invalid types are rejected', () => {
  assert.deepEqual(validateSample(sample), { ...sample, tankLevel: sample.value, tankMax: 10000, pumpMask: null, pumpKnownMask: 0 });
  assert.ok(validateSample({ ...sample, value: 0 }));
  for (const changes of [{value:null}, {value:'1'}, {value:Infinity}, {value:1000001}, {sequence:-1}, {sequence:1.5}, {ageMs:300001}, {rssi:200}, {snr:NaN}]) {
    assert.equal(validateSample({...sample,...changes}), null);
  }
  assert.equal(validateSample({}), null);
});

test('retries do not refresh sample age; rollover and sender restart work', () => {
  const db = {};
  assert.equal(recordSample(db, 'LORA-0001', sample, 100000), true);
  assert.equal(Date.parse(db.loraReadings['LORA-0001'].receivedAt), 97000);
  assert.equal(recordSample(db, 'LORA-0001', sample, 200000), false);
  assert.equal(Date.parse(db.loraReadings['LORA-0001'].uploadedAt), 100000);
  assert.equal(recordSample(db, 'LORA-0001', {...sample,sequence:0}), false);
  assert.equal(recordSample(db, 'LORA-0001', {...sample,session:43,sequence:0xffffffff}), true);
  assert.equal(recordSample(db, 'LORA-0001', {...sample,session:43,sequence:0}), true);
});

function makeServer() {
  const root = path.resolve(__dirname, '..');
  const files = new Map([
    [path.join(root,'data','db.json'), JSON.stringify({users:[{id:'owner'},{id:'other'}],sessions:[{token:'owner-token',userId:'owner'},{token:'other-token',userId:'other'}],userDevices:[{deviceId:'LORA-0001',userId:'owner'}],commandLogs:[]})],
    [path.join(root,'data','registry.json'), JSON.stringify({rows:[{device_id:'LORA-0001',device_secret:'test-only',status:'active'}]})]
  ]);
  let handler;
  const fakeFs = {existsSync:p=>files.has(p),mkdirSync(){},readFileSync:p=>files.get(p),writeFileSync:(p,v)=>files.set(p,v)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'server.js'),'utf8'), {
    require(name) {
      if(name==='fs') return fakeFs;
      if(name==='http') return {createServer:fn=>{handler=fn;return {listen(){}}}};
      if(name==='mqtt') throw new Error('disabled');
      if(name==='./lora') return {validateSample,recordSample};
      return require(name);
    },
    __dirname:root, process:{env:{}}, console:{log(){},warn(){},error(){}},
    setInterval(){}, URL, Buffer,
    fetch:async()=>{throw new Error('Tests must not access live services');}
  });
  return async (method, url, body, token) => {
    const req = new EventEmitter();
    Object.assign(req,{method,url,headers:{host:'localhost',authorization:token?`Bearer ${token}`:''}});
    let code, result;
    const promise = handler(req,{writeHead:c=>code=c,end:b=>result=JSON.parse(b)});
    if(body !== undefined) req.emit('data',JSON.stringify(body));
    req.emit('end');
    await promise;
    return {code,body:result};
  };
}

test('actual HTTP handlers enforce device credentials and account ownership', async () => {
  const request = makeServer();
  const payload = {...sample,deviceId:'LORA-0001',deviceSecret:'test-only'};
  assert.equal((await request('POST','/api/device/lora',{...payload,deviceSecret:'wrong'})).code,401);
  assert.equal((await request('POST','/api/device/lora',{...payload,value:null})).code,400);
  assert.equal((await request('POST','/api/device/lora',payload)).code,200);
  assert.equal((await request('POST','/api/device/lora',payload)).body.updated,false);
  assert.equal((await request('GET','/api/devices/LORA-0001/lora')).code,401);
  assert.equal((await request('GET','/api/devices/LORA-0001/lora',undefined,'other-token')).code,404);
  const read = await request('GET','/api/devices/LORA-0001/lora',undefined,'owner-token');
  assert.equal(read.code,200);
  assert.equal(read.body.sample.value,-12.34);
  assert.equal('deviceSecret' in read.body.sample,false);
});

test('pump telemetry preserves selected P12/P13 and never defaults missing status to STOP', () => {
  const result = validateSample({...sample, pumpMask:6, pumpKnownMask:6});
  assert.equal(result.pumpMask,6); assert.equal(result.pumpKnownMask,6);
  for (const pumpMask of [undefined, null, -1, 16, 1.5, '6']) assert.equal(validateSample({...sample,pumpMask}).pumpMask,null);
  assert.equal(validateSample({...sample,pumpMask:6}).pumpKnownMask,15);
  assert.equal(validateSample({...sample,pumpMask:6,pumpKnownMask:null}).pumpKnownMask,0);
});

test('high-lift readings survive ingestion and the public SCADA endpoint', async () => {
  const request = makeServer();
  const data = {...sample, deviceId:'LORA-0001', deviceSecret:'test-only', tankKnown:false,
    highPumpMask:45, highPumpKnownMask:127, cityPressure:4.4, banLaemFlow:2193, cityFlow:0, hatChaoFlow:null};
  assert.equal((await request('POST','/api/device/lora',data)).code,200);
  const result = (await request('GET','/api/public/scada/LORA-0001')).body.sample;
  assert.equal(result.highPumpMask,45);
  assert.equal(result.highPumpKnownMask,127);
  assert.equal(result.cityPressure,4.4);
  assert.equal(result.banLaemFlow,2193);
  assert.equal(result.cityFlow,0);
  assert.equal(result.hatChaoFlow,null);
  assert.equal(result.tankKnown,false);
  assert.equal('deviceSecret' in result,false);
});

test('invalid high-lift values are not converted into zero or STOP', () => {
  const result = validateSample({...sample,highPumpMask:128,highPumpKnownMask:127,cityPressure:'4.4',cityFlow:-1,banLaemFlow:Infinity});
  assert.equal(result.highPumpMask,null);
  assert.equal(result.highPumpKnownMask,0);
  for(const key of ['cityPressure','cityFlow','banLaemFlow']) assert.equal(result[key],null);
  assert.equal(validateSample({...sample,highPumpMask:1,highPumpKnownMask:0}).highPumpKnownMask,0);
});

test('two senders retain independent samples, duplicate tracking, and timestamps', async () => {
  const request=makeServer();
  const creds={deviceId:'LORA-0001',deviceSecret:'test-only'};
  const first={...sample,...creds,tankLevel:9207,pumpMask:12,pumpKnownMask:15};
  const second={...sample,...creds,sourceId:2,value:4.98,pumpMask:1,pumpKnownMask:3,maintenanceMask:0,rawLevel:4.98,banLat1Pressure:2.95,banLat1Flow:0};
  assert.equal((await request('POST','/api/device/lora',first)).body.updated,true);
  assert.equal((await request('POST','/api/device/lora',second)).body.updated,true);
  assert.equal((await request('POST','/api/device/lora',first)).body.updated,false);
  assert.equal((await request('POST','/api/device/lora',second)).body.updated,false);
  let one=(await request('GET','/api/public/scada/LORA-0001')).body.sample;
  let two=(await request('GET','/api/public/scada/LORA-0001?sourceId=2')).body.sample;
  assert.equal(one.tankLevel,9207); assert.equal(one.pumpMask,12);
  assert.equal(two.rawLevel,4.98); assert.equal(two.banLat1Pressure,2.95); assert.equal(two.banLat1Flow,0);
  assert.equal(two.pumpMask,1); assert.equal(two.tankKnown,false);
  const received=two.receivedAt;
  await request('POST','/api/device/lora',{...first,sequence:2});
  two=(await request('GET','/api/public/scada/LORA-0001?sourceId=2')).body.sample;
  assert.equal(two.receivedAt,received); assert.equal(two.sequence,1);
  assert.equal((await request('GET','/api/devices/LORA-0001/lora?sourceId=2',undefined,'other-token')).code,404);
  assert.equal((await request('GET','/api/public/scada/LORA-0001?sourceId=4')).code,400);
  assert.equal((await request('POST','/api/device/lora',{...second,sourceId:3})).code,400);
});

test('Mini uses its own source and preserves unknown readings without changing Ban Lat', async () => {
  const request=makeServer();
  const creds={deviceId:'LORA-0001',deviceSecret:'test-only'};
  const mini={...sample,...creds,sourceId:3,operation:'RUN',lt3:1.27,volume:3178,beforeConductivity:157,beforePh:7.43,afterConductivity:9,afterPh:6.81};
  await request('POST','/api/device/lora',{...sample,...creds});
  assert.equal((await request('POST','/api/device/lora',mini)).body.updated,true);
  assert.equal((await request('POST','/api/device/lora',mini)).body.updated,false);
  let saved=(await request('GET','/api/public/scada/LORA-0001?sourceId=3')).body.sample;
  assert.equal(saved.lt3,1.27); assert.equal(saved.volume,3178); assert.equal(saved.operation,'RUN');
  assert.equal(saved.beforeConductivity,157); assert.equal(saved.beforePh,7.43);
  assert.equal(saved.afterConductivity,9); assert.equal(saved.afterPh,6.81);
  const invalid=validateSample({...mini,beforePh:15,afterConductivity:'9'});
  assert.equal(invalid.beforePh,null); assert.equal(invalid.afterConductivity,null);
  assert.equal(saved.tankKnown,false); assert.equal(saved.meterFilter,undefined);
  assert.equal((await request('GET','/api/public/scada/LORA-0001')).body.sample.value,sample.value);
  await request('POST','/api/device/lora',{...mini,sequence:2,operation:'UNKNOWN',lt3:null,volume:null});
  saved=(await request('GET','/api/public/scada/LORA-0001?sourceId=3')).body.sample;
  assert.equal(saved.lt3,null); assert.equal(saved.volume,null); assert.equal(saved.operation,'UNKNOWN');
  assert.equal((await request('GET','/api/devices/LORA-0001/lora?sourceId=3',undefined,'other-token')).code,404);
});

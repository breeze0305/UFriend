const test = require('node:test');
const assert = require('node:assert/strict');
const {ModelPoolScheduler} = require('../app/services/model-pool.cjs');

function harness(options = {}) {
  let now = 0;
  const events = [];
  const pool = new ModelPoolScheduler({clock:()=>now,loadMs:10,unloadMs:5,onEvent:e=>events.push(e),...options});
  return {pool,events,step(ms=0){now+=ms;pool.tick();return pool.snapshot();},snapshot:()=>pool.snapshot()};
}
const job = (h,id) => h.snapshot().jobs.find(j=>j.id===id);
const device = (h,id) => h.snapshot().devices.find(d=>d.id===id);

test('empty pool preserves FIFO work; resident policy reuses the loaded model indefinitely',()=>{
  const h=harness();
  h.pool.setPolicy({idleMs:20});
  const first=h.pool.submit({model:'llm',durationMs:20});
  const second=h.pool.submit({model:'llm',durationMs:20});
  assert.equal(h.snapshot().queueLength,2);
  h.step(100);
  assert.equal(job(h,first).state,'queued');
  const d=h.pool.addDevice();
  assert.equal(job(h,first).state,'preparing');
  h.step(10);
  assert.equal(job(h,first).state,'running');
  h.step(20);
  assert.equal(job(h,first).state,'completed');
  assert.equal(job(h,second).state,'running');
  h.step(20);h.step(1000);
  assert.equal(device(h,d).model,'llm');
  assert.equal(device(h,d).state,'ready');
  assert.equal(h.events.filter(e=>e.type==='model-loading').length,1);
});

test('FIFO demand uses idle matching model, then empty device, then least recently idle device',()=>{
  const h=harness(),a=h.pool.addDevice(),b=h.pool.addDevice();
  const llm=h.pool.submit({model:'llm',durationMs:10});
  const ocr=h.pool.submit({model:'ocr',durationMs:20});
  h.step(10);h.step(10);h.step(10);
  assert.equal(job(h,llm).deviceId,a);assert.equal(job(h,ocr).deviceId,b);
  const match=h.pool.submit({model:'ocr',durationMs:5});
  assert.equal(job(h,match).deviceId,b);
  h.step(5);
  const empty=h.pool.addDevice();
  const whisper=h.pool.submit({model:'whisper',durationMs:5});
  assert.equal(job(h,whisper).deviceId,empty);
  h.step(10);h.step(5);
  const reuse=h.pool.submit({model:'whisper',durationMs:100});
  assert.equal(job(h,reuse).deviceId,empty);
  const replace=h.pool.submit({model:'whisper',durationMs:5});
  assert.equal(job(h,replace).deviceId,a);
  assert.equal(device(h,a).state,'unloading');
  assert.equal(device(h,b).state,'ready');
});

test('all busy devices queue demand without interruption and release to oldest waiting job',()=>{
  const h=harness(),d=h.pool.addDevice();
  const first=h.pool.submit({model:'llm',durationMs:20});
  h.step(10);
  const second=h.pool.submit({model:'ocr',durationMs:5});
  const third=h.pool.submit({model:'whisper',durationMs:5});
  h.step(19);
  assert.equal(job(h,first).state,'running');assert.equal(h.snapshot().queueLength,2);
  h.step(1);
  assert.equal(job(h,first).state,'completed');assert.equal(job(h,second).state,'preparing');
  assert.equal(job(h,third).state,'queued');assert.equal(device(h,d).target,'ocr');
  h.step(5);h.step(10);h.step(5);
  assert.equal(job(h,second).state,'completed');assert.equal(job(h,third).state,'preparing');
});

test('offload counts idle time separately per device and never unloads running work',()=>{
  const h=harness(),a=h.pool.addDevice(),b=h.pool.addDevice();
  h.pool.setPolicy({mode:'offload',idleMs:30});
  h.pool.submit({model:'llm',durationMs:10});
  h.pool.submit({model:'ocr',durationMs:80});
  h.step(10);h.step(10);h.step(29);
  assert.equal(device(h,a).state,'ready');assert.equal(device(h,b).state,'running');
  h.step(1);
  assert.equal(device(h,a).state,'unloading');assert.equal(device(h,b).state,'running');
  h.step(5);h.step(35);
  assert.equal(device(h,a).state,'empty');assert.equal(device(h,b).state,'ready');
  h.step(29);assert.equal(device(h,b).state,'ready');
  h.step(1);assert.equal(device(h,b).state,'unloading');
});

test('preferred policy reserves one pool copy, replaces other idle models, and allows demand copies',()=>{
  const h=harness();h.pool.addDevice();h.pool.addDevice();
  h.pool.setPolicy({mode:'preferred',preferred:'llm',idleMs:20});
  h.pool.submit({model:'ocr',durationMs:10});h.pool.submit({model:'whisper',durationMs:10});
  h.step(10);h.step(10);h.step(20);
  assert.equal(h.snapshot().devices.filter(d=>d.target==='llm').length,1);
  h.step(5);h.step(10);
  assert.equal(h.snapshot().devices.filter(d=>d.model==='llm').length,1);
  assert.equal(h.snapshot().devices.filter(d=>d.state==='empty').length,1);
  const first=h.pool.submit({model:'llm',durationMs:10});
  const second=h.pool.submit({model:'llm',durationMs:10});
  h.step(10);h.step(10);
  assert.equal(job(h,first).state,'completed');assert.equal(job(h,second).state,'completed');
  assert.equal(h.snapshot().devices.filter(d=>d.model==='llm').length,2);
  h.step(20);h.step(5);
  assert.equal(h.snapshot().devices.filter(d=>d.model==='llm').length,1);
  assert.equal(h.snapshot().devices.filter(d=>d.state==='empty').length,1);
});

test('policy changes cancel speculative preparation but preserve user preparation and execution',()=>{
  const h=harness(),d=h.pool.addDevice();
  h.pool.setPolicy({mode:'preferred',preferred:'llm',idleMs:0});
  assert.equal(device(h,d).state,'loading');
  h.pool.setPolicy({mode:'resident'});
  assert.equal(device(h,d).state,'empty');
  h.step(10);
  assert.equal(h.events.filter(e=>e.type==='model-ready').length,0);
  const id=h.pool.submit({model:'ocr',durationMs:20});
  h.pool.setPolicy({mode:'offload',idleMs:1});
  assert.equal(job(h,id).state,'preparing');
  h.step(10);
  h.pool.setPolicy({mode:'preferred',preferred:'whisper'});
  assert.equal(job(h,id).state,'running');
  h.step(20);
  assert.equal(job(h,id).state,'completed');
  assert.equal(h.events.filter(e=>e.type==='job-completed'&&e.jobId===id).length,1);
});

test('removing a device fails its preparing/running job once and never emits a stale completion',()=>{
  for(const startRunning of [false,true]) {
    const h=harness(),d=h.pool.addDevice();
    const id=h.pool.submit({model:'whisper',durationMs:10});
    if(startRunning)h.step(10);
    const waiting=h.pool.submit({model:'ocr',durationMs:10});
    assert.equal(h.pool.removeDevice(d),true);assert.equal(h.pool.removeDevice(d),false);
    h.step(1000);
    assert.equal(job(h,id).state,'failed');assert.equal(job(h,id).deviceId,null);
    assert.equal(h.events.filter(e=>e.type==='job-failed'&&e.jobId===id).length,1);
    assert.equal(h.events.filter(e=>e.type==='job-completed'&&e.jobId===id).length,0);
    assert.equal(job(h,waiting).state,'queued');
    const replacement=h.pool.addDevice();assert.notEqual(replacement,d);
    h.step(10);h.step(10);assert.equal(job(h,waiting).state,'completed');
  }
});

test('cancellation releases simulation resources and does not deliver stale completion',()=>{
  for(const startRunning of [false,true]) {
    const h=harness(),d=h.pool.addDevice();
    const id=h.pool.submit({model:'llm',durationMs:10});if(startRunning)h.step(10);
    const waiting=h.pool.submit({model:'llm',durationMs:10});
    assert.equal(h.pool.cancelJob(id),true);assert.equal(h.pool.cancelJob(id),false);
    assert.equal(job(h,waiting).state,startRunning?'running':'preparing');
    h.step(10);h.step(10);
    assert.equal(job(h,id).state,'cancelled');assert.equal(job(h,waiting).state,'completed');
    assert.equal(device(h,d).state,'ready');
    assert.equal(h.events.filter(e=>e.type==='job-completed'&&e.jobId===id).length,0);
  }
});

test('snapshots are isolated; progress is monotonic and event callbacks cannot recurse into tick',()=>{
  let h,callbacks=0;const progress=[];
  h=harness({onEvent:()=>{callbacks++;h.pool.tick();}});
  h.pool.addDevice();
  const id=h.pool.submit({model:'llm',durationMs:10,onProgress:p=>{progress.push(p);h.pool.tick();}});
  const copy=h.snapshot();copy.policy.mode='offload';copy.devices.length=0;copy.jobs[0].state='failed';
  assert.equal(h.snapshot().policy.mode,'resident');assert.equal(h.snapshot().devices.length,1);
  assert.equal(job(h,id).state,'preparing');
  h.step(10);h.step(5);h.step(5);h.step(100);
  assert.deepEqual(progress,[0,50,100]);assert.ok(callbacks<20);
  assert.equal(job(h,id).state,'completed');
});

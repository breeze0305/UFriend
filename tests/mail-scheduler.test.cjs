'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {MailScheduler,mailSchedule,DEFAULT_MAIL_SCHEDULE_STATE}=require('../app/services/mail-scheduler.cjs');
function fixture(run=()=>{}){
  let date=new Date(2026,8,13,8,59),busy=false;
  const data={settings:{modelDefaults:{llm:'local'},mailSchedule:{enabled:true,time:'09:00'}},mailScheduleState:{...DEFAULT_MAIL_SCHEDULE_STATE}},calls=[];
  const scheduler=new MailScheduler({read:()=>structuredClone(data),save:state=>{data.mailScheduleState=state;},now:()=>date,isBusy:()=>busy,run:settings=>{calls.push(settings);return run(settings);}});
  return{scheduler,data,calls,time:value=>{date=value;},busy:value=>{busy=value;}};
}
test('daily schedule waits until the configured local minute and claims today only once',async()=>{
  const f=fixture();assert.equal(await f.scheduler.tick(),false);f.time(new Date(2026,8,13,9,0));assert.equal(await f.scheduler.tick(),true);
  assert.equal(f.data.mailScheduleState.lastScheduledDate,'2026-09-13');assert.equal(f.data.mailScheduleState.status,'done');assert(f.data.mailScheduleState.lastCompletedAt);
  f.time(new Date(2026,8,13,23,59));assert.equal(await f.scheduler.tick(),false);assert.equal(f.calls.length,1);
});
test('resume catches up only today and a clock rollback cannot duplicate completed days',async()=>{
  const f=fixture();f.time(new Date(2026,8,16,18,0));await f.scheduler.tick();assert.equal(f.calls.length,1);
  f.time(new Date(2026,8,15,18,0));assert.equal(await f.scheduler.tick(),false);
  f.time(new Date(2026,8,17,8,59));assert.equal(await f.scheduler.tick(),false);f.time(new Date(2026,8,17,9,0));await f.scheduler.tick();assert.equal(f.calls.length,2);
});
test('disabled or busy scheduler does not claim a date and can run once it is free',async()=>{
  const f=fixture();f.time(new Date(2026,8,13,12,0));f.data.settings.mailSchedule.enabled=false;assert.equal(await f.scheduler.tick(),false);
  f.data.settings.mailSchedule.enabled=true;f.busy(true);assert.equal(await f.scheduler.tick(),false);assert.equal(f.data.mailScheduleState.lastScheduledDate,'');
  f.busy(false);await f.scheduler.tick();assert.equal(f.calls.length,1);
});
test('running job captures settings and cannot overlap or re-run after a restart',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));f.time(new Date(2026,8,13,9,0));const pending=f.scheduler.tick();
  assert.equal(f.data.mailScheduleState.status,'running');assert.equal(await f.scheduler.tick(),false);
  f.data.settings.modelDefaults.llm='cloud';assert.equal(f.calls[0].modelDefaults.llm,'local');
  const restored=new MailScheduler({read:()=>f.data,save:()=>assert.fail('already claimed'),run:()=>assert.fail('duplicate'),now:()=>new Date(2026,8,13,10,0)});
  assert.equal(await restored.tick(),false);release();await pending;
});
test('failure persists without repeated retries and partial failures never appear completed successfully',async()=>{
  const f=fixture(()=>{throw new Error('Synthetic offline model');});f.time(new Date(2026,8,13,10,0));await f.scheduler.tick();
  assert.equal(f.data.mailScheduleState.status,'error');assert.match(f.data.mailScheduleState.error,/offline/);assert.equal(f.data.mailScheduleState.lastCompletedAt,'');assert.equal(await f.scheduler.tick(),false);
  const partial=fixture(()=>({status:'error',error:'One account failed to sync.'}));partial.time(new Date(2026,8,13,10,0));await partial.scheduler.tick();assert.equal(partial.data.mailScheduleState.status,'error');
});
test('failed durable claim never dispatches a model and leaves the scheduler retryable',async()=>{
  const f=fixture();f.time(new Date(2026,8,13,10,0));const save=f.scheduler.save;f.scheduler.save=()=>{throw new Error('disk full');};await assert.rejects(f.scheduler.tick(),/disk full/);
  assert.equal(f.calls.length,0);assert.equal(f.scheduler.running,false);f.scheduler.save=save;await f.scheduler.tick();assert.equal(f.calls.length,1);
});
test('editing the daily time preserves enabled state and never causes a second run on the same date',async()=>{
  const f=fixture();f.time(new Date(2026,8,13,10,0));await f.scheduler.tick();f.data.settings.mailSchedule=mailSchedule({time:'11:00'},f.data.settings.mailSchedule);
  assert(f.data.settings.mailSchedule.enabled);f.time(new Date(2026,8,13,11,0));assert.equal(await f.scheduler.tick(),false);
});

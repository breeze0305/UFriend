'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {clearMeetingMedia}=require('../app/services/media-cleanup.cjs');

const root=path.resolve(__dirname,'../.test-data/recording-queue-tests');
function clock(){
  let timestamp=Date.parse('2030-01-02T03:00:00Z'),sequence=0;const timers=new Map();
  const api={now:()=>timestamp,setTimer(fn,delay){const id=++sequence;timers.set(id,{fn,at:timestamp+delay});return id;},clearTimer:id=>timers.delete(id),advance:milliseconds=>{timestamp+=milliseconds;},timerCount:()=>timers.size,
    async flush(){for(let pass=0;pass<100;pass++){await new Promise(setImmediate);const next=[...timers].sort((a,b)=>a[1].at-b[1].at).find(([,timer])=>timer.at<=timestamp);if(!next)return;timers.delete(next[0]);next[1].fn();}throw new Error('Scheduler spun without waiting.');}};
  return api;
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const result=text=>({segments:[{start:0,end:1,text}]});
const busy=()=>Object.assign(new Error('Synthetic busy server'),{code:'MODEL_API_BUSY'});
async function fixture(t,{count=3,run}={}){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-')),store=new Store({dataDir}),models=new ModelAdapters(),requests=[],fake=clock();
  models.register('whisper',{run:request=>{const work=deferred();requests.push({...request,...work});return run?run(request,requests.length):work.promise;}});
  const core=new AppService({store,dataDir,models});
  store.update(d=>{for(let index=1;index<=count;index++){d.assets.push({id:'asset-'+index,file:index+'.wav',name:index+'.wav',category:'recording',mediaType:'audio'});d.recordings.push({id:'recording-'+index,assetId:'asset-'+index,name:index+'.wav',type:'audio',lang:'zh-TW',state:'waiting-model',segments:[],textOnly:null});}});
  t.after(async()=>{core.stopRecordingScheduler();for(const controller of core.active.values())controller.abort();for(const request of requests)request.resolve({segments:[]});assert.equal(path.dirname(path.resolve(dataDir)),root);await fs.rm(dataDir,{recursive:true,force:true});});
  return{core,store,models,dataDir,requests,clock:fake,start:()=>core.startRecordingScheduler(fake),record:id=>core.snapshot().recordings.find(recording=>recording.id===id)};
}

test('queued transcription runs one at a time in chosen FIFO order and completes each recording',async t=>{
  const f=await fixture(t);f.start();f.core.queueRecordings(['recording-2','recording-1','recording-3']);await f.clock.flush();
  assert.equal(f.requests.length,1);assert.match(f.requests[0].input.filePath,/2\.wav$/);assert.equal(f.record('recording-1').state,'queued');assert.equal(f.record('recording-2').state,'running');
  f.requests[0].resolve(result('second chosen first'));await f.clock.flush();assert.equal(f.requests.length,2);assert.match(f.requests[1].input.filePath,/1\.wav$/);
  f.requests[1].resolve(result('first chosen second'));await f.clock.flush();assert.equal(f.requests.length,3);assert.match(f.requests[2].input.filePath,/3\.wav$/);
  f.requests[2].resolve(result('third'));await f.clock.flush();assert.deepEqual(f.core.snapshot().recordings.map(recording=>recording.state),['done','done','done']);assert.equal(f.clock.timerCount(),0);
});

test('future jobs do not block immediate jobs and start after their persisted due time',async t=>{
  const f=await fixture(t);f.start();const scheduledAt=new Date(f.clock.now()+60000).toISOString();
  f.core.queueRecordings(['recording-1'],{scheduledAt});f.core.queueRecordings(['recording-2']);await f.clock.flush();
  assert.equal(f.record('recording-1').state,'scheduled');assert.equal(f.requests.length,1);assert.match(f.requests[0].input.filePath,/2\.wav$/);
  f.requests[0].resolve(result('immediate'));await f.clock.flush();f.clock.advance(59999);await f.clock.flush();assert.equal(f.requests.length,1);
  f.clock.advance(1);await f.clock.flush();assert.equal(f.requests.length,2);assert.match(f.requests[1].input.filePath,/1\.wav$/);assert.equal(f.record('recording-1').scheduledAt,undefined);
  f.requests[1].resolve(result('scheduled'));await f.clock.flush();assert.equal(f.record('recording-1').state,'done');
});

test('queue survives disk reopen but interrupted work stays paused and invalid legacy intent is not resumed',async t=>{
  const f=await fixture(t,{count:5});f.core.queueRecordings(['recording-1']);f.core.queueRecordings(['recording-2'],{scheduledAt:new Date(f.clock.now()+1000).toISOString()});
  f.store.update(d=>{d.recordings[2].state='running';d.recordings[3].state='queued';d.recordings[4].state='scheduled';d.recordings[4].scheduledAt='bad-date';});
  const reopened=new AppService({store:new Store({dataDir:f.dataDir}),dataDir:f.dataDir,models:f.models});t.after(()=>reopened.stopRecordingScheduler());
  assert.deepEqual(reopened.snapshot().recordings.map(recording=>recording.state),['queued','scheduled','paused','paused','paused']);
  f.clock.advance(2000);reopened.startRecordingScheduler(f.clock);await f.clock.flush();assert.equal(f.requests.length,1);assert.match(f.requests[0].input.filePath,/1\.wav$/);
  f.requests[0].resolve(result('restored immediate'));await f.clock.flush();assert.equal(f.requests.length,2);assert.match(f.requests[1].input.filePath,/2\.wav$/);
  f.requests[1].resolve(result('missed time'));await f.clock.flush();assert.equal(reopened.snapshot().recordings[2].state,'paused');
});

test('invalid schedule batches leave all records untouched and running or completed records cannot be queued',async t=>{
  const f=await fixture(t);f.start();const before=f.store.read().recordings;
  for(const [ids,options] of [[[],{}],[['recording-1','missing'],{}],[['recording-1','recording-1'],{}],[['recording-1'],{scheduledAt:'bad'}],[['recording-1'],{scheduledAt:new Date(f.clock.now()).toISOString()}],[['recording-1'],{scheduledAt:123}]]){
    assert.throws(()=>f.core.queueRecordings(ids,options));assert.deepEqual(f.store.read().recordings,before);
  }
  f.start();f.core.queueRecordings(['recording-1']);await f.clock.flush();assert.throws(()=>f.core.queueRecordings(['recording-1']),/正在轉錄/);
  f.core.saveTranscript('recording-2',{format:'txt',text:'preserved manual'});assert.throws(()=>f.core.queueRecordings(['recording-3','recording-2']),/已有逐字稿/);assert.equal(f.record('recording-3').state,'waiting-model');
});

test('clearing a manual transcript with whitespace allows queued transcription to run again',async t=>{
  const f=await fixture(t,{count:1});
  f.core.saveTranscript('recording-1',{format:'txt',text:'Previously edited transcript'});
  f.core.saveTranscript('recording-1',{format:'txt',text:' \t\r\n\u3000'});
  assert.equal(f.record('recording-1').state,'waiting-model');assert.equal(f.record('recording-1').textOnly,null);
  f.start();f.core.queueRecordings(['recording-1']);await f.clock.flush();
  assert.equal(f.requests.length,1);f.requests[0].resolve(result('New transcription'));await f.clock.flush();
  assert.equal(f.record('recording-1').state,'done');assert.equal(f.record('recording-1').segments[0].text,'New transcription');
});

test('restart normalizes legacy blank transcripts and preserves meaningful manual whitespace',async t=>{
  const f=await fixture(t,{count:2});
  f.store.update(d=>{d.recordings[0].textOnly=' \t\r\n';d.recordings[1].textOnly='  Manual text\n';d.recordings[1].state='done';});
  const reopened=new AppService({store:new Store({dataDir:f.dataDir}),dataDir:f.dataDir,models:f.models});t.after(()=>reopened.stopRecordingScheduler());
  assert.equal(reopened.snapshot().recordings[0].textOnly,null);assert.equal(reopened.snapshot().recordings[1].textOnly,'  Manual text\n');
  reopened.queueRecordings(['recording-1']);reopened.startRecordingScheduler(f.clock);await f.clock.flush();
  assert.equal(f.requests.length,1);f.requests[0].resolve(result('Restored blank recording'));await f.clock.flush();
  assert.equal(reopened.snapshot().recordings[0].state,'done');assert.throws(()=>reopened.queueRecordings(['recording-2']),/已有逐字稿/);
});

test('pause waits for adapter cancellation cleanup before dispatching the next job and ignores late output',async t=>{
  const f=await fixture(t);f.start();f.core.queueRecordings(['recording-1','recording-2']);await f.clock.flush();
  f.core.pauseRecording('recording-1');await f.clock.flush();assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.requests.length,1);assert.equal(f.record('recording-1').state,'paused');
  f.requests[0].onProgress(99);f.requests[0].resolve(result('stale cancelled output'));await f.clock.flush();assert.equal(f.requests.length,2);assert.deepEqual(f.record('recording-1').segments,[]);
  f.requests[1].resolve(result('next'));await f.clock.flush();assert.equal(f.record('recording-2').state,'done');
});

test('cancel, remove and manual transcript edits withdraw durable queued or scheduled intent',async t=>{
  const f=await fixture(t);f.core.queueRecordings(['recording-1'],{scheduledAt:new Date(f.clock.now()+1000).toISOString()});f.core.queueRecordings(['recording-2','recording-3']);
  f.core.pauseRecording('recording-1');f.core.removeRecording('recording-2');f.core.saveTranscript('recording-3',{format:'txt',text:'manual takes precedence'});
  f.start();f.clock.advance(2000);await f.clock.flush();assert.equal(f.requests.length,0);assert.equal(f.record('recording-1').scheduledAt,undefined);assert.equal(f.record('recording-2'),undefined);assert.equal(f.record('recording-3').textOnly,'manual takes precedence');assert.equal(f.record('recording-3').queueOrder,undefined);
});

test('failed or unconfigured transcription consumes its intent and continues to the next item',async t=>{
  const f=await fixture(t);f.start();f.core.queueRecordings(['recording-1','recording-2','recording-3']);await f.clock.flush();
  f.requests[0].reject(new Error('Synthetic model failure'));await f.clock.flush();assert.equal(f.requests.length,2);assert.equal(f.record('recording-1').state,'error');
  f.requests[1].reject(Object.assign(new Error('Synthetic unavailable'),{code:'MODEL_NOT_CONFIGURED'}));await f.clock.flush();assert.equal(f.requests.length,3);assert.equal(f.record('recording-2').state,'waiting-model');
  f.requests[2].resolve(result('success'));await f.clock.flush();assert.equal(f.record('recording-3').state,'done');assert.equal(f.clock.timerCount(),0);
});

test('shutdown stops dispatch while keeping pending intent and startup is idempotent',async t=>{
  const f=await fixture(t);f.start();f.core.queueRecordings(['recording-1','recording-2']);await f.clock.flush();f.core.stopRecordingScheduler();f.core.pauseRecording('recording-1');
  f.requests[0].resolve(result('late'));await f.clock.flush();assert.equal(f.requests.length,1);assert.equal(f.record('recording-2').state,'queued');assert.equal(f.clock.timerCount(),0);
  f.start();f.start();await f.clock.flush();assert.equal(f.requests.length,2);f.requests[1].resolve(result('resumed'));await f.clock.flush();assert.equal(f.record('recording-2').state,'done');
});

test('a low-level transcription already in flight blocks automatic queue dispatch',async t=>{
  const f=await fixture(t);const pending=f.core.runRecording('recording-1');f.start();f.core.queueRecordings(['recording-2']);await f.clock.flush();assert.equal(f.requests.length,1);
  f.requests[0].resolve(result('direct'));await pending;await f.clock.flush();assert.equal(f.requests.length,2);f.requests[1].resolve(result('queued'));await f.clock.flush();
});

test('media cleanup purges queued and scheduled intent without allowing removed recordings to run',async t=>{
  const f=await fixture(t);f.core.queueRecordings(['recording-1','recording-2']);f.core.queueRecordings(['recording-3'],{scheduledAt:new Date(f.clock.now()+1000).toISOString()});f.start();
  const cleanup=await clearMeetingMedia(f.core,{includeVideo:true});assert.equal(cleanup.deletedRecords,3);f.core.wakeRecordingScheduler();f.clock.advance(2000);await f.clock.flush();assert.equal(f.requests.length,0);
  const recovered=new Store({dataDir:f.dataDir});assert.deepEqual(recovered.read().recordings,[]);
});

test('persistence failure leaves pending work retryable without a tight dispatch loop',async t=>{
  const f=await fixture(t);f.core.queueRecordings(['recording-1']);const update=f.store.update.bind(f.store);let failures=0;
  f.store.update=()=>{failures++;throw new Error('Synthetic disk failure');};f.start();await f.clock.flush();
  assert.equal(f.requests.length,0);assert.equal(f.core.active.size,0);assert.equal(f.record('recording-1').state,'queued');assert.equal(failures,2);
  f.clock.advance(29999);await f.clock.flush();assert.equal(failures,2);f.store.update=update;f.clock.advance(1);await f.clock.flush();assert.equal(f.requests.length,1);
  f.requests[0].resolve(result('after persistence recovery'));await f.clock.flush();assert.equal(f.record('recording-1').state,'done');
});

test('a busy Whisper service retries the same FIFO item after five seconds without consuming later items',async t=>{
  const f=await fixture(t);f.start();f.core.queueRecordings(['recording-1']);await f.clock.flush();const originalOrder=1;
  f.core.queueRecordings(['recording-2','recording-3']);f.requests[0].reject(busy());await f.clock.flush();
  assert.equal(f.record('recording-1').state,'queued');assert.equal(f.record('recording-1').queueOrder,originalOrder);assert.match(f.record('recording-1').error,/自動重試/);
  for(let index=0;index<5;index++){f.core.wakeRecordingScheduler();await f.clock.flush();}assert.equal(f.requests.length,1);
  f.clock.advance(4999);await f.clock.flush();assert.equal(f.requests.length,1);f.clock.advance(1);await f.clock.flush();assert.equal(f.requests.length,2);assert.match(f.requests[1].input.filePath,/1\.wav$/);
  f.requests[1].reject(busy());await f.clock.flush();assert.deepEqual(f.core.snapshot().recordings.map(recording=>recording.state),['queued','queued','queued']);assert.equal(f.requests.length,2);
  assert.equal(f.core.snapshot().logs.filter(log=>log.text==='等待語音服務').length,1);assert.equal(f.core.snapshot().logs.filter(log=>log.text==='開始語音轉錄').length,1);
  f.clock.advance(5000);await f.clock.flush();assert.equal(f.requests.length,3);assert.match(f.requests[2].input.filePath,/1\.wav$/);
  f.requests[2].resolve(result('first after busy'));await f.clock.flush();assert.equal(f.requests.length,4);assert.match(f.requests[3].input.filePath,/2\.wav$/);
  f.requests[3].resolve(result('second'));await f.clock.flush();assert.equal(f.requests.length,5);assert.match(f.requests[4].input.filePath,/3\.wav$/);
  f.requests[4].resolve(result('third'));await f.clock.flush();assert.deepEqual(f.core.snapshot().recordings.map(recording=>recording.state),['done','done','done']);assert.equal(f.record('recording-1').queueRetryAt,undefined);
});

for(const action of ['pause','remove'])test(action+' during a busy wait cancels that item while the next still observes service backoff',async t=>{
  const f=await fixture(t,{count:2});f.start();f.core.queueRecordings(['recording-1','recording-2']);await f.clock.flush();f.requests[0].reject(busy());await f.clock.flush();
  if(action==='pause')f.core.pauseRecording('recording-1');else f.core.removeRecording('recording-1');
  await f.clock.flush();assert.equal(f.requests.length,1);if(action==='pause'){assert.equal(f.record('recording-1').state,'paused');assert.equal(f.record('recording-1').queueRetryAt,undefined);assert.equal(f.record('recording-1').error,'');}else assert.equal(f.record('recording-1'),undefined);
  f.clock.advance(5000);await f.clock.flush();assert.equal(f.requests.length,2);assert.match(f.requests[1].input.filePath,/2\.wav$/);f.requests[1].resolve(result('remaining item'));await f.clock.flush();assert.equal(f.record('recording-2').state,'done');
});

test('shutdown and disk reopen preserve busy intent and backoff while later imports retain FIFO order',async t=>{
  const f=await fixture(t,{count:2});f.start();f.core.queueRecordings(['recording-1']);await f.clock.flush();f.requests[0].reject(busy());await f.clock.flush();const retryAt=f.record('recording-1').queueRetryAt;
  f.core.stopRecordingScheduler();await f.clock.flush();assert.equal(f.requests.length,1);
  const reopened=new AppService({store:new Store({dataDir:f.dataDir}),dataDir:f.dataDir,models:f.models});t.after(()=>reopened.stopRecordingScheduler());assert.equal(reopened.snapshot().recordings[0].queueRetryAt,retryAt);
  reopened.startRecordingScheduler(f.clock);await f.clock.flush();assert.equal(f.requests.length,1);f.clock.advance(5000);await f.clock.flush();assert.equal(f.requests.length,2);
  reopened.queueRecordings(['recording-2']);f.requests[1].reject(busy());await f.clock.flush();assert.equal(f.requests.length,2);assert.equal(reopened.snapshot().recordings[0].queueOrder<reopened.snapshot().recordings[1].queueOrder,true);
  f.clock.advance(5000);await f.clock.flush();assert.equal(f.requests.length,3);assert.match(f.requests[2].input.filePath,/1\.wav$/);f.requests[2].resolve(result('first'));await f.clock.flush();assert.equal(f.requests.length,4);assert.match(f.requests[3].input.filePath,/2\.wav$/);f.requests[3].resolve(result('second'));await f.clock.flush();assert.deepEqual(reopened.snapshot().recordings.map(recording=>recording.state),['done','done']);
});

test('direct low-level transcription retains its existing busy failure behavior',async t=>{
  const f=await fixture(t,{count:1}),pending=f.core.runRecording('recording-1');f.requests[0].reject(busy());await pending;
  assert.equal(f.record('recording-1').state,'error');assert.equal(f.record('recording-1').queueRetryAt,undefined);f.start();f.clock.advance(10000);await f.clock.flush();assert.equal(f.requests.length,1);
});

test('a due scheduled recording joins the visible queue during active work without starting in parallel or changing FIFO intent',async t=>{
  const f=await fixture(t);f.start();f.core.queueRecordings(['recording-1']);await f.clock.flush();
  f.core.queueRecordings(['recording-2'],{scheduledAt:new Date(f.clock.now()+10000).toISOString()});const intent=f.record('recording-2');f.core.queueRecordings(['recording-3']);await f.clock.flush();
  assert.equal(f.requests.length,1);assert.equal(f.record('recording-2').state,'scheduled');let changes=0;f.core.onChange=()=>{changes++;};
  f.clock.advance(30000);await f.clock.flush();assert.equal(f.requests.length,1);assert.equal(f.record('recording-1').state,'running');assert.equal(f.record('recording-2').state,'queued');assert.equal(changes,1);
  for(const key of ['queueOrder','queuedAt','scheduledAt'])assert.equal(f.record('recording-2')[key],intent[key]);
  assert.deepEqual(f.core.snapshot().recordings.filter(recording=>recording.state==='queued').sort((a,b)=>a.queueOrder-b.queueOrder).map(recording=>recording.id),['recording-2','recording-3']);
  f.requests[0].resolve(result('current'));await f.clock.flush();assert.equal(f.requests.length,2);assert.match(f.requests[1].input.filePath,/2\.wav$/);f.requests[1].resolve(result('previously scheduled'));await f.clock.flush();assert.equal(f.requests.length,3);assert.match(f.requests[2].input.filePath,/3\.wav$/);f.requests[2].resolve(result('last'));await f.clock.flush();
});

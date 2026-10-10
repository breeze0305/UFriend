'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {VideoExportJobs}=require('../app/services/video-export-jobs.cjs');

const tick=()=>new Promise(setImmediate);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const aborted=()=>Object.assign(new Error('private /output/path'),{name:'AbortError',code:'VIDEO_EXPORT_CANCELLED'});
function fixture(options={}){
  const state={recordings:[{id:'r1',assetId:'a1',type:'video',name:'會議.mov',segments:[{start:0,end:2,text:'第一段'},{start:2,end:4,text:'第二段'}],textOnly:null,duration:8}],assets:[{id:'a1',path:path.resolve('.test-data/private-source.mov')}]};
  const core={store:{read:()=>structuredClone(state)},asset:id=>{const asset=state.assets.find(item=>item.id===id);if(!asset)throw new Error('private missing path');return{...asset};}},requests=[],changes=[],choices=[];
  const outputPath=path.resolve('.test-data/private-export/輸出.mp4');
  const jobs=new VideoExportJobs({core,chooseOutput:input=>{choices.push(input);return options.chooseOutput?options.chooseOutput(input):{filePath:outputPath,canceled:false};},resolveFfmpeg:options.resolveFfmpeg||(()=>'/local/private/ffmpeg'),
    exporter:input=>{const request={...input,...deferred()};requests.push(request);return request.promise;},onChange:value=>changes.push(value)});
  return{jobs,state,core,requests,changes,choices,outputPath};
}

test('invalid audio, TXT, missing timed subtitles and source records never open the chooser',async()=>{
  for(const change of [f=>{f.state.recordings=[];},f=>{f.state.recordings[0].type='audio';},f=>{f.state.recordings[0].textOnly='plain text';},f=>{f.state.recordings[0].segments=[];},f=>{f.state.recordings[0].segments[0].end=0;},f=>{f.state.recordings[0].segments[0].start=NaN;},f=>{f.state.assets=[];}]){
    const f=fixture();change(f);await assert.rejects(f.jobs.start('r1'),error=>/^VIDEO_EXPORT_(NOT_FOUND|INVALID_MEDIA|INVALID_SUBTITLES)$/.test(error.code));
    assert.equal(f.choices.length,0);assert.equal(f.jobs.snapshot().status,'idle');assert.equal(f.requests.length,0);
  }
});

test('choosing holds the single-job lock, and closing a save dialog makes no exporter request',async()=>{
  const chosen=deferred(),f=fixture({chooseOutput:()=>chosen.promise}),started=f.jobs.start('r1');
  assert.equal(f.jobs.snapshot().status,'choosing');assert.deepEqual(f.choices,[{name:'會議_字幕.mp4'}]);
  await assert.rejects(f.jobs.start('r1'),{code:'VIDEO_EXPORT_BUSY'});
  chosen.resolve({canceled:true});assert.deepEqual(await started,{cancelled:true});assert.equal(f.jobs.snapshot().status,'cancelled');assert.equal(f.requests.length,0);
});

test('a cancelled pending chooser cannot launch or overwrite a replacement job',async()=>{
  const first=deferred(),second=deferred(),choices=[first,second],f=fixture({chooseOutput:()=>choices.shift().promise});
  const oldStart=f.jobs.start('r1');await f.jobs.cancel('unrelated');assert.equal(f.jobs.snapshot().status,'choosing');
  await f.jobs.cancel('r1');assert.equal(f.jobs.snapshot().status,'cancelled');
  const newStart=f.jobs.start('r1');second.resolve({filePath:f.outputPath});assert.deepEqual(await newStart,{started:true});await tick();
  first.resolve({filePath:'/stale/output.mp4'});assert.deepEqual(await oldStart,{cancelled:true});assert.equal(f.requests.length,1);assert.equal(f.jobs.snapshot().status,'running');
  f.requests[0].resolve({seconds:8});await tick();assert.equal(f.jobs.getOutput('r1'),f.outputPath);
});

test('removal or source replacement while choosing cancels without opening FFmpeg',async()=>{
  for(const change of [f=>{f.state.recordings=[];},f=>{f.state.assets=[];},f=>{f.state.assets[0].path='/replaced/private-path';},f=>{f.core.mediaClearing=true;}]){
    const choice=deferred(),f=fixture({chooseOutput:()=>choice.promise}),started=f.jobs.start('r1');change(f);choice.resolve({filePath:f.outputPath});
    assert.deepEqual(await started,{cancelled:true});assert.equal(f.requests.length,0);assert.equal(f.jobs.snapshot().status,'cancelled');
  }
});

test('a run uses click-time subtitles and metadata, and the public snapshot contains no paths',async()=>{
  const choice=deferred(),f=fixture({chooseOutput:()=>choice.promise}),started=f.jobs.start('r1');
  f.state.recordings[0].segments[0].text='後來修改';f.state.recordings[0].duration=99;f.state.recordings[0].name='改名.mp4';choice.resolve({filePath:f.outputPath});
  assert.deepEqual(await started,{started:true});await tick();const request=f.requests[0];
  assert.equal(request.segments[0].text,'第一段');assert.equal(request.durationSeconds,8);assert.equal(f.jobs.snapshot().name,'會議.mov');
  const copy=f.jobs.snapshot();copy.status='corrupted';assert.equal(f.jobs.snapshot().status,'running');
  assert.equal(JSON.stringify(copy).includes('private'),false);assert.equal(f.jobs.getOutput('r1'),null);
  request.resolve({seconds:8,outputPath:f.outputPath,size:123});await tick();
  assert.equal(f.jobs.snapshot().status,'done');assert.equal(f.jobs.snapshot().fileName,'輸出.mp4');assert.equal(f.jobs.snapshot().progress,1);
  assert.equal(f.jobs.getOutput('missing'),null);assert.equal(f.jobs.getOutput('r1'),f.outputPath);
  await f.jobs.cancel('r1');assert.equal(f.jobs.snapshot().status,'done');
});

test('progress is coalesced by percent or second and stale callbacks cannot mutate completed state',async()=>{
  const f=fixture();await f.jobs.start('r1');await tick();const request=f.requests[0];
  request.onProgress({stage:'encoding',seconds:1.1,progress:.121});const count=f.changes.length;
  request.onProgress({stage:'encoding',seconds:1.9,progress:.129});assert.equal(f.changes.length,count);
  request.onProgress({stage:'encoding',seconds:2.1,progress:.125});assert.equal(f.changes.length,count+1);
  request.onProgress({stage:'/private/path',seconds:NaN,progress:NaN});assert.equal(f.changes.length,count+1);
  request.onProgress({stage:'encoding',seconds:-9,progress:-3});assert.equal(f.changes.length,count+1);
  request.resolve({seconds:8});await tick();const done=f.jobs.snapshot();request.onProgress({stage:'encoding',seconds:999,progress:.5});assert.deepEqual(f.jobs.snapshot(),done);
});

test('cancel keeps the lock until exporter abort cleanup settles and ignores late progress',async()=>{
  const f=fixture();await f.jobs.start('r1');await tick();const request=f.requests[0];request.onProgress({seconds:2,progress:.25});
  let settled=false;const cancellation=f.jobs.cancel('r1').then(()=>{settled=true;});await tick();
  assert.equal(request.signal.aborted,true);assert.equal(settled,false);assert.equal(f.jobs.snapshot().status,'cancelling');
  await assert.rejects(f.jobs.start('r1'),{code:'VIDEO_EXPORT_BUSY'});request.onProgress({seconds:9,progress:1});assert.equal(f.jobs.snapshot().seconds,2);
  request.reject(aborted());await cancellation;assert.equal(f.jobs.snapshot().status,'cancelled');assert.equal(f.jobs.getOutput('r1'),null);
  await f.jobs.start('r1');await tick();request.onProgress({seconds:999,progress:1});assert.equal(f.jobs.snapshot().seconds,0);
  f.requests[1].resolve({seconds:8});await tick();assert.equal(f.jobs.snapshot().status,'done');
});

test('successful publication wins a cancellation arriving just before promise settlement',async()=>{
  const f=fixture();await f.jobs.start('r1');await tick();const cancelled=f.jobs.cancel('r1');
  f.requests[0].resolve({seconds:8,outputPath:f.outputPath});await cancelled;
  assert.equal(f.jobs.snapshot().status,'done');assert.equal(f.jobs.getOutput('r1'),f.outputPath);
});

test('exporter and chooser failures return safe messages, and a new job can follow failure',async()=>{
  const f=fixture();await f.jobs.start('r1');await tick();f.requests[0].reject(new Error('C:\\private\\secret-output.mp4'));await tick();
  assert.equal(f.jobs.snapshot().status,'error');assert.equal(f.jobs.snapshot().code,'VIDEO_EXPORT_FAILED');assert.equal(f.jobs.snapshot().error.includes('private'),false);
  await f.jobs.start('r1');await tick();f.requests[1].reject(Object.assign(new Error('/private/ffmpeg'),{code:'FFMPEG_NOT_FOUND'}));await tick();assert.equal(f.jobs.snapshot().code,'FFMPEG_NOT_FOUND');
  const g=fixture({chooseOutput:()=>{throw new Error('/private/chooser');}});await assert.rejects(g.jobs.start('r1'),{code:'VIDEO_EXPORT_FAILED'});assert.equal(g.jobs.snapshot().status,'error');
});

test('shutdown waits for cancellation cleanup, blocks starting, and can be resumed explicitly',async()=>{
  const f=fixture();await f.jobs.start('r1');await tick();let closed=false;const shutdown=f.jobs.shutdown().then(()=>{closed=true;});await tick();
  assert.equal(closed,false);await assert.rejects(f.jobs.start('r1'),{code:'VIDEO_EXPORT_CLOSING'});assert.equal(f.requests[0].signal.aborted,true);
  f.requests[0].reject(aborted());await shutdown;assert.equal(f.jobs.snapshot().status,'cancelled');f.jobs.setClosing(false);
  await f.jobs.start('r1');await tick();f.requests[1].resolve({seconds:8});await tick();assert.equal(f.jobs.snapshot().status,'done');
});

test('shutdown invalidates a chooser and cancellation while resolving FFmpeg prevents spawning',async()=>{
  const choice=deferred(),f=fixture({chooseOutput:()=>choice.promise}),started=f.jobs.start('r1');await f.jobs.shutdown();choice.resolve({filePath:f.outputPath});
  assert.deepEqual(await started,{cancelled:true});assert.equal(f.requests.length,0);
  const ffmpeg=deferred(),g=fixture({resolveFfmpeg:()=>ffmpeg.promise});await g.jobs.start('r1');const cancel=g.jobs.cancel('r1');
  ffmpeg.resolve('/private/ffmpeg');await cancel;assert.equal(g.requests.length,0);assert.equal(g.jobs.snapshot().status,'cancelled');
});

test('removal awaiting cancellation cannot complete while the video process still owns its source',async()=>{
  const f=fixture();await f.jobs.start('r1');await tick();let removed=false;
  const remove=(async()=>{await f.jobs.cancel('r1');f.state.recordings=[];removed=true;})();await tick();assert.equal(removed,false);
  f.requests[0].reject(aborted());await remove;assert.equal(removed,true);assert.equal(f.jobs.snapshot().status,'cancelled');
});

test('default filenames preserve MP4, extensionless choices append MP4, and published canonical paths are retained privately',async()=>{
  const f=fixture({chooseOutput:()=>({filePath:path.resolve('.test-data/output-without-extension')})});f.state.recordings[0].name='長'.repeat(180)+'.mov';
  await f.jobs.start('r1');await tick();assert.ok(f.choices[0].name.length<=157);assert.ok(f.choices[0].name.endsWith('_字幕.mp4'));
  assert.ok(f.requests[0].outputPath.endsWith('output-without-extension.mp4'));assert.equal(f.jobs.snapshot().fileName,'output-without-extension.mp4');
  const canonical=path.resolve('.test-data/canonical/output-without-extension.mp4');f.requests[0].resolve({outputPath:canonical,seconds:8});await tick();
  assert.equal(f.jobs.getOutput('r1'),canonical);assert.equal(JSON.stringify(f.jobs.snapshot()).includes('canonical'),false);
  const g=fixture({chooseOutput:()=>({filePath:path.resolve('.test-data/output.avi')})});await g.jobs.start('r1');await tick();assert.ok(g.requests[0].outputPath.endsWith('.avi'));
  g.requests[0].reject(Object.assign(new Error('/private/output.avi'),{code:'VIDEO_INVALID_OUTPUT'}));await tick();assert.match(g.jobs.snapshot().error,/MP4/);
});

test('known exporter failures retain specific local guidance while untrusted error details remain private',async()=>{
  for(const [code,expected] of [['VIDEO_OUTPUT_EXISTS',/新的檔名/],['VIDEO_INVALID_PATH',/有效的本機/],['VIDEO_INVALID_SUBTITLES',/有效文字/],['FFMPEG_NOT_FOUND',/完整的 UFriend/],['FFMPEG_START_FAILED',/執行權限/]]){
    const f=fixture();await f.jobs.start('r1');await tick();f.requests[0].reject(Object.assign(new Error('/private/source-secret'),{code}));await tick();
    assert.equal(f.jobs.snapshot().code,code);assert.match(f.jobs.snapshot().error,expected);assert.equal(JSON.stringify(f.jobs.snapshot()).includes('source-secret'),false);
  }
});

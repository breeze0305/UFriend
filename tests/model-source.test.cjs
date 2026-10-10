'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {modelSource}=require('../app/services/model-source.cjs');

const testRoot=path.resolve(__dirname,'../.test-data/model-source-tests');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const mail=id=>({id,folder:'inbox',done:false,subject:'Synthetic meeting',body:'Review the synthetic plan.',analysis:null,level:null});
function output(request){
  if(request.task==='mail')return{analyses:request.input.messages.map(item=>({id:item.id,summary:'Synthetic summary',priority:1,reason:'Synthetic reason',evidence:['synthetic plan']})),meta:{model:'fixture',backend:'test',source:'untrusted'}};
  if(request.task==='transcribe')return{segments:[{start:0,end:1,text:'Synthetic transcript'}],language:'en',meta:{source:'untrusted'}};
  return{text:'Synthetic result',meta:{model:'fixture',backend:'test',source:'untrusted'}};
}
async function fixture(t,{settings={},mutate=()=>{},run=(_kind,request)=>output(request)}={}){
  await fs.mkdir(testRoot,{recursive:true});const dataDir=await fs.mkdtemp(path.join(testRoot,'case-'));
  const store=new Store({dataDir});store.update(state=>{state.settings=settings;mutate(state);});
  const calls=[],models={status:()=>({}),run:(kind,request)=>{calls.push({kind,request});return run(kind,request);}};
  const core=new AppService({store,dataDir,models});
  await fs.mkdir(path.join(dataDir,'files'));await fs.writeFile(path.join(dataDir,'files','fixture.wav'),'synthetic media');
  store.update(state=>{state.assets.push({id:'fixture',name:'fixture.wav',file:'fixture.wav'});state.recordings.push({id:'recording',name:'fixture.wav',assetId:'fixture',lang:'en',state:'waiting-model',source:'local',segments:[]});});
  await core.setOcrImage({id:'fixture',name:'fixture.png'});core.savePolish({input:'Synthetic input'});core.saveTranslation({input:'Synthetic input'});
  t.after(async()=>{core.stopRecordingScheduler();for(const controller of core.active.values())controller.abort();assert.equal(path.dirname(path.resolve(dataDir)),testRoot);await fs.rm(dataDir,{recursive:true,force:true});});
  return{core,store,calls,dataDir,models,reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};
}

test('legacy global compute becomes a local backend and never selects cloud for existing work',async t=>{
  for(const [compute,backend] of [[undefined,'pc-api'],['dev-api','pc-api'],['local','ugen300'],['cloud','pc-api']]){
    const f=await fixture(t,{settings:compute===undefined?{}:{compute}}),state=f.core.snapshot();
    assert.equal(state.settings.localBackend,backend);assert(!Object.hasOwn(state.settings,'compute'));
    for(const job of [state.ocr,state.polish,state.translation,state.chat,state.mailAnalysis])assert.equal(job.source,'local');
    assert.deepEqual(state.settings.api,{endpoint:'',model:'',ocrModel:'',transcriptionModel:'',temperature:null});
    for(const value of ['local','dev-api','cloud',null,undefined])assert.throws(()=>f.core.settings({compute:value,theme:'dark'}),/不再使用全域/);
    assert.equal(f.core.snapshot().settings.theme,'system');assert.equal(f.reopen().snapshot().settings.localBackend,backend);
  }
});

test('source migration preserves legacy OCR filename and per-conversation selections',async t=>{
  const f=await fixture(t);
  f.store.update(state=>{
    state.ocr={imageId:'fixture',source:'legacy-image.png',text:'retained',status:'done',revision:1};
    state.chat.source='cloud';state.chat.draft='Saved cloud draft';
    state.chatHistory.conversations[0].chat={...state.chat};
    delete state.recordings[0].source;
  });
  const restored=f.reopen().snapshot();
  assert.equal(restored.ocr.imageName,'legacy-image.png');assert.equal(restored.ocr.source,'local');assert.equal(restored.ocr.text,'retained');
  assert.equal(restored.chat.source,'cloud');assert.equal(restored.chatHistory.conversations[0].chat.source,'cloud');assert.equal(restored.recordings[0].source,'local');
});

test('all six execution paths use the event selection and retain the actual source in result metadata',async t=>{
  const f=await fixture(t);f.store.update(state=>state.messages.push(mail('one')));
  f.core.updateRecording('recording',{source:'cloud'});
  await f.core.runRecording('recording');await f.core.runOcr('cloud');await f.core.runPolish('cloud');await f.core.runTranslation('cloud');await f.core.sendChat('Synthetic question','cloud');await f.core.analyzeMail('cloud');
  assert.deepEqual(f.calls.map(({request})=>request.task),['transcribe','recognize','polish','translate','chat','mail']);
  assert(f.calls.every(({request})=>request.source==='cloud'));
  const state=f.reopen().snapshot();
  for(const job of [state.recordings[0],state.ocr,state.polish,state.translation]){assert.equal(job.source,'cloud');assert.equal(job.meta.source,'cloud');}
  assert.equal(state.chat.source,'cloud');assert(state.chat.messages.every(message=>message.meta.source==='cloud'));
  assert.equal(state.mailAnalysis.source,'cloud');assert.equal(state.messages[0].analysis.meta.source,'cloud');
  await f.core.runPolish();await f.core.runTranslation();await f.core.runOcr();await f.core.sendChat('Another synthetic question');await f.core.analyzeMail();
  assert(f.calls.every(({request})=>request.source==='cloud'));
});

test('automatic local OCR preserves the manual cloud selection during execution and after reopening',async t=>{
  const f=await fixture(t);f.core.setTaskSource('ocr','cloud');
  await f.core.setOcrImage({id:'fixture',name:'automatic-capture.png'});
  const automatic=f.core.runOcr('local',{preserveSelection:true});
  assert.equal(f.core.snapshot().ocr.status,'running');assert.equal(f.core.snapshot().ocr.source,'cloud');
  assert.equal(f.core.snapshot().ocr.runningSource,'local','The UI must have the actual automatic execution source even when an older selection is preserved.');
  assert.equal(f.calls[0].request.source,'local');
  await automatic;
  const restored=f.reopen().snapshot().ocr;
  assert.equal(restored.source,'cloud');assert.equal(restored.meta.source,'local');
  await f.core.runOcr();assert.equal(f.calls[1].request.source,'cloud');assert.equal(f.core.snapshot().ocr.meta.source,'cloud');
  await f.core.runOcr('local');assert.equal(f.core.snapshot().ocr.source,'local');
});

test('unknown sources reject before model dispatch or asset import and keep saved selections intact',async t=>{
  const f=await fixture(t);f.store.update(state=>state.messages.push(mail('one')));
  for(const value of ['dev-api','ugen300','',null,{},[],3]){
    assert.throws(()=>modelSource(value),{code:'MODEL_INVALID_SOURCE'});
    for(const kind of ['mail','ocr','polish','translation','chat'])assert.throws(()=>f.core.setTaskSource(kind,value),{code:'MODEL_INVALID_SOURCE'});
    for(const action of [()=>f.core.runOcr(value),()=>f.core.runPolish(value),()=>f.core.runTranslation(value),()=>f.core.sendChat('Synthetic question',value),()=>f.core.analyzeMail(value),()=>f.core.importMedia([],undefined,value)])await assert.rejects(action,{code:'MODEL_INVALID_SOURCE'});
    assert.throws(()=>f.core.updateRecording('recording',{source:value}),{code:'MODEL_INVALID_SOURCE'});
    assert.throws(()=>f.core.queueRecordings(['recording'],{source:value}),{code:'MODEL_INVALID_SOURCE'});
  }
  f.store.update(state=>{state.recordings[0].source='invalid';});await assert.rejects(()=>f.core.runRecording('recording'),{code:'MODEL_INVALID_SOURCE'});
  assert.equal(f.calls.length,0);assert.equal(f.core.active.size,0);assert.equal(f.core.snapshot().chat.messages.length,0);
});

test('task source controls cancel only their own running event and preserve the selected conversation',async t=>{
  const pending=[];const f=await fixture(t,{run:(_kind,request)=>new Promise(resolve=>pending.push({request,resolve}))});
  const polish=f.core.runPolish(),chat=f.core.sendChat('Synthetic question');await turn();
  f.core.setTaskSource('polish','local');assert(pending.every(item=>!item.request.signal.aborted));
  f.core.setTaskSource('polish','cloud');await polish;
  assert.equal(pending[0].request.signal.aborted,true);assert.equal(pending[1].request.signal.aborted,false);
  const conversationId=f.core.snapshot().chatHistory.activeId;f.core.setTaskSource('chat','cloud');await chat;
  assert.equal(f.core.snapshot().chat.draft,'Synthetic question');assert.equal(f.core.snapshot().chat.source,'cloud');
  assert.equal(f.core.snapshot().chatHistory.conversations.find(item=>item.id===conversationId).chat.source,'cloud');
  f.core.newChat();assert.equal(f.core.snapshot().chat.source,'local');f.core.selectChat(conversationId);assert.equal(f.core.snapshot().chat.source,'cloud');
  for(const item of pending)item.resolve(output(item.request));await turn();
  assert.equal(f.core.snapshot().polish.output,'');assert.equal(f.core.snapshot().chat.messages.length,0);
});

test('cloud connection fields are validated atomically and partial saves preserve other model parameters',async t=>{
  const f=await fixture(t);
  f.core.settings({api:{endpoint:'https://example.invalid/v1/',model:'text-model',ocrModel:'vision-model',transcriptionModel:'audio-model',temperature:0.2}});
  f.core.settings({api:{temperature:null}});
  assert.deepEqual(f.reopen().snapshot().settings.api,{endpoint:'https://example.invalid/v1',model:'text-model',ocrModel:'vision-model',transcriptionModel:'audio-model',temperature:null});
  for(const temperature of [0,2,null])f.core.settings({api:{temperature}});
  const before=f.core.snapshot().settings;
  for(const api of [null,[],{endpoint:'http://remote.invalid'},{endpoint:'https://user:secret@example.invalid'},{endpoint:'https://example.invalid/?'},{endpoint:'https://example.invalid/#'},{endpoint:'https://example.invalid/?token=synthetic'},{endpoint:'x'.repeat(2049)},{endpoint:12},{endpoint:'https://example.invalid\n'},{temperature:-1},{temperature:2.1},{temperature:'0.2'},{temperature:NaN},{temperature:Infinity},{model:12},{ocrModel:'x'.repeat(251)},{transcriptionModel:null}]){
    assert.throws(()=>f.core.settings({theme:'dark',api}));assert.deepEqual(f.core.snapshot().settings,before);
  }
  for(const endpoint of ['http://127.0.0.1:3000/v1','http://[::1]:3000','http://localhost:3000','https://example.invalid'])f.core.settings({api:{endpoint}});
  for(const localBackend of ['cloud','dev-api',null,''])assert.throws(()=>f.core.settings({localBackend}));
});

test('connection edits cancel only running jobs using the affected source and model kind',async t=>{
  const cases=[
    {patch:{devLlm:{endpoint:'http://localhost:18888'}},source:'local',kinds:['llm']},
    {patch:{devOcr:{endpoint:'http://localhost:18887'}},source:'local',kinds:['ocr']},
    {patch:{devWhisper:{endpoint:'http://localhost:18886'}},source:'local',kinds:['whisper']},
    {patch:{localBackend:'ugen300'},source:'local',kinds:['llm','ocr','whisper']},
    {patch:{api:{model:'next'}},source:'cloud',kinds:['llm']},
    {patch:{api:{ocrModel:'next'}},source:'cloud',kinds:['ocr']},
    {patch:{api:{transcriptionModel:'next'}},source:'cloud',kinds:['whisper']},
    {patch:{api:{temperature:0.8}},source:'cloud',kinds:['llm','ocr']},
    {patch:{api:{endpoint:'https://example.invalid/v1'}},source:'cloud',kinds:['llm','ocr','whisper']},
  ];
  for(const entry of cases){
    const pending=[];const f=await fixture(t,{run:(kind,request)=>new Promise(resolve=>pending.push({kind,request,resolve}))});
    f.store.update(state=>{state.recordings.push({...state.recordings[0],id:'cloud-recording',source:'cloud'});state.messages.push(mail('one'));});
    const runs=[f.core.runPolish('local'),f.core.sendChat('Synthetic question','cloud'),f.core.runTranslation('cloud'),f.core.analyzeMail('local'),f.core.runOcr(entry.source),f.core.runRecording('recording'),f.core.runRecording('cloud-recording')];await turn();
    f.core.settings(entry.patch);
    for(const item of pending)assert.equal(item.request.signal.aborted,item.request.source===entry.source&&entry.kinds.includes(item.kind),`${JSON.stringify(entry.patch)} affected ${item.request.source}/${item.kind}`);
    f.core.cancelPolish();f.core.cancelChat();f.core.cancelTranslation();f.core.cancelMailAnalysis();f.core.cancelOcr();f.core.pauseRecording('recording');f.core.pauseRecording('cloud-recording');
    for(const item of pending)item.resolve(output(item.request));await Promise.all(runs);
  }
});

test('a mail batch keeps its source while unrelated connection settings change',async t=>{
  let f;f=await fixture(t,{run:(_kind,request)=>{if(request.task==='mail')f.core.settings({localBackend:'ugen300',devLlm:{endpoint:'http://localhost:18885'}});return output(request);}});
  f.store.update(state=>state.messages.push(mail('one'),mail('two')));await f.core.analyzeMail('cloud');
  assert.equal(f.calls.length,2);assert(f.calls.every(({request})=>request.source==='cloud'&&!request.signal.aborted));
  assert(f.core.snapshot().messages.every(item=>item.analysis.meta.source==='cloud'));
});

test('meeting import and queue save the source, reject partial changes, and preserve intent across restart',async t=>{
  const f=await fixture(t),media=path.join(f.dataDir,'synthetic.wav');await fs.writeFile(media,'synthetic recording');
  const result=await f.core.importMedia([media],'en','cloud'),id=result.imported[0];assert(id);
  f.core.queueRecordings([id],{source:'cloud',scheduledAt:new Date(Date.now()+60000).toISOString()});
  const before=f.core.snapshot().recordings;
  assert.throws(()=>f.core.queueRecordings([id],{source:'local'}),/先暫停/);assert.deepEqual(f.core.snapshot().recordings,before);
  assert.throws(()=>f.core.queueRecordings(['recording','missing'],{source:'cloud'}));assert.deepEqual(f.core.snapshot().recordings,before);
  assert.equal(f.reopen().snapshot().recordings.find(item=>item.id===id).source,'cloud');
  f.core.queueRecordings([id],{source:'cloud'});assert.equal(f.core.snapshot().recordings.find(item=>item.id===id).state,'queued');
  f.core.updateRecording(id,{source:'local'});const paused=f.core.snapshot().recordings.find(item=>item.id===id);assert.equal(paused.source,'local');assert.equal(paused.state,'paused');assert(!Object.hasOwn(paused,'queueOrder'));assert(!Object.hasOwn(paused,'scheduledAt'));
  f.core.queueRecordings([id],{source:'cloud'});await f.core.runRecording(id,{fromQueue:true});assert.equal(f.calls.at(-1).request.source,'cloud');
});

test('busy recording retry preserves the queued source and a source change prevents late completion',async t=>{
  let rejectBusy=true;const f=await fixture(t,{run:(_kind,request)=>{if(rejectBusy){rejectBusy=false;throw Object.assign(new Error('Synthetic busy'),{code:'MODEL_API_BUSY'});}return output(request);}});
  f.core.queueRecordings(['recording'],{source:'cloud'});await f.core.runRecording('recording',{fromQueue:true});
  let recording=f.core.snapshot().recordings[0];assert.equal(recording.source,'cloud');assert.equal(recording.state,'queued');assert(recording.queueRetryAt);
  const reopened=f.reopen();await reopened.runRecording('recording',{fromQueue:true});assert(f.calls.every(({request})=>request.source==='cloud'));assert.equal(reopened.snapshot().recordings[0].meta.source,'cloud');
  const pending=[];const g=await fixture(t,{run:(_kind,request)=>new Promise(resolve=>pending.push({request,resolve}))});g.core.updateRecording('recording',{source:'cloud'});
  const running=g.core.runRecording('recording');assert.throws(()=>g.core.queueRecordings(['recording'],{source:'local'}),/先暫停/);
  g.core.updateRecording('recording',{source:'local'});await running;pending[0].resolve(output(pending[0].request));await turn();
  recording=g.core.snapshot().recordings[0];assert.equal(recording.source,'local');assert.equal(recording.state,'paused');assert.deepEqual(recording.segments,[]);assert.equal(pending[0].request.source,'cloud');assert.equal(pending[0].request.signal.aborted,true);
});

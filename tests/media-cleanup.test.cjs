'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {meetingCleanupInfo,clearMeetingMedia}=require('../app/services/media-cleanup.cjs');
const root=path.resolve(__dirname,'../.test-data/media-cleanup-tests');
async function fixture(t){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));
  t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir}),models=new ModelAdapters(),core=new AppService({store,dataDir,models});
  await fs.mkdir(path.join(dataDir,'files'));return{dataDir,store,models,core};
}
async function asset(f,id,name,{category='recording',content='synthetic media'}={}){
  const item={id,name,file:id+path.extname(name),category,size:Buffer.byteLength(content)};
  await fs.writeFile(path.join(f.dataDir,'files',item.file),content);f.store.update(state=>state.assets.push(item));return item;
}
function record(f,id,source,{type='audio',...patch}={}){
  const item={id,name:source.name,assetId:source.id,type,lang:'zh-TW',size:source.size,state:'waiting-model',progress:0,segments:[],textOnly:null,...patch};
  f.store.update(state=>state.recordings.push(item));return item;
}
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const exists=file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('audio cleanup removes managed copies, orphan audio and transcripts while preserving video, OCR, originals and other state',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','meeting.wav'),orphan=await asset(f,'orphan','removed-before.mp3'),video=await asset(f,'video','meeting.mp4'),orphanVideo=await asset(f,'orphan-video','removed-before.mp4'),ocr=await asset(f,'ocr','image.png',{category:'ocr'});
  record(f,'audio-record',audio,{textOnly:'private audio transcript',segments:[{start:0,end:1,text:'private audio segment'}]});record(f,'video-record',video,{type:'video',textOnly:'kept video transcript'});
  const original=path.join(f.dataDir,'original.wav');await fs.writeFile(original,'original source');
  f.store.update(state=>{state.ocr.imageId=ocr.id;state.ocr.text='kept OCR';state.messages=[{id:'mail',body:'kept mail'}];state.chat.draft='kept chat';state.settings.theme='dark';});
  const before=f.store.read(),info=meetingCleanupInfo(f.core);assert.equal(info.records,1);assert.equal(info.files,2);assert.equal(info.bytes,audio.size+orphan.size);
  assert.deepEqual(await clearMeetingMedia(f.core),{deletedRecords:1,deletedFiles:2,remainingFiles:0,failed:[],sharedFiles:0});
  const after=f.store.read();assert.deepEqual(after.recordings,before.recordings.filter(item=>item.type==='video'));
  for(const key of ['settings','messages','chat','chatHistory','ocr','logs'])assert.deepEqual(after[key],before[key]);
  for(const item of [audio,orphan])assert.equal(await exists(path.join(f.dataDir,'files',item.file)),false);
  for(const item of [video,orphanVideo,ocr])assert.equal(await fs.readFile(path.join(f.dataDir,'files',item.file),'utf8'),'synthetic media');
  assert.equal(await fs.readFile(original,'utf8'),'original source');
  for(const file of [f.store.file,f.store.backup]){const state=await read(file);assert(!JSON.stringify(state).includes('private audio'));assert.deepEqual(state.assets,after.assets);}
  await fs.writeFile(f.store.file,'invalid primary');const restored=new Store({dataDir:f.dataDir}).read();assert(!JSON.stringify(restored).includes('private audio'));assert.deepEqual(restored.recordings,after.recordings);
});

test('audio copies shared by mail, drafts, OCR or a remaining video keep their file and asset while audio records are removed',async t=>{
  const f=await fixture(t),shared=[];
  for(const owner of ['mail','draft','ocr','video']){const item=await asset(f,owner,owner+'.wav');shared.push(item);record(f,owner+'-audio',item);}
  record(f,'remaining-video',shared[3],{type:'video'});
  f.store.update(state=>{state.messages=[{id:'mail',attachments:[{assetId:'mail'}]}];state.drafts=[{id:'draft',attachments:[{assetId:'draft'}]}];state.ocr.imageId='ocr';});
  const before=f.store.read(),info=meetingCleanupInfo(f.core);assert.equal(info.records,4);assert.equal(info.files,0);assert.equal(info.sharedFiles,4);
  assert.deepEqual(await clearMeetingMedia(f.core),{deletedRecords:4,deletedFiles:0,remainingFiles:0,failed:[],sharedFiles:4});
  assert.deepEqual(f.store.read().assets,before.assets);assert.deepEqual(f.store.read().recordings.map(item=>item.id),['remaining-video']);
  for(const item of shared)assert.equal(await fs.readFile(path.join(f.dataDir,'files',item.file),'utf8'),'synthetic media');
});

test('includeVideo also clears video records and orphan copies, and an empty cleanup is idempotent',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','meeting.wav'),video=await asset(f,'video','meeting.mp4');await asset(f,'orphan-video','old.mp4');
  record(f,'audio-record',audio);record(f,'video-record',video,{type:'video'});
  assert.equal(meetingCleanupInfo(f.core,{includeVideo:true}).files,3);
  assert.deepEqual(await clearMeetingMedia(f.core,{includeVideo:true}),{deletedRecords:2,deletedFiles:3,remainingFiles:0,failed:[],sharedFiles:0});
  assert.deepEqual(f.store.read().recordings,[]);assert.deepEqual(f.store.read().assets,[]);
  assert.deepEqual(await clearMeetingMedia(f.core,{includeVideo:true}),{deletedRecords:0,deletedFiles:0,remainingFiles:0,failed:[],sharedFiles:0});assert.equal(f.core.mediaClearing,false);
});

test('primary purge failure deletes no files and does not cancel active transcription',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','meeting.wav');record(f,'recording',audio,{textOnly:'private transcript'});
  const before=f.store.read(),controller=new AbortController();f.core.active.set('recording:recording',controller);
  const atomic=f.store._atomicWrite.bind(f.store);f.store._atomicWrite=(target,value)=>{if(target===f.store.file)throw new Error('fixture primary write failed');return atomic(target,value);};
  await assert.rejects(clearMeetingMedia(f.core),/fixture primary write failed/);
  assert.deepEqual(f.store.read(),before);assert.deepEqual(await read(f.store.file),before);assert.equal(await fs.readFile(path.join(f.dataDir,'files',audio.file),'utf8'),'synthetic media');
  assert.equal(controller.signal.aborted,false);assert.equal(f.core.active.get('recording:recording'),controller);assert.equal(f.core.mediaClearing,false);
  f.store._atomicWrite=atomic;assert.equal((await clearMeetingMedia(f.core)).deletedFiles,1);assert.equal(controller.signal.aborted,true);
});

test('an unlink failure leaves a retryable orphan index after purging transcripts, and retry removes it',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','meeting.wav');record(f,'recording',audio,{textOnly:'private transcript'});
  const target=path.join(f.dataDir,'files',audio.file),unlink=fs.unlink;let blocked=true;
  t.mock.method(fs,'unlink',async(file,...args)=>{if(file===target&&blocked)throw Object.assign(new Error('fixture busy file'),{code:'EPERM'});return unlink(file,...args);});
  const result=await clearMeetingMedia(f.core);assert.equal(result.deletedRecords,1);assert.equal(result.deletedFiles,0);assert.equal(result.remainingFiles,1);assert.equal(result.failed[0].name,'meeting.wav');
  assert.deepEqual(f.store.read().recordings,[]);assert.equal(f.store.read().assets[0].id,audio.id);assert.equal(await exists(target),true);assert.equal(meetingCleanupInfo(f.core).files,1);
  for(const file of [f.store.file,f.store.backup])assert(!JSON.stringify(await read(file)).includes('private transcript'));
  blocked=false;assert.deepEqual(await clearMeetingMedia(f.core),{deletedRecords:0,deletedFiles:1,remainingFiles:0,failed:[],sharedFiles:0});assert.equal(await exists(target),false);assert.deepEqual(f.store.read().assets,[]);
});

test('an extensionless imported audio asset remains discoverable for retry after its recording is removed',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','a'.repeat(180));record(f,'recording',audio,{type:'audio'});
  // Older safeName truncation could strip a long source filename's extension.
  const target=path.join(f.dataDir,'files',audio.file),unlink=fs.unlink;let blocked=true;
  t.mock.method(fs,'unlink',async(file,...args)=>{if(file===target&&blocked)throw Object.assign(new Error('fixture busy file'),{code:'EPERM'});return unlink(file,...args);});
  const first=await clearMeetingMedia(f.core);assert.equal(first.remainingFiles,1);assert.deepEqual(f.store.read().recordings,[]);assert.equal(await exists(target),true);
  assert.equal(meetingCleanupInfo(f.core).files,1,'same audio-only setting must still offer the failed file for retry');
  blocked=false;const second=await clearMeetingMedia(f.core);assert.equal(second.deletedFiles,1);assert.equal(second.remainingFiles,0);assert.equal(await exists(target),false);assert.deepEqual(f.store.read().assets,[]);
});

test('a long-named audio import keeps its media type when individual removal leaves an extensionless orphan',async t=>{
  const f=await fixture(t),source=path.join(f.dataDir,'a'.repeat(181)+'.mp3');await fs.writeFile(source,'original audio');
  const imported=await f.core.importMedia([source]);assert.equal(imported.errors.length,0);assert.equal(imported.imported.length,1);
  const saved=f.store.read().assets[0];assert.equal(path.extname(saved.name),'');assert.equal(path.extname(saved.file),'');
  f.core.removeRecording(imported.imported[0]);assert.equal(meetingCleanupInfo(f.core).files,1);
  assert.equal((await clearMeetingMedia(f.core)).deletedFiles,1);assert.equal(await exists(path.join(f.dataDir,'files',saved.file)),false);assert.equal(await fs.readFile(source,'utf8'),'original audio');
});

test('missing managed copies are pruned, including a missing files directory',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','missing.wav');record(f,'recording',audio);await fs.unlink(path.join(f.dataDir,'files',audio.file));await fs.rmdir(path.join(f.dataDir,'files'));
  const result=await clearMeetingMedia(f.core);assert.equal(result.deletedRecords,1);assert.equal(result.deletedFiles,1);assert.equal(result.remainingFiles,0);assert.deepEqual(f.store.read().recordings,[]);assert.deepEqual(f.store.read().assets,[]);
});

test('path traversal is rejected before any planned record or safe file is removed',async t=>{
  const f=await fixture(t),good=await asset(f,'good','good.wav'),bad=await asset(f,'bad','bad.wav');record(f,'good-record',good);record(f,'bad-record',bad);
  const sentinel=path.join(f.dataDir,'outside.wav');await fs.writeFile(sentinel,'must remain');f.store.update(state=>{state.assets.find(item=>item.id==='bad').file='../outside.wav';});const before=f.store.read();
  await assert.rejects(clearMeetingMedia(f.core),/路徑不安全/);assert.deepEqual(f.store.read(),before);assert.equal(await fs.readFile(sentinel,'utf8'),'must remain');assert.equal(await exists(path.join(f.dataDir,'files',good.file)),true);assert.equal(f.core.mediaClearing,false);
});

test('a redirected managed directory is rejected and cannot remove a source outside files',async t=>{
  const f=await fixture(t),source=path.join(f.dataDir,'originals');await fs.mkdir(source);await fs.writeFile(path.join(source,'audio.wav'),'original sentinel');await fs.rmdir(path.join(f.dataDir,'files'));await fs.symlink(source,path.join(f.dataDir,'files'),'junction');
  f.store.update(state=>{state.assets.push({id:'audio',file:'audio.wav',name:'audio.wav',category:'recording'});});record(f,'recording',{id:'audio',name:'audio.wav',size:17});const before=f.store.read();
  await assert.rejects(clearMeetingMedia(f.core),/目錄不安全/);assert.deepEqual(f.store.read(),before);assert.equal(await fs.readFile(path.join(source,'audio.wav'),'utf8'),'original sentinel');
});

test('cleanup cancels only targeted active transcription and rejects its late progress and result',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','meeting.wav'),video=await asset(f,'video','meeting.mp4');record(f,'audio-record',audio);record(f,'video-record',video,{type:'video'});
  const audioDone=deferred(),videoDone=deferred(),requests=new Map();f.models.register('whisper',{run:request=>{requests.set(path.basename(request.input.filePath),request);return request.input.filePath.endsWith('.wav')?audioDone.promise:videoDone.promise;}});
  const audioPending=f.core.runRecording('audio-record'),videoPending=f.core.runRecording('video-record');await Promise.resolve();
  assert.equal(meetingCleanupInfo(f.core).running,1);await clearMeetingMedia(f.core);await audioPending;
  const old=requests.get(audio.file),kept=requests.get(video.file);assert.equal(old.signal.aborted,true);assert.equal(kept.signal.aborted,false);assert.equal(f.core.active.has('recording:audio-record'),false);
  old.onProgress(90,{processedSeconds:90});audioDone.resolve({segments:[{start:0,end:1,text:'private late transcript'}]});await Promise.resolve();
  videoDone.resolve({segments:[{start:0,end:1,text:'kept video transcript'}]});await videoPending;
  assert.deepEqual(f.store.read().recordings.map(item=>item.id),['video-record']);assert.equal(f.store.read().recordings[0].segments[0].text,'kept video transcript');
  for(const file of [f.store.file,f.store.backup])assert(!JSON.stringify(await read(file)).includes('private late transcript'));
});

test('concurrent imports keep cleanup busy until both settle, and import failures reset the counter',async t=>{
  const f=await fixture(t),source=path.join(f.dataDir,'original.wav');await fs.writeFile(source,'original');
  const gate=deferred(),ingest=f.core.ingestAsset.bind(f.core);f.core.ingestAsset=async(...args)=>{await gate.promise;return ingest(...args);};
  const first=f.core.importMedia([source]),second=f.core.importMedia([source]);assert.equal(f.core.mediaImports,2);assert.equal(meetingCleanupInfo(f.core).importing,true);
  await assert.rejects(clearMeetingMedia(f.core),{code:'MEDIA_BUSY'});gate.resolve();const results=await Promise.all([first,second]);assert(results.every(result=>result.imported.length===1));assert.equal(f.core.mediaImports,0);
  await assert.rejects(f.core.importMedia([], 'unsupported-language'));assert.equal(f.core.mediaImports,0);assert.equal(meetingCleanupInfo(f.core).importing,false);
  assert.equal((await clearMeetingMedia(f.core)).deletedRecords,2);assert.equal(await fs.readFile(source,'utf8'),'original');
});

test('an ongoing cleanup rejects importing, transcription and another cleanup until it completes',async t=>{
  const f=await fixture(t),audio=await asset(f,'audio','meeting.wav');record(f,'recording',audio);
  const gate=deferred(),stat=fs.lstat,managedRoot=path.join(f.dataDir,'files');let held=false;
  t.mock.method(fs,'lstat',async(file,...args)=>{if(file===managedRoot&&!held){held=true;await gate.promise;}return stat(file,...args);});
  const pending=clearMeetingMedia(f.core);assert.equal(f.core.mediaClearing,true);
  await assert.rejects(f.core.importMedia([]),{code:'MEDIA_BUSY'});await assert.rejects(f.core.runRecording('recording'),{code:'MEDIA_BUSY'});await assert.rejects(clearMeetingMedia(f.core),{code:'MEDIA_BUSY'});
  gate.resolve();assert.equal((await pending).deletedRecords,1);assert.equal(f.core.mediaClearing,false);assert.equal(f.core.mediaImports||0,0);
});

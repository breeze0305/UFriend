'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');

const testRoot=path.resolve(__dirname,'../.test-data/core-media-tests');
async function fixture(t,kind,run){
  await fs.mkdir(testRoot,{recursive:true});const dataDir=await fs.mkdtemp(path.join(testRoot,'case-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dataDir)),testRoot);await fs.rm(dataDir,{recursive:true,force:true});});
  const models=new ModelAdapters();models.register(kind,{run});
  const store=new Store({dataDir}),core=new AppService({store,dataDir,models});
  await fs.mkdir(path.join(dataDir,'files'));await fs.writeFile(path.join(dataDir,'files','fixture.png'),'synthetic');
  store.update(state=>{state.assets.push({id:'fixture',file:'fixture.png',name:'fixture.png'});state.recordings.push({id:'recording',assetId:'fixture',name:'fixture.wav',lang:'zh-TW',state:'waiting-model',progress:0,segments:[]});});
  await core.setOcrImage({id:'fixture',name:'fixture.png'});
  return{core,store};
}
function deferred(){let resolve;return{promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};}

test('independent media endpoints migrate and reject remote paths; changing one endpoint cancels only its active work',async t=>{
  const waiting=deferred();const f=await fixture(t,'ocr',()=>waiting.promise);
  assert.equal(f.core.snapshot().settings.devOcr.endpoint,'http://127.0.0.1:8767');assert.equal(f.core.snapshot().settings.devWhisper.endpoint,'http://127.0.0.1:8768');
  for(const value of ['https://example.com','http://127.0.0.1/private','http://user:pass@localhost','http://localhost/?x=1'])assert.throws(()=>f.core.settings({devOcr:{endpoint:value}}));
  const pending=f.core.runOcr();f.core.settings({devWhisper:{endpoint:'http://127.0.0.1:8888'}});assert.equal(f.core.snapshot().ocr.status,'running');
  f.core.settings({devOcr:{endpoint:'http://127.0.0.1:8887'}});await pending;waiting.resolve({text:'late'});await Promise.resolve();
  assert.equal(f.core.snapshot().ocr.status,'cancelled');assert.equal(f.core.snapshot().ocr.text,'');
});

test('same-value OCR editor saves do not cancel inference; result metadata and regions stay associated with the image',async t=>{
  const waiting=deferred();const f=await fixture(t,'ocr',()=>waiting.promise);const pending=f.core.runOcr();
  f.core.saveOcrText('');assert.equal(f.core.snapshot().ocr.status,'running');
  const regions=[{text:'測試',confidence:0.9,box:[[0,0],[20,0],[20,10],[0,10]]}];
  waiting.resolve({text:'測試',regions,meta:{model:'fixture',backend:'test'}});await pending;
  assert.equal(f.core.snapshot().ocr.status,'done');assert.equal(f.core.snapshot().ocr.imageId,'fixture');assert.deepEqual(f.core.snapshot().ocr.regions,regions);
  assert.equal(f.core.active.has('ocr'),false);
});

test('empty image and silent recording complete honestly without invented text',async t=>{
  const ocr=await fixture(t,'ocr',()=>({text:'',regions:[]}));await ocr.core.runOcr();assert.equal(ocr.core.snapshot().ocr.status,'no-text');
  const asr=await fixture(t,'whisper',()=>({segments:[],language:'zh',duration:4,meta:{model:'fixture',backend:'test'}}));
  await asr.core.runRecording('recording');const recording=asr.core.snapshot().recordings[0];
  assert.equal(recording.state,'no-speech');assert.equal(recording.progress,100);assert.deepEqual(recording.segments,[]);assert.equal(recording.duration,4);
});

test('failed long transcription keeps its processed range while withholding a complete transcript',async t=>{
  const f=await fixture(t,'whisper',({onProgress})=>{onProgress(45,{processedSeconds:120,durationSeconds:270});throw Object.assign(new Error('Synthetic interruption'),{processedSeconds:125});});
  await f.core.runRecording('recording');const r=f.core.snapshot().recordings[0];
  assert.equal(r.state,'error');assert.equal(r.processedSeconds,125);assert.equal(r.progress,45);assert.equal(r.duration,270);assert.deepEqual(r.segments,[]);
  assert(!f.core.snapshot().logs.some(log=>log.text==='語音轉錄完成'));
});

test('changing a recording language cancels its in-flight interpretation and preserves later manual text',async t=>{
  const waiting=deferred();const f=await fixture(t,'whisper',()=>waiting.promise);
  const pending=f.core.runRecording('recording');f.core.updateRecording('recording',{lang:'en'});await pending;
  f.core.saveTranscript('recording',{format:'txt',text:'人工校正'});waiting.resolve({segments:[{start:0,end:1,text:'late'}]});await Promise.resolve();
  const r=f.core.snapshot().recordings[0];assert.equal(r.lang,'en');assert.equal(r.textOnly,'人工校正');assert.equal(r.transcriptSource,'manual');
});

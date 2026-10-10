'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const root=path.resolve(__dirname,'../.test-data/translation-tests');
async function fixture(t,run){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));
  t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});
  const models=new ModelAdapters();if(run)models.register('llm',{run});
  const store=new Store({dataDir}),core=new AppService({store,dataDir,models});
  return{store,core,reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
test('translation sends only the chosen text and languages, and persists the result across reopen',async t=>{
  let request;const f=await fixture(t,async value=>{request=value;return{text:'明天下午三點開會。',meta:{model:'fixture',backend:'test',secret:'omit'}};});
  f.store.update(state=>state.messages.push({body:'private email'}));
  f.core.saveTranslation({input:'Meet tomorrow at 15:00.',sourceLanguage:'en',targetLanguage:'zh-TW'});
  await f.core.runTranslation();assert.equal(request.task,'translate');assert.deepEqual(request.input,{text:'Meet tomorrow at 15:00.',sourceLanguage:'en',targetLanguage:'zh-TW'});
  const result=f.reopen().snapshot().translation;assert.equal(result.status,'done');assert.equal(result.output,'明天下午三點開會。');assert.deepEqual(result.meta,{source:'local',model:'fixture',backend:'test'});
  assert(!JSON.stringify(f.store.read().logs).includes('15:00'));
});
test('changing language cancels the old translation, and a late result cannot overwrite a retry',async t=>{
  const first=deferred(),started=deferred();let calls=0;
  const f=await fixture(t,()=>{if(++calls===1){started.resolve();return first.promise;}return{text:'Hello'};});
  f.core.saveTranslation({input:'你好',targetLanguage:'ja'});const running=f.core.runTranslation();await started.promise;
  f.core.saveTranslation({targetLanguage:'en'});await running;await f.core.runTranslation();first.resolve({text:'こんにちは'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.core.snapshot().translation.output,'Hello');assert.equal(f.core.snapshot().translation.targetLanguage,'en');
});
test('same-value saves keep the current request alive, while explicit cancel preserves input',async t=>{
  const pending=deferred(),started=deferred();let signal;
  const f=await fixture(t,request=>{signal=request.signal;started.resolve();return pending.promise;});
  f.core.saveTranslation({input:'Keep this input.'});const run=f.core.runTranslation();await started.promise;
  f.core.saveTranslation({input:'Keep this input.'});assert.equal(signal.aborted,false);
  f.core.cancelTranslation();await run;assert.equal(signal.aborted,true);assert.equal(f.core.snapshot().translation.input,'Keep this input.');assert.equal(f.core.snapshot().translation.status,'cancelled');
  pending.resolve({text:'late'});assert.equal(f.core.snapshot().translation.output,'');
});
test('translation validation rejects invalid language and oversized input without losing a saved source',async t=>{
  const f=await fixture(t);f.core.saveTranslation({input:'saved'});
  for(const patch of [{targetLanguage:'auto'},{sourceLanguage:'made-up'},{input:'x'.repeat(16001)}])assert.throws(()=>f.core.saveTranslation(patch));
  assert.equal(f.core.snapshot().translation.input,'saved');await f.core.runTranslation();assert.equal(f.core.snapshot().translation.status,'waiting-model');
});
test('invalid output and input-capacity failure retain source and never present a successful translation',async t=>{
  for(const mode of ['invalid','capacity']){
    const f=await fixture(t,()=>{if(mode==='capacity')throw Object.assign(new Error('capacity'),{code:'MODEL_INPUT_TOO_LONG'});return{text:''};});
    f.core.saveTranslation({input:'original'});await f.core.runTranslation();assert.equal(f.core.snapshot().translation.status,'error');assert.equal(f.core.snapshot().translation.output,'');assert.equal(f.core.snapshot().translation.input,'original');
  }
});
test('changing the LLM endpoint cancels translation and restart recovers an interrupted job',async t=>{
  const started=deferred(),pending=deferred();const f=await fixture(t,()=>{started.resolve();return pending.promise;});
  f.core.saveTranslation({input:'original'});const run=f.core.runTranslation();await started.promise;
  f.core.settings({devLlm:{endpoint:'http://127.0.0.1:18888'}});await run;assert.equal(f.core.snapshot().translation.status,'cancelled');
  f.store.update(state=>state.translation.status='running');const reopened=f.reopen();assert.equal(reopened.snapshot().translation.status,'cancelled');assert.equal(reopened.snapshot().translation.input,'original');pending.resolve({text:'late'});
});

'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const {DEFAULT_UI_LANGUAGE,UI_LANGUAGES,normalizeUiLanguage}=require('../app/services/ui-language.cjs');

const root=path.resolve(__dirname,'../.test-data/ui-language-tests');
async function fixture(t,{settings={},run}={}){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dataDir)),root);await fs.rm(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir}),models=new ModelAdapters();
  store.update(state=>{state.settings=settings;});
  if(run)models.register('llm',{run});
  return{store,models,core:new AppService({store,dataDir,models}),reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('legacy or invalid UI language settings migrate to Traditional Chinese without changing the model language',async t=>{
  for(const stored of [undefined,null,'auto','zh','ja','invalid',false,42,[],{}]){
    const settings={preferredLanguage:'ja',theme:'dark',...(stored===undefined?{}:{uiLanguage:stored})};
    const f=await fixture(t,{settings}),state=f.core.snapshot();
    assert.equal(state.settings.uiLanguage,'zh-TW');
    assert.equal(state.settings.preferredLanguage,'ja');assert.equal(state.settings.theme,'dark');
    assert.equal(JSON.parse(await fs.readFile(f.store.file,'utf8')).settings.uiLanguage,'zh-TW');
    assert.equal(f.reopen().snapshot().settings.uiLanguage,'zh-TW');
  }
});

test('supported UI languages save and survive reopening independently of preferred language',async t=>{
  const f=await fixture(t,{settings:{preferredLanguage:'ko'}});
  assert.equal(DEFAULT_UI_LANGUAGE,'zh-TW');assert.deepEqual(UI_LANGUAGES,['zh-TW','en']);
  assert.equal(Object.isFrozen(UI_LANGUAGES),true);
  for(const uiLanguage of [...UI_LANGUAGES].reverse()){
    assert.equal(normalizeUiLanguage(uiLanguage),uiLanguage);
    const state=f.core.settings({uiLanguage});
    assert.equal(state.settings.uiLanguage,uiLanguage);assert.equal(state.settings.preferredLanguage,'ko');
    const reopened=f.reopen().snapshot();
    assert.equal(reopened.settings.uiLanguage,uiLanguage);assert.equal(reopened.settings.preferredLanguage,'ko');
  }
  f.core.settings({preferredLanguage:'en'});assert.equal(f.core.snapshot().settings.uiLanguage,'zh-TW');
});

test('invalid UI language values reject combined saves before writes, notifications or model cancellation',async t=>{
  const f=await fixture(t,{settings:{uiLanguage:'en',preferredLanguage:'ja'}});
  const controller=new AbortController();f.core.active.set('chat',controller);
  let changes=0;f.core.onChange=()=>{changes++;};
  const before=f.store.read(),file=await fs.readFile(f.store.file,'utf8');
  for(const uiLanguage of [undefined,null,false,true,0,1,NaN,{},[],['en'],new String('en'),'','auto','zh','zh-CN','ja','EN','en-US',' en','en ','en\n']){
    assert.throws(()=>normalizeUiLanguage(uiLanguage),/介面語言/);
    assert.throws(()=>f.core.settings({uiLanguage,theme:'dark',preferredLanguage:'en'}),/介面語言/);
  }
  assert.deepEqual(f.store.read(),before);assert.equal(await fs.readFile(f.store.file,'utf8'),file);
  assert.equal(changes,0);assert.equal(controller.signal.aborted,false);
});

test('UI language changes keep all active model controllers and complete the current streaming chat',async t=>{
  const started=deferred(),finished=deferred();
  const f=await fixture(t,{settings:{preferredLanguage:'ja'},run:request=>{started.resolve(request);return finished.promise;}});
  const pending=f.core.sendChat('Synthetic question'),request=await started.promise;
  const keys=['polish','mail-analysis','translation','ocr','recording:synthetic'];
  const controllers=Object.fromEntries(keys.map(key=>[key,new AbortController()]));
  for(const [key,controller]of Object.entries(controllers))f.core.active.set(key,controller);
  request.onDelta('Synthetic ');const initial=f.core.snapshot();
  for(const uiLanguage of ['en','en','zh-TW']){
    const state=f.core.settings({uiLanguage});
    assert.equal(request.signal.aborted,false);
    for(const [key,controller]of Object.entries(controllers)){
      assert.equal(controller.signal.aborted,false,key);assert.equal(f.core.active.get(key),controller);
    }
    assert.equal(state.chat.status,'running');assert.equal(state.chat.partialText,'Synthetic ');
    assert.equal(state.chat.streamId,initial.chat.streamId);assert.equal(state.chat.revision,initial.chat.revision);
    assert.equal(state.chatHistory.activeId,initial.chatHistory.activeId);
    assert.equal(state.settings.preferredLanguage,'ja');
  }
  request.onDelta('answer');finished.resolve({text:'Synthetic answer'});await pending;
  const completed=f.core.snapshot();
  assert.equal(completed.chat.status,'done');assert.equal(completed.chat.partialText,'');
  assert.deepEqual(completed.chat.messages.map(message=>message.content),['Synthetic question','Synthetic answer']);
  assert.deepEqual(f.reopen().snapshot().chat.messages,completed.chat.messages);
});

test('UI language changes leave LLM request context and saved prompts unchanged for every text task',async t=>{
  const profile={name:'Synthetic person',jobTitle:'Synthetic writer'};
  const prompts={chat:{system:'Synthetic instruction',user:'{{text}}'}};
  const f=await fixture(t,{settings:{compute:'dev-api',preferredLanguage:'ja',personalProfile:{enabled:true,...profile},llmPrompts:prompts}}),bodies=[];
  const adapter=new LocalLlmApiAdapter({getSettings:()=>f.core.snapshot().settings,fetchImpl:async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({apiVersion:'1',text:'Synthetic answer',analyses:[{}]}),{headers:{'Content-Type':'application/json'}});
  }});
  const tasks=['chat','polish','mail','translate'];
  for(const uiLanguage of UI_LANGUAGES){
    f.core.settings({uiLanguage});
    for(const task of tasks)await adapter.run({task,input:task==='chat'?{messages:[{role:'user',content:'Synthetic question'}]}:{text:'Synthetic text'}});
  }
  for(let index=0;index<tasks.length;index++){
    assert.deepEqual(bodies[index+tasks.length],bodies[index]);
    assert.equal(Object.hasOwn(bodies[index],'uiLanguage'),false);
    assert.equal(Object.hasOwn(bodies[index].context||{},'uiLanguage'),false);
  }
  assert.deepEqual(bodies[0].context,{preferredLanguage:'ja',profile});assert.deepEqual(bodies[0].prompt,prompts.chat);
  assert.deepEqual(bodies[1].context,{profile});assert.deepEqual(bodies[2].context,{profile});assert.equal(bodies[3].context,undefined);
  const settings=f.reopen().snapshot().settings;
  assert.equal(settings.preferredLanguage,'ja');assert.deepEqual(settings.llmPrompts,prompts);
});

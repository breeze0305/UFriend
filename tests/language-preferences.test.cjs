'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs'),{AppService}=require('../app/services/core.cjs'),{ModelAdapters}=require('../app/models/adapters.cjs'),{LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const root=path.resolve(__dirname,'../.test-data/language-tests');
async function fixture(t){await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});const store=new Store({dataDir}),models=new ModelAdapters();return{store,core:new AppService({store,dataDir,models}),reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};}
test('preferred language migrates to Traditional Chinese, persists choices and rejects invalid changes atomically',async t=>{
  const f=await fixture(t);assert.equal(f.core.snapshot().settings.preferredLanguage,'zh-TW');f.core.settings({preferredLanguage:'ja'});assert.equal(f.reopen().snapshot().settings.preferredLanguage,'ja');
  for(const value of ['auto','unknown',null,{},''])assert.throws(()=>f.core.settings({preferredLanguage:value,theme:'dark'}));assert.equal(f.core.snapshot().settings.preferredLanguage,'ja');assert.equal(f.core.snapshot().settings.theme,'system');
  f.store.update(state=>{state.settings.preferredLanguage='invalid-stored-language';});assert.equal(f.reopen().snapshot().settings.preferredLanguage,'zh-TW');
});
test('changing preferred language cancels only chat and same-value saves keep it running',async t=>{
  const f=await fixture(t),controllers=Object.fromEntries(['chat','polish','mail-analysis','translation'].map(key=>[key,new AbortController()]));for(const [key,value]of Object.entries(controllers))f.core.active.set(key,value);
  f.core.settings({preferredLanguage:'zh-TW'});assert.equal(controllers.chat.signal.aborted,false);f.core.settings({preferredLanguage:'en'});assert.equal(controllers.chat.signal.aborted,true);for(const key of ['polish','mail-analysis','translation'])assert.equal(controllers[key].signal.aborted,false);
});
test('the request carries a language snapshot only for chat, without rewriting saved prompts',async()=>{
  const settings={compute:'dev-api',preferredLanguage:'ja',llmPrompts:{chat:{system:'Synthetic default',user:'{{text}}'}}},bodies=[];
  const adapter=new LocalLlmApiAdapter({getSettings:()=>settings,fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({apiVersion:'1',text:'Synthetic answer',analyses:[{}]}),{headers:{'Content-Type':'application/json'}});}});
  const pending=adapter.run({task:'chat',input:{messages:[{role:'user',content:'Synthetic question'}]}});settings.preferredLanguage='en';await pending;assert.deepEqual(bodies[0].context,{preferredLanguage:'ja'});assert.deepEqual(bodies[0].prompt,settings.llmPrompts.chat);
  for(const task of ['polish','mail','translate'])await adapter.run({task,input:{text:'Synthetic question'}});for(const body of bodies.slice(1))assert.equal(body.context,undefined);
});

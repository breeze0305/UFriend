'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs'),{AppService}=require('../app/services/core.cjs'),{ModelAdapters}=require('../app/models/adapters.cjs');
const {validatePrompt,validatePromptOverrides}=require('../app/services/llm-prompts.cjs');
const root=path.resolve(__dirname,'../.test-data/prompt-tests');
async function fixture(t){await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});const models=new ModelAdapters(),store=new Store({dataDir});return{models,store,core:new AppService({store,dataDir,models}),reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};}
test('prompt validation supports deliberate empty system text and only documented required template variables',()=>{
  assert.deepEqual(validatePrompt('chat',{system:'',user:'問題：{{text}}',extra:'discard'}),{system:'',user:'問題：{{text}}'});
  assert.deepEqual(Object.keys(validatePromptOverrides({mail:{system:'只分析',user:'原文{{lines}} 本人{{recipient}}'}})),['mail']);
  for(const [task,prompt] of [['unknown',{system:'a',user:'{{text}}'}],['chat',{system:'a',user:'nothing'}],['polish',{system:'a',user:'{{text}} {{secret}}'}],['chat',{system:'x'.repeat(12001),user:'{{text}}'}],['mail',{system:'a',user:'{{text}}'}]])assert.throws(()=>validatePrompt(task,prompt));
  assert.throws(()=>validatePromptOverrides(JSON.parse('{"__proto__":{"system":"a","user":"{{text}}"}}')));
  assert.throws(()=>validatePrompt('chat',{system:'{{secret}}',user:'{{text}}'}));
  assert.throws(()=>validatePrompt('chat',{system:'a',user:'{{text}} {{broken'}));
});
test('saved task prompts persist, resetting one task keeps others, and invalid edits are atomic',async t=>{
  const f=await fixture(t),mail={system:'郵件實驗',user:'{{lines}}'},chat={system:'對話實驗',user:'{{text}}'};
  f.core.settings({llmPrompts:{mail,chat}});assert.deepEqual(f.reopen().snapshot().settings.llmPrompts,{mail,chat});
  assert.throws(()=>f.core.settings({llmPrompts:{mail,chat:{system:'bad',user:'missing'}}}));assert.deepEqual(f.core.snapshot().settings.llmPrompts,{mail,chat});
  f.core.settings({llmPrompts:{mail}});assert.deepEqual(f.reopen().snapshot().settings.llmPrompts,{mail});
  assert(!JSON.stringify(f.store.read().logs).includes('郵件實驗'));
});
test('changing a task prompt cancels only that task and same-value saves do not cancel work',async t=>{
  const f=await fixture(t),chat={system:'a',user:'{{text}}'};f.core.settings({llmPrompts:{chat}});
  const chatJob=new AbortController(),translationJob=new AbortController();f.core.active.set('chat',chatJob);f.core.active.set('translation',translationJob);
  f.core.settings({llmPrompts:{chat}});assert.equal(chatJob.signal.aborted,false);
  f.core.settings({llmPrompts:{chat:{system:'b',user:'{{text}}'}}});assert.equal(chatJob.signal.aborted,true);assert.equal(translationJob.signal.aborted,false);
  f.core.cancelTranslation();
});

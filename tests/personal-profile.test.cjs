'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {emptyProfile,normalizeProfile,profileContext}=require('../app/services/personal-profile.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs'),{AppService}=require('../app/services/core.cjs'),{ModelAdapters}=require('../app/models/adapters.cjs'),{LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const root=path.resolve(__dirname,'../.test-data/profile-tests');
async function fixture(t){await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});const store=new Store({dataDir}),models=new ModelAdapters();return{store,models,core:new AppService({store,dataDir,models}),reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};}
test('personal information keeps only supported fields and empty or disabled profiles send no background',()=>{
  assert.equal(profileContext(emptyProfile()),undefined);assert.equal(profileContext({enabled:false,name:'Synthetic person'}),undefined);
  assert.deepEqual(profileContext({name:' Synthetic person ',personalEmail:'synthetic@example.invalid',notes:'Role: {{unknown}}\nThis is background.'}),{name:'Synthetic person',personalEmail:'synthetic@example.invalid',notes:'Role: {{unknown}}\nThis is background.'});
  assert.throws(()=>normalizeProfile({name:'Synthetic',password:'secret'}));assert.throws(()=>normalizeProfile({enabled:'true'}));
});
test('invalid email, oversized or unsafe input is rejected without reflecting personal values',()=>{
  for(const value of [{name:'x'.repeat(121)},{phone:'x'.repeat(81)},{notes:'x'.repeat(2001)},{personalEmail:'PRIVATE_INVALID_ADDRESS'},{workEmail:'PRIVATE_INVALID_ADDRESS'},{name:'PRIVATE\nNAME'},{notes:'PRIVATE\x00DATA'},JSON.parse('{"__proto__":{"notes":"PRIVATE"}}')]){
    assert.throws(()=>normalizeProfile(value),error=>!error.message.includes('PRIVATE'));
  }
  assert.throws(()=>normalizeProfile({notes:'\\'.repeat(2000),name:'x'.repeat(120),phone:'x'.repeat(80),company:'x'.repeat(120),jobTitle:'x'.repeat(120),personalEmail:'a'.repeat(220)+'@example.invalid',workEmail:'a'.repeat(220)+'@example.invalid'}));
});

test('profile persists locally, rejects invalid combined saves atomically and excludes fields from operation logs',async t=>{
  const f=await fixture(t);assert.deepEqual(f.core.snapshot().settings.personalProfile,emptyProfile());
  const profile={enabled:true,name:'Synthetic Private Person',phone:'TEST-555-0199',personalEmail:'synthetic@example.invalid',workEmail:'office@example.invalid',company:'Synthetic Workshop',jobTitle:'Synthetic Designer',notes:'Synthetic background'};
  f.core.settings({personalProfile:profile});assert.deepEqual(f.reopen().snapshot().settings.personalProfile,profile);
  assert.throws(()=>f.core.settings({preferredLanguage:'en',personalProfile:{personalEmail:'INVALID_PRIVATE'}}));assert.equal(f.core.snapshot().settings.preferredLanguage,'zh-TW');assert.deepEqual(f.core.snapshot().settings.personalProfile,profile);
  for(const value of Object.values(profile).filter(value=>typeof value==='string'))assert(!JSON.stringify(f.store.read().logs).includes(value));
  f.store.update(state=>{state.settings.personalProfile={enabled:true,notes:8};});assert.deepEqual(f.reopen().snapshot().settings.personalProfile,emptyProfile());
});

test('effective profile changes cancel chat, mail and polish while preserving translation and same-context work',async t=>{
  const f=await fixture(t),profile={enabled:true,name:'Synthetic'};f.core.settings({personalProfile:profile});
  const controllers=Object.fromEntries(['chat','polish','mail-analysis','translation'].map(key=>[key,new AbortController()]));for(const [key,value]of Object.entries(controllers))f.core.active.set(key,value);
  f.core.settings({personalProfile:profile});for(const controller of Object.values(controllers))assert.equal(controller.signal.aborted,false);
  f.core.settings({personalProfile:{...profile,enabled:false}});for(const key of ['chat','polish','mail-analysis'])assert.equal(controllers[key].signal.aborted,true);assert.equal(controllers.translation.signal.aborted,false);
  const chat=new AbortController();f.core.active.set('chat',chat);f.core.settings({personalProfile:{enabled:false,name:'Synthetic changed'}});assert.equal(chat.signal.aborted,false);
});

test('disabling profile rejects late chat and polish output generated with old background',async t=>{
  const f=await fixture(t),requests=[];f.models.register('llm',{run:request=>new Promise(resolve=>requests.push({request,resolve}))});f.core.settings({personalProfile:{name:'Synthetic'}});
  const chat=f.core.sendChat('Synthetic question');f.core.savePolish({input:'Synthetic text'});const polish=f.core.runPolish();await Promise.resolve();assert.equal(requests.length,2);
  f.core.settings({personalProfile:{enabled:false,name:'Synthetic'}});await Promise.all([chat,polish]);for(const pending of requests){assert(pending.request.signal.aborted);pending.resolve({text:'Late private answer'});}await Promise.resolve();
  assert.equal(f.core.snapshot().chat.messages.length,0);assert.equal(f.core.snapshot().chat.draft,'Synthetic question');assert.equal(f.core.snapshot().polish.output,'');assert.equal(f.core.snapshot().polish.input,'Synthetic text');
});

test('request snapshots send enabled nonempty profile to supported tasks only without logging private background',async()=>{
  const profile={name:'Synthetic Private Marker',personalEmail:'synthetic@example.invalid',jobTitle:'Synthetic Designer'},settings={compute:'dev-api',preferredLanguage:'ja',personalProfile:{enabled:true,...profile}},bodies=[],events=[];
  const adapter=new LocalLlmApiAdapter({getSettings:()=>settings,onDiagnostic:event=>events.push(event),fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({apiVersion:'1',text:'Synthetic answer',analyses:[{}]}),{headers:{'Content-Type':'application/json'}});}});
  const pending=adapter.run({task:'chat',input:{messages:[{role:'user',content:'Synthetic question'}]}});settings.personalProfile.name='Changed';await pending;assert.deepEqual(bodies[0].context,{preferredLanguage:'ja',profile});
  for(const task of ['polish','mail','translate'])await adapter.run({task,input:{text:'Synthetic question'}});
  assert.deepEqual(bodies[1].context,{profile:{...profile,name:'Changed'}});assert.deepEqual(bodies[2].context,bodies[1].context);assert.equal(bodies[3].context,undefined);
  settings.personalProfile.enabled=false;await adapter.run({task:'chat',input:{messages:[{role:'user',content:'Synthetic question'}]}});assert.deepEqual(bodies[4].context,{preferredLanguage:'ja'});
  for(const value of Object.values(profile))assert(!JSON.stringify(events).includes(value));assert(!JSON.stringify(events).includes('Changed'));
});

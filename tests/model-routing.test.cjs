'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ModelAdapters,localApiEnabled}=require('../app/models/adapters.cjs');

test('task sources route independently and do not fall back on failure or missing adapters',async()=>{
  const models=new ModelAdapters(),calls=[];
  models.register('llm',{run:async request=>{calls.push(['local',request.source]);return{text:'local response'};}});
  models.register('llm',{run:async request=>{calls.push(['cloud',request.source]);throw Object.assign(new Error('unavailable'),{code:'MODEL_API_UNAVAILABLE'});}},{source:'cloud'});
  assert.equal((await models.run('llm',{source:'local'})).meta.source,'local');
  await assert.rejects(models.run('llm',{source:'cloud'}),{code:'MODEL_API_UNAVAILABLE'});
  await assert.rejects(models.run('ocr',{source:'cloud'}),{code:'MODEL_NOT_CONFIGURED'});
  assert.deepEqual(calls,[['local','local'],['cloud','cloud']]);
});

test('source validation happens before any adapter is invoked',async()=>{
  const models=new ModelAdapters();models.register('llm',{run(){assert.fail('invalid source reached local model');}});
  for(const source of ['dev-api','ugen300','remote','',null,{},false])await assert.rejects(models.run('llm',{source}),{code:'MODEL_INVALID_SOURCE'});
  assert.throws(()=>models.register('llm',{run(){}},{source:'remote'}),{code:'MODEL_INVALID_SOURCE'});
});

test('source availability is separate and each completed result retains its execution source',async()=>{
  const models=new ModelAdapters();let complete;
  models.register('llm',{isConfigured:()=>true,run:()=>new Promise(resolve=>{complete=resolve;})});
  models.register('llm',{isConfigured:()=>false,run:async()=>({text:'cloud'})},{source:'cloud'});
  assert.equal(models.status().sources.local.llm.configured,true);
  assert.equal(models.status().sources.cloud.llm.configured,false);
  const running=models.run('llm',{source:'local'});
  models.register('llm',{run:async()=>({text:'new local adapter'})});
  complete({text:'original local result',meta:{model:'fixture',source:'cloud'}});
  assert.deepEqual(await running,{text:'original local result',meta:{model:'fixture',source:'local'}});
});

test('new local backend configuration takes precedence over legacy compute mode',()=>{
  assert.equal(localApiEnabled({localBackend:'pc-api',compute:'cloud'}),true);
  assert.equal(localApiEnabled({localBackend:'ugen300',compute:'dev-api'}),false);
  assert.equal(localApiEnabled({compute:'dev-api'}),true);
});

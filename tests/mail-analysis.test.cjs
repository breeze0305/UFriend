'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');

const testRoot=path.resolve(__dirname,'..','.test-data','mail-analysis-tests');
const mail=(id,patch={})=>({id,folder:'inbox',done:false,level:null,analysis:null,subject:'請確認 '+id,
  body:'請在明天下午三點前回覆報價。謝謝。',date:'2026-09-09T10:00:00.000Z',sender:'Fixture Sender',...patch});
const result=(id,patch={})=>({analyses:[{id,summary:'確認報價並回覆。',priority:1,reason:'郵件明確要求限時回覆。',evidence:['明天下午三點前回覆報價'],...patch}],
  meta:{model:'fixture-model',backend:'fixture-api',privateExtra:'not persisted'}});
const organize={categorize:true,onlyChanged:true};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function assertProgressCleared(state){assert(!state.phase);assert(!state.currentId);assert(!Object.hasOwn(state,'chunkIndex'));assert(!Object.hasOwn(state,'chunkTotal'));}
async function fixture(t,run){
  await fs.mkdir(testRoot,{recursive:true});const dataDir=await fs.mkdtemp(path.join(testRoot,'case-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dataDir)),testRoot);assert.match(path.basename(dataDir),/^case-/);await fs.rm(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir}),models=new ModelAdapters();if(run)models.register('llm',{run});
  const core=new AppService({store,dataDir,models});
  return{store,core,models,reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models:new ModelAdapters()})};
}

test('organization summarizes every inbox mail including read and done, then classifies only the generated summary',async t=>{
  const calls=[];
  const f=await fixture(t,request=>{
    calls.push(request);
    if(request.task==='mail')return result(request.input.messages[0].id);
    assert.equal(request.task,'mail-classify');assert.deepEqual(request.input,{summary:'確認報價並回覆。'});
    const saved=f.core.snapshot().messages.find(m=>m.analysis?.categoryStatus==='pending');
    assert(saved);assert.equal(saved.analysis.summary,'確認報價並回覆。');assert.equal(saved.analysis.category,undefined);
    return{category:'work',meta:{model:'category-fixture'}};
  });
  f.store.update(d=>{d.messages=[mail('unread',{read:false}),mail('read',{read:true}),mail('done',{done:true}),mail('sent',{folder:'sent'})];});
  const state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.processed,3);assert.deepEqual(calls.map(c=>c.task),['mail','mail-classify','mail','mail-classify','mail','mail-classify']);
  for(const item of state.messages.slice(0,3)){assert.equal(item.analysis.category,'work');assert.equal(item.analysis.categoryStatus,'done');assert.match(item.analysis.fingerprint,/^[a-f0-9]{64}$/);}
  assert.equal(state.messages[3].analysis,null);
  assert.equal(f.reopen().snapshot().messages[0].analysis.category,'work');
  const unchanged=await f.core.analyzeMail('local',organize);assert.equal(calls.length,6);assert.equal(unchanged.mailAnalysis.unchanged,3);
});

for(const source of ['local','cloud'])test(`${source} mail analysis saves Traditional Chinese before classification without changing original mail or evidence`,async t=>{
  const original=mail('traditional',{subject:'求助信',body:'请提供汇款账号信息。',html:'<p>请提供汇款账号信息。</p>',sender:'测试寄件人'});
  const calls=[],summary='求助信 - 請求匯款帳號資訊',reason='需要匯款帳號資訊。';
  const run=request=>{
    calls.push(request.task);
    if(request.task==='mail'){
      assert.equal(request.input.messages[0].body,original.body);
      return result(original.id,{summary:'求助信 - 请求汇款账号信息',reason:'需要汇款账号信息。',priority:2,evidence:[original.body]});
    }
    assert.deepEqual(request.input,{summary});
    const pending=f.store.read().messages[0].analysis;
    assert.equal(pending.categoryStatus,'pending');assert.equal(pending.summary,summary);assert.equal(pending.reason,reason);
    assert.deepEqual(pending.evidence,[original.body]);assert(pending.sourceFacts.includes(original.body));
    return{category:'finance'};
  };
  const f=await fixture(t,run);if(source==='cloud')f.models.register('llm',{run},{source});
  f.store.update(state=>{state.messages=[original];});
  const state=await f.core.analyzeMail(source,organize),saved=f.store.read().messages[0];
  assert.equal(state.mailAnalysis.failed,0);assert.deepEqual(calls,['mail','mail-classify']);
  assert.equal(saved.analysis.summary,summary);assert.equal(saved.analysis.reason,reason);assert.equal(saved.analysis.category,'finance');
  assert.deepEqual(saved.analysis.evidence,[original.body]);assert(saved.analysis.sourceFacts.includes(original.body));
  for(const key of ['subject','body','html','sender'])assert.equal(saved[key],original[key],key);
  const fingerprint=saved.analysis.fingerprint;
  const unchanged=await f.core.analyzeMail(source,organize);
  assert.deepEqual(calls,['mail','mail-classify']);assert.equal(unchanged.mailAnalysis.unchanged,1);
  assert.equal(unchanged.messages[0].analysis.fingerprint,fingerprint);
});

test('snapshots convert existing simplified summaries without writing, changing fingerprints, or rerunning cached models',async t=>{
  let calls=0;
  const original=mail('existing-language',{subject:'求助信',body:'请提供汇款账号信息。',html:'<p>请提供汇款账号信息。</p>'});
  const f=await fixture(t,request=>{
    calls++;
    return request.task==='mail'?result(original.id,{summary:'求助信 - 請求匯款帳號資訊',reason:'需要匯款帳號資訊。',priority:2,evidence:[original.body]}):{category:'finance'};
  });
  f.store.update(state=>{state.messages=[original];});await f.core.analyzeMail('local',organize);
  f.store.update(state=>{
    Object.assign(state.messages[0].analysis,{summary:'求助信 - 请求汇款账号信息',reason:'需要汇款账号信息。'});
    state.messages.push(mail('not-analyzed',{body:'尚未整理的简体正文。'}));
  });
  const stored=f.store.read(),fileBefore=await fs.readFile(f.store.file),backupBefore=await fs.readFile(f.store.backup);
  const update=f.store.update;let writes=0;
  f.store.update=function(...args){writes++;return update.apply(this,args);};
  const snapshot=f.core.snapshot(),analysis=snapshot.messages[0].analysis;
  assert.equal(analysis.summary,'求助信 - 請求匯款帳號資訊');assert.equal(analysis.reason,'需要匯款帳號資訊。');
  for(const key of ['fingerprint','summaryFingerprint','analyzedAt','category','categoryStatus','evidence','sourceFacts','quality','meta'])assert.deepEqual(analysis[key],stored.messages[0].analysis[key],key);
  assert.deepEqual(snapshot.messages[0],{...stored.messages[0],analysis});
  assert.deepEqual(snapshot.messages[1],stored.messages[1]);assert.equal(calls,2);
  assert.deepEqual(f.store.read(),stored);assert.deepEqual(await fs.readFile(f.store.file),fileBefore);assert.deepEqual(await fs.readFile(f.store.backup),backupBefore);
  assert.deepEqual(f.core.snapshot().messages[0].analysis,analysis);
  assert.equal(writes,0);f.store.update=update;
  const unchanged=await f.core.analyzeMail('local',{...organize,ids:[original.id]});
  assert.equal(unchanged.mailAnalysis.unchanged,1);assert.equal(calls,2);
  assert.equal(unchanged.messages[0].analysis.fingerprint,stored.messages[0].analysis.fingerprint);
  assert.deepEqual(f.store.read().messages[0].analysis,stored.messages[0].analysis);
});

test('organization cache ignores read, manual priority, done and labels, but refreshes content, source and effective settings',async t=>{
  const calls=[],run=request=>{calls.push(request.task);return request.task==='mail'?result(request.input.messages[0].id):{category:'work'};};
  const f=await fixture(t,run);f.models.register('llm',{run},{source:'cloud'});
  f.store.update(d=>{d.messages=[mail('cached')];});await f.core.analyzeMail('local',organize);
  f.store.update(d=>Object.assign(d.messages[0],{read:true,done:true,level:2,prioritySource:'manual',labels:['test']}));
  await f.core.analyzeMail('local',organize);assert.equal(calls.length,2);
  f.core.settings({modelDefaults:{ocr:'cloud'},theme:'dark'});await f.core.analyzeMail('local',organize);assert.equal(calls.length,2);
  f.store.update(d=>{d.messages[0].body+='新增資訊。';});await f.core.analyzeMail('local',organize);assert.equal(calls.length,4);assert.equal(f.core.snapshot().messages[0].level,2);
  await f.core.analyzeMail('cloud',organize);assert.equal(calls.length,6);
  f.core.settings({api:{model:'next-model'}});await f.core.analyzeMail('cloud',organize);assert.equal(calls.length,8);
  await f.core.analyzeMail('cloud',{...organize,onlyChanged:false,ids:['cached']});assert.equal(calls.length,10);
});

test('classification failure retains the new summary and retry reuses it without a fake category',async t=>{
  let classifications=0,summaries=0;
  const f=await fixture(t,request=>{
    if(request.task==='mail'){summaries++;return result(request.input.messages[0].id);}
    classifications++;if(classifications===1)throw new Error('Synthetic classifier failed');return{category:'finance'};
  });
  f.store.update(d=>{d.messages=[mail('partial',{analysis:{summary:'old',category:'personal',categoryStatus:'done'}})];});
  let state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.failed,1);assert.equal(state.messages[0].analysis.summary,'確認報價並回覆。');assert.equal(state.messages[0].analysis.category,undefined);assert.equal(state.messages[0].analysis.categoryStatus,'error');
  assert.match(state.messages[0].analysis.categoryError,/Synthetic/);
  state=await f.core.analyzeMail('local',organize);assert.equal(summaries,1);assert.equal(classifications,2);assert.equal(state.messages[0].analysis.category,'finance');assert.equal(state.messages[0].analysisError,undefined);
});

test('segmented progress counts completed chunks separately from mail and clears before classification and completion',async t=>{
  const seen=[];
  const f=await fixture(t,request=>{
    if(request.task==='mail-classify'){seen.push({step:'classification',snapshot:f.core.snapshot()});return{category:'work'};}
    for(const details of [{stage:'mail-chunks',chunkIndex:0,chunkTotal:2},{stage:'mail-chunks',chunkIndex:1,chunkTotal:2},{stage:'mail-chunks',chunkIndex:1,chunkTotal:3},{stage:'mail-chunks',chunkIndex:3,chunkTotal:3},{stage:'mail-merge',chunkIndex:3,chunkTotal:3}]){
      request.onProgress(undefined,details);seen.push({step:details.stage,snapshot:f.core.snapshot()});
    }
    return{...result('segmented'),meta:{model:'fixture-model',processingMode:'segmented',chunkCount:3,chunkSummaries:['must not persist']}};
  });
  const prior={summary:'Previously completed summary.',priority:2,reason:'Previous result.',evidence:['報價']};
  f.store.update(d=>{d.messages=[mail('segmented',{analysis:prior,level:1,prioritySource:'manual'})];});
  const state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.status,'done');assert.equal(state.mailAnalysis.processed,1);assert.equal(state.mailAnalysis.total,1);
  assert.deepEqual(seen.slice(0,5).map(({snapshot:s})=>[s.mailAnalysis.phase,s.mailAnalysis.chunkIndex,s.mailAnalysis.chunkTotal,s.mailAnalysis.processed]),[
    ['chunking',0,2,0],['chunking',1,2,0],['chunking',1,3,0],['chunking',3,3,0],['merging',3,3,0],
  ]);
  for(const {snapshot:s}of seen.slice(0,5)){assert.equal(s.mailAnalysis.currentId,'segmented');assert.deepEqual(s.messages[0].analysis,prior);assert.equal(s.messages[0].level,1);}
  const classifying=seen.at(-1).snapshot;assert.equal(classifying.mailAnalysis.phase,'classification');assert(!Object.hasOwn(classifying.mailAnalysis,'chunkIndex'));assert(!Object.hasOwn(classifying.mailAnalysis,'chunkTotal'));
  assert.equal(classifying.messages[0].analysis.categoryStatus,'pending');assert.equal(classifying.messages[0].analysis.summary,'確認報價並回覆。');
  assert.deepEqual(state.messages[0].analysis.meta,{source:'local',model:'fixture-model',processingMode:'segmented',chunkCount:3});
  assert.equal(state.messages[0].level,1);assertProgressCleared(state.mailAnalysis);assert.deepEqual(f.reopen().snapshot().messages[0].analysis.meta,state.messages[0].analysis.meta);
});

test('mail progress accepts only bounded stage counters and ignores duplicate reports and injected state fields',async t=>{
  const started=deferred(),finish=deferred();let request;
  const f=await fixture(t,next=>{if(next.task==='mail-classify')return{category:'work'};request=next;started.resolve();return finish.promise;});
  f.store.update(d=>{d.messages=[mail('safe-progress')];});const pending=f.core.analyzeMail('local',organize);await started.promise;
  request.onProgress(999,{stage:'mail-chunks',chunkIndex:0,chunkTotal:3,status:'done',processed:123,error:'Injected text',body:'Not progress data'});
  const baseline=f.core.snapshot().mailAnalysis;assert.equal(baseline.status,'running');assert.equal(baseline.processed,0);assert.equal(baseline.error,'');assert(!Object.hasOwn(baseline,'body'));
  let broadcasts=0;f.core.onChange=()=>{broadcasts++;};
  request.onProgress(undefined,{stage:'mail-chunks',chunkIndex:0,chunkTotal:3});assert.equal(broadcasts,0);
  const invalid=[undefined,null,[],{},'mail-chunks',
    {stage:'constructor',chunkIndex:1,chunkTotal:3},{stage:'<img>',chunkIndex:1,chunkTotal:3},
    {stage:'mail-chunks',chunkIndex:-1,chunkTotal:3},{stage:'mail-chunks',chunkIndex:4,chunkTotal:3},
    {stage:'mail-chunks',chunkIndex:0.5,chunkTotal:3},{stage:'mail-chunks',chunkIndex:'1',chunkTotal:3},
    {stage:'mail-chunks',chunkIndex:NaN,chunkTotal:3},{stage:'mail-chunks',chunkIndex:Infinity,chunkTotal:3},
    {stage:'mail-chunks',chunkIndex:0,chunkTotal:0},{stage:'mail-chunks',chunkIndex:0,chunkTotal:129},
    {stage:'mail-merge',chunkIndex:1,chunkTotal:'3'},
  ];
  for(const details of invalid){request.onProgress(undefined,details);assert.deepEqual(f.core.snapshot().mailAnalysis,baseline);}
  assert.equal(broadcasts,0);
  finish.resolve({...result('safe-progress'),meta:{model:'fixture-model',processingMode:'segmented',chunkCount:129}});
  const state=await pending;assert.equal(state.mailAnalysis.status,'done');assertProgressCleared(state.mailAnalysis);assert.deepEqual(state.messages[0].analysis.meta,{source:'local',model:'fixture-model'});
});

test('cancelled segmented work clears progress immediately and its late callbacks cannot alter a new run',async t=>{
  const firstStarted=deferred(),firstFinish=deferred(),secondStarted=deferred(),secondFinish=deferred(),requests=[];
  const f=await fixture(t,request=>{
    if(request.task==='mail-classify')return{category:'work'};requests.push(request);
    if(requests.length===1){firstStarted.resolve();return firstFinish.promise;}secondStarted.resolve();return secondFinish.promise;
  });
  f.store.update(d=>{d.messages=[mail('cancel-progress')];});const first=f.core.analyzeMail('local',organize);await firstStarted.promise;
  requests[0].onProgress(undefined,{stage:'mail-chunks',chunkIndex:1,chunkTotal:3});
  const cancelled=f.core.cancelMailAnalysis();assert.equal(cancelled.mailAnalysis.status,'cancelled');assertProgressCleared(cancelled.mailAnalysis);await first;
  requests[0].onProgress(undefined,{stage:'mail-merge',chunkIndex:3,chunkTotal:3});assert.deepEqual(f.core.snapshot().mailAnalysis,cancelled.mailAnalysis);
  const second=f.core.analyzeMail('local',organize);await secondStarted.promise;
  const fresh=f.core.snapshot().mailAnalysis;assert.equal(fresh.phase,'summary');
  requests[0].onProgress(undefined,{stage:'mail-chunks',chunkIndex:3,chunkTotal:3});firstFinish.resolve(result('cancel-progress'));await Promise.resolve();
  assert.deepEqual(f.core.snapshot().mailAnalysis,fresh);
  secondFinish.resolve(result('cancel-progress'));const state=await second;assert.equal(state.mailAnalysis.status,'done');assertProgressCleared(state.mailAnalysis);
});

test('URL-only input changes discard further progress and late segmented results for the old raw mail',async t=>{
  const started=deferred(),finish=deferred();let request;
  const f=await fixture(t,next=>{request=next;started.resolve();return finish.promise;});
  const prior={summary:'Previous valid summary.',priority:2,reason:'Previous result.',evidence:['回覆報價']};
  f.store.update(d=>{d.messages=[mail('stale-progress',{body:'請在明天下午三點前回覆報價。 https://fixture.example.test/?v=1',analysis:prior})];});
  const pending=f.core.analyzeMail('local',organize);await started.promise;
  request.onProgress(undefined,{stage:'mail-chunks',chunkIndex:1,chunkTotal:3});const previous=f.core.snapshot().mailAnalysis;
  f.store.update(d=>{d.messages[0].body=d.messages[0].body.replace('?v=1','?v=2');});
  request.onProgress(undefined,{stage:'mail-merge',chunkIndex:3,chunkTotal:3});assert.deepEqual(f.core.snapshot().mailAnalysis,previous);
  finish.resolve(result('stale-progress'));const state=await pending;
  assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.mailAnalysis.failed,0);assert.deepEqual(state.messages[0].analysis,prior);assertProgressCleared(state.mailAnalysis);
});

test('late progress from a completed summary cannot overwrite classification or the next mail in the same batch',async t=>{
  let earlier;const seen=[];
  const f=await fixture(t,request=>{
    if(request.task==='mail-classify'){
      const before=f.core.snapshot().mailAnalysis;earlier.onProgress(undefined,{stage:'mail-merge',chunkIndex:9,chunkTotal:9});seen.push([before,f.core.snapshot().mailAnalysis]);return{category:'work'};
    }
    if(request.input.messages[0].id==='first-progress'){earlier=request;request.onProgress(undefined,{stage:'mail-chunks',chunkIndex:1,chunkTotal:2});}
    else{const before=f.core.snapshot().mailAnalysis;earlier.onProgress(undefined,{stage:'mail-chunks',chunkIndex:2,chunkTotal:2});seen.push([before,f.core.snapshot().mailAnalysis]);}
    return result(request.input.messages[0].id);
  });
  f.store.update(d=>{d.messages=[mail('first-progress'),mail('second-progress')];});const state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.processed,2);assert.equal(state.mailAnalysis.status,'done');
  for(const [before,after]of seen){assert.deepEqual(after,before);assert(!Object.hasOwn(after,'chunkIndex'));assert(!Object.hasOwn(after,'chunkTotal'));}
  assert.equal(seen[1][0].currentId,'second-progress');assert.equal(seen[1][0].phase,'summary');assertProgressCleared(state.mailAnalysis);
});

test('failed segmented work preserves earlier analysis and clears counters before another mail or a blocked batch',async t=>{
  for(const code of ['MODEL_OUTPUT_LIMIT','MODEL_NOT_CONFIGURED']){
    const seen=[];const prior={summary:'Previous valid summary.',priority:2,reason:'Previous result.',evidence:['回覆報價']};
    const f=await fixture(t,request=>{
      if(request.task==='mail-classify')return{category:'work'};
      if(request.input.messages[0].id==='failed-progress'){request.onProgress(undefined,{stage:'mail-chunks',chunkIndex:1,chunkTotal:4});throw Object.assign(new Error('Synthetic segmented failure'),{code});}
      seen.push(f.core.snapshot().mailAnalysis);return result('after-failure');
    });
    f.store.update(d=>{d.messages=[mail('failed-progress',{analysis:prior}),mail('after-failure')];});
    if(code==='MODEL_NOT_CONFIGURED')await assert.rejects(f.core.analyzeMail('local',organize),{code});else await f.core.analyzeMail('local',organize);
    const state=f.core.snapshot();assert.equal(state.mailAnalysis.status,'error');assert.equal(state.mailAnalysis.failed,1);assert.deepEqual(state.messages[0].analysis,prior);assert(state.messages[0].analysisError);assertProgressCleared(state.mailAnalysis);
    assert.equal(seen.length,code==='MODEL_NOT_CONFIGURED'?0:1);
    if(seen.length){assert.equal(seen[0].phase,'summary');assert.equal(seen[0].currentId,'after-failure');assert(!Object.hasOwn(seen[0],'chunkIndex'));assert(!Object.hasOwn(seen[0],'chunkTotal'));}
  }
});

test('invalid categories keep summaries unclassified while other messages finish',async t=>{
  let count=0;const f=await fixture(t,request=>request.task==='mail'?result(request.input.messages[0].id):{category:++count===1?'invalid':'other'});
  f.store.update(d=>{d.messages=[mail('bad'),mail('good')];});const state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.failed,1);assert.equal(state.messages[0].analysis.category,undefined);assert.equal(state.messages[1].analysis.category,'other');
});

test('cancelling classification preserves the summary and ignores a late category after content changes',async t=>{
  const started=deferred(),finish=deferred();
  const f=await fixture(t,request=>{if(request.task==='mail')return result(request.input.messages[0].id);started.resolve();return finish.promise;});
  f.store.update(d=>{d.messages=[mail('cancel')];});const pending=f.core.analyzeMail('local',organize);await started.promise;
  f.core.cancelMailAnalysis();const state=await pending;assert.equal(state.mailAnalysis.status,'cancelled');assert.equal(state.messages[0].analysis.summary,'確認報價並回覆。');
  f.store.update(d=>{d.messages[0].body='changed';});finish.resolve({category:'meeting'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.core.snapshot().messages[0].analysis.category,undefined);assert.equal(f.core.active.size,0);
});

test('a changed mail cannot accept a late category, and a changed account cannot reuse old cache',async t=>{
  const started=deferred(),finish=deferred();let classifications=0;
  const f=await fixture(t,request=>{if(request.task==='mail')return result(request.input.messages[0].id);if(++classifications===1){started.resolve();return finish.promise;}return{category:'work'};});
  f.store.update(d=>{d.accounts=[{id:'a',email:'one@example.invalid'}];d.messages=[mail('changed',{accountId:'a'})];});
  const pending=f.core.analyzeMail('local',organize);await started.promise;f.store.update(d=>{d.accounts[0].email='two@example.invalid';});finish.resolve({category:'work'});
  const state=await pending;assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.messages[0].analysis.category,undefined);
  await f.core.analyzeMail('local',organize);assert.equal(classifications,2);
});

test('organization settings validate partial defaults and preserve an active source until its task ends',async t=>{
  const gate=deferred(),started=deferred();
  const f=await fixture(t,request=>{assert.equal(request.source,'local');if(request.task==='mail'){started.resolve();return gate.promise;}return{category:'work'};});
  f.core.settings({modelDefaults:{whisper:'cloud'},mailSchedule:{enabled:true,time:'23:59'}});
  f.core.settings({modelDefaults:{ocr:'cloud'},mailSchedule:{time:'00:01'}});
  assert.deepEqual(f.core.snapshot().settings.modelDefaults,{llm:'local',ocr:'cloud',whisper:'cloud'});assert.deepEqual(f.core.snapshot().settings.mailSchedule,{enabled:true,time:'00:01'});
  for(const value of [{time:'24:00'},{time:'9:00'},{enabled:'true'},null])assert.throws(()=>f.core.settings({mailSchedule:value}));
  for(const value of [{llm:'invalid'},{other:'local'},null])assert.throws(()=>f.core.settings({modelDefaults:value}));
  f.store.update(d=>{d.messages=[mail('default')];});const pending=f.core.analyzeMail(undefined,organize);await started.promise;
  f.core.settings({modelDefaults:{llm:'cloud'}});assert.equal(f.core.snapshot().mailAnalysis.status,'running');gate.resolve(result('default'));await pending;
  assert.equal(f.core.snapshot().messages[0].analysis.meta.source,'local');assert.equal(f.reopen().snapshot().settings.modelDefaults.llm,'cloud');
});

test('organization validates single-message scope and can retry after its initial save fails',async t=>{
  let calls=0;const f=await fixture(t,request=>{calls++;return request.task==='mail'?result(request.input.messages[0].id):{category:'work'};});
  f.store.update(d=>{d.messages=[mail('first'),mail('second'),mail('sent',{folder:'sent'})];});
  for(const ids of [[],['missing'],['sent'],'first'])await assert.rejects(f.core.analyzeMail('local',{...organize,ids}));
  const update=f.store.update.bind(f.store);let fail=true;f.store.update=mutate=>{if(fail){fail=false;throw new Error('Synthetic disk write failure');}return update(mutate);};
  await assert.rejects(f.core.analyzeMail('local',organize),/Synthetic disk/);assert.equal(calls,0);assert.equal(f.core.active.size,0);
  await f.core.analyzeMail('local',{...organize,ids:['second']});assert.equal(calls,2);assert.equal(f.core.snapshot().messages[0].analysis,null);assert.equal(f.core.snapshot().messages[1].analysis.category,'work');
});

test('mail analysis calls one message at a time, persists real progress and retains first results before the batch ends',async t=>{
  const second=deferred(),secondStarted=deferred(),calls=[];
  const f=await fixture(t,request=>{
    calls.push(request);assert.equal(request.task,'mail');assert.equal(request.input.messages.length,1);
    if(calls.length===1)return result('first');secondStarted.resolve();return second.promise;
  });
  f.store.update(d=>{d.messages=[mail('first'),mail('second'),mail('archived',{folder:'archive'}),mail('done',{done:true})];});
  const pending=f.core.analyzeMail();await secondStarted.promise;
  const partial=f.core.snapshot();
  assert.deepEqual(partial.mailAnalysis,{source:'local',status:'running',processed:1,total:2,failed:0,skipped:0,error:''});
  assert.equal(partial.messages[0].level,1);assert.equal(partial.messages[0].prioritySource,'model');
  assert.equal(partial.messages[0].analysis.summary,'確認報價並回覆。');assert.equal(partial.messages[1].analysis,null);
  assert.deepEqual(partial.messages[0].analysis.meta,{source:'local',model:'fixture-model',backend:'fixture-api'});
  assert.ok(Number.isFinite(Date.parse(partial.messages[0].analysis.analyzedAt)));
  assert.deepEqual(Object.keys(calls[0].input.messages[0]),['id','subject','body','date','sender','senderEmail','to','cc','contentContext']);
  assert.equal(calls[0].input.recipient,'');assert.deepEqual(calls[0].input.messages[0].to,[]);assert.deepEqual(calls[0].input.messages[0].cc,[]);
  assert.equal(calls[0].input.referenceTime,calls[1].input.referenceTime);
  assert.ok(Number.isFinite(Date.parse(calls[0].input.referenceTime)));assert.ok(calls[0].signal instanceof AbortSignal);
  f.store.update(d=>d.messages.push(mail('new-arrival')));
  second.resolve(result('second',{priority:2}));const complete=await pending;
  assert.deepEqual(complete.mailAnalysis,{source:'local',status:'done',processed:2,total:2,failed:0,skipped:0,error:''});
  assert.equal(complete.messages[1].level,2);assert.equal(complete.messages.at(-1).analysis,null);assert.equal(calls.length,2);
  const reopened=f.reopen().snapshot();assert.equal(reopened.messages[0].analysis.priority,1);assert.equal(reopened.messages[1].analysis.priority,2);
  assert.ok(!JSON.stringify(reopened.messages).includes('privateExtra'));assert.equal(f.core.active.has('mail-analysis'),false);
});

test('cancelled batches retain completed mail, resolve promptly and cannot overwrite a new batch with late results',async t=>{
  const old=deferred(),oldStarted=deferred(),fresh=deferred(),freshStarted=deferred();let calls=0;
  const requests=[];
  const f=await fixture(t,request=>{
    requests.push(request);calls++;
    if(calls===1)return result('first');
    if(calls===2){oldStarted.resolve();return old.promise;}
    if(calls===3){freshStarted.resolve();return fresh.promise;}
    return result(request.input.messages[0].id,{priority:2});
  });
  f.store.update(d=>{d.messages=[mail('first'),mail('second')];});
  const firstRun=f.core.analyzeMail();await oldStarted.promise;
  const cancelled=f.core.cancelMailAnalysis();assert.equal(requests[1].signal.aborted,true);
  assert.equal(cancelled.mailAnalysis.status,'cancelled');assert.equal(cancelled.mailAnalysis.processed,1);
  await firstRun;assert.equal(f.reopen().snapshot().messages[0].analysis.priority,1);
  const newRun=f.core.analyzeMail();await freshStarted.promise;
  await assert.rejects(f.core.analyzeMail(),{code:'MAIL_ANALYSIS_BUSY'});
  old.resolve(result('second',{priority:1}));await Promise.resolve();
  assert.equal(f.core.snapshot().mailAnalysis.status,'running');assert.equal(f.core.snapshot().mailAnalysis.processed,0);
  assert.equal(f.core.snapshot().messages[1].analysis,null);assert.equal(f.core.active.has('mail-analysis'),true);
  fresh.resolve(result('first',{priority:2}));await newRun;
  assert.equal(f.core.snapshot().messages[1].analysis.priority,2);assert.equal(calls,4);
});

test('manual priorities set during analysis or a previous run remain authoritative, including explicit unclassified',async t=>{
  for(const level of [0,1,2,null]){
    const wait=deferred();let first=true;
    const f=await fixture(t,()=>{if(first){first=false;return wait.promise;}return result('manual',{priority:2});});
    f.store.update(d=>{d.messages=[mail('manual')];});const pending=f.core.analyzeMail();
    f.core.updateLocalMessages(['manual'],{level});wait.resolve(result('manual'));await pending;
    let saved=f.core.snapshot().messages[0];assert.equal(saved.level,level);assert.equal(saved.prioritySource,'manual');assert.equal(saved.analysis.priority,1);
    await f.core.analyzeMail();saved=f.core.snapshot().messages[0];assert.equal(saved.level,level);assert.equal(saved.analysis.priority,2);
    assert.equal(f.reopen().snapshot().messages[0].level,level);
  }
  const f=await fixture(t,()=>result('legacy'));
  f.store.update(d=>{d.messages=[mail('legacy',{level:1})];});f.core.initialize();
  await f.core.analyzeMail();assert.equal(f.core.snapshot().messages[0].level,1);assert.equal(f.core.snapshot().messages[0].prioritySource,'manual');
});

test('invalid model output is rejected without replacing prior analysis and later messages still finish',async t=>{
  const invalid=[
    {},{analyses:[]},{analyses:[...result('bad').analyses,...result('bad').analyses]},
    result('different'),result('bad',{priority:'0'}),result('bad',{priority:1.5}),result('bad',{priority:3}),
    result('bad',{summary:' '}),result('bad',{summary:'x'.repeat(2001)}),result('bad',{reason:null}),result('bad',{reason:'x'.repeat(2001)}),
    result('bad',{evidence:[]}),result('bad',{evidence:'明天'}),result('bad',{evidence:[' ']}),
    result('bad',{evidence:['模型捏造的內容']}),result('bad',{evidence:['確認 bad\n請在明天']}),
    result('bad',{evidence:Array(9).fill('明天')}),result('bad',{evidence:['x'.repeat(1001)]})
  ];
  for(const bad of invalid){
    const f=await fixture(t,request=>request.input.messages[0].id==='bad'?bad:result('good'));
    const prior={summary:'previous confirmed result',priority:2,reason:'previous',evidence:['回覆報價']};
    f.store.update(d=>{d.messages=[mail('bad',{analysis:prior,level:2,prioritySource:'model'}),mail('good')];});
    const state=await f.core.analyzeMail();
    assert.equal(state.mailAnalysis.status,'error');assert.equal(state.mailAnalysis.processed,2);assert.equal(state.mailAnalysis.failed,1);
    assert.deepEqual(state.messages[0].analysis,prior);assert.equal(state.messages[0].level,2);assert.ok(state.messages[0].analysisError);
    assert.equal(state.messages[1].analysis.priority,1);assert.equal(state.messages[1].prioritySource,'model');
  }
});

test('a per-mail API failure or oversized input preserves earlier results and continues to later mail',async t=>{
  const calls=[];
  const f=await fixture(t,request=>{
    const id=request.input.messages[0].id;calls.push(id);
    if(id==='too-long')throw Object.assign(new Error('郵件超過模型內容長度，請縮短後再試。'),{code:'MODEL_INPUT_TOO_LONG'});
    return result(id);
  });
  f.store.update(d=>{d.messages=[mail('first'),mail('too-long'),mail('last')];});
  const state=await f.core.analyzeMail();assert.deepEqual(calls,['first','too-long','last']);
  assert.equal(state.mailAnalysis.failed,1);assert.equal(state.mailAnalysis.processed,3);assert.match(state.mailAnalysis.error,/超過模型內容長度/);
  assert.equal(state.messages[1].analysis,null);assert.equal(f.reopen().snapshot().messages[2].analysis.priority,1);
});

test('deleted, moved, completed or changed messages ignore in-flight results and queued changes are not submitted',async t=>{
  for(const mutate of [
    d=>{d.messages=[];},d=>{d.messages[0].folder='archive';},d=>{d.messages[0].done=true;},
    d=>{d.messages[0].subject='changed subject';},d=>{d.messages[0].body='changed body';},
    d=>{d.messages[0].date='2026-09-10T10:00:00.000Z';},d=>{d.messages[0].sender='Changed Sender';},
    d=>{d.messages[0].email='changed-sender@example.invalid';},d=>{d.messages[0].attachments=[{name:'new.pdf'}];},
    d=>{d.messages[0].html='<img src="https://example.invalid/new.png">';},
    d=>{d.messages[0].to='new-recipient@example.invalid';},d=>{d.messages[0].cc='new-copy@example.invalid';}
  ]){
    const wait=deferred();const f=await fixture(t,()=>wait.promise);
    f.store.update(d=>{d.messages=[mail('changed')];});const pending=f.core.analyzeMail();f.store.update(mutate);
    wait.resolve(result('changed'));const state=await pending;
    assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.mailAnalysis.failed,0);
    assert.ok(state.messages.every(m=>m.analysis===null&&m.level===null));
  }
  const wait=deferred();let calls=0;const f=await fixture(t,()=>{calls++;return wait.promise;});
  f.store.update(d=>{d.messages=[mail('first'),mail('queued')];});const pending=f.core.analyzeMail();
  f.store.update(d=>{d.messages[1].body='changed before its turn';});wait.resolve(result('first'));
  const state=await pending;assert.equal(calls,1);assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.mailAnalysis.processed,2);
});

test('recipient context uses the matching account and parsed To/Cc addresses without inventing local identity or exposing Bcc',async t=>{
  const requests=[];
  const f=await fixture(t,request=>{requests.push(request.input);return result(request.input.messages[0].id);});
  f.store.update(d=>{
    d.accounts=[{id:'gmail:alpha',email:'ALPHA@example.invalid'},{id:'gmail:beta',email:'beta@example.invalid'}];
    d.messages=[mail('alpha',{accountId:'gmail:alpha',to:'"Doe, Jane" <JANE@example.invalid>, Team: alpha@example.invalid, bob@example.invalid;',
      cc:'ALPHA@example.invalid, alpha@example.invalid, invalid-address',bcc:'private-copy@example.invalid'}),
      mail('beta',{accountId:'gmail:beta',to:'beta@example.invalid',cc:'alpha@example.invalid'}),
      mail('local',{accountId:'local',to:'local-target@example.invalid'}),
      mail('unsafe',{accountId:'missing-account',to:'safe@example.invalid\r\nBcc: bad@example.invalid',cc:{address:'object@example.invalid'}})];
  });
  await f.core.analyzeMail();
  assert.equal(requests[0].recipient,'alpha@example.invalid');
  assert.deepEqual(requests[0].messages[0].to,['jane@example.invalid','alpha@example.invalid','bob@example.invalid']);
  assert.deepEqual(requests[0].messages[0].cc,['alpha@example.invalid']);
  assert.equal(requests[1].recipient,'beta@example.invalid');assert.deepEqual(requests[1].messages[0].to,['beta@example.invalid']);
  assert.equal(requests[2].recipient,'');assert.deepEqual(requests[2].messages[0].to,['local-target@example.invalid']);
  assert.equal(requests[3].recipient,'');assert.deepEqual(requests[3].messages[0].to,[]);assert.deepEqual(requests[3].messages[0].cc,[]);
  assert.ok(!JSON.stringify(requests).includes('private-copy'));assert.ok(requests.every(input=>!Object.hasOwn(input.messages[0],'bcc')));
});

test('changing the account identity before a result arrives skips analysis made for the prior recipient',async t=>{
  const wait=deferred();const f=await fixture(t,()=>wait.promise);
  f.store.update(d=>{d.accounts=[{id:'account',email:'old@example.invalid'}];d.messages=[mail('changed',{accountId:'account'})];});
  const pending=f.core.analyzeMail();f.store.update(d=>{d.accounts[0].email='new@example.invalid';});
  wait.resolve(result('changed'));const state=await pending;
  assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.messages[0].analysis,null);assert.equal(state.messages[0].level,null);
});

test('empty inputs never call a model and interrupted batch state recovers without losing saved analysis',async t=>{
  let calls=0;const f=await fixture(t,()=>{calls++;return result('empty');});
  await assert.rejects(f.core.analyzeMail(),/沒有待分析/);assert.equal(calls,0);
  f.store.update(d=>{d.messages=[mail('empty',{subject:' ',body:''})];});const state=await f.core.analyzeMail();
  assert.equal(calls,0);assert.equal(state.messages[0].analysis,null);assert.equal(state.mailAnalysis.status,'error');
  f.store.update(d=>{d.messages[0]=mail('saved',{analysis:result('saved').analyses[0]});d.mailAnalysis={status:'running',processed:1,total:3,failed:0,skipped:0,error:'',phase:'chunking',currentId:'saved',chunkIndex:2,chunkTotal:5};});
  const restored=f.reopen().snapshot();assert.equal(restored.mailAnalysis.status,'cancelled');assert.equal(restored.mailAnalysis.processed,1);
  assert.equal(restored.mailAnalysis.total,3);assert.equal(restored.messages[0].analysis.summary,'確認報價並回覆。');assert.match(restored.mailAnalysis.error,/已中斷/);
  assertProgressCleared(restored.mailAnalysis);
});

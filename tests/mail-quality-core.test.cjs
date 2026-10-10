'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const {Store}=require('../app/services/store.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {applyMailQuality}=require('../app/services/mail-quality.cjs');

const testRoot=path.resolve(__dirname,'..','.test-data','mail-quality-core');
const coreFile=path.resolve(__dirname,'..','app','services','core.cjs');
const coreSource=fs.readFileSync(coreFile,'utf8'),moduleRequire=createRequire(coreFile);
const organize={categorize:true,onlyChanged:true};
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const mail=(patch={})=>({id:'synthetic',accountId:'account',folder:'inbox',done:false,read:false,level:null,analysis:null,
  subject:'Synthetic notification',body:'原文已確認。',date:'2026-09-17T01:00:00.000Z',sender:'Display Name',email:'SENDER@example.invalid',
  to:'reader@example.invalid',cc:'copy@example.invalid',html:'<p>原文已確認。</p>',attachments:[],...patch});
const response=(input,patch={})=>({analyses:[{id:input.id,summary:'原文已確認。',reason:'已確認的通知。',priority:0,evidence:[input.body],...patch}]});
const assessed=({analysis,input},patch={})=>({...analysis,sourceFacts:[input.subject],quality:{issues:[],summaryMode:'generated',priorityReview:false,contentLimited:false,...patch}});

async function fixture(t,{run,quality=assessed,message=mail(),now}={}){
  await fsp.mkdir(testRoot,{recursive:true});
  const dataDir=await fsp.mkdtemp(path.join(testRoot,'case-'));
  t.after(async()=>{const real=await fsp.realpath(dataDir);assert.equal(path.dirname(real).toLowerCase(),testRoot.toLowerCase());assert.match(path.basename(real),/^case-/);await fsp.rm(real,{recursive:true,force:true});});
  // Stub only the synchronous quality policy so these tests verify core's
  // save/race contract independently of the policy's linguistic decisions.
  const module={exports:{}};
  const ClockDate=now?class extends Date{
    constructor(...args){super(...(args.length?args:[now()]));}
    static now(){return new Date(now()).getTime();}
  }:Date;
  vm.runInNewContext(coreSource,{module,require:name=>name==='./mail-quality.cjs'?{applyMailQuality:quality}:moduleRequire(name),
    __filename:coreFile,__dirname:path.dirname(coreFile),process,console,Buffer,URL,Date:ClockDate,AbortController,AbortSignal,structuredClone,
    setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask},{filename:coreFile});
  const store=new Store({dataDir}),models=new ModelAdapters(),requests=[];
  models.register('llm',{run:request=>{requests.push(request);return run?run(request):request.task==='mail'?response(request.input.messages[0]):{category:'work'};}});
  const core=new module.exports.AppService({store,dataDir,models});
  store.update(state=>{state.accounts=[{id:'account',email:'reader@example.invalid'}];state.messages=[structuredClone(message)];});
  return{core,store,requests};
}

test('quality receives validated original quotations and locally derived context before and after classification',async t=>{
  const url='https://example.invalid/receipt?token=synthetic',original=mail({body:`原文已確認，連結 ${url}。`,html:'<img src="https://example.invalid/content.png">',attachments:[{name:'file.pdf'}]});
  const seen=[];
  const f=await fixture(t,{message:original,quality:args=>{
    seen.push(plain(args));assert.equal(args.analysis.sourceFacts,undefined);assert.equal(args.analysis.quality,undefined);
    assert.equal(args.input.body,original.body);assert.deepEqual(plain(args.analysis.evidence),[original.body]);
    // Deliberately omit policy fields here so the second invocation also has
    // an independent input; the next test checks persisted fields explicitly.
    return{...args.analysis};
  },run:request=>{
    if(request.task==='mail')return response(request.input.messages[0],{sourceFacts:['INJECTED'],quality:{priorityReview:false},untrusted:'field'});
    assert.equal(seen.length,1);assert.equal(f.store.read().messages[0].analysis.categoryStatus,'pending');
    return{category:'work'};
  }});
  const state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.status,'done');assert.equal(seen.length,2);
  assert.equal(seen[0].category,undefined);assert.equal(seen[1].category,'work');
  assert.equal(seen[0].recipient,'reader@example.invalid');assert.equal(seen[0].referenceTime,seen[1].referenceTime);
  const input=f.requests[0].input.messages[0];
  assert.equal(input.body,'原文已確認，連結 【網址】。');assert.equal(input.sender,'Display Name');assert.equal(input.senderEmail,'sender@example.invalid');
  assert.deepEqual(plain(input.contentContext),{attachmentCount:1,unreadImageCount:1,imageTextUnavailable:true,textLimited:true});
  assert(!Object.hasOwn(input,'html'));assert(!Object.hasOwn(input,'attachments'));
  for(const field of ['body','html','email','sender','attachments'])assert.deepEqual(state.messages[0][field],original[field]);
  assert.equal(state.messages[0].analysis.untrusted,undefined);
});

test('quality fields are produced locally and kept across the intermediate and final saves',async t=>{
  const f=await fixture(t,{quality:args=>assessed(args,{contentLimited:true}),run:request=>{
    if(request.task==='mail')return response(request.input.messages[0],{sourceFacts:['INJECTED'],quality:{issues:['INJECTED'],priorityReview:true}});
    assert.deepEqual(f.store.read().messages[0].analysis.sourceFacts,['Synthetic notification']);
    assert.equal(f.store.read().messages[0].analysis.quality.contentLimited,true);
    return{category:'account'};
  }});
  const state=await f.core.analyzeMail('local',organize),analysis=state.messages[0].analysis;
  assert.deepEqual(analysis.sourceFacts,['Synthetic notification']);assert.deepEqual(analysis.quality,{issues:[],summaryMode:'generated',priorityReview:false,contentLimited:true});
  assert.equal(state.messages[0].level,0);assert.equal(state.messages[0].prioritySource,'model');
});

test('a concise gist is classified unchanged when only optional offer details are omitted',async t=>{
  const summary='商店通知已發送新的折價券，可自行決定是否使用。';
  const original=mail({subject:'折價券通知',body:'新的折價券已發送。訂單消費滿NT$500可折抵NT$60，自由決定是否使用。',html:'<p>新的折價券已發送。</p>'});
  const f=await fixture(t,{message:original,quality:applyMailQuality,run:request=>{
    if(request.task==='mail')return response(request.input.messages[0],{summary,reason:'只有優惠通知，今天無待辦。',priority:2});
    assert.deepEqual(Object.keys(request.input),['summary']);assert.equal(request.input.summary,summary);
    return{category:'promotion'};
  }});
  const state=await f.core.analyzeMail('local',organize),saved=state.messages[0];
  assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify']);
  assert.equal(saved.analysis.summary,summary);assert.equal(saved.analysis.quality.summaryMode,'generated');
  assert.equal(saved.analysis.quality.priorityReview,false);assert.equal(saved.level,2);
  assert.equal(saved.analysis.category,'promotion');assert.equal(saved.analysis.categoryStatus,'done');
  assert.equal(saved.body,original.body);assert(saved.analysis.sourceFacts.every(text=>(original.subject+'\n'+original.body).includes(text)));
});

test('short topic summaries survive quality checks without expanding source details',async t=>{
  for(const [summary,body,category]of [
    ['文具優惠推薦','推出筆記本、鉛筆和畫具優惠，消費滿NT$500折NT$60，活動到月底。','promotion'],
    ['付款完成通知','已收到本次費用NT$700，交易已完成，無須回覆。','finance'],
    ['會議取消通知','本週五上午10點會議已取消，不必參加。','meeting']
  ]){
    const original=mail({subject:summary,body}),f=await fixture(t,{message:original,quality:applyMailQuality,run:request=>request.task==='mail'?
      response(request.input.messages[0],{summary,reason:'僅通知，無需行動。',priority:2}):{category}});
    const state=await f.core.analyzeMail('local',organize),saved=state.messages[0];
    assert.equal(state.mailAnalysis.status,'done');assert.equal(saved.analysis.summary,summary);assert.equal(saved.analysis.quality.summaryMode,'generated');
    assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify']);assert.equal(f.requests[1].input.summary,summary);
    assert.equal(saved.body,body);assert(saved.analysis.sourceFacts.length>0);
  }
});

test('an unsupported priority reason preserves the valid gist through classification and retry',async t=>{
  const summary='會員訂閱已啟用，費用也已收取。';
  const original=mail({subject:'會員服務通知',body:'會員訂閱已啟用，本次費用NT$700已成功收取，目前無需任何行動。',html:'<p>會員訂閱已啟用。</p>'});
  let classifications=0;
  const f=await fixture(t,{message:original,quality:applyMailQuality,run:request=>{
    if(request.task==='mail')return response(request.input.messages[0],{summary,reason:'今天需要另外支付USD90。',priority:1});
    assert.deepEqual(Object.keys(request.input),['summary']);assert.equal(request.input.summary,summary);
    if(++classifications===1)throw new Error('Synthetic classification interruption');
    return{category:'account'};
  }});
  const failed=await f.core.analyzeMail('local',organize);
  assert.equal(failed.messages[0].analysis.summary,summary);assert.equal(failed.messages[0].analysis.categoryStatus,'error');
  assert.equal(failed.messages[0].analysis.quality.summaryMode,'generated');assert.equal(failed.messages[0].analysis.quality.priorityReview,true);
  const retried=await f.core.analyzeMail('local',organize),saved=retried.messages[0];
  assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify','mail-classify']);
  assert.equal(saved.analysis.summary,summary);assert.equal(saved.analysis.category,'account');
  assert.equal(saved.analysis.quality.summaryMode,'generated');assert.equal(saved.analysis.quality.priorityReview,true);
  assert.equal(saved.level,null);assert(!Object.hasOwn(saved,'prioritySource'));assert.equal(saved.analysis.priority,1);
});

for(const processingFailure of ['MODEL_INPUT_TOO_LONG','MODEL_OUTPUT_LIMIT'])test(`validated ${processingFailure} source excerpts require review and rebuild facts from original mail`,async t=>{
  const original=mail({body:'原文已確認，詳情 https://example.invalid/details。',level:1,prioritySource:'model'}),seen=[];
  const expected={issues:['model-capacity-limited'],summaryMode:'source-excerpts',priorityReview:true};
  const f=await fixture(t,{message:original,quality:args=>{
    seen.push(plain(args));assert.equal(args.input.body,original.body);
    assert.equal(args.analysis.quality.summaryMode,expected.summaryMode);assert.equal(args.analysis.quality.priorityReview,true);
    assert.deepEqual(plain(args.analysis.quality.issues),expected.issues);
    if(seen.length===1)assert.equal(args.analysis.sourceFacts,undefined);
    return{...assessed(args,args.analysis.quality),sourceFacts:[args.input.body]};
  },run:request=>request.task==='mail'?{...response(request.input.messages[0],{sourceFacts:['INJECTED'],quality:{issues:[],priorityReview:false}}),
    meta:{processingMode:'source-excerpts',processingFailure}}:{category:'work'}});
  const state=await f.core.analyzeMail('local',organize),saved=state.messages[0];
  assert.equal(state.mailAnalysis.status,'done');assert.equal(seen.length,2);
  assert.deepEqual(saved.analysis.sourceFacts,[original.body]);assert.equal(saved.analysis.quality.priorityReview,true);
  assert(!Object.hasOwn(saved,'level'));assert(!Object.hasOwn(saved,'prioritySource'));
});

test('a message containing only quoted history cannot borrow it as summary content',async t=>{
  for(const subject of ['','Re: 舊事件','FW: 舊通知']){
    const original=mail({subject,body:'-----Original Message-----\n只有舊信內容。'}),f=await fixture(t,{message:original});
    const state=await f.core.analyzeMail('local',organize);
    assert.equal(state.mailAnalysis.failed,1);assert.equal(f.requests.length,0);assert.equal(state.messages[0].analysis,null);assert.equal(state.messages[0].body,original.body);assert.equal(state.messages[0].subject,subject);
  }
});

test('a new message with only an ordinary subject retains its available source',async t=>{
  const original=mail({subject:'通知：會議取消。',body:''}),f=await fixture(t,{message:original,quality:applyMailQuality,run:request=>request.task==='mail'?
    response(request.input.messages[0],{summary:'會議取消。',reason:'無須參加。',priority:2,evidence:[original.subject]}):{category:'meeting'}});
  const state=await f.core.analyzeMail('local',organize);
  assert.equal(state.mailAnalysis.status,'done');assert.equal(f.requests[0].input.messages[0].subject,original.subject);assert.equal(state.messages[0].analysis.summary,'會議取消。');
});

test('capacity fallback, source facts and classification exclude all content after the first reply boundary',async t=>{
  const top='報表已發布，可自行查看。\n',old='HISTORY_ONLY 請今天匯款 987654 元。';
  const original=mail({subject:'報表通知',body:top+'-----Original Message-----\n'+old,html:'<p>報表已發布，可自行查看。</p><blockquote><img src="https://example.invalid/old.png"></blockquote>'});
  const f=await fixture(t,{message:original,quality:applyMailQuality,run:request=>{
    if(request.task==='mail'){
      assert.equal(request.input.messages[0].body,top);
      assert.equal(request.input.messages[0].contentContext.unreadImageCount,0);
      return{...response(request.input.messages[0]),meta:{processingMode:'source-excerpts',processingFailure:'MODEL_OUTPUT_LIMIT'}};
    }
    assert.deepEqual(Object.keys(request.input),['summary']);assert.doesNotMatch(request.input.summary,/HISTORY_ONLY|987654/);
    return{category:'work'};
  }});
  const state=await f.core.analyzeMail('local',organize),saved=state.messages[0];
  assert.equal(state.mailAnalysis.status,'done');assert.equal(saved.analysis.quality.summaryMode,'source-excerpts');
  assert.match(saved.analysis.summary,/報表已發布/);assert.doesNotMatch(JSON.stringify(saved.analysis),/HISTORY_ONLY|987654/);
  assert(saved.analysis.sourceFacts.every(text=>original.subject.includes(text)||top.includes(text)));
  assert.equal(saved.body,original.body);assert.equal(saved.html,original.html);
});

test('capacity metadata cannot rescue invalid output and a failure code alone does not mark an ordinary result as excerpts',async t=>{
  const invalid=await fixture(t,{quality:()=>assert.fail('Invalid evidence must never reach quality review'),run:request=>({
    ...response(request.input.messages[0],{evidence:['invented quote']}),meta:{processingMode:'source-excerpts',processingFailure:'MODEL_INPUT_TOO_LONG'}
  })});
  const rejected=await invalid.core.analyzeMail('local',organize);assert.equal(rejected.mailAnalysis.failed,1);assert.equal(rejected.messages[0].analysis,null);
  const ordinary=await fixture(t,{quality:args=>{assert.equal(args.analysis.quality,undefined);return assessed(args);},run:request=>({
    ...response(request.input.messages[0]),meta:{processingFailure:'MODEL_INPUT_TOO_LONG',complete:true}
  })});
  const accepted=await ordinary.core.analyzeMail('local');assert.equal(accepted.messages[0].analysis.quality.summaryMode,'generated');assert.equal(accepted.messages[0].analysis.quality.priorityReview,false);
});

test('quality cannot turn invalid model evidence or an oversized summary into a saved result',async t=>{
  for(const patch of [{evidence:['fabricated quotation']},{summary:'x'.repeat(2001)},{evidence:['<【網址】>']}]){
    let calls=0;
    const prior={summary:'先前有效摘要',priority:2,reason:'先前理由',evidence:['原文已確認']};
    const f=await fixture(t,{message:mail({body:'原文已確認 <https://example.invalid/first> <https://example.invalid/second>',analysis:prior,level:2,prioritySource:'model'}),
      quality:args=>{calls++;return assessed(args);},run:request=>response(request.input.messages[0],patch)});
    const state=await f.core.analyzeMail('local',organize);
    assert.equal(calls,0);assert.equal(state.mailAnalysis.failed,1);assert.deepEqual(state.messages[0].analysis,prior);assert.equal(state.messages[0].level,2);
    assert.equal(f.requests.length,1);
  }
});

test('priority review clears an earlier model assignment and preserves every manual priority',async t=>{
  for(const patch of [{level:1,prioritySource:'model'},...([0,1,2,null].map(level=>({level,prioritySource:'manual'}))),{level:null}]){
    const f=await fixture(t,{message:mail(patch),quality:args=>assessed(args,{priorityReview:true})});
    const state=await f.core.analyzeMail('local'),saved=state.messages[0];
    assert.equal(saved.analysis.quality.priorityReview,true);assert.equal(saved.analysis.priority,0);
    if(patch.prioritySource==='model'){assert(!Object.hasOwn(saved,'level'));assert(!Object.hasOwn(saved,'prioritySource'));}
    else{assert.equal(saved.level,patch.level);assert.equal(saved.prioritySource,patch.prioritySource);}
  }
});

test('classification can require priority review after an otherwise applicable summary priority',async t=>{
  const f=await fixture(t,{quality:args=>assessed(args,{priorityReview:args.category==='promotion'}),run:request=>{
    if(request.task==='mail')return response(request.input.messages[0]);
    assert.equal(f.store.read().messages[0].level,0);assert.equal(f.store.read().messages[0].prioritySource,'model');
    return{category:'promotion'};
  }});
  const state=await f.core.analyzeMail('local',organize),saved=state.messages[0];
  assert.equal(saved.analysis.quality.priorityReview,true);assert(!Object.hasOwn(saved,'level'));assert(!Object.hasOwn(saved,'prioritySource'));
});

const excerptAfterClassification=args=>{
  const result={...assessed(args,args.analysis.quality),sourceFacts:[args.input.body]};
  if(args.category==='promotion')Object.assign(result,{summary:`原文摘錄：${args.input.body}`,evidence:[args.input.body],
    quality:{...result.quality,issues:['summary-mismatch'],summaryMode:'source-excerpts',priorityReview:true}});
  return result;
};
const assertUnclassified=(analysis,status)=>{
  assert.equal(analysis.categoryStatus,status);
  for(const key of ['category','categoryMeta','fingerprint'])assert(!Object.hasOwn(analysis,key),key);
};

for(const replacementStage of ['before-classification','after-classification'])test(`simplified source excerpts created ${replacementStage} are normalized before saving and classification`,async t=>{
  const original=mail({subject:'账号通知',body:'汇款账号信息已确认。',html:'<p>汇款账号信息已确认。</p>'});
  const summary='原文摘錄：匯款帳號資訊已確認。',seen=[];
  const f=await fixture(t,{message:original,quality:args=>{
    const result={...assessed(args,args.analysis.quality),sourceFacts:[args.input.body]};
    if(replacementStage==='before-classification'||args.category)Object.assign(result,{
      summary:'原文摘录：'+args.input.body,reason:'账号信息需核对。',evidence:[args.input.body],
      quality:{...result.quality,summaryMode:'source-excerpts',priorityReview:true}
    });
    return result;
  },run:request=>{
    if(request.task==='mail')return response(request.input.messages[0],{summary:'通知待確認。'});
    const pending=f.store.read().messages[0].analysis;
    assertUnclassified(pending,'pending');assert.deepEqual(plain(request.input),{summary:pending.summary});seen.push(request.input.summary);
    if(replacementStage==='before-classification'||seen.length===2){
      assert.equal(pending.summary,summary);assert.equal(pending.reason,'帳號資訊需核對。');
      assert.deepEqual(pending.evidence,[original.body]);assert.deepEqual(pending.sourceFacts,[original.body]);
    }
    return{category:'finance'};
  }});
  const state=await f.core.analyzeMail('local',organize),saved=f.store.read().messages[0];
  assert.equal(state.mailAnalysis.failed,0);assert.equal(saved.analysis.summary,summary);assert.equal(saved.analysis.reason,'帳號資訊需核對。');
  assert.deepEqual(seen,replacementStage==='before-classification'?[summary]:['通知待確認。',summary]);
  assert.equal(saved.analysis.categoryStatus,'done');assert.equal(saved.analysis.category,'finance');
  assert.deepEqual(saved.analysis.evidence,[original.body]);assert.deepEqual(saved.analysis.sourceFacts,[original.body]);
  for(const key of ['subject','body','html'])assert.equal(saved[key],original[key],key);
});

test('quality changes only simplified typography after classification without starting a duplicate classification',async t=>{
  const f=await fixture(t,{quality:args=>({...assessed(args),
    ...(args.category?{summary:'请求汇款账号信息',reason:'账号信息已确认。'}:{})
  }),run:request=>request.task==='mail'?response(request.input.messages[0],{
    summary:'請求匯款帳號資訊',reason:'帳號資訊已確認。'
  }):{category:'finance'}});
  const state=await f.core.analyzeMail('local',organize),saved=f.store.read().messages[0].analysis;
  assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify']);
  assert.equal(state.mailAnalysis.failed,0);assert.equal(saved.summary,'請求匯款帳號資訊');assert.equal(saved.reason,'帳號資訊已確認。');
  assert.equal(saved.categoryStatus,'done');assert.equal(saved.category,'finance');
});

test('classification-dependent excerpts are saved and classified from the updated summary exactly once',async t=>{
  const original=mail({body:'原文訂單已取消，無須付款。'}),seen=[];
  let classifications=0;
  const f=await fixture(t,{message:original,quality:args=>{seen.push(plain(args));return excerptAfterClassification(args);},run:request=>{
    if(request.task==='mail')return response(request.input.messages[0],{summary:'請立即付款享有優惠。'});
    const saved=f.store.read().messages[0];assertUnclassified(saved.analysis,'pending');
    assert.deepEqual(plain(request.input),{summary:saved.analysis.summary});
    if(++classifications===1)return{category:'promotion',meta:{model:'first-classifier'}};
    assert.equal(saved.analysis.summary,`原文摘錄：${original.body}`);assert.equal(saved.analysis.quality.priorityReview,true);
    assert(!Object.hasOwn(saved,'level'));assert(!Object.hasOwn(saved,'prioritySource'));
    return{category:'account',meta:{model:'second-classifier'}};
  }});
  const state=await f.core.analyzeMail('local',organize),saved=state.messages[0];
  assert.equal(state.mailAnalysis.processed,1);assert.equal(state.mailAnalysis.failed,0);assert.equal(classifications,2);
  assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify','mail-classify']);
  assert.equal(saved.analysis.summary,`原文摘錄：${original.body}`);assert.equal(saved.analysis.category,'account');assert.equal(saved.analysis.categoryStatus,'done');
  assert.deepEqual(saved.analysis.categoryMeta,{source:'local',model:'second-classifier'});assert.match(saved.analysis.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(saved.analysis.sourceFacts,[original.body]);assert.deepEqual(seen.map(args=>args.category),[undefined,'promotion','account']);
  assert.equal(new Set(seen.map(args=>args.referenceTime)).size,1);
  const unchanged=await f.core.analyzeMail('local',organize);assert.equal(unchanged.mailAnalysis.unchanged,1);assert.equal(f.requests.length,3);
});

for(const failure of ['exception','invalid-category'])test(`a ${failure} during excerpt classification keeps the newest summary unclassified and retries without summarizing again`,async t=>{
  let classifications=0;
  const f=await fixture(t,{quality:excerptAfterClassification,run:request=>{
    if(request.task==='mail')return response(request.input.messages[0]);
    if(++classifications===1)return{category:'promotion',meta:{model:'old-classifier'}};
    if(classifications===2){
      assertUnclassified(f.store.read().messages[0].analysis,'pending');
      if(failure==='exception')throw new Error('Synthetic second classification failed');
      return{category:'not-a-category'};
    }
    return{category:'work',meta:{model:'retry-classifier'}};
  }});
  const failed=await f.core.analyzeMail('local',organize),saved=failed.messages[0];
  assert.equal(failed.mailAnalysis.status,'error');assert.equal(failed.mailAnalysis.processed,1);assert.equal(failed.mailAnalysis.failed,1);
  assert.equal(saved.analysis.summary,'原文摘錄：原文已確認。');assertUnclassified(saved.analysis,'error');
  assert(saved.analysis.categoryError);assert(saved.analysisError);assert.equal(saved.analysis.quality.priorityReview,true);
  assert(!Object.hasOwn(saved,'level'));assert(!Object.hasOwn(saved,'prioritySource'));
  const retried=await f.core.analyzeMail('local',organize);
  assert.equal(f.requests.filter(request=>request.task==='mail').length,1);assert.equal(classifications,3);
  assert.equal(retried.mailAnalysis.status,'done');assert.equal(retried.messages[0].analysis.summary,saved.analysis.summary);
  assert.equal(retried.messages[0].analysis.category,'work');assert.equal(retried.messages[0].analysis.categoryError,undefined);
  assert.equal(retried.messages[0].analysisError,undefined);
});

test('cancelling excerpt classification preserves the replacement and ignores its late category after a successful retry',async t=>{
  const started=deferred(),release=deferred();let classifications=0;
  const f=await fixture(t,{quality:excerptAfterClassification,run:request=>{
    if(request.task==='mail')return response(request.input.messages[0]);
    if(++classifications===1)return{category:'promotion'};
    if(classifications===2){started.resolve();return release.promise;}
    return{category:'work',meta:{model:'new-classifier'}};
  }});
  const pending=f.core.analyzeMail('local',organize);await started.promise;
  f.core.cancelMailAnalysis();const cancelled=await pending;
  assert.equal(cancelled.mailAnalysis.status,'cancelled');assert.equal(cancelled.mailAnalysis.processed,0);
  assert.equal(cancelled.messages[0].analysis.summary,'原文摘錄：原文已確認。');assertUnclassified(cancelled.messages[0].analysis,'pending');
  assert.equal(f.requests[2].signal.aborted,true);
  const retried=await f.core.analyzeMail('local',organize);assert.equal(retried.messages[0].analysis.category,'work');
  assert.equal(f.requests.filter(request=>request.task==='mail').length,1);
  release.resolve({category:'finance',meta:{model:'late-classifier'}});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.store.read().messages[0].analysis,retried.messages[0].analysis);assert.equal(f.core.active.size,0);
});

test('changed mail cannot accept or reclassify a late excerpt replacement',async t=>{
  for(const heldRound of [1,2]){
    const started=deferred(),release=deferred();let classifications=0;
    const f=await fixture(t,{quality:excerptAfterClassification,run:async request=>{
      if(request.task==='mail')return response(request.input.messages[0]);
      const round=++classifications;if(round===heldRound){started.resolve();await release.promise;}
      return{category:round===1?'promotion':'work'};
    }});
    const pending=f.core.analyzeMail('local',organize);await started.promise;
    const saved=f.store.read().messages[0].analysis;
    f.store.update(state=>{state.messages[0].body='郵件內容已更新。';});release.resolve();
    const state=await pending;assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.mailAnalysis.failed,0);
    assert.deepEqual(state.messages[0].analysis,saved);assert.equal(classifications,heldRound);
  }
});

test('a second quality replacement is retained as an error instead of causing unbounded classification or a stale completed category',async t=>{
  let replacements=0;
  const f=await fixture(t,{quality:args=>args.category?{...assessed(args),summary:`原文摘錄 ${++replacements}：${args.input.body}`} : assessed(args)});
  const state=await f.core.analyzeMail('local',organize);
  assert.equal(f.requests.length,3);assert.equal(replacements,2);assert.equal(state.mailAnalysis.failed,1);
  assert.equal(state.messages[0].analysis.summary,'原文摘錄 2：原文已確認。');assertUnclassified(state.messages[0].analysis,'error');
});

test('identity and attachment/image context invalidate a completed cache while presentation-only edits do not',async t=>{
  const f=await fixture(t);
  const first=await f.core.analyzeMail('local',organize);let fingerprint=first.messages[0].analysis.fingerprint;
  for(const mutate of [
    message=>{message.email='different@example.invalid';},
    message=>{message.attachments.push({name:'new.pdf'});},
    message=>{message.html+='<img src="https://example.invalid/details.png">';}
  ]){
    const calls=f.requests.length;f.store.update(state=>{mutate(state.messages[0]);});
    const updated=await f.core.analyzeMail('local',organize);
    assert.equal(f.requests.length,calls+2);assert.notEqual(updated.messages[0].analysis.fingerprint,fingerprint);fingerprint=updated.messages[0].analysis.fingerprint;
  }
  const calls=f.requests.length;
  f.store.update(state=>{state.messages[0].html=state.messages[0].html.replace('<p>','<p style="color:navy">');state.messages[0].email='DIFFERENT@example.invalid';});
  const unchanged=await f.core.analyzeMail('local',organize);assert.equal(unchanged.mailAnalysis.unchanged,1);assert.equal(f.requests.length,calls);
});

for(const categoryStatus of ['done','error'])test(`a dated v8 ${categoryStatus} cache is summarized again after a mail policy revision and then reused only within the same Taipei day`,async t=>{
  const original=mail(),summary='本次規則重新分析的摘要。';let time='2026-09-17T01:00:00.000Z';
  const f=await fixture(t,{message:original,now:()=>time,run:request=>request.task==='mail'?response(request.input.messages[0],{summary}):{category:'work'}});
  const settings=f.store.read().settings;
  // A fully populated, same-day v8 cache: missing context or referenceDate
  // must not accidentally be what makes this migration test pass.
  const oldInput={id:original.id,subject:original.subject,body:original.body,date:original.date,sender:original.sender,
    senderEmail:'sender@example.invalid',to:['reader@example.invalid'],cc:['copy@example.invalid'],
    contentContext:{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:true}};
  const oldHash=createHash('sha256').update(JSON.stringify({version:8,input:oldInput,recipient:'reader@example.invalid',source:'local',
    model:{backend:settings.localBackend,endpoint:settings.devLlm.endpoint},prompt:settings.llmPrompts?.mail??null,
    language:settings.preferredLanguage,referenceDate:'2026-09-17'})).digest('hex');
  f.store.update(state=>{state.messages[0].analysis={summary:'舊處理規則留下的摘要。',reason:'舊快取。',priority:2,evidence:[original.body],
    sourceFacts:['舊重點'],quality:{issues:[],summaryMode:'generated',priorityReview:false},summaryFingerprint:oldHash,categoryStatus,
    ...(categoryStatus==='done'?{fingerprint:oldHash,category:'work'}:{categoryError:'Synthetic interrupted classification'})};});
  const refreshed=await f.core.analyzeMail('local',organize),analysis=refreshed.messages[0].analysis;
  assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify']);assert.equal(refreshed.mailAnalysis.processed,1);
  assert.equal(refreshed.mailAnalysis.unchanged,0);assert.equal(refreshed.mailAnalysis.failed,0);assert.equal(analysis.summary,summary);
  assert.notEqual(analysis.summaryFingerprint,oldHash);assert.equal(analysis.fingerprint,analysis.summaryFingerprint);
  assert.deepEqual(analysis.sourceFacts,[original.subject]);assert.equal(analysis.categoryStatus,'done');
  assert.equal(analysis.categoryError,undefined);assert.equal(refreshed.messages[0].body,original.body);
  time='2026-09-17T15:59:59.999Z';
  const unchanged=await f.core.analyzeMail('local',organize);
  assert.equal(unchanged.mailAnalysis.unchanged,1);assert.equal(f.requests.length,2);assert.equal(unchanged.messages[0].analysis.fingerprint,analysis.fingerprint);
  time='2026-09-17T16:00:00.000Z';
  const nextDay=await f.core.analyzeMail('local',organize);
  assert.deepEqual(f.requests.slice(2).map(request=>request.task),['mail','mail-classify']);assert.equal(nextDay.mailAnalysis.processed,1);
  assert.notEqual(nextDay.messages[0].analysis.fingerprint,analysis.fingerprint);
  assert.equal(nextDay.messages[0].analysis.summaryFingerprint,nextDay.messages[0].analysis.fingerprint);
});

test('unchanged mail is reused within a Taipei day and reprioritized at Taipei midnight rather than UTC midnight',async t=>{
  let time='2026-09-16T23:50:00.000Z';
  const midnight=Date.parse('2026-09-17T16:00:00.000Z');
  const f=await fixture(t,{now:()=>time,quality:args=>({...assessed(args),priority:Date.parse(args.referenceTime)<midnight?0:2})});
  const first=await f.core.analyzeMail('local',organize),fingerprint=first.messages[0].analysis.fingerprint;
  assert.equal(first.messages[0].level,0);assert.equal(f.requests.length,2);
  // The UTC date changes here; Taipei remains September 17 throughout.
  for(const sameDay of ['2026-09-17T00:10:00.000Z','2026-09-17T15:59:59.999Z']){
    time=sameDay;const unchanged=await f.core.analyzeMail('local',organize);
    assert.equal(unchanged.mailAnalysis.unchanged,1);assert.equal(f.requests.length,2);
    assert.equal(unchanged.messages[0].analysis.fingerprint,fingerprint);assert.equal(unchanged.messages[0].level,0);
  }
  time='2026-09-17T16:00:00.000Z';
  const nextDay=await f.core.analyzeMail('local',organize);
  assert.equal(f.requests.length,4);assert.equal(nextDay.messages[0].level,2);
  assert.notEqual(nextDay.messages[0].analysis.fingerprint,fingerprint);
  assert.equal(f.requests[2].input.referenceTime,time);
  const again=await f.core.analyzeMail('local',organize);assert.equal(again.mailAnalysis.unchanged,1);assert.equal(f.requests.length,4);
});

test('a batch crossing Taipei midnight keeps one reference time and both messages refresh in the next batch',async t=>{
  const batchTime='2026-09-17T15:59:50.000Z',nextTime='2026-09-17T16:00:10.000Z';
  let time=batchTime,held=false;
  const started=deferred(),release=deferred(),qualityTimes=[];
  const f=await fixture(t,{now:()=>time,quality:args=>{qualityTimes.push(args.referenceTime);return assessed(args);},run:async request=>{
    if(request.task==='mail-classify')return{category:'work'};
    if(!held){held=true;started.resolve();await release.promise;}
    return response(request.input.messages[0]);
  }});
  f.store.update(state=>{state.messages.push(mail({id:'second-synthetic'}));});
  const pending=f.core.analyzeMail('local',organize);await started.promise;time=nextTime;release.resolve();
  const first=await pending;
  assert.equal(first.mailAnalysis.processed,2);assert.equal(first.mailAnalysis.skipped,0);assert.equal(first.mailAnalysis.failed,0);
  assert.equal(f.requests.length,4);
  assert.deepEqual(f.requests.filter(request=>request.task==='mail').map(request=>request.input.referenceTime),[batchTime,batchTime]);
  assert.deepEqual(qualityTimes,[batchTime,batchTime,batchTime,batchTime]);
  const fingerprints=first.messages.map(message=>message.analysis.fingerprint);
  const next=await f.core.analyzeMail('local',organize);
  assert.equal(f.requests.length,8);assert.equal(next.mailAnalysis.processed,2);assert.equal(next.mailAnalysis.skipped,0);
  for(let index=0;index<2;index++)assert.notEqual(next.messages[index].analysis.fingerprint,fingerprints[index]);
  assert.deepEqual(f.requests.filter(request=>request.task==='mail').slice(2).map(request=>request.input.referenceTime),[nextTime,nextTime]);
});

test('new sender metadata never manufactures an address from a display name or accepts injected headers',async t=>{
  for(const value of [undefined,'Name <person@example.invalid>','broken','person@example.invalid\r\nBcc: injected@example.invalid']){
    const f=await fixture(t,{message:mail({email:value,sender:'display@example.invalid'})});
    await f.core.analyzeMail('local');assert.equal(f.requests[0].input.messages[0].senderEmail,'');
  }
});

test('late summaries and classifications cannot overwrite changed sender, image or attachment context',async t=>{
  for(const stage of ['mail','mail-classify'])for(const mutate of [
    message=>{message.email='other@example.invalid';},
    message=>{message.attachments=[{name:'changed.pdf'}];},
    message=>{message.html='<img src="https://example.invalid/new.png">';}
  ]){
    const started=deferred(),release=deferred();
    const f=await fixture(t,{run:async request=>{
      const result=request.task==='mail'?response(request.input.messages[0]):{category:'work'};
      if(request.task===stage){started.resolve();await release.promise;}return result;
    }});
    const pending=f.core.analyzeMail('local',organize);await started.promise;
    const before=f.store.read().messages[0].analysis;f.store.update(state=>{mutate(state.messages[0]);});release.resolve();
    const state=await pending;assert.equal(state.mailAnalysis.skipped,1);assert.equal(state.mailAnalysis.failed,0);
    assert.deepEqual(state.messages[0].analysis,before);
    assert.equal(f.requests.length,stage==='mail'?1:2);
  }
});

test('manual edits during classification remain authoritative when final quality requires review',async t=>{
  const started=deferred(),release=deferred();
  const f=await fixture(t,{quality:args=>assessed(args,{priorityReview:!!args.category}),run:async request=>{
    if(request.task==='mail')return response(request.input.messages[0]);started.resolve();await release.promise;return{category:'promotion'};
  }});
  const pending=f.core.analyzeMail('local',organize);await started.promise;f.core.updateLocalMessages(['synthetic'],{level:1});release.resolve();
  const state=await pending;assert.equal(state.messages[0].analysis.quality.priorityReview,true);assert.equal(state.messages[0].level,1);assert.equal(state.messages[0].prioritySource,'manual');
});

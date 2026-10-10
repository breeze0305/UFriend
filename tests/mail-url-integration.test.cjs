'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const {CloudApiAdapter}=require('../app/models/cloud-api.cjs');
const {profileContext}=require('../app/services/personal-profile.cjs');

const testRoot=path.resolve(__dirname,'..','.test-data','mail-url-integration');
const organize={categorize:true,onlyChanged:true};
const summary='請核對報表。';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mail=(patch={})=>({id:'url-fixture',accountId:'fixture-account',source:'Gmail',folder:'inbox',done:false,read:false,level:null,analysis:null,
  subject:'合成報表通知',body:'請核對報表。',date:'2026-09-14T01:00:00.000Z',sender:'Synthetic Report Sender',
  to:'receiver@example.test',cc:'copy@example.test',html:'<p>合成郵件內容</p>',htmlVersion:1,attachments:[],...patch});
// These transport/cache fixtures quote the supplied body; they must not invent
// an attachment, a deadline or an event unrelated to the synthetic source.
const analysis=(id,evidence)=>{
  const text=evidence.at(-1).replaceAll('【網址】','').trim();
  return{analyses:[{id,summary:text,priority:2,reason:text,evidence}]};
};
const originalFields=['id','accountId','source','folder','done','read','subject','body','date','sender','to','cc','html','htmlVersion','attachments'];
const originals=message=>Object.fromEntries(originalFields.map(key=>[key,message[key]]));

function decodeRequest(source,payload,id){
  if(source==='local')return{task:payload.task,input:payload.input};
  const user=JSON.parse(payload.messages.filter(item=>item.role==='user').at(-1).content);
  if(Object.hasOwn(user,'summary'))return{task:'mail-classify',input:user};
  const lines=user['原文行'],text=line=>{
    if(!Array.isArray(line))return line.text;
    assert.equal(line.length,4);assert(['subject','body'].includes(line[1]));assert(Number.isInteger(line[2])&&line[2]>=0);
    return line[3];
  };
  const field=line=>Array.isArray(line)?line[1]:line.field;
  return{task:'mail',input:{messages:[{id,subject:lines.filter(line=>field(line)==='subject').map(text).join('\n'),body:lines.filter(line=>field(line)==='body').map(text).join('\n')}],referenceTime:user['參考時間'],recipient:user['本人'],sender:user['寄件者'],to:user['收件者'],cc:user['副本']}};
}

async function fixture(t,source,original,options={}){
  await fs.mkdir(testRoot,{recursive:true});
  const root=await fs.realpath(testRoot),dataDir=await fs.mkdtemp(path.join(root,'case-'));
  t.after(async()=>{
    const real=await fs.realpath(dataDir);
    assert.equal(path.dirname(real).toLowerCase(),root.toLowerCase());assert.match(path.basename(real),/^case-/);
    await fs.rm(real,{recursive:true,force:true,maxRetries:3});
  });
  const store=new Store({dataDir}),models=new ModelAdapters(),requests=[];
  const fetchImpl=async(url,args)=>{
    const payload=JSON.parse(args.body),request={url,payload,text:args.body,...decodeRequest(source,payload,original.id)};
    requests.push(request);
    // Simulate the existing PC API v1 body limit at the HTTP boundary. The
    // independent PC service is neither imported nor started by these tests.
    if(source==='local'&&request.task==='mail'&&request.input.messages[0].body.length>200000)return json({error:{code:'MODEL_INVALID_REQUEST'}},400);
    if(request.task==='mail'&&options.httpFailure)return json({error:{code:'MODEL_API_UNAVAILABLE'}},503);
    const value=await(request.task==='mail'?(options.respondMail?.(request)||analysis(original.id,[request.input.messages[0].body])):
      (options.respondClassification?.(request)||{category:'work'}));
    return source==='local'?json({apiVersion:'1',...value}):json({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]});
  };
  const getSettings=()=>store.read().settings;
  const adapter=source==='local'?new LocalLlmApiAdapter({getSettings,fetchImpl}):new CloudApiAdapter({getSettings,getApiKey:()=> 'synthetic-integration-key',fetchImpl});
  models.register('llm',adapter,{source});
  const core=new AppService({store,dataDir,models});
  core.settings({localBackend:'pc-api',api:{endpoint:'https://synthetic-provider.example.test/v1',model:'synthetic-mail-model'},personalProfile:{enabled:true,name:'Synthetic Profile Only'}});
  store.update(state=>{state.accounts=[{id:'fixture-account',email:'receiver@example.test'}];state.messages=[structuredClone(original)];});
  return{core,store,requests,reopen:()=>new Store({dataDir}).read()};
}

test('URL-only changes invalidate cached summaries and reject late results even when sanitized HTTP inputs are identical',async t=>{
  for(const source of ['local','cloud']){
    const body=token=>'請核對 https://cache-change.example.test/report?token='+token+' 報表。';
    const original=mail({body:body('first')});
    let holdNext=false,started,release;
    const waiting=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const f=await fixture(t,source,original,{respondMail:async request=>{
      const value=analysis(original.id,[request.input.messages[0].body]);
      if(holdNext){holdNext=false;started();await gate;}return value;
    }});
    const first=await f.core.analyzeMail(source,organize),firstFingerprint=first.messages[0].analysis.fingerprint;
    assert.equal(first.mailAnalysis.status,'done');assert.equal(f.requests.length,2);
    f.store.update(state=>{state.messages[0].body=body('second');});
    const second=await f.core.analyzeMail(source,organize),saved=second.messages[0].analysis;
    assert.equal(second.mailAnalysis.status,'done');assert.equal(f.requests.length,4);
    assert.equal(f.requests[0].input.messages[0].body,f.requests[2].input.messages[0].body);
    assert.notEqual(saved.fingerprint,firstFingerprint,'Changing only the original URL must invalidate the cache.');

    f.store.update(state=>{state.messages[0].body=body('third');});holdNext=true;
    const pending=f.core.analyzeMail(source,organize);await waiting;
    f.store.update(state=>{state.messages[0].body=body('fourth');});release();
    const stale=await pending;
    assert.equal(stale.mailAnalysis.skipped,1);assert.equal(stale.mailAnalysis.failed,0);
    assert.deepEqual(stale.messages[0].analysis,saved,'A late result must not replace the saved summary after its raw URL changes.');
    assert.equal(f.requests.length,5,'A stale summary must not proceed to classification.');
    assert.equal(f.requests[2].input.messages[0].body,f.requests[4].input.messages[0].body);

    const fresh=await f.core.analyzeMail(source,organize);
    assert.equal(fresh.mailAnalysis.status,'done');assert.equal(f.requests.length,7);assert.notEqual(fresh.messages[0].analysis.fingerprint,saved.fingerprint);
    assertOriginalsPreserved({...original,body:body('fourth')},fresh.messages[0]);
    await f.core.analyzeMail(source,organize);assert.equal(f.requests.length,7,'The refreshed raw-URL fingerprint must be cacheable.');
  }
});

function assertOriginalsPreserved(original,saved){
  // Hash long fields so a failing test never prints a 200,000-character URL.
  assert.equal(hash(originals(saved)),hash(originals(original)),'Original mail fields, HTML and attachment metadata must remain byte-for-byte unchanged.');
}

function assertSummaryOnly(request,expectedSummary){
  assert.equal(request.task,'mail-classify');assert.deepEqual(request.input,{summary:expectedSummary});
  assert.doesNotMatch(request.text,/Synthetic Profile Only|Synthetic Report Sender|receiver@example\.test|copy@example\.test|http[s]?:\/\//);
  if(Object.hasOwn(request.payload,'task'))assert.deepEqual(Object.keys(request.payload).sort(),['input','task']);
}

// Build saved cache versions explicitly to verify migration without reaching
// into the current analyzer or sanitizer implementation.
function fingerprintAtVersion(original,settings,source,version,referenceTime){
  const input={id:original.id,subject:original.subject,body:original.body,date:original.date,sender:original.sender,
    ...(version>=4?{senderEmail:''}:{}),to:['receiver@example.test'],cc:['copy@example.test'],
    ...(version>=4?{contentContext:{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:true}}:{})};
  const model=source==='cloud'?{endpoint:settings.api.endpoint,model:settings.api.model,temperature:settings.api.temperature}:{backend:settings.localBackend,endpoint:settings.devLlm.endpoint};
  const referenceDate=referenceTime?new Date(Date.parse(referenceTime)+8*60*60*1000).toISOString().slice(0,10):undefined;
  return hash({version,input,recipient:'receiver@example.test',source,model,prompt:settings.llmPrompts?.mail??null,profile:profileContext(settings.personalProfile),language:settings.preferredLanguage,
    ...(version>=4&&referenceDate?{referenceDate}:{})});
}

for(const source of ['local','cloud']){
  test(`${source} keeps a short topic summary when repeated link labels map to different URLs`,async t=>{
    const original=mail({subject:'本週影音精選',body:'精選直播與遊戲實況，推薦您可能喜歡的頻道。\n立即觀看 [https://stream.example.test/category/a]\n立即觀看 [https://stream.example.test/category/b]\n立即觀看 [https://stream.example.test/category/a]'});
    const topic='影音內容推薦',f=await fixture(t,source,original,{respondMail:()=>({analyses:[{id:original.id,summary:topic,priority:2,reason:'僅推薦內容，無需行動。',evidence:['立即觀看 [【網址】]']}]}),respondClassification:()=>({category:'promotion'})});
    const state=await f.core.analyzeMail(source,organize),saved=state.messages[0];
    assert.equal(state.mailAnalysis.status,'done');assert.equal(state.mailAnalysis.failed,0);assert.equal(f.requests.length,2);
    assert.equal(saved.analysis.summary,topic);assert.equal(saved.analysis.quality.summaryMode,'generated');assert.equal(saved.analysis.category,'promotion');
    assert(saved.analysis.evidence.some(quote=>quote.includes('立即觀看')));
    for(const quote of saved.analysis.evidence){assert(original.body.includes(quote));assert.doesNotMatch(quote,/https?:\/\/|【網址】/);}
    assertSummaryOnly(f.requests[1],topic);assertOriginalsPreserved(original,saved);assertOriginalsPreserved(original,f.reopen().messages[0]);
    const cached=await f.core.analyzeMail(source,organize);assert.equal(cached.mailAnalysis.unchanged,1);assert.equal(f.requests.length,2);
  });

  test(`${source} excludes inherited reply subjects from generation, evidence and source facts`,async t=>{
    for(const prefix of ['Re: Fwd:','re[2]:','回覆：']){
      const original=mail({subject:prefix+' OLD_SUBJECT 故障產品退款 654321',body:'為本次對話評分。'}),f=await fixture(t,source,original);
      const state=await f.core.analyzeMail(source,organize),saved=state.messages[0];
      assert.equal(state.mailAnalysis.status,'done');assert.equal(f.requests[0].input.messages[0].subject,'');
      assert.doesNotMatch(f.requests[0].text,/OLD_SUBJECT|故障|654321/);assert.doesNotMatch(JSON.stringify(saved.analysis),/OLD_SUBJECT|故障|654321/);
      assert.equal(saved.analysis.summary,original.body);assertSummaryOnly(f.requests[1],original.body);assertOriginalsPreserved(original,saved);
    }
  });

  test(`${source} summarizes only the first body while preserving quoted history and invalidating changed originals`,async t=>{
    const top='本次只通知報表已發布，可自行查看。\n\n',old='HISTORY_ONLY 請在今天匯款 987654 元，並立即回覆。';
    const original=mail({body:top+'On September 10, 2026, Old Sender wrote:\n> '+old+'\n下方後續回覆不屬於首段。',html:'<p>本次只通知報表已發布，可自行查看。</p><blockquote><img src="https://history.example.test/old.png"></blockquote>'});
    const f=await fixture(t,source,original),state=await f.core.analyzeMail(source,organize),saved=state.messages[0];
    assert.equal(state.mailAnalysis.status,'done');assert.equal(f.requests.length,2);
    assert.equal(f.requests[0].input.messages[0].body,top);
    assert.doesNotMatch(f.requests[0].text,/HISTORY_ONLY|987654|下方後續回覆|history\.example/);
    assert.equal(saved.analysis.summary,top.trim());
    assert.doesNotMatch(JSON.stringify(saved.analysis),/HISTORY_ONLY|987654|下方後續回覆/);
    assertSummaryOnly(f.requests[1],saved.analysis.summary);assertOriginalsPreserved(original,saved);
    const priorFingerprint=saved.analysis.fingerprint;
    f.store.update(data=>{data.messages[0].body=data.messages[0].body.replace('987654','987655');});
    const changed=await f.core.analyzeMail(source,organize);
    assert.equal(f.requests.length,4);assert.equal(f.requests[2].input.messages[0].body,top);
    assert.notEqual(changed.messages[0].analysis.fingerprint,priorFingerprint);
    assertOriginalsPreserved({...original,body:original.body.replace('987654','987655')},changed.messages[0]);
  });

  test(`${source} evidence from excluded reply history cannot replace a saved summary`,async t=>{
    const prior={summary:'先前有效摘要。',priority:2,reason:'先前內容。',evidence:['報表已發布。'],category:'work',categoryStatus:'done'};
    const old='舊信要求支付 987654 元。',original=mail({body:'報表已發布。\n\n-----Original Message-----\n'+old,analysis:prior});
    const f=await fixture(t,source,original,{respondMail:()=>analysis(original.id,[old])}),state=await f.core.analyzeMail(source,organize);
    assert.equal(state.mailAnalysis.status,'error');assert.equal(state.mailAnalysis.failed,1);assert.equal(f.requests.length,1);
    assert.deepEqual(state.messages[0].analysis,prior);assertOriginalsPreserved(original,state.messages[0]);
  });

  test(`${source} mail HTTP requests replace subject and body URLs while preserving original content and exact short evidence`,async t=>{
    const subjectUrl='https://subject.example.test/report?tracking=synthetic',first='https://links.example.test/open?token=synthetic-123',second='http://downloads.example.test/report?id=42';
    const detail='請核對報表中的各項資料，並依原始紀錄確認內容是否正確；此通知只說明文件的檢閱方式與下載位置，所有資料應以本次寄送的正文及正式檔案為準，保留必要的來源以便後續查核。';
    const original=mail({subject:`報表 ${subjectUrl} 更新`,body:`請查看 ${first} 並下載 ${second} 。金額為 420 元。\n${detail}`,
      html:`<p>請查看 <a href="${first}">完整報表</a></p><img src="${second}">`,attachments:[{name:'fixture.pdf',mimeType:'application/pdf',size:42,attachmentId:'synthetic-attachment',sourceUrl:second}]});
    const f=await fixture(t,source,original,{respondMail:request=>{const clean=request.input.messages[0];return analysis(original.id,[clean.subject,clean.body]);}});
    const state=await f.core.analyzeMail(source,organize);
    assert.equal(state.mailAnalysis.status,'done');assert.equal(state.mailAnalysis.failed,0);assert.equal(f.requests.length,2);
    const request=f.requests[0],clean=request.input.messages[0];
    assert.equal(request.task,'mail');assert.equal(clean.subject,'報表 【網址】 更新');assert.equal(clean.body,'請查看 【網址】 並下載 【網址】 。金額為 420 元。\n'+detail);
    assert.doesNotMatch(request.text,/https?:\/\//);assert.match(request.text,/【網址】/);
    assert.match(request.url,source==='local'?/^http:\/\/127\.0\.0\.1:8765\/v1\/llm$/:/^https:\/\/synthetic-provider\.example\.test\/v1\/chat\/completions$/);
    const saved=state.messages[0];assert.deepEqual(saved.analysis.evidence,[original.subject,original.body]);assert.equal(saved.analysis.meta.source,source);
    assert.equal(saved.analysis.category,'work');assert.equal(saved.analysis.categoryStatus,'done');assertSummaryOnly(f.requests[1],saved.analysis.summary);
    assertOriginalsPreserved(original,saved);assertOriginalsPreserved(original,f.reopen().messages[0]);
  });

  test(`${source} mail with a URL over the PC body limit is shortened before HTTP and retains bounded real-source evidence`,async t=>{
    const longUrl='https://tracking.example.test/click?opaque='+'a'.repeat(210000),prefix='請開啟 ',suffix=' 下載附件，無須回覆。';
    const original=mail({body:prefix+longUrl+suffix,html:`<a href="${longUrl}">下載附件</a>`,attachments:[{name:'source.txt',size:originalFields.length,attachmentId:'long-url-fixture'}]});
    assert(original.body.length>200000);
    const f=await fixture(t,source,original),state=await f.core.analyzeMail(source,organize);
    assert.equal(state.mailAnalysis.status,'done');assert.equal(state.mailAnalysis.failed,0);assert.equal(f.requests.length,2);
    const request=f.requests[0];assert.equal(request.input.messages[0].body,prefix+'【網址】'+suffix);
    assert(request.text.length<200000,'A long tracking URL must not reach the existing HTTP input-size limit.');assert.doesNotMatch(request.text,/tracking\.example\.test|a{1000}/);
    const evidence=state.messages[0].analysis.evidence;
    assert(evidence.length>=1&&evidence.length<=8);
    for(const quote of evidence){assert(quote.trim());assert(quote.length<=1000);assert(original.subject.includes(quote)||original.body.includes(quote));assert(!quote.includes('【網址】'));}
    assert(evidence.some(quote=>quote.includes('請開啟')||quote.includes('下載附件')),'Evidence spanning an oversized URL must retain a genuine surrounding source fragment.');
    assertSummaryOnly(f.requests[1],state.messages[0].analysis.summary);assertOriginalsPreserved(original,state.messages[0]);assertOriginalsPreserved(original,f.reopen().messages[0]);
  });

  test(`${source} failed HTTP summaries do not create successful analyses or classifications after URL replacement`,async t=>{
    const original=mail({body:'請核對 https://failure.example.test/report?token=synthetic 報表。'}),f=await fixture(t,source,original,{httpFailure:true});
    const state=await f.core.analyzeMail(source,organize);
    assert.equal(f.requests.length,1);assert.match(f.requests[0].text,/【網址】/);assert.doesNotMatch(f.requests[0].text,/failure\.example\.test/);
    assert.equal(state.mailAnalysis.status,'error');assert.equal(state.mailAnalysis.failed,1);assert.equal(state.messages[0].analysis,null);assert(state.messages[0].analysisError);
    assertOriginalsPreserved(original,state.messages[0]);assert.equal(f.core.active.size,0);
  });

  test(`${source} fabricated placeholder evidence is rejected without replacing an earlier summary`,async t=>{
    const prior={summary:'先前已確認的摘要。',priority:2,reason:'先前內容。',evidence:['請核對'],category:'work',categoryStatus:'done'};
    const original=mail({body:'請核對 https://evidence.example.test/report 報表。',analysis:prior});
    const f=await fixture(t,source,original,{respondMail:()=>analysis(original.id,['原信不存在的內容【網址】'])});
    const state=await f.core.analyzeMail(source,organize);
    assert.equal(f.requests.length,1);assert.equal(state.mailAnalysis.status,'error');assert.equal(state.mailAnalysis.failed,1);
    assert.deepEqual(state.messages[0].analysis,prior);assert(state.messages[0].analysisError);assertOriginalsPreserved(original,state.messages[0]);
  });

  for(const version of [1,2,3,4])for(const categoryStatus of ['done','error'])test(`${source} v${version} URL ${categoryStatus} caches without a reference date are summarized again using the v9 pipeline`,async t=>{
    const original=mail({body:'請核對報表。 https://cache.example.test/report?token=synthetic'}),f=await fixture(t,source,original);
    const oldHash=fingerprintAtVersion(original,f.store.read().settings,source,version);
    f.store.update(state=>{state.messages[0].analysis={summary:'URL 處理前的舊摘要。',priority:2,reason:'舊快取。',evidence:['請核對報表。'],fingerprint:oldHash,summaryFingerprint:oldHash,category:'work',categoryStatus};});
    const state=await f.core.analyzeMail(source,organize);
    assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify']);assert.equal(state.mailAnalysis.status,'done');
    assert.equal(state.messages[0].analysis.summary,summary);assert.notEqual(state.messages[0].analysis.fingerprint,oldHash);
    assert.equal(state.messages[0].analysis.fingerprint,fingerprintAtVersion(original,f.store.read().settings,source,9,f.requests[0].input.referenceTime));
    const rerun=await f.core.analyzeMail(source,organize);assert.equal(f.requests.length,2);assert.equal(rerun.mailAnalysis.unchanged,1);
    assertOriginalsPreserved(original,state.messages[0]);
  });

  test(`${source} v1 caches without URLs are refreshed once and then reused with the v9 fingerprint`,async t=>{
    const original=mail(),f=await fixture(t,source,original),oldHash=fingerprintAtVersion(original,f.store.read().settings,source,1);
    const prior={summary:'無網址的既有摘要。',priority:2,reason:'已完成。',evidence:['請核對報表。'],fingerprint:oldHash,summaryFingerprint:oldHash,category:'work',categoryStatus:'done'};
    f.store.update(state=>{state.messages[0].analysis=prior;});const state=await f.core.analyzeMail(source,organize);
    assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-classify']);assert.equal(state.mailAnalysis.status,'done');
    assert.equal(state.messages[0].analysis.summary,summary);assert.equal(state.messages[0].analysis.fingerprint,fingerprintAtVersion(original,f.store.read().settings,source,9,f.requests[0].input.referenceTime));
    const reused=await f.core.analyzeMail(source,organize);assert.equal(f.requests.length,2);assert.equal(reused.mailAnalysis.unchanged,1);
    assertOriginalsPreserved(original,state.messages[0]);
  });
}

'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const frame=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n');
const taskInput={messages:[{role:'user',content:'PRIVATE_SOURCE_繁中原文'}]};
const allowedKeys=new Set(['event','level','task','requestId','serverRequestId','durationMs','httpStatus','inputCharacters','inputHash','promptCharacters','promptHash','outputCharacters','model','backend','finishReason','promptTokens','completionTokens','maxOutputTokens','contextTokens','code']);
function fixture(fetchImpl,{settings={compute:'dev-api'},onDiagnostic,timeoutMs=1000}={}){
  const records=[],requests=[];
  const adapter=new LocalLlmApiAdapter({getSettings:()=>settings,timeoutMs,fetchImpl:async(url,options)=>{requests.push({url,options});return fetchImpl(url,options);},onDiagnostic:record=>{records.push(record);return onDiagnostic?.(record);}});
  return{adapter,records,requests,settings};
}
function assertSafe(records,secrets=[]){
  for(const record of records){
    assert.ok(Object.keys(record).every(key=>allowedKeys.has(key)));
    assert.match(record.requestId,UUID);
    if(record.serverRequestId)assert.match(record.serverRequestId,UUID);
    assert.ok(Number.isSafeInteger(record.durationMs)&&record.durationMs>=0);
  }
  const serialized=JSON.stringify(records);
  for(const secret of ['PRIVATE_SOURCE','PRIVATE_PROMPT','PRIVATE_TEMPLATE','PRIVATE_RESPONSE','PRIVATE_EXCEPTION',...secrets])assert.ok(!serialized.includes(secret),'diagnostics must omit '+secret);
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('successful runs send unique UUID headers and log only fingerprints, counts and safe model metrics',async()=>{
  const override={user:'PRIVATE_TEMPLATE {{text}}',system:'PRIVATE_PROMPT system'};
  const f=fixture((_url,options)=>{
    const id=options.headers['X-UFriend-Request-Id'];
    return json({apiVersion:'1',text:'PRIVATE_RESPONSE 完整答案',meta:{requestId:id,model:'Qwen2.5-1.5B-Instruct',backend:'pc-llama.cpp',finishReason:'stop',promptTokens:101,completionTokens:22,maxOutputTokens:4096,contextTokens:8192,private:'PRIVATE_RESPONSE metadata'}},200,{'X-UFriend-Request-Id':id});
  },{settings:{compute:'dev-api',llmPrompts:{chat:override}}});
  await f.adapter.run({task:'chat',input:taskInput});
  const [started,completed]=f.records,body=JSON.parse(f.requests[0].options.body);
  assert.deepEqual(f.records.map(record=>record.event),['llm.request.started','llm.request.completed']);
  assert.equal(started.requestId,f.requests[0].options.headers['X-UFriend-Request-Id']);
  assert.equal(completed.requestId,started.requestId);assert.equal(completed.serverRequestId,started.requestId);
  assert.equal(started.inputHash,hash(body.input));assert.equal(started.inputCharacters,JSON.stringify(body.input).length);
  assert.equal(started.promptHash,hash(body.prompt));assert.equal(started.promptCharacters,JSON.stringify(body.prompt).length);
  assert.equal(completed.httpStatus,200);assert.equal(completed.outputCharacters,'PRIVATE_RESPONSE 完整答案'.length);
  for(const [key,value] of Object.entries({model:'Qwen2.5-1.5B-Instruct',backend:'pc-llama.cpp',finishReason:'stop',promptTokens:101,completionTokens:22,maxOutputTokens:4096,contextTokens:8192}))assert.equal(completed[key],value);
  delete f.settings.llmPrompts.chat;
  await f.adapter.run({task:'chat',input:taskInput});
  assert.notEqual(f.records[2].requestId,started.requestId);
  assert.equal(f.records[2].promptHash,undefined);assert.equal(f.records[2].promptCharacters,undefined);
  assertSafe(f.records);
});

test('server correlation IDs are kept separate from the generated client ID and can come from metadata or headers',async()=>{
  const headerId='6fe90766-1f63-402f-9c46-e7f9d9c9ec92',metaId='7fe90766-1f63-402f-9c46-e7f9d9c9ec92';
  for(const meta of [{requestId:metaId},{}]){
    const f=fixture(()=>json({apiVersion:'1',text:'complete',meta},200,{'X-UFriend-Request-Id':headerId}));
    await f.adapter.run({task:'chat',input:taskInput});const completed=f.records[1];
    assert.equal(completed.serverRequestId,meta.requestId||headerId);
    assert.equal(completed.requestId,f.requests[0].options.headers['X-UFriend-Request-Id']);
    assert.notEqual(completed.requestId,completed.serverRequestId);
    assertSafe(f.records);
  }
});

test('HTTP limits and SSE limit events log failed with safe IDs without logging partial text',async()=>{
  const serverId='8fe90766-1f63-402f-9c46-e7f9d9c9ec92';
  for(const streaming of [false,true]){
    const f=fixture(()=>streaming?new Response(Buffer.concat([frame({type:'delta',text:'PRIVATE_RESPONSE partial'}),frame({type:'error',error:{code:'MODEL_OUTPUT_LIMIT',requestId:serverId,message:'PRIVATE_EXCEPTION backend'}})]),{headers:{'Content-Type':'text/event-stream'}}):json({error:{code:'MODEL_OUTPUT_LIMIT',requestId:serverId,message:'PRIVATE_EXCEPTION backend'}},502));
    const seen=[];
    await assert.rejects(f.adapter.run({task:'chat',input:taskInput,...(streaming?{onDelta:text=>seen.push(text)}:{})}),error=>error.code==='MODEL_OUTPUT_LIMIT'&&error.requestId===serverId);
    assert.deepEqual(f.records.map(record=>record.event),['llm.request.started','llm.request.failed']);
    assert.equal(f.records[1].code,'MODEL_OUTPUT_LIMIT');assert.equal(f.records[1].httpStatus,streaming?200:502);assert.equal(f.records[1].serverRequestId,serverId);
    if(streaming){assert.deepEqual(seen,['PRIVATE_RESPONSE partial']);assert.equal(f.records[1].outputCharacters,'PRIVATE_RESPONSE partial'.length);}
    assertSafe(f.records);
  }
});

test('all output validation failures after HTTP 200 produce failed diagnostics and chat or translation friendly errors',async()=>{
  for(const [task,result,code] of [
    ['chat',{apiVersion:'1',text:42},'MODEL_INVALID_OUTPUT'],
    ['translate',{apiVersion:'1',text:''},'MODEL_INVALID_OUTPUT'],
    ['polish',{apiVersion:'1',text:[]},'MODEL_INVALID_OUTPUT'],
    ['mail',{apiVersion:'1',analyses:[]},'MODEL_INVALID_OUTPUT'],
    ['chat',{apiVersion:'2',text:'complete'},'MODEL_API_INCOMPATIBLE']
  ]){
    const f=fixture(()=>json(result));
    await assert.rejects(f.adapter.run({task,input:taskInput}),error=>{
      assert.equal(error.code,code);assert.equal(error.requestId,f.requests[0].options.headers['X-UFriend-Request-Id']);
      if(task==='chat'&&code==='MODEL_INVALID_OUTPUT')assert.match(error.message,/完整的對話回覆/);
      if(task==='translate')assert.match(error.message,/完整的翻譯/);
      return true;
    });
    assert.deepEqual(f.records.map(record=>record.event),['llm.request.started','llm.request.failed']);
    assert.equal(f.records[1].httpStatus,200);assert.equal(f.records[1].code,code);assertSafe(f.records);
  }
});

test('network failures have a client correlation ID and never log exception text or stack',async()=>{
  const f=fixture(()=>{throw Object.assign(new Error('PRIVATE_EXCEPTION network body'),{stack:'PRIVATE_EXCEPTION stack',body:'PRIVATE_RESPONSE body'});});
  await assert.rejects(f.adapter.run({task:'chat',input:taskInput}),error=>error.code==='MODEL_API_UNAVAILABLE'&&error.requestId===f.requests[0].options.headers['X-UFriend-Request-Id']);
  assert.deepEqual(f.records.map(record=>record.event),['llm.request.started','llm.request.failed']);
  assert.equal(f.records[1].code,'MODEL_API_UNAVAILABLE');assert.equal(f.records[1].httpStatus,undefined);assert.equal(f.records[1].serverRequestId,undefined);
  assertSafe(f.records);
});

test('cancellation records cancelled rather than failed and annotates the abort error with a UUID',async()=>{
  let arrive;const arrived=new Promise(resolve=>{arrive=resolve;});
  const f=fixture((_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});arrive();}));
  const controller=new AbortController(),pending=f.adapter.run({task:'chat',input:taskInput,signal:controller.signal});
  const rejected=assert.rejects(pending,error=>error.name==='AbortError'&&error.requestId===f.requests[0].options.headers['X-UFriend-Request-Id']);
  await arrived;controller.abort();await rejected;
  assert.deepEqual(f.records.map(record=>record.event),['llm.request.started','llm.request.cancelled']);
  assert.equal(f.records[1].code,'MODEL_CANCELLED');assertSafe(f.records);
});

test('timeouts remain failed requests with a timeout code rather than user cancellations',async()=>{
  const f=fixture((_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});}),{timeoutMs:10});
  await Promise.all([assert.rejects(f.adapter.run({task:'chat',input:taskInput}),{code:'MODEL_API_TIMEOUT'}),delay(30)]);
  assert.deepEqual(f.records.map(record=>record.event),['llm.request.started','llm.request.failed']);assert.equal(f.records[1].code,'MODEL_API_TIMEOUT');assertSafe(f.records);
});

test('diagnostic callbacks that throw or reject cannot change successful output or failure classification',async()=>{
  for(const onDiagnostic of [()=>{throw new Error('PRIVATE_EXCEPTION logger');},async()=>{throw new Error('PRIVATE_EXCEPTION async logger');}]){
    const success=fixture(()=>json({apiVersion:'1',text:'complete'}),{onDiagnostic});
    assert.equal((await success.adapter.run({task:'chat',input:taskInput})).text,'complete');
    const failure=fixture(()=>json({error:{code:'MODEL_API_BUSY'}},429),{onDiagnostic});
    await assert.rejects(failure.adapter.run({task:'chat',input:taskInput}),{code:'MODEL_API_BUSY'});
    assert.equal(success.records[1].event,'llm.request.completed');assert.equal(failure.records[1].event,'llm.request.failed');
    assertSafe([...success.records,...failure.records]);
  }
});

test('the adapter sanitizes malicious metadata before invoking any external diagnostic whitelist',async()=>{
  for(const finishReason of ['PRIVATE_RESPONSE finish','stop']){
    const f=fixture(()=>json({apiVersion:'1',text:'PRIVATE_RESPONSE result',meta:{requestId:'PRIVATE_RESPONSE bad ID',model:'PRIVATE_RESPONSE model with spaces',backend:'PRIVATE_RESPONSE backend with spaces',finishReason,promptTokens:-1,completionTokens:1.25,maxOutputTokens:'4096',contextTokens:9007199254740992,prompt:'PRIVATE_PROMPT contents',messages:[{content:'PRIVATE_SOURCE leaked'}],stack:'PRIVATE_EXCEPTION stack'}},200,{'X-UFriend-Request-Id':'PRIVATE_RESPONSE bad header'}));
    if(finishReason==='stop')await f.adapter.run({task:'chat',input:taskInput});
    else await assert.rejects(f.adapter.run({task:'chat',input:taskInput}),{code:'MODEL_INVALID_OUTPUT'});
    const record=f.records[1];
    assert.equal(record.event,finishReason==='stop'?'llm.request.completed':'llm.request.failed');
    assert.equal(record.finishReason,finishReason==='stop'?'stop':undefined);
    for(const key of ['serverRequestId','model','backend','promptTokens','completionTokens','maxOutputTokens','contextTokens','prompt','messages','stack'])assert.equal(record[key],undefined);
    assertSafe(f.records);
  }
});

test('preflight failures still have a started and failed event, while health requests do not create inference logs',async()=>{
  const unavailable=fixture(()=>{assert.fail('An unconfigured adapter must not fetch.');},{settings:{compute:'local'}});
  await assert.rejects(unavailable.adapter.run({task:'chat',input:taskInput}),error=>error.code==='MODEL_NOT_CONFIGURED'&&UUID.test(error.requestId));
  assert.deepEqual(unavailable.records.map(record=>record.event),['llm.request.started','llm.request.failed']);assertSafe(unavailable.records);
  const badPrompt=fixture(()=>{assert.fail('Invalid prompts must not be sent.');},{settings:{compute:'dev-api',llmPrompts:{chat:{system:'PRIVATE_PROMPT',user:'PRIVATE_TEMPLATE missing required variable'}}}});
  await assert.rejects(badPrompt.adapter.run({task:'chat',input:taskInput}),error=>error.code==='MODEL_INVALID_REQUEST'&&UUID.test(error.requestId));
  assert.deepEqual(badPrompt.records.map(record=>record.event),['llm.request.started','llm.request.failed']);assertSafe(badPrompt.records);
  const health=fixture(()=>json({apiVersion:'1',backend:'pc-llama.cpp',model:'fixture',ready:true}));
  assert.equal((await health.adapter.health()).ok,true);assert.deepEqual(health.records,[]);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {LocalLlmApiAdapter,normalizeEndpoint}=require('../app/models/local-llm-api.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {MAIL_CATEGORY_IDS}=require('../app/services/mail-categories.cjs');

async function fixture(t,handler,{timeoutMs=1000}={}){
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const settings={compute:'dev-api',devLlm:{endpoint:'http://127.0.0.1:'+server.address().port}};
  return{server,settings,adapter:new LocalLlmApiAdapter({getSettings:()=>settings,timeoutMs})};
}
function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));}

test('only explicit PC API mode is configured and network URLs are limited to loopback HTTP',async()=>{
  for(const endpoint of ['https://example.com','http://example.com','http://127.0.0.1@evil.example','http://localhost/?key=secret','http://user:pass@127.0.0.1','file:///test'])assert.throws(()=>normalizeEndpoint(endpoint));
  assert.equal(normalizeEndpoint('http://127.0.0.1:8765/'),'http://127.0.0.1:8765');
  let calls=0;const settings={compute:'local'};
  const adapter=new LocalLlmApiAdapter({getSettings:()=>settings,fetchImpl:()=>{calls++;throw new Error('should not fetch');}});
  const registry=new ModelAdapters();registry.register('llm',adapter);
  assert.equal(registry.status().llm.configured,false);
  await assert.rejects(adapter.run({task:'polish',input:{text:'hello'}}),{code:'MODEL_NOT_CONFIGURED'});
  settings.compute='cloud';await assert.rejects(adapter.run({task:'polish',input:{text:'hello'}}),{code:'MODEL_NOT_CONFIGURED'});
  assert.equal(calls,0);settings.compute='dev-api';assert.equal(registry.status().llm.configured,true);
});

test('transport sends only the requested task payload and returns protocol v1 output',async t=>{
  let received;
  const f=await fixture(t,async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received={url:req.url,body:JSON.parse(Buffer.concat(chunks))};json(res,{apiVersion:'1',text:'請於 15:00 前提供資料。',meta:{backend:'pc-llama.cpp'}});});
  const input={text:'15:00 前給我資料',use:'email',tone:'polite'};
  const result=await f.adapter.run({task:'polish',input});
  assert.equal(received.url,'/v1/llm');assert.deepEqual(received.body,{task:'polish',input});assert.equal(result.text,'請於 15:00 前提供資料。');
});

test('health checks protocol and actual readiness without sending mail',async t=>{
  let ready=true;
  const f=await fixture(t,(req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/health');json(res,{apiVersion:'1',backend:'pc-llama.cpp',model:'test-model',ready,contextTokens:2048});});
  assert.equal((await f.adapter.health()).ready,true);
  ready=false;await assert.rejects(f.adapter.health(),{code:'MODEL_API_UNAVAILABLE'});
});

test('health accepts text capabilities and rejects OCR or transcription-only services',async()=>{
  let capabilities;
  const adapter=new LocalLlmApiAdapter({fetchImpl:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:8765/health');assert.equal(options.method,'GET');assert.equal(options.body,undefined);
    return Response.json({apiVersion:'1',backend:'synthetic-service',model:'synthetic-model',ready:true,capabilities});
  }});
  for(capabilities of [['polish','mail','chat','translate','context'],['translate'],['chat','future-capability']])assert.equal((await adapter.health()).ready,true);
  for(capabilities of [['ocr'],['whisper'],['ocr','whisper'],['context'],[],null,'chat',['chat',null]])await assert.rejects(adapter.health(),{code:'MODEL_API_INCOMPATIBLE'});
  capabilities=undefined;assert.equal((await adapter.health()).ready,true);
});

test('mail classification sends only the summary and accepts the seven category IDs without profile or prompt overrides',async()=>{
  const requests=[],input={summary:'Synthetic summary: the project owner requests a progress report.'};let category;
  const settings={localBackend:'pc-api',personalProfile:{enabled:true,name:'PRIVATE PROFILE'},llmPrompts:{'mail-classify':{system:'PRIVATE CUSTOM PROMPT',user:'PRIVATE TEMPLATE'}}};
  const adapter=new LocalLlmApiAdapter({getSettings:()=>settings,fetchImpl:async(url,args)=>{requests.push({url,args});return Response.json({apiVersion:'1',category,meta:{model:'fixture',backend:'pc-llama.cpp'}});}});
  for(category of MAIL_CATEGORY_IDS){
    const result=await adapter.run({task:'mail-classify',input});assert.equal(result.category,category);assert.equal(result.text,undefined);
  }
  assert.equal(requests.length,MAIL_CATEGORY_IDS.length);
  for(const {url,args} of requests){assert.equal(url,'http://127.0.0.1:8765/v1/llm');assert.deepEqual(JSON.parse(args.body),{task:'mail-classify',input});assert.equal(args.body.includes('PRIVATE'),false);}
});

test('mail classification validates input before dispatch and reports an explicit upgrade requirement for older PC services',async()=>{
  let calls=0;
  const adapter=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),fetchImpl:async()=>{calls++;return Response.json({error:{code:'MODEL_INVALID_REQUEST',message:'PRIVATE SERVER DETAILS'}},{status:400});}});
  for(const input of [null,[],{}, {summary:''},{summary:' '},{summary:7},{summary:'x'.repeat(2001)},{summary:'Synthetic summary',body:'PRIVATE ORIGINAL MAIL'}]){
    await assert.rejects(adapter.run({task:'mail-classify',input}),error=>error.code==='MODEL_INVALID_REQUEST'&&!error.message.includes('0.1.5'));
  }
  assert.equal(calls,0);
  await assert.rejects(adapter.run({task:'mail-classify',input:{summary:'x'.repeat(2000)}}),error=>error.code==='MODEL_API_INCOMPATIBLE'&&error.message.includes('0.1.5')&&!error.message.includes('PRIVATE'));
  assert.equal(calls,1);
});

test('mail classification rejects invalid categories and incomplete terminal results',async()=>{
  let result;
  const adapter=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),fetchImpl:async()=>Response.json({apiVersion:'1',...result})});
  const request={task:'mail-classify',input:{summary:'Synthetic meeting invitation summary.'}};
  for(result of [{},{category:'billing'},{category:'Meeting'},{category:null},{category:[]},{category:'meeting',text:'unexpected'},{category:'meeting',meta:'invalid'},{category:'meeting',finishReason:'content_filter'}])await assert.rejects(adapter.run(request),{code:'MODEL_INVALID_OUTPUT'});
  for(const flags of [{complete:false},{truncated:true},{finishReason:'length'},{meta:{finish_reason:'max_tokens'}}]){result={category:'meeting',...flags};await assert.rejects(adapter.run(request),{code:'MODEL_OUTPUT_LIMIT'});}
});

test('mail classification cancellation and timeout cannot return a category',async t=>{
  let arrived;const started=new Promise(resolve=>{arrived=resolve;});
  const f=await fixture(t,()=>arrived(),{timeoutMs:50}),input={summary:'Synthetic account security summary.'};
  const controller=new AbortController(),running=f.adapter.run({task:'mail-classify',input,signal:controller.signal});
  const rejected=assert.rejects(running,{name:'AbortError'});await started;controller.abort();await rejected;
  await assert.rejects(f.adapter.run({task:'mail-classify',input}),{code:'MODEL_API_TIMEOUT'});
});

test('mail classification rejects valid responses that arrive after cancellation or timeout',async()=>{
  const input={summary:'Synthetic meeting invitation summary.'},controller=new AbortController(),events=[];
  const cancelled=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),onDiagnostic:event=>events.push(event),fetchImpl:async()=>{
    controller.abort();return Response.json({apiVersion:'1',category:'meeting'});
  }});
  await assert.rejects(cancelled.run({task:'mail-classify',input,signal:controller.signal}),{name:'AbortError'});
  assert.equal(events.some(event=>event.event==='llm.request.completed'),false);
  const timedOut=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),timeoutMs:5,fetchImpl:async()=>{
    await new Promise(resolve=>setTimeout(resolve,15));return Response.json({apiVersion:'1',category:'meeting'});
  }});
  await assert.rejects(timedOut.run({task:'mail-classify',input}),{code:'MODEL_API_TIMEOUT'});
});

test('translation transport preserves explicit languages and rejects missing translation text',async t=>{
  let received,valid=true;
  const f=await fixture(t,async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received=JSON.parse(Buffer.concat(chunks));json(res,{apiVersion:'1',...(valid?{text:'こんにちは。'}:{})});});
  const input={text:'Hello.',sourceLanguage:'en',targetLanguage:'ja'};
  assert.equal((await f.adapter.run({task:'translate',input})).text,'こんにちは。');assert.deepEqual(received,{task:'translate',input});
  valid=false;await assert.rejects(f.adapter.run({task:'translate',input}),{code:'MODEL_INVALID_OUTPUT'});
});

test('chat, translation and polish reject explicit incomplete output while accepting legacy API v1 results',async()=>{
  let completion={};
  const adapter=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),fetchImpl:async()=>Response.json({apiVersion:'1',text:'Synthetic result.',...completion})});
  for(const task of ['chat','translate','polish']){
    const input=task==='chat'?{messages:[{role:'user',content:'Synthetic question'}]}:task==='translate'?{text:'Synthetic source.',sourceLanguage:'en',targetLanguage:'zh-TW'}:{text:'Synthetic source.',use:'document',tone:'formal'};
    for(completion of [{meta:{finishReason:'length'}},{meta:{finish_reason:'max_tokens'}},{finish_reason:'length'},{finishReason:'max_tokens'},{truncated:true},{complete:false},
      {meta:{truncated:true}},{meta:{complete:false}},{finishReason:'stop',meta:{finishReason:'length'}}])await assert.rejects(adapter.run({task,input}),{code:'MODEL_OUTPUT_LIMIT'});
    for(completion of [{},{meta:{finishReason:'stop'}},{complete:true,truncated:false}])assert.equal((await adapter.run({task,input})).text,'Synthetic result.');
  }
});

test('JSON responses reject malformed UTF-8 instead of saving replacement characters',async()=>{
  let bytes;
  const adapter=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),fetchImpl:async()=>new Response(bytes,{headers:{'Content-Type':'application/json'}})});
  for(const invalid of [[0xc3,0x28],[0xe6,0xb8],[0xc0,0xaf]]){
    bytes=Buffer.concat([Buffer.from('{"apiVersion":"1","text":"before '),Buffer.from(invalid),Buffer.from(' after"}')]);
    await assert.rejects(adapter.run({task:'translate',input:{text:'Synthetic source.',sourceLanguage:'en',targetLanguage:'zh-TW'}}),{code:'MODEL_INVALID_OUTPUT'});
  }
  bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{"apiVersion":"1","text":"Synthetic result."}')]);
  await assert.rejects(adapter.run({task:'polish',input:{text:'Synthetic source.',use:'document',tone:'formal'}}),{code:'MODEL_INVALID_OUTPUT'});
});

test('JSON responses preserve valid multibyte text across transport chunk boundaries',async()=>{
  const text='測試翻譯：こんにちは 🌱',bytes=Buffer.from(JSON.stringify({apiVersion:'1',text}));
  const adapter=new LocalLlmApiAdapter({getSettings:()=>({localBackend:'pc-api'}),fetchImpl:async()=>new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}}),{headers:{'Content-Type':'application/json'}})});
  assert.equal((await adapter.run({task:'translate',input:{text:'Synthetic source.',sourceLanguage:'en',targetLanguage:'ja'}})).text,text);
});

test('API error bodies and redirects cannot expose remote text or follow another endpoint',async t=>{
  let mode='error',requests=0;
  const f=await fixture(t,(req,res)=>{requests++;if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/private'});res.end();return;}json(res,{error:{code:mode==='review'?'MODEL_REVIEW_REQUIRED':'MODEL_API_BUSY',message:'private email must never reach UI'}},mode==='review'?422:429);});
  await assert.rejects(f.adapter.run({task:'polish',input:{text:'hello'}}),e=>e.code==='MODEL_API_BUSY'&&!e.message.includes('private email'));
  mode='review';await assert.rejects(f.adapter.run({task:'mail',input:{messages:[]}}),e=>e.code==='MODEL_REVIEW_REQUIRED'&&e.message.includes('人工確認')&&!e.message.includes('private email'));
  mode='redirect';await assert.rejects(f.adapter.health(),{code:'MODEL_API_UNAVAILABLE'});assert.equal(requests,3);
});

test('cancellation closes the real HTTP request and a timeout reports a distinct code',async t=>{
  let arrived,closed;const requestArrived=new Promise(resolve=>{arrived=resolve;}),requestClosed=new Promise(resolve=>{closed=resolve;});
  const f=await fixture(t,(req,res)=>{res.on('close',closed);arrived();},{timeoutMs:500});
  const controller=new AbortController();
  const running=f.adapter.run({task:'polish',input:{text:'hello'},signal:controller.signal});
  const rejected=assert.rejects(running,{name:'AbortError'});
  await requestArrived;controller.abort();await rejected;await requestClosed;
  await assert.rejects(f.adapter.run({task:'polish',input:{text:'hello'}}),{code:'MODEL_API_TIMEOUT'});
});

test('unparseable, oversized and incompatible output is rejected before use',async t=>{
  let mode='invalid';
  const f=await fixture(t,(req,res)=>{if(mode==='invalid'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>not JSON</h1>');}else if(mode==='large')json(res,{apiVersion:'1',text:'a'.repeat(1024*1024+1)});else json(res,{apiVersion:'2',text:'wrong protocol'});});
  await assert.rejects(f.adapter.run({task:'polish',input:{text:'hello'}}),{code:'MODEL_INVALID_OUTPUT'});
  mode='large';await assert.rejects(f.adapter.run({task:'polish',input:{text:'hello'}}),{code:'MODEL_INVALID_OUTPUT'});
  mode='version';await assert.rejects(f.adapter.run({task:'polish',input:{text:'hello'}}),{code:'MODEL_API_INCOMPATIBLE'});
});

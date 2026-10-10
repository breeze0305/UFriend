'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {once}=require('node:events');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
async function fixture(t,handler,timeoutMs=1000){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});return new LocalLlmApiAdapter({getSettings:()=>({compute:'dev-api',devLlm:{endpoint:'http://127.0.0.1:'+server.address().port},llmPrompts:{chat:{system:'Test prompt',user:'{{text}}'}}}),timeoutMs});}
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
test('chat with onDelta uses real HTTP streaming and passes prompt overrides before final JSON validation',async t=>{
  let finish,arrived;const deltaArrived=new Promise(resolve=>{arrived=resolve;}),seen=[];
  const adapter=await fixture(t,async(req,res)=>{assert.equal(req.url,'/v1/llm/stream');assert.equal(req.headers.accept,'text/event-stream');const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.prompt.system,'Test prompt');res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(event({type:'delta',text:'即時文字'}));finish=()=>res.end(event({type:'done',result:{apiVersion:'1',text:'即時文字'}}));});
  let complete=false;const pending=adapter.run({task:'chat',input:{messages:[{role:'user',content:'hello'}]},onDelta:text=>{seen.push(text);arrived();}}).then(value=>{complete=true;return value;});
  await deltaArrived;assert.equal(complete,false);assert.deepEqual(seen,['即時文字']);finish();assert.equal((await pending).text,'即時文字');
});
test('output limit and stream interruption have specific messages without unrelated mail evidence wording',async t=>{
  let mode='limit';const adapter=await fixture(t,(req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(event({type:'delta',text:'片段'}));res.end(mode==='limit'?event({type:'error',error:{code:'MODEL_OUTPUT_LIMIT',message:'private output'}}):'');});
  for(const code of ['MODEL_OUTPUT_LIMIT','MODEL_STREAM_INTERRUPTED']){await assert.rejects(adapter.run({task:'chat',input:{messages:[]},onDelta:()=>{}}),error=>error.code===code&&!error.message.includes('原文依據')&&!error.message.includes('private'));mode='interrupted';}
});
test('a stalled HTTP stream can be cancelled and has a bounded overall timeout',async t=>{
  let arrived;const started=new Promise(resolve=>{arrived=resolve;});const adapter=await fixture(t,(req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(event({type:'delta',text:'start'}));arrived();},100);
  const controller=new AbortController(),pending=adapter.run({task:'chat',input:{messages:[]},onDelta:()=>{},signal:controller.signal});const rejected=assert.rejects(pending,{name:'AbortError'});await started;controller.abort();await rejected;
  await assert.rejects(adapter.run({task:'chat',input:{messages:[]},onDelta:()=>{}}),{code:'MODEL_API_TIMEOUT'});
});

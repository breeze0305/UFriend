'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {once}=require('node:events');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const settings=()=>({compute:'dev-api'});
const frame=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n');
const chat=()=>({task:'chat',input:{messages:[{role:'user',content:'Synthetic question'}]},onDelta(){}});

test('streaming MIME rejection cancels the body and aborts only the owned HTTP controller',async()=>{
  let ownedSignal,cancelled=false;
  const parent=new AbortController();
  const body=new ReadableStream({start(controller){controller.enqueue(Buffer.from('still open'));},cancel(){cancelled=true;}});
  const adapter=new LocalLlmApiAdapter({getSettings:settings,fetchImpl:async(_url,options)=>{ownedSignal=options.signal;return new Response(body,{headers:{'Content-Type':'text/plain'}});}});
  await assert.rejects(adapter.run({...chat(),signal:parent.signal}),{code:'MODEL_API_INCOMPATIBLE'});
  assert.equal(cancelled,true);assert.equal(ownedSignal.aborted,true);assert.equal(parent.signal.aborted,false);
});

test('an incompatible streaming HTTP response is disconnected without waiting for the server to finish',async t=>{
  let closed;const disconnected=new Promise(resolve=>{closed=resolve;});
  const server=http.createServer((_request,response)=>{response.on('close',closed);response.writeHead(200,{'Content-Type':'text/plain'});response.write('This body intentionally remains open.');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const adapter=new LocalLlmApiAdapter({getSettings:()=>({compute:'dev-api',devLlm:{endpoint:'http://127.0.0.1:'+server.address().port}}),timeoutMs:1000});
  await assert.rejects(adapter.run(chat()),{code:'MODEL_API_INCOMPATIBLE'});
  await disconnected;
});

test('HTTP error responses preserve a valid correlation ID while rejecting unsafe IDs and backend messages',async()=>{
  const valid='6fe90766-1f63-402f-9c46-e7f9d9c9ec92';
  for(const requestId of [valid,'private source text',{id:valid},null]){
    let clientId;
    const adapter=new LocalLlmApiAdapter({getSettings:settings,fetchImpl:async(_url,options)=>{clientId=options.headers['X-UFriend-Request-Id'];return new Response(JSON.stringify({error:{code:'MODEL_INPUT_TOO_LONG',requestId,message:'private backend output'}}),{status:413,headers:{'Content-Type':'application/json'}});}});
    await assert.rejects(adapter.run(chat()),error=>error.code==='MODEL_INPUT_TOO_LONG'&&error.requestId===(requestId===valid?valid:clientId)&&!error.message.includes('private'));
    assert.match(clientId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  }
});

test('malformed streaming UTF-8 reaches the application as invalid output instead of unavailable API',async()=>{
  const body=Buffer.concat([Buffer.from('data: {"type":"delta","text":"'),Buffer.from([0xff]),Buffer.from('"}\n\n')]);
  const adapter=new LocalLlmApiAdapter({getSettings:settings,fetchImpl:async()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}})});
  await assert.rejects(adapter.run(chat()),{code:'MODEL_INVALID_OUTPUT'});
});

test('successful streaming still delivers deltas and returns validated output without aborting the request',async()=>{
  let ownedSignal;const seen=[];
  const body=Buffer.concat([frame({type:'delta',text:'Complete answer'}),frame({type:'done',result:{apiVersion:'1',text:'Complete answer'}})]);
  const adapter=new LocalLlmApiAdapter({getSettings:settings,fetchImpl:async(url,options)=>{assert.ok(url.endsWith('/v1/llm/stream'));assert.equal(options.headers.Accept,'text/event-stream');ownedSignal=options.signal;return new Response(body,{headers:{'Content-Type':'text/event-stream'}});}});
  const result=await adapter.run({...chat(),onDelta:text=>seen.push(text)});
  assert.deepEqual(seen,['Complete answer']);assert.equal(result.text,'Complete answer');assert.equal(ownedSignal.aborted,false);
});

test('streaming terminal metadata cannot mark an incomplete answer as successful',async()=>{
  for(const [flags,code] of [
    [{meta:{complete:false}},'MODEL_OUTPUT_LIMIT'],[{meta:{truncated:true}},'MODEL_OUTPUT_LIMIT'],
    [{finishReason:'stop',meta:{finish_reason:'length'}},'MODEL_OUTPUT_LIMIT'],
    [{finishReason:'stop',meta:{finish_reason:'content_filter'}},'MODEL_INVALID_OUTPUT'],
  ]){
    const events=[],seen=[];
    const body=Buffer.concat([frame({type:'delta',text:'Partial answer'}),frame({type:'done',result:{apiVersion:'1',text:'Partial answer',...flags}})]);
    const adapter=new LocalLlmApiAdapter({getSettings:settings,onDiagnostic:event=>events.push(event),fetchImpl:async()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}})});
    await assert.rejects(adapter.run({...chat(),onDelta:text=>seen.push(text)}),{code});
    assert.deepEqual(seen,['Partial answer']);assert.equal(events.some(event=>event.event==='llm.request.completed'),false);
    assert.equal(events.at(-1).event,'llm.request.failed');assert.equal(events.at(-1).code,code);
  }
});

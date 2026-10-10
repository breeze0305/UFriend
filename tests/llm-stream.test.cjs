'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readLlmStream}=require('../app/models/llm-stream.cjs');
const encode=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n');
const response=stream=>new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
test('streaming delivers UTF-8 deltas before completion even across byte and frame boundaries',async()=>{
  let controller;const readable=new ReadableStream({start(value){controller=value;}}),seen=[];
  const pending=readLlmStream(response(readable),{onDelta:text=>seen.push(text)});
  const packet=encode({type:'delta',text:'繁體中文🐍'});for(const byte of packet)controller.enqueue(Uint8Array.of(byte));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(seen,['繁體中文🐍']);
  controller.enqueue(encode({type:'delta',text:' Python'}));controller.enqueue(encode({type:'done',result:{apiVersion:'1',text:'繁體中文🐍 Python',meta:{completionTokens:12}}}));controller.close();
  assert.equal((await pending).text,'繁體中文🐍 Python');assert.deepEqual(seen,['繁體中文🐍',' Python']);
});
test('an interrupted stream cannot be mistaken for a complete answer',async()=>{
  const seen=[];await assert.rejects(readLlmStream(response(encode({type:'delta',text:'Only a fragment'})),{onDelta:text=>seen.push(text)}),{code:'MODEL_STREAM_INTERRUPTED'});assert.deepEqual(seen,['Only a fragment']);
});
test('stream errors expose the error category and request ID, never backend body text',async()=>{
  const id='6fe90766-1f63-402f-9c46-e7f9d9c9ec92';
  const body=Buffer.concat([encode({type:'delta',text:'partial'}),encode({type:'error',error:{code:'MODEL_OUTPUT_LIMIT',requestId:id,message:'private backend output'}})]);
  await assert.rejects(readLlmStream(response(body)),error=>error.code==='MODEL_OUTPUT_LIMIT'&&error.requestId===id&&!error.message.includes('private'));
});
test('malformed, excessive, inconsistent or duplicate terminal events are rejected',async()=>{
  const delta=encode({type:'delta',text:'actual'}),done=encode({type:'done',result:{apiVersion:'1',text:'actual'}});
  for(const body of [Buffer.from('data: bad\n\n'),encode({type:'delta',text:'x'.repeat(16001)}),Buffer.concat([delta,encode({type:'done',result:{apiVersion:'1',text:'different'}})]),Buffer.concat([delta,done,done])])await assert.rejects(readLlmStream(response(body)),{code:'MODEL_INVALID_OUTPUT'});
});
test('cancellation releases a stalled reader and ignores all later deltas',async()=>{
  let source,cancelled=false;const stream=new ReadableStream({start(value){source=value;},cancel(){cancelled=true;}}),controller=new AbortController(),seen=[];
  const pending=readLlmStream(response(stream),{signal:controller.signal,onDelta:value=>seen.push(value)});source.enqueue(encode({type:'delta',text:'first'}));await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);assert.deepEqual(seen,['first']);
});

test('cancelling in one delta callback suppresses later frames already buffered in the same read',async()=>{
  const controller=new AbortController(),seen=[];
  const body=Buffer.concat([encode({type:'delta',text:'first'}),encode({type:'delta',text:'second'}),encode({type:'done',result:{apiVersion:'1',text:'firstsecond'}})]);
  await assert.rejects(readLlmStream(response(body),{signal:controller.signal,onDelta:text=>{seen.push(text);controller.abort();}}),{name:'AbortError'});
  assert.deepEqual(seen,['first']);
});

test('a valid large stream has the same result when fetch coalesces frames or splits them into smaller reads',async()=>{
  const expected='x'.repeat(16000),parts=Array.from({length:16000},()=>encode({type:'delta',text:'x'}));
  parts.push(encode({type:'done',result:{apiVersion:'1',text:expected}}));
  const body=Buffer.concat(parts);
  assert.ok(body.length>256*1024&&body.length<2*1024*1024);
  for(const input of [body,new ReadableStream({start(controller){for(let offset=0;offset<body.length;offset+=65536)controller.enqueue(body.subarray(offset,offset+65536));controller.close();}})]){
    let delivered='';const result=await readLlmStream(response(input),{onDelta:delta=>{delivered+=delta;}});
    assert.equal(delivered,expected);assert.equal(result.text,expected);
  }
});

test('individual complete and unfinished frames remain bounded even when they contain only ignored comments',async()=>{
  const oversizedComment=':'+'x'.repeat(256*1024);
  for(const tail of ['\n\n',''])await assert.rejects(readLlmStream(response(Buffer.from(oversizedComment+tail))),{code:'MODEL_INVALID_OUTPUT'});
});

test('invalid UTF-8 bytes and a truncated multibyte sequence at EOF are protocol errors',async()=>{
  const prefix=Buffer.from('data: {"type":"delta","text":"');
  for(const body of [Buffer.concat([prefix,Buffer.from([0xff]),Buffer.from('"}\n\n')]),Buffer.concat([prefix,Buffer.from([0xf0,0x9f])])]){
    await assert.rejects(readLlmStream(response(body)),{code:'MODEL_INVALID_OUTPUT'});
  }
});

test('rejecting an incompatible content type cancels its still-open body and releases the reader',async()=>{
  let cancelled=false;
  const body=new ReadableStream({start(controller){controller.enqueue(Buffer.from('not SSE'));},cancel(){cancelled=true;}});
  const incompatible=new Response(body,{headers:{'Content-Type':'text/plain'}});
  await assert.rejects(readLlmStream(incompatible),{code:'MODEL_API_INCOMPATIBLE'});
  assert.equal(cancelled,true);assert.equal(body.locked,false);
});

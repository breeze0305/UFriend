'use strict';

const fail=code=>Object.assign(new Error(code),{code});
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function readLlmStream(response,{signal,onDelta}={}){
  const compatible=/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type')||'');
  const reader=response.body?.getReader();if(!reader)throw fail(compatible?'MODEL_INVALID_OUTPUT':'MODEL_API_INCOMPATIBLE');
  const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',bytes=0,text='',final;
  const requireActive=()=>{if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');};
  const decode=(value,options)=>{try{return decoder.decode(value,options);}catch{throw fail('MODEL_INVALID_OUTPUT');}};
  const frame=source=>{
    requireActive();
    const data=source.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(!data)return;
    if(final)throw fail('MODEL_INVALID_OUTPUT');
    let value;try{value=JSON.parse(data);}catch{throw fail('MODEL_INVALID_OUTPUT');}
    if(value?.type==='delta'){
      if(typeof value.text!=='string'||!value.text||text.length+value.text.length>16000)throw fail('MODEL_INVALID_OUTPUT');
      text+=value.text;onDelta?.(value.text);return;
    }
    if(value?.type==='error'){
      const error=fail(typeof value.error?.code==='string'&&/^MODEL_[A-Z_]+$/.test(value.error.code)?value.error.code:'MODEL_INVALID_OUTPUT');
      if(typeof value.error?.requestId==='string'&&UUID.test(value.error.requestId))error.requestId=value.error.requestId;
      throw error;
    }
    if(value?.type==='done'){
      const result=value.result;
      if(result?.apiVersion!=='1'||typeof result.text!=='string'||!result.text.trim()||result.text.length>16000||result.text.trim()!==text.trim())throw fail('MODEL_INVALID_OUTPUT');
      final=result;return;
    }
    throw fail('MODEL_INVALID_OUTPUT');
  };
  const consume=()=>{
    let match;
    while((match=/\r?\n\r?\n/.exec(buffer))){
      // Bound each frame, independent of how fetch batches complete frames.
      if(match.index>256*1024)throw fail('MODEL_INVALID_OUTPUT');
      const value=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);frame(value);
    }
    if(buffer.length>256*1024)throw fail('MODEL_INVALID_OUTPUT');
  };
  const cancelled=()=>{reader.cancel(signal.reason).catch(()=>{});};signal?.addEventListener('abort',cancelled,{once:true});
  try{
    if(!compatible)throw fail('MODEL_API_INCOMPATIBLE');
    while(true){
      requireActive();
      const {done,value}=await reader.read();
      requireActive();
      if(done)break;
      bytes+=value.byteLength;if(bytes>2*1024*1024)throw fail('MODEL_INVALID_OUTPUT');
      buffer+=decode(value,{stream:true});consume();
    }
    buffer+=decode();consume();
    if(buffer.trim()||!final)throw fail('MODEL_STREAM_INTERRUPTED');
    return final;
  }catch(error){
    await reader.cancel().catch(()=>{});
    if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
    if(error.code)throw error;throw fail('MODEL_STREAM_INTERRUPTED');
  }finally{signal?.removeEventListener('abort',cancelled);reader.releaseLock();}
}
module.exports={readLlmStream};

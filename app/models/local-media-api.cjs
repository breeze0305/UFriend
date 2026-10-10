'use strict';

// The desktop transports managed files; model environments live in independent services.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {Readable}=require('node:stream');
const {ModelUnavailableError,localApiEnabled}=require('./adapters.cjs');

const CONFIG={
  ocr:{setting:'devOcr',port:8767,task:'recognize',limit:40*1024*1024,timeout:180000,label:'OCR'},
  whisper:{setting:'devWhisper',port:8768,task:'transcribe',limit:1000*1024*1024,timeout:2*60*60*1000,label:'Whisper'},
};
const ERRORS={
  MODEL_API_UNAVAILABLE:'無法使用模型 API，請先啟動對應的獨立服務，等候模型就緒。',
  MODEL_API_TIMEOUT:'模型處理逾時，原始檔案已保留，可稍後重新處理。',
  MODEL_API_BUSY:'模型正在處理其他檔案，請等候完成後再試。',
  MODEL_API_INCOMPATIBLE:'服務的能力或 API 版本不相容，請確認模型端點。',
  MODEL_INVALID_OUTPUT:'模型回傳的結果不完整或格式錯誤，未套用這筆結果。',
  MODEL_INVALID_REQUEST:'模型無法讀取這份檔案，請確認檔案格式。',
  MODEL_INPUT_TOO_LONG:'檔案超過模型服務的處理上限，原始檔案已保留。',
  MODEL_CANCELLED:'已取消模型處理。',
  MODEL_JOB_NOT_FOUND:'處理作業已失效，原始檔案已保留，請重新開始。',
  MODEL_PROCESSING_FAILED:'模型未能完成處理，原始檔案已保留，請重新開始。',
};
// The independent services retain their own protocol error names. Normalize codes,
// never their diagnostic messages, before exposing a desktop error to the user.
const ERROR_ALIASES={
  UNSAFE_REQUEST:'MODEL_INVALID_REQUEST',
  UNSUPPORTED_MEDIA_TYPE:'MODEL_INVALID_REQUEST',
  IMAGE_TOO_LARGE:'MODEL_INPUT_TOO_LONG',
  INVALID_IMAGE:'MODEL_INVALID_REQUEST',
  UPLOAD_TIMEOUT:'MODEL_API_TIMEOUT',
  REQUEST_CANCELLED:'MODEL_CANCELLED',
  MODEL_TIMEOUT:'MODEL_API_TIMEOUT',
  MODEL_PROCESS_EXIT:'MODEL_API_UNAVAILABLE',
  MODEL_LOAD_FAILED:'MODEL_API_UNAVAILABLE',
  OCR_FAILED:'MODEL_PROCESSING_FAILED',
  INVALID_MODEL_OUTPUT:'MODEL_INVALID_OUTPUT',
  JOB_NOT_FOUND:'MODEL_JOB_NOT_FOUND',
  NOT_FOUND:'MODEL_API_INCOMPATIBLE',
  INTERNAL_ERROR:'MODEL_PROCESSING_FAILED',
  MODEL_API_FORBIDDEN:'MODEL_INVALID_REQUEST',
  MODEL_API_INPUT_TOO_LARGE:'MODEL_INPUT_TOO_LONG',
  MODEL_API_INVALID_REQUEST:'MODEL_INVALID_REQUEST',
  MODEL_API_INVALID_AUDIO:'MODEL_INVALID_REQUEST',
  MODEL_API_INVALID_RESPONSE:'MODEL_INVALID_OUTPUT',
  MODEL_API_TRANSCRIPTION_FAILED:'MODEL_PROCESSING_FAILED',
  MODEL_API_CANCELLED:'MODEL_CANCELLED',
  MODEL_API_JOB_NOT_FOUND:'MODEL_JOB_NOT_FOUND',
  MODEL_API_NOT_FOUND:'MODEL_API_INCOMPATIBLE',
};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const jobId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{16,128}$/.test(value);
function errorCode(code){if(typeof code!=='string')return undefined;return Object.hasOwn(ERRORS,code)?code:Object.hasOwn(ERROR_ALIASES,code)?ERROR_ALIASES[code]:undefined;}
function failure(code,fallback='MODEL_PROCESSING_FAILED'){const normalized=errorCode(code)||fallback;return Object.assign(new Error(ERRORS[normalized]),{code:normalized});}
function endpoint(value,kind){
  let url;try{url=new URL(value||'http://127.0.0.1:'+CONFIG[kind].port);}catch{throw failure('MODEL_INVALID_REQUEST');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw failure('MODEL_INVALID_REQUEST');
  return url.origin;
}
async function readJson(response){
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){await response.body?.cancel();throw failure('MODEL_INVALID_OUTPUT');}
  const reader=response.body?.getReader();if(!reader)throw failure('MODEL_INVALID_OUTPUT');
  const chunks=[];let bytes=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>12*1024*1024){await reader.cancel();throw failure('MODEL_INVALID_OUTPUT');}chunks.push(Buffer.from(value));}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}
    catch{throw failure('MODEL_INVALID_OUTPUT');}
  }catch(error){if(error.code)throw error;throw failure('MODEL_INVALID_OUTPUT');}
  finally{reader.releaseLock();}
}
function pause(milliseconds,signal){
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},milliseconds);
    signal.addEventListener('abort',abort,{once:true});
  });
}
function meta(value){
  if(!object(value)||!['model','backend'].every(key=>typeof value[key]==='string'&&value[key].trim()&&value[key].length<=250))throw failure('MODEL_INVALID_OUTPUT');
  return{model:value.model,backend:value.backend};
}
function validateResult(kind,value){
  if(!object(value))throw failure('MODEL_INVALID_OUTPUT');
  const resultMeta=meta(value.meta);
  if(kind==='ocr'){
    if(typeof value.text!=='string'||value.text.length>1000000||!Array.isArray(value.regions)||value.regions.length>10000)throw failure('MODEL_INVALID_OUTPUT');
    const regions=value.regions.map(region=>{
      if(!object(region)||typeof region.text!=='string'||region.text.length>10000||!Number.isFinite(region.confidence)||region.confidence<0||region.confidence>1
        ||!Array.isArray(region.box)||region.box.length!==4||region.box.some(point=>!Array.isArray(point)||point.length!==2||point.some(number=>!Number.isFinite(number)||number<0||number>20000)))throw failure('MODEL_INVALID_OUTPUT');
      return{text:region.text,confidence:region.confidence,box:region.box.map(point=>[...point])};
    });
    return{text:value.text.trim(),regions,meta:resultMeta};
  }
  if(!Array.isArray(value.segments)||value.segments.length>100000||typeof value.language!=='string'||!value.language||value.language.length>30)throw failure('MODEL_INVALID_OUTPUT');
  if(value.duration!==undefined&&(!Number.isFinite(value.duration)||value.duration<0))throw failure('MODEL_INVALID_OUTPUT');
  let previous=-1,characters=0;
  const segments=value.segments.map(segment=>{
    if(!object(segment)||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.start<previous||segment.end<segment.start
      ||(value.duration!==undefined&&segment.end>value.duration+1)||typeof segment.text!=='string'||!segment.text.trim()||segment.text.length>10000)throw failure('MODEL_INVALID_OUTPUT');
    previous=segment.start;characters+=segment.text.length;if(characters>2000000)throw failure('MODEL_INVALID_OUTPUT');
    return{start:segment.start,end:segment.end,text:segment.text.trim()};
  });
  return{segments,language:value.language,...(value.duration!==undefined?{duration:value.duration}:{}),meta:resultMeta};
}
class LocalMediaApiAdapter {
  constructor({kind,getSettings,fetchImpl=globalThis.fetch,pollMs=500,timeoutMs}={}){
    if(!CONFIG[kind])throw new TypeError('Unknown media model kind.');
    this.kind=kind;this.config=CONFIG[kind];this.getSettings=getSettings||(()=>({compute:'local'}));this.fetch=fetchImpl;this.pollMs=pollMs;this.timeoutMs=timeoutMs??this.config.timeout;
    this.activeRuns=new Map();
  }
  isConfigured(){return localApiEnabled(this.getSettings());}
  base(value){return endpoint(value||this.getSettings()[this.config.setting]?.endpoint,this.kind);}
  async request(base,route,{method='GET',headers={},body,signal,timeoutMs=30000}={}){
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
    try{
      const response=await this.fetch(base+route,{method,headers:{Accept:'application/json','X-UFriend-Client':'1',...headers},...(body?{body,duplex:'half'}:{}),signal:combined,redirect:'error'});
      const value=await readJson(response);
      if(!response.ok)throw failure(value?.error?.code,response.status===429?'MODEL_API_BUSY':response.status===413?'MODEL_INPUT_TOO_LONG':response.status===404?'MODEL_JOB_NOT_FOUND':'MODEL_API_UNAVAILABLE');
      if(value?.apiVersion!=='1')throw failure('MODEL_API_INCOMPATIBLE');
      return value;
    }catch(error){
      if(signal?.aborted)throw signal.reason;
      if(combined.aborted)throw failure('MODEL_API_TIMEOUT');
      if(errorCode(error.code))throw failure(error.code);
      throw failure('MODEL_API_UNAVAILABLE');
    }
  }
  async health({endpoint:value}={}){
    const info=await this.request(this.base(value),'/health',{timeoutMs:5000});
    if(typeof info.ready!=='boolean'||!Array.isArray(info.capabilities)||!info.capabilities.includes(this.kind))throw failure('MODEL_API_INCOMPATIBLE');
    const model=meta(info);
    if(!info.ready)throw failure('MODEL_API_UNAVAILABLE');
    return{ok:true,apiVersion:'1',ready:true,capabilities:[this.kind],...model};
  }
  async cancelAll(){
    const pending=[...this.activeRuns];for(const [controller] of pending)controller.abort(new DOMException('Cancelled','AbortError'));
    await Promise.allSettled(pending.map(([,settled])=>settled));
  }
  async run({task,input,signal,onProgress}={}){
    if(!this.isConfigured())throw new ModelUnavailableError(this.kind);
    const base=this.base();
    if(task!==this.config.task||typeof input?.filePath!=='string'||!path.isAbsolute(input.filePath)||/^[\\/]{2}/.test(input.filePath))throw failure('MODEL_INVALID_REQUEST');
    if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
    let source,stat;
    try{source=await fsp.realpath(input.filePath);stat=await fsp.stat(source);}catch{throw failure('MODEL_INVALID_REQUEST');}
    if(/^[\\/]{2}/.test(source))throw failure('MODEL_INVALID_REQUEST');
    if(!stat.isFile()||stat.size===0)throw failure('MODEL_INVALID_REQUEST');
    if(stat.size>this.config.limit)throw Object.assign(failure('MODEL_INPUT_TOO_LONG'),{message:this.config.label+' 測試 API 每個檔案上限為 '+Math.round(this.config.limit/1024/1024)+' MiB。原始檔案仍保留於工作空間。'});
    const controller=new AbortController(),cancel=()=>controller.abort(signal.reason||new DOMException('Cancelled','AbortError'));
    signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(failure('MODEL_API_TIMEOUT')),this.timeoutMs);timer.unref?.();
    let settled;this.activeRuns.set(controller,new Promise(resolve=>{settled=resolve;}));
    let id,stream,completed=false,latestProgress=0,processedSeconds=0,durationSeconds;
    try{
      if(signal?.aborted)cancel();
      const headers={'Content-Type':this.kind==='ocr'?'image/png':'application/octet-stream','Content-Length':String(stat.size)};
      if(this.kind==='whisper'){
        if(!['auto','zh-TW','zh','en','ja','ko','es','fr','de'].includes(input.language||'auto'))throw failure('MODEL_INVALID_REQUEST');
        headers['X-UFriend-Language']=input.language||'auto';headers['X-UFriend-Filename']=encodeURIComponent(path.basename(source));
      }else if(/\.jpe?g$/i.test(source))headers['Content-Type']='image/jpeg';
      stream=fs.createReadStream(source);
      const created=await this.request(base,'/v1/jobs',{method:'POST',headers,body:Readable.toWeb(stream),signal:controller.signal,timeoutMs:10*60*1000});
      if(!jobId(created.jobId))throw failure('MODEL_INVALID_OUTPUT');id=created.jobId;
      while(true){
        const state=await this.request(base,'/v1/jobs/'+id,{signal:controller.signal});
        if(state.jobId!==id||!['queued','running','completed','failed','cancelled'].includes(state.status)||!Number.isFinite(state.progress)||state.progress<0||state.progress>1)throw failure('MODEL_INVALID_OUTPUT');
        latestProgress=Math.max(latestProgress,state.progress);
        if(Number.isFinite(state.processedSeconds)&&state.processedSeconds>=0)processedSeconds=state.processedSeconds;
        if(Number.isFinite(state.durationSeconds)&&state.durationSeconds>=0)durationSeconds=state.durationSeconds;
        if(controller.signal.aborted)throw controller.signal.reason;
        onProgress?.(Math.min(99,latestProgress*100),{processedSeconds,durationSeconds,stage:state.status});
        if(state.status==='completed'){const result=validateResult(this.kind,state.result);completed=true;return result;}
        if(state.status==='failed')throw failure(state.error?.code);
        if(state.status==='cancelled')throw failure('MODEL_CANCELLED');
        await pause(this.pollMs,controller.signal);
      }
    }catch(error){
      if(processedSeconds>0)error.processedSeconds=processedSeconds;
      if(durationSeconds!==undefined)error.durationSeconds=durationSeconds;
      throw error;
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',cancel);stream?.destroy();
      // Cleanup gets its own bounded request because the work signal may already be aborted.
      if(id&&!completed)await this.request(base,'/v1/jobs/'+id,{method:'DELETE',timeoutMs:5000}).catch(()=>{});
      this.activeRuns.delete(controller);settled();
    }
  }
}
module.exports={LocalMediaApiAdapter,validateResult,endpoint};

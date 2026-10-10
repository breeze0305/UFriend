'use strict';

// Transport only. The desktop app never installs, starts, or imports a model runtime.
const {createHash,randomUUID}=require('node:crypto');
const {ModelUnavailableError,localApiEnabled} = require('./adapters.cjs');
const {TASK_VARIABLES,validatePrompt}=require('../services/llm-prompts.cjs');
const {preferredLanguage}=require('../services/llm-context.cjs');
const {profileContext}=require('../services/personal-profile.cjs');
const {validMailCategory}=require('../services/mail-categories.cjs');
const {readLlmStream}=require('./llm-stream.cjs');
const {PRIVATE_MAIL_TASKS,validateProcessingInput,validateProcessingOutput,runMailPipeline}=require('./mail-processing.cjs');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safeRequestId=value=>typeof value==='string'&&UUID.test(value)?value:undefined;
const TASKS=new Set(['polish','mail','chat','translate','mail-classify',...PRIVATE_MAIL_TASKS]);
const FINISH_REASONS=new Set(['stop','length','tool_calls','function_call','content_filter','missing']);
const METRIC_FIELDS=['promptTokens','completionTokens','maxOutputTokens','contextTokens'];
const MESSAGES = {
  MODEL_API_UNAVAILABLE:'無法連接 PC 測試 API，請先啟動獨立的 LLM 服務。',
  MODEL_API_TIMEOUT:'PC 測試 API 處理逾時，原始內容已保留。',
  MODEL_API_BUSY:'PC 測試 API 正在處理其他工作，請稍後再試。',
  MODEL_INPUT_TOO_LONG:'這篇內容超過測試模型的容量，尚未分析；請縮短內容後再試。',
  MODEL_INVALID_OUTPUT:'模型回傳的格式或原文依據不完整，未套用這筆結果。',
  MODEL_OUTPUT_LIMIT:'回覆達到模型輸出長度上限，未保存不完整答案；請縮小問題範圍後重試。',
  MODEL_STREAM_INTERRUPTED:'回覆串流中斷，未保存不完整答案；問題已保留，可重新傳送。',
  MODEL_API_INCOMPATIBLE:'這個服務不支援 UFriend LLM API v1。',
  MODEL_INVALID_REQUEST:'模型收到的資料格式不正確，原始內容已保留。',
  MODEL_REVIEW_REQUIRED:'這封郵件包含針對模型的控制指令，請人工確認；原文與分級已保留。',
};
function apiError(code) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.MODEL_API_UNAVAILABLE),{code:MESSAGES[code]?code:'MODEL_API_UNAVAILABLE'}); }
function fingerprint(value){
  const json=JSON.stringify(value);
  return typeof json==='string'?{characters:json.length,hash:createHash('sha256').update(json).digest('hex')}:{};
}
function safeModelMetrics(meta){
  const result={};
  if(typeof meta?.model==='string'&&/^[a-zA-Z0-9_.:/+-]{1,200}$/.test(meta.model))result.model=meta.model;
  if(typeof meta?.backend==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(meta.backend))result.backend=meta.backend;
  if(FINISH_REASONS.has(meta?.finishReason))result.finishReason=meta.finishReason;
  for(const key of METRIC_FIELDS)if(Number.isSafeInteger(meta?.[key])&&meta[key]>=0)result[key]=meta[key];
  return result;
}
function emitDiagnostic(adapter,event,details){
  if(typeof adapter.onDiagnostic!=='function')return;
  const record={event,level:event==='llm.request.failed'?'error':'info'};
  if(TASKS.has(details.task))record.task=details.task;
  for(const key of ['requestId','serverRequestId']){const id=safeRequestId(details[key]);if(id)record[key]=id;}
  for(const key of ['durationMs','inputCharacters','promptCharacters','outputCharacters',...METRIC_FIELDS])if(Number.isSafeInteger(details[key])&&details[key]>=0)record[key]=details[key];
  if(Number.isInteger(details.httpStatus)&&details.httpStatus>=100&&details.httpStatus<=599)record.httpStatus=details.httpStatus;
  for(const key of ['inputHash','promptHash'])if(typeof details[key]==='string'&&/^[a-f0-9]{64}$/.test(details[key]))record[key]=details[key];
  if(Object.hasOwn(MESSAGES,details.code)||['MODEL_NOT_CONFIGURED','MODEL_CANCELLED'].includes(details.code))record.code=details.code;
  Object.assign(record,safeModelMetrics(details));
  // The observer gets only a new whitelist record, never request data, results,
  // errors or shared mutable context. Logging failures cannot affect inference.
  try{const pending=adapter.onDiagnostic(record);if(pending&&typeof pending.catch==='function')pending.catch(()=>{});}catch{}
}
function attachRequestContext(error,requestId,serverRequestId,code,cancelled){
  const source=error&&typeof error==='object'?error:apiError('MODEL_API_UNAVAILABLE');
  const id=safeRequestId(source.requestId)||serverRequestId||requestId;
  try{
    source.requestId=id;if(serverRequestId)source.serverRequestId=serverRequestId;
    if(!cancelled)source.code=code;
    return source;
  }catch{
    const replacement=new Error(typeof source.message==='string'?source.message:MESSAGES.MODEL_API_UNAVAILABLE);
    replacement.name=typeof source.name==='string'?source.name:'Error';replacement.code=cancelled?source.code:code;
    replacement.requestId=id;if(serverRequestId)replacement.serverRequestId=serverRequestId;
    return replacement;
  }
}
function normalizeEndpoint(value) {
  let url;
  try { url = new URL(String(value || 'http://127.0.0.1:8765')); } catch { throw new Error('PC 測試 API 位址格式錯誤。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error('PC 測試 API 只接受本機 HTTP 位址。');
  return url.href.replace(/\/+$/,'');
}
async function readJson(response, maximum = 1024*1024) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw apiError('MODEL_INVALID_OUTPUT');
  const reader = response.body?.getReader();
  if (!reader) throw apiError('MODEL_INVALID_OUTPUT');
  let bytes=0; const chunks=[];
  try {
    while (true) {
      const {done,value}=await reader.read(); if(done) break;
      bytes+=value.byteLength;
      if(bytes>maximum){await reader.cancel();throw apiError('MODEL_INVALID_OUTPUT');}
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks))); }
    catch { throw apiError('MODEL_INVALID_OUTPUT'); }
  } catch (error) {
    if (error.code) throw error;
    throw apiError('MODEL_INVALID_OUTPUT');
  } finally { reader.releaseLock(); }
}
class LocalLlmApiAdapter {
  constructor({getSettings,fetchImpl=globalThis.fetch,timeoutMs=180000,onDiagnostic}={}) {
    this.getSettings=getSettings || (()=>({compute:'local'}));
    this.fetch=fetchImpl; this.timeoutMs=timeoutMs;
    this.onDiagnostic=onDiagnostic;
  }
  isConfigured() { return localApiEnabled(this.getSettings()); }
  async request(route,{body,signal,endpoint,timeoutMs=this.timeoutMs,onDelta,requestId,onResponse}={}) {
    if(signal?.aborted) throw signal.reason || new DOMException('Cancelled','AbortError');
    const base=normalizeEndpoint(endpoint || this.getSettings().devLlm?.endpoint);
    const controller=new AbortController();
    const cancel=()=>controller.abort(signal.reason || new DOMException('Cancelled','AbortError'));
    signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(apiError('MODEL_API_TIMEOUT')),timeoutMs); timer.unref?.();
    let completed=false;
    try {
      const response=await this.fetch(base+route,{method:body?'POST':'GET',headers:{Accept:onDelta?'text/event-stream':'application/json',...(body?{'Content-Type':'application/json'}:{}),...(safeRequestId(requestId)?{'X-UFriend-Request-Id':requestId}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error'});
      const serverRequestId=safeRequestId(response.headers.get('X-UFriend-Request-Id'));
      onResponse?.({httpStatus:response.status,...(serverRequestId?{serverRequestId}:{})});
      const value=response.ok&&onDelta?await readLlmStream(response,{signal:controller.signal,onDelta}):await readJson(response);
      if(controller.signal.aborted)throw controller.signal.reason;
      if(!response.ok) {
        const code=value?.error?.code;
        const error=apiError(MESSAGES[code]?code:response.status===429?'MODEL_API_BUSY':response.status===413?'MODEL_INPUT_TOO_LONG':response.status===404&&onDelta?'MODEL_API_INCOMPATIBLE':'MODEL_API_UNAVAILABLE');
        const requestId=safeRequestId(value?.error?.requestId);if(requestId)error.requestId=requestId;
        throw error;
      }
      completed=true;
      return value;
    } catch(error) {
      if(signal?.aborted) throw signal.reason || new DOMException('Cancelled','AbortError');
      if(controller.signal.aborted) throw controller.signal.reason;
      if(MESSAGES[error.code]) {const requestId=safeRequestId(error.requestId);throw Object.assign(apiError(error.code),requestId?{requestId}:{});}
      throw apiError('MODEL_API_UNAVAILABLE');
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(!completed&&!controller.signal.aborted)controller.abort();}
  }
  async health({endpoint}={}) {
    const value=await this.request('/health',{endpoint,timeoutMs:5000});
    if(value?.apiVersion!=='1' || typeof value?.backend!=='string' || !value.backend || value.backend.length>100 || typeof value.ready!=='boolean'
      || typeof value.model!=='string' || value.model.length>200) throw apiError('MODEL_API_INCOMPATIBLE');
    // Older API v1 services omitted capabilities. When advertised, they must
    // identify a text task rather than an OCR or transcription-only service.
    if(value.capabilities!==undefined&&(!Array.isArray(value.capabilities)||value.capabilities.some(capability=>typeof capability!=='string')
      ||!value.capabilities.some(capability=>TASKS.has(capability))))throw apiError('MODEL_API_INCOMPATIBLE');
    if(!value.ready) throw apiError('MODEL_API_UNAVAILABLE');
    return {ok:true,apiVersion:'1',backend:value.backend,model:value.model,ready:true,
      quantization:typeof value.quantization==='string'?value.quantization.slice(0,40):'',
      contextTokens:Number.isInteger(value.contextTokens)?value.contextTokens:0};
  }
  async run(request) {
    if(request.task!=='mail')return this.runSingle(request);
    const settings=structuredClone(this.getSettings());
    return runMailPipeline({input:request.input,signal:request.signal,onProgress:request.onProgress,
      run:(task,input,signal)=>this.runSingle({task,input,signal},settings)});
  }
  async runSingle({task,input,signal,onDelta},settingsSnapshot) {
    const requestId=randomUUID(),startedAt=performance.now(),details={task,requestId};let started=false,requestSent=false;
    const start=()=>{if(!started){started=true;emitDiagnostic(this,'llm.request.started',{...details,durationMs:0});}};
    try{
      if(task==='mail-classify'){
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'summary')
          ||typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>2000)throw apiError('MODEL_INVALID_REQUEST');
        input={summary:input.summary};
      }
      if(PRIVATE_MAIL_TASKS.has(task))input=validateProcessingInput(input);
      const inputFingerprint=fingerprint(input);
      if(inputFingerprint.hash)Object.assign(details,{inputCharacters:inputFingerprint.characters,inputHash:inputFingerprint.hash});
      const settings=settingsSnapshot||this.getSettings();
      if(!localApiEnabled(settings))throw new ModelUnavailableError('llm','local');
      if(!TASKS.has(task))throw apiError('MODEL_INVALID_REQUEST');
      const privateTask=task==='mail-classify'||PRIVATE_MAIL_TASKS.has(task);
      const override=privateTask?undefined:settings.llmPrompts?.[task],prompt=override?validatePrompt(task,override):undefined;
      const context={};
      if(task==='chat'&&settings.preferredLanguage!==undefined)context.preferredLanguage=preferredLanguage(settings.preferredLanguage);
      if(task!=='translate'&&!privateTask){const profile=profileContext(settings.personalProfile);if(profile)context.profile=profile;}
      if(prompt){const value=fingerprint(prompt);Object.assign(details,{promptCharacters:value.characters,promptHash:value.hash});}
      const streaming=task==='chat'&&typeof onDelta==='function';
      const deliverDelta=delta=>{details.outputCharacters=(details.outputCharacters||0)+delta.length;onDelta(delta);};
      start();
      requestSent=true;
      const value=await this.request(streaming?'/v1/llm/stream':'/v1/llm',{endpoint:settings.devLlm?.endpoint,body:{task,input,...(prompt?{prompt}:{}),...(Object.keys(context).length?{context}:{})},signal,requestId,onResponse:info=>Object.assign(details,info),...(streaming?{onDelta:deliverDelta}:{})});
      Object.assign(details,safeModelMetrics(value?.meta));
      const serverRequestId=safeRequestId(value?.meta?.requestId);if(serverRequestId)details.serverRequestId=serverRequestId;
      if(value?.apiVersion!=='1')throw apiError('MODEL_API_INCOMPATIBLE');
      if(PRIVATE_MAIL_TASKS.has(task)||['chat','polish','translate','mail-classify'].includes(task)){
        const completion=[value,value.meta];
        const reasons=completion.flatMap(part=>[part?.finishReason,part?.finish_reason]).filter(reason=>reason!==undefined);
        if(completion.some(part=>part?.truncated===true||part?.complete===false)||reasons.some(reason=>['length','max_tokens'].includes(reason)))throw apiError('MODEL_OUTPUT_LIMIT');
        if((privateTask||task==='chat')&&reasons.some(reason=>reason!=='stop'))throw apiError('MODEL_INVALID_OUTPUT');
      }
      if(PRIVATE_MAIL_TASKS.has(task)){
        const validated=validateProcessingOutput(task,value,input);
        emitDiagnostic(this,'llm.request.completed',{...details,durationMs:Math.max(0,Math.round(performance.now()-startedAt))});
        return validated;
      }
      if(task==='polish'&&(typeof value.text!=='string'||!value.text.trim()||value.text.length>200000))throw apiError('MODEL_INVALID_OUTPUT');
      if(task==='mail'&&(!Array.isArray(value.analyses)||value.analyses.length!==1))throw apiError('MODEL_INVALID_OUTPUT');
      if(['chat','translate'].includes(task)&&(typeof value.text!=='string'||!value.text.trim()||value.text.length>16000))throw apiError('MODEL_INVALID_OUTPUT');
      if(task==='mail-classify'&&(!validMailCategory(value.category)||Object.keys(value).some(key=>!['apiVersion','category','meta','finishReason','finish_reason','truncated','complete'].includes(key))
        ||value.meta!==undefined&&(!value.meta||typeof value.meta!=='object'||Array.isArray(value.meta))))throw apiError('MODEL_INVALID_OUTPUT');
      if(typeof value.text==='string')details.outputCharacters=value.text.length;
      emitDiagnostic(this,'llm.request.completed',{...details,durationMs:Math.max(0,Math.round(performance.now()-startedAt))});
      return task==='mail-classify'?{apiVersion:'1',category:value.category,...(value.meta?{meta:value.meta}:{})}:value;
    }catch(caught){
      start();
      const cancelled=!!signal?.aborted||caught?.name==='AbortError'||caught?.code==='MODEL_CANCELLED';
      const needsUpgrade=(task==='mail-classify'||PRIVATE_MAIL_TASKS.has(task))&&requestSent&&caught?.code==='MODEL_INVALID_REQUEST';
      const code=cancelled?'MODEL_CANCELLED':needsUpgrade?'MODEL_API_INCOMPATIBLE':typeof caught?.code==='string'&&Object.hasOwn(MESSAGES,caught.code)?caught.code:caught?.code==='MODEL_NOT_CONFIGURED'?'MODEL_NOT_CONFIGURED':'MODEL_INVALID_REQUEST';
      const serverRequestId=safeRequestId(caught?.serverRequestId)||safeRequestId(caught?.requestId)||details.serverRequestId;
      const error=attachRequestContext(caught,requestId,serverRequestId,code,cancelled);
      if(task==='mail-classify'&&code==='MODEL_API_INCOMPATIBLE')error.message='目前的 PC LLM API 不支援摘要分類，請更新至 0.1.5 或更新版本後重試。';
      if(PRIVATE_MAIL_TASKS.has(task)&&code==='MODEL_API_INCOMPATIBLE')error.message='目前的 PC LLM API 不支援長信分段整理，請更新至 0.1.6 或更新版本，重新啟動服務後再試。';
      if(code==='MODEL_INVALID_OUTPUT'&&['chat','translate'].includes(task))error.message=task==='chat'?'模型未能產生完整的對話回覆，問題已保留，請重試。':'模型未能產生完整的翻譯，原文已保留，請重試。';
      emitDiagnostic(this,cancelled?'llm.request.cancelled':'llm.request.failed',{...details,...(serverRequestId?{serverRequestId}:{}),code,durationMs:Math.max(0,Math.round(performance.now()-startedAt))});
      throw error;
    }
  }
  async prompts(){
    const value=await this.request('/v1/prompts',{timeoutMs:5000});
    if(value?.apiVersion!=='1'||!value.tasks||typeof value.tasks!=='object')throw apiError('MODEL_API_INCOMPATIBLE');
    const tasks={};
    for(const task of Object.keys(TASK_VARIABLES)){
      try{
        const prompt=validatePrompt(task,value.tasks[task]);
        tasks[task]={...prompt,variables:[...TASK_VARIABLES[task]],requiredVariables:[task==='mail'?'lines':'text']};
      }catch{throw apiError('MODEL_API_INCOMPATIBLE');}
    }
    return{apiVersion:'1',tasks,limits:{system:12000,user:16000}};
  }
}
module.exports={LocalLlmApiAdapter,normalizeEndpoint};

'use strict';

/** Each adapter implements run({task,input,signal,onProgress}) and returns
 * validated structured output. Register adapters in main, never in renderer.
 * llm: mail -> {analyses:[{id,summary,priority,reason,evidence:[]}]}
 * llm: polish -> {text}; ocr: recognize -> {text};
 * llm: chat -> {text}; OCR also returns regions with coordinates and confidence.
 * whisper: transcribe -> {segments:[{start,end,text}],language}.
 * OCR is a logical pipeline; a Hailo adapter may own detector + recognizer HEFs.
 */
class ModelUnavailableError extends Error {
  constructor(kind,source) {
    super((source==='cloud'?'雲端':source==='local'?'本地':'')+({llm:'LLM 文字模型',ocr:'OCR 辨識模型',whisper:'Whisper 語音模型'}[kind] || kind)+'尚未接入。資料已保留，可稍後再處理。');
    this.code='MODEL_NOT_CONFIGURED'; this.name='ModelUnavailableError';
  }
}
const KINDS=['llm','ocr','whisper'];
function modelSource(value='local'){
  if(!['local','cloud'].includes(value))throw Object.assign(new Error('請選擇本地或雲端來源。'),{code:'MODEL_INVALID_SOURCE'});
  return value;
}
// Legacy adapter fixtures and older saved settings can still describe PC APIs
// with compute=dev-api. New app settings use only the local backend selector.
function localApiEnabled(settings={}){return settings.localBackend!==undefined?settings.localBackend==='pc-api':settings.compute==='dev-api';}
class ModelAdapters {
  constructor(){this.adapters=new Map();this.sourceAdapters={local:this.adapters,cloud:new Map()};}
  register(kind,adapter,{source='local'}={}){modelSource(source);if(!KINDS.includes(kind)||typeof adapter?.run!=='function')throw new TypeError('Invalid adapter');this.sourceAdapters[source].set(kind,adapter);}
  get(kind,source='local'){return this.sourceAdapters[modelSource(source)].get(kind);}
  status(){
    const sources=Object.fromEntries(['local','cloud'].map(source=>[source,Object.fromEntries(KINDS.map(kind=>{
      const adapter=this.get(kind,source);let configured=false;
      try{configured=!!adapter&&(typeof adapter.isConfigured!=='function'||!!adapter.isConfigured());}catch{/* An unavailable credential store is an unconfigured source. */}
      return[kind,{configured}];
    }))]));
    return{...sources.local,sources};
  }
  async run(kind,request={}){
    const source=modelSource(request.source),adapter=this.get(kind,source);
    if(!adapter)throw new ModelUnavailableError(kind,source);
    // No lookup of a global compute mode and no fallback to another source.
    const result=await adapter.run({...request,source});
    if(result&&typeof result==='object'&&!Array.isArray(result))return{...result,meta:{...result.meta,source}};
    return result;
  }
}
module.exports={ModelAdapters,ModelUnavailableError,modelSource,localApiEnabled};

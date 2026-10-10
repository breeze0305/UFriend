'use strict';
const {restoredSource,selectedSource,trackModelRun}=require('./model-source.cjs');

const LANGUAGES=new Set(['zh-TW','zh-CN','en','ja','ko','es','fr','de']);
const emptyTranslation=()=>({source:'local',input:'',sourceLanguage:'auto',targetLanguage:'zh-TW',output:'',status:'empty',error:'',revision:0});
function initializeTranslation(state){
  state.translation={...emptyTranslation(),...(state.translation&&typeof state.translation==='object'&&!Array.isArray(state.translation)?state.translation:{})};
  const current=state.translation;
  current.source=restoredSource(current.source);
  if(typeof current.input!=='string')current.input='';
  if(typeof current.output!=='string')current.output='';
  if(current.sourceLanguage!=='auto'&&!LANGUAGES.has(current.sourceLanguage))current.sourceLanguage='auto';
  if(!LANGUAGES.has(current.targetLanguage))current.targetLanguage='zh-TW';
  if(!Number.isSafeInteger(current.revision))current.revision=0;
  if(current.status==='running'){current.status='cancelled';current.error='上次翻譯已中斷，原文已保留，可重新開始。';current.revision++;}
}
function waitFor(work,signal){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(callback,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',cancel);callback(value);};
    const cancel=()=>finish(reject,Object.assign(new Error('已取消翻譯。'),{name:'AbortError'}));
    if(signal.aborted){cancel();return;}signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(work).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}
const translationMethods={
  saveTranslation(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('翻譯設定格式錯誤。');
    if(patch.input!==undefined&&(typeof patch.input!=='string'||patch.input.length>16000))throw new Error('翻譯原文最多 16,000 字元。');
    if(patch.sourceLanguage!==undefined&&patch.sourceLanguage!=='auto'&&!LANGUAGES.has(patch.sourceLanguage))throw new Error('來源語言不支援。');
    if(patch.targetLanguage!==undefined&&!LANGUAGES.has(patch.targetLanguage))throw new Error('請選擇有效的目標語言。');
    const current=this.store.read().translation,keys=['input','sourceLanguage','targetLanguage'];
    if(!keys.some(key=>patch[key]!==undefined&&patch[key]!==current[key]))return this.snapshot();
    this.active.get('translation')?.abort();this.active.delete('translation');
    return this.change(state=>{
      const next=state.translation;for(const key of keys)if(patch[key]!==undefined)next[key]=patch[key];
      next.output='';next.error='';next.status=next.input.trim()?'waiting-model':'empty';next.revision++;delete next.meta;
    },null);
  },
  cancelTranslation(){
    this.active.get('translation')?.abort();this.active.delete('translation');
    if(this.store.read().translation.status!=='running')return this.snapshot();
    return this.change(state=>{state.translation.status='cancelled';state.translation.error='';state.translation.revision++;},'已取消翻譯');
  },
  async runTranslation(source){
    const input=this.store.read().translation;
    source=selectedSource(source,input.source);
    if(this.active.has('translation'))throw new Error('正在翻譯，請等候完成或取消。');
    if(!input.input.trim())throw new Error('請先輸入要翻譯的文字。');
    const controller=trackModelRun(new AbortController(),'llm',source);this.active.set('translation',controller);
    const current=()=>!controller.signal.aborted&&this.active.get('translation')===controller&&this.store.read().translation.revision===input.revision;
    try{this.change(state=>{Object.assign(state.translation,{source,status:'running',output:'',error:''});delete state.translation.meta;},'開始翻譯','','started');}
    catch(error){controller.abort();if(this.active.get('translation')===controller)this.active.delete('translation');throw error;}
    try{
      const result=await waitFor(()=>this.models.run('llm',{task:'translate',source,input:{text:input.input,sourceLanguage:input.sourceLanguage,targetLanguage:input.targetLanguage},signal:controller.signal}),controller.signal);
      if(!current())return this.snapshot();
      if(!result||typeof result.text!=='string'||!result.text.trim()||result.text.length>16000)throw Object.assign(new Error('模型沒有回傳完整的翻譯文字。'),{code:'MODEL_INVALID_OUTPUT'});
      const meta={source};for(const key of ['model','backend'])if(typeof result.meta?.[key]==='string'&&result.meta[key].length<=250)meta[key]=result.meta[key];
      this.change(state=>{Object.assign(state.translation,{output:result.text.trim(),status:'done',error:'',meta});},'翻譯完成');
    }catch(error){
      if(!current())return this.snapshot();
      const message=error.code==='MODEL_INPUT_TOO_LONG'?'原文超過模型的上下文容量，請分段翻譯。':String(error.message||'翻譯未完成，請稍後再試。').slice(0,500);
      this.change(state=>{state.translation.status=error.code==='MODEL_NOT_CONFIGURED'?'waiting-model':'error';state.translation.error=message;},'翻譯未完成','',error.code==='MODEL_NOT_CONFIGURED'?'blocked':'error');
    }finally{if(this.active.get('translation')===controller)this.active.delete('translation');}
    return this.snapshot();
  },
};
module.exports={initializeTranslation,translationMethods};

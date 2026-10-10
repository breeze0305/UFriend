'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const addressparser=require('nodemailer/lib/addressparser');
const {parseEml}=require('./mail-util.cjs');
const {safeName,fileType,mimeType,digest,parseSrt,validateSegments}=require('./formats.cjs');
const {initializeChat,chatMethods,overlayChatStream}=require('./chat.cjs');
const {initializeTranslation,translationMethods}=require('./translation.cjs');
const {initializeRecordingQueue,clearRecordingSchedule,recordingQueueMethods}=require('./recording-queue.cjs');
const {validatePromptOverrides}=require('./llm-prompts.cjs');
const {preferredLanguage}=require('./llm-context.cjs');
const {DEFAULT_UI_LANGUAGE,normalizeUiLanguage}=require('./ui-language.cjs');
const {emptyProfile,normalizeProfile,profileContext}=require('./personal-profile.cjs');
const {modelSource,restoredSource,selectedSource,defaultModelSource,modelDefaults,trackModelRun,matchingModelRun}=require('./model-source.cjs');
const {validMailCategory}=require('./mail-categories.cjs');
const {prepareMailAnalysisInput}=require('./mail-analysis-input.cjs');
const {getMailContentContext,splitMailThread}=require('./mail-content-context.cjs');
const {applyMailQuality}=require('./mail-quality.cjs');
const {traditionalMailAnalysis}=require('./mail-output-language.cjs');
const {mailSchedule,DEFAULT_MAIL_SCHEDULE,DEFAULT_MAIL_SCHEDULE_STATE}=require('./mail-scheduler.cjs');

const DEFAULT_SETTINGS={theme:'system',localBackend:'pc-api',uiLanguage:DEFAULT_UI_LANGUAGE,preferredLanguage:'zh-TW',keepBackground:true,syncMinutes:5,initialDays:30,api:{endpoint:'',model:'',ocrModel:'',transcriptionModel:'',temperature:null},devLlm:{endpoint:'http://127.0.0.1:8765'},devOcr:{endpoint:'http://127.0.0.1:8767'},devWhisper:{endpoint:'http://127.0.0.1:8768'},gmailClientId:'',ocrAuto:false,policy:{mode:'resident',preferred:'llm',idleMs:300000}};
const LANGUAGES=new Set(['auto','zh-TW','zh','en','ja','ko','es','fr','de']);
DEFAULT_SETTINGS.modelDefaults={llm:'local',ocr:'local',whisper:'local'};
DEFAULT_SETTINGS.mailSchedule={...DEFAULT_MAIL_SCHEDULE};
const MAIL_ANALYSIS_DEFAULT={source:'local',status:'idle',processed:0,total:0,failed:0,skipped:0,error:''};
// Bump when input preparation or local mail quality rules change so both
// completed analyses and partially classified summaries are rebuilt once.
const MAIL_ANALYSIS_REVISION=9;
const MAIL_REPLY_SUBJECT=/^\s*(?:re|fw|fwd|回覆|回复|答覆|答复|轉寄|转发)(?:\s*\[\d+\])?\s*[:：]/i;
const MAIL_DAY_FORMAT=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function cloudApiConfig(patch,current=DEFAULT_SETTINGS.api){
  if(!object(patch))throw new Error('雲端 API 設定格式錯誤。');
  const next={...DEFAULT_SETTINGS.api,...current};
  if(Object.hasOwn(patch,'endpoint')){
    if(typeof patch.endpoint!=='string'||patch.endpoint.length>2048||/[\x00-\x1f\x7f]/.test(patch.endpoint))throw new Error('API 端點格式錯誤。');
    const value=patch.endpoint.trim();
    if(value){
      let url;try{url=new URL(value);}catch{throw new Error('API 端點格式錯誤。');}
      if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('API 端點須為 HTTPS，或本機 HTTP 位址。');
      if(url.username||url.password||value.includes('?')||value.includes('#'))throw new Error('API 端點不可包含帳密、查詢參數或片段。');
      next.endpoint=url.href.replace(/\/+$/,'');
    }else next.endpoint='';
  }
  for(const key of ['model','ocrModel','transcriptionModel'])if(Object.hasOwn(patch,key)){
    if(typeof patch[key]!=='string'||patch[key].length>250||/[\x00-\x1f\x7f]/.test(patch[key]))throw new Error('雲端模型名稱格式錯誤。');
    next[key]=patch[key].trim();
  }
  if(Object.hasOwn(patch,'temperature')){
    if(patch.temperature!==null&&(typeof patch.temperature!=='number'||!Number.isFinite(patch.temperature)||patch.temperature<0||patch.temperature>2))throw new Error('Temperature 必須使用服務預設，或介於 0 與 2。');
    next.temperature=patch.temperature;
  }
  return next;
}
function restoredCloudApi(value){
  let restored={...DEFAULT_SETTINGS.api};
  for(const key of Object.keys(DEFAULT_SETTINGS.api))if(object(value)&&Object.hasOwn(value,key))try{restored=cloudApiConfig({[key]:value[key]},restored);}catch{/* Invalid legacy fields revert independently. */}
  return restored;
}
function devLlmEndpoint(value){
  if(typeof value!=='string'||!value.trim()||value.length>2048)throw new Error('PC 模型 API 位址格式錯誤。');
  let url;try{url=new URL(value.trim());}catch{throw new Error('PC 模型 API 位址格式錯誤。');}
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('PC 模型 API 只允許本機 HTTP 位址。');
  if(url.username||url.password||value.includes('?')||value.includes('#'))throw new Error('PC 模型 API 位址不可包含帳密、查詢參數或片段。');
  return url.href.replace(/\/+$/,'');
}
function abortedError(){return Object.assign(new Error('已取消模型處理。'),{name:'AbortError',code:'MODEL_CANCELLED'});}
function abortable(work,signal){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(callback,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',cancel);callback(value);};
    const cancel=()=>finish(reject,abortedError());
    if(signal.aborted){cancel();return;}
    signal.addEventListener('abort',cancel,{once:true});
    try{Promise.resolve(work()).then(value=>finish(resolve,value),error=>finish(reject,error));}catch(error){finish(reject,error);}
  });
}
function emailAddress(value){
  if(typeof value!=='string'||value.length>254)return'';
  const address=value.trim().toLowerCase();
  return /^[^\s@<>(),;:"\\\x00-\x1f\x7f]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address)?address:'';
}
function mailAddresses(value){
  if(typeof value!=='string'||/[\r\n\x00]/.test(value))return[];
  try{
    const pending=[...addressparser(value)],addresses=new Set();
    while(pending.length){const entry=pending.shift();if(Array.isArray(entry.group))pending.push(...entry.group);else{const address=emailAddress(entry.address);if(address)addresses.add(address);}}
    return[...addresses];
  }catch{return[];}
}
function mailRecipient(mail,accounts){return mail?emailAddress(accounts.find(account=>account.id===mail.accountId)?.email):'';}
function mailInput(mail){return{id:mail.id,subject:typeof mail.subject==='string'?mail.subject:'',body:typeof mail.body==='string'?mail.body:'',date:typeof mail.date==='string'?mail.date:'',sender:typeof mail.sender==='string'?mail.sender:'',senderEmail:emailAddress(mail.email),to:mailAddresses(mail.to),cc:mailAddresses(mail.cc),contentContext:getMailContentContext(mail)};}
function sameMail(mail,input,includeDone=false){return!!mail&&mail.folder==='inbox'&&(includeDone||!mail.done)&&JSON.stringify(mailInput(mail))===JSON.stringify(input);}
function sameMailContext(state,input,recipient,includeDone=false){const mail=state.messages.find(m=>m.id===input.id);return sameMail(mail,input,includeDone)&&mailRecipient(mail,state.accounts)===recipient;}
function mailReferenceDate(referenceTime){
  const parts=Object.fromEntries(MAIL_DAY_FORMAT.formatToParts(new Date(referenceTime)).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function mailFingerprint(input,recipient,settings,source,referenceDate){
  const model=source==='cloud'?{endpoint:settings.api.endpoint,model:settings.api.model,temperature:settings.api.temperature}:{backend:settings.localBackend,endpoint:settings.devLlm.endpoint};
  return digest(Buffer.from(JSON.stringify({version:MAIL_ANALYSIS_REVISION,input,recipient,source,model,prompt:settings.llmPrompts?.mail??null,profile:profileContext(settings.personalProfile),language:settings.preferredLanguage,referenceDate})));
}
function applyMailPriority(mail,analysis){
  if(mail.prioritySource==='manual')return;
  if(analysis.quality?.priorityReview===true){
    if(mail.prioritySource==='model'){delete mail.level;delete mail.prioritySource;}
    return;
  }
  mail.level=analysis.priority;mail.prioritySource='model';
}
function resetMailProgress(state,phase='',currentId=''){
  delete state.chunkIndex;delete state.chunkTotal;
  if(phase||Object.hasOwn(state,'phase'))state.phase=phase;
  if(currentId||Object.hasOwn(state,'currentId'))state.currentId=currentId;
}
function mailProgress(details){
  if(!object(details))return null;
  const phase=details.stage==='mail-chunks'?'chunking':details.stage==='mail-merge'?'merging':null;
  const {chunkIndex,chunkTotal}=details;
  if(!phase||!Number.isSafeInteger(chunkTotal)||chunkTotal<1||chunkTotal>128||!Number.isSafeInteger(chunkIndex)||chunkIndex<0||chunkIndex>chunkTotal)return null;
  return{phase,chunkIndex,chunkTotal};
}
function invalidAnalysis(message){return Object.assign(new Error(message),{code:'INVALID_MAIL_ANALYSIS'});}
function modelMeta(value,source){
  const meta=source===undefined?{}:{source};
  if(object(value))for(const key of ['model','backend'])if(typeof value[key]==='string'&&value[key].trim()&&value[key].length<=250)meta[key]=value[key].trim();
  if(value?.processingMode==='segmented'&&Number.isSafeInteger(value.chunkCount)&&value.chunkCount>=1&&value.chunkCount<=128)Object.assign(meta,{processingMode:'segmented',chunkCount:value.chunkCount});
  return Object.keys(meta).length?meta:undefined;
}
function validateMailAnalysis(result,input,source){
  if(!object(result)||!Array.isArray(result.analyses)||result.analyses.length!==1||!object(result.analyses[0]))throw invalidAnalysis('模型沒有回傳單封郵件的有效分析。');
  const analysis=result.analyses[0];
  if(analysis.id!==input.id)throw invalidAnalysis('模型回傳的郵件識別碼不符，結果未套用。');
  if(!Number.isInteger(analysis.priority)||![0,1,2].includes(analysis.priority))throw invalidAnalysis('模型回傳的優先程度無效，結果未套用。');
  for(const key of ['summary','reason'])if(typeof analysis[key]!=='string'||!analysis[key].trim()||analysis[key].length>2000)throw invalidAnalysis('模型回傳的摘要或理由無效，結果未套用。');
  if(!Array.isArray(analysis.evidence)||!analysis.evidence.length||analysis.evidence.length>8||analysis.evidence.some(fragment=>
    typeof fragment!=='string'||!fragment.trim()||fragment.length>1000||(!input.subject.includes(fragment)&&!input.body.includes(fragment))))throw invalidAnalysis('模型引用的證據不在郵件原文中，結果未套用。');
  const meta=modelMeta(result.meta,source);
  return{summary:analysis.summary.trim(),priority:analysis.priority,reason:analysis.reason.trim(),evidence:[...analysis.evidence],analyzedAt:new Date().toISOString(),...(meta?{meta}:{})};
}
const failureText=error=>typeof error?.message==='string'&&error.message.trim()?error.message.trim().slice(0,500):'模型未能完成處理，請稍後再試。';
class AppService {
  constructor({store,dataDir,models,onChange=()=>{}}){this.store=store;this.dataDir=dataDir;this.models=models;this.onChange=onChange;this.active=new Map();this.initialize();}
  initialize(){
    this.stopRecordingScheduler();
    for(const controller of this.active.values())controller.abort();this.active.clear();
    this.store.update(d=>{
      const localBackend=['pc-api','ugen300'].includes(d.settings?.localBackend)?d.settings.localBackend:d.settings?.compute==='local'?'ugen300':'pc-api';
      d.settings={...DEFAULT_SETTINGS,...d.settings,localBackend,api:restoredCloudApi(d.settings?.api),devLlm:{...DEFAULT_SETTINGS.devLlm,...d.settings?.devLlm},policy:{...DEFAULT_SETTINGS.policy,...d.settings?.policy}};
      delete d.settings.compute;
      d.settings.modelDefaults=Object.fromEntries(['llm','ocr','whisper'].map(kind=>[kind,defaultModelSource(d.settings,kind)]));
      try{d.settings.mailSchedule=mailSchedule(d.settings.mailSchedule??{});}catch{d.settings.mailSchedule={...DEFAULT_MAIL_SCHEDULE};}
      d.mailScheduleState={...DEFAULT_MAIL_SCHEDULE_STATE,...(object(d.mailScheduleState)?d.mailScheduleState:{})};
      if(d.mailScheduleState.status==='running'){d.mailScheduleState.status='cancelled';d.mailScheduleState.error='上次自動郵件整理已中斷，可手動重新整理。';}
      try{d.settings.devLlm={endpoint:devLlmEndpoint(d.settings.devLlm.endpoint)};}catch{d.settings.devLlm={...DEFAULT_SETTINGS.devLlm};}
      for(const key of ['devOcr','devWhisper']){try{d.settings[key]={endpoint:devLlmEndpoint(d.settings[key]?.endpoint||DEFAULT_SETTINGS[key].endpoint)};}catch{d.settings[key]={...DEFAULT_SETTINGS[key]};}}
      initializeChat(d);
      initializeTranslation(d);
      try{d.settings.llmPrompts=validatePromptOverrides(d.settings.llmPrompts||{});}catch{d.settings.llmPrompts={};}
      try{d.settings.uiLanguage=normalizeUiLanguage(d.settings.uiLanguage);}catch{d.settings.uiLanguage=DEFAULT_UI_LANGUAGE;}
      try{d.settings.preferredLanguage=preferredLanguage(d.settings.preferredLanguage);}catch{d.settings.preferredLanguage=DEFAULT_SETTINGS.preferredLanguage;}
      try{d.settings.personalProfile=normalizeProfile(d.settings.personalProfile??emptyProfile());}catch{d.settings.personalProfile=emptyProfile();}
      d.messages??=[];d.recordings??=[];d.assets??=[];d.drafts??=[];
      // Before model analysis existed, an assigned level could only be a manual choice.
      for(const mail of d.messages)if(!mail.prioritySource&&[0,1,2].includes(mail.level))mail.prioritySource='manual';
      d.ocr??={imageId:null,text:'',status:'empty',revision:0};d.polish??={input:'',use:'email',tone:'polite',output:'',status:'empty',revision:0};
      if(typeof d.ocr.source==='string'&&!['local','cloud'].includes(d.ocr.source)&&!d.ocr.imageName)d.ocr.imageName=d.ocr.source;
      for(const job of [d.ocr,d.polish])job.source=restoredSource(job.source);
      for(const job of [d.ocr,d.polish])if(['running','queued','loading'].includes(job.status)){job.status='waiting-model';job.error='上次處理已中斷，可重新開始。';job.revision++;}
      d.mailAnalysis={...MAIL_ANALYSIS_DEFAULT,...(object(d.mailAnalysis)?d.mailAnalysis:{})};
      d.mailAnalysis.source=restoredSource(d.mailAnalysis.source);
      if(d.mailAnalysis.status==='running'){d.mailAnalysis.status='cancelled';d.mailAnalysis.error='上次郵件分析已中斷，已保存的結果仍保留，可重新開始。';}
      resetMailProgress(d.mailAnalysis);
      for(const recording of d.recordings)recording.source=restoredSource(recording.source);
      initializeRecordingQueue(d);
    });
  }
  snapshot(){const d=overlayChatStream(this.store.read(),this.chatStream);for(const mail of d.messages)if(mail.analysis)mail.analysis=traditionalMailAnalysis(mail.analysis);return{...d,models:this.models.status()};}
  change(mutator,text,detail='',status='success'){this.store.update(mutator);if(text)this.store.appendLog(text,detail,status);this.onChange();return this.snapshot();}
  setTaskSource(kind,value){
    const source=modelSource(value);
    if(kind==='chat')return this.setChatSource(source);
    const tasks={mail:['mailAnalysis','cancelMailAnalysis'],ocr:['ocr','cancelOcr'],polish:['polish','cancelPolish'],translation:['translation','cancelTranslation']};
    const task=Object.hasOwn(tasks,kind)?tasks[kind]:null;
    if(!task)throw new Error('模型工作類型錯誤。');
    if(this.store.read()[task[0]].source===source)return this.snapshot();
    this[task[1]]();
    return this.change(d=>{d[task[0]].source=source;},null);
  }
  cancelModelRuns(source,kinds){
    const cancel={chat:'cancelChat',translation:'cancelTranslation',polish:'cancelPolish','mail-analysis':'cancelMailAnalysis',ocr:'cancelOcr'};
    for(const [key,controller] of [...this.active]){
      if(!matchingModelRun(controller,source,kinds))continue;
      if(key.startsWith('recording:'))this.pauseRecording(key.slice(10));else if(cancel[key])this[cancel[key]]();
    }
  }
  settings(patch){
    if(!object(patch))throw new Error('設定格式錯誤。');const allowed={};
    if(patch.theme!==undefined){if(!['light','dark','system'].includes(patch.theme))throw new Error('外觀設定錯誤。');allowed.theme=patch.theme;}
    if(Object.hasOwn(patch,'uiLanguage'))allowed.uiLanguage=normalizeUiLanguage(patch.uiLanguage);
    if(patch.preferredLanguage!==undefined)allowed.preferredLanguage=preferredLanguage(patch.preferredLanguage);
    if(patch.personalProfile!==undefined)allowed.personalProfile=normalizeProfile(patch.personalProfile);
    if(Object.hasOwn(patch,'compute'))throw new Error('模型來源不再使用全域設定，請在每個工作中選擇本地或雲端。');
    if(Object.hasOwn(patch,'localBackend')){if(!['pc-api','ugen300'].includes(patch.localBackend))throw new Error('本地模型連線類型錯誤。');allowed.localBackend=patch.localBackend;}
    for(const k of ['keepBackground','ocrAuto'])if(patch[k]!==undefined)allowed[k]=!!patch[k];
    for(const k of ['syncMinutes','initialDays'])if(patch[k]!==undefined){const n=Number(patch[k]);if(!Number.isInteger(n)||n<1||n>(k==='initialDays'?3650:1440))throw new Error('同步時間設定超出範圍。');allowed[k]=n;}
    if(patch.gmailClientId!==undefined)allowed.gmailClientId=String(patch.gmailClientId).trim().slice(0,250);
    if(Object.hasOwn(patch,'api'))allowed.api=cloudApiConfig(patch.api,this.store.read().settings.api);
    if(Object.hasOwn(patch,'modelDefaults'))allowed.modelDefaults=modelDefaults(patch.modelDefaults,this.store.read().settings.modelDefaults);
    if(Object.hasOwn(patch,'mailSchedule'))allowed.mailSchedule=mailSchedule(patch.mailSchedule,this.store.read().settings.mailSchedule);
    if(patch.devLlm!==undefined){if(!object(patch.devLlm))throw new Error('PC 模型 API 設定格式錯誤。');allowed.devLlm={endpoint:devLlmEndpoint(patch.devLlm.endpoint)};}
    if(patch.llmPrompts!==undefined)allowed.llmPrompts=validatePromptOverrides(patch.llmPrompts);
    for(const key of ['devOcr','devWhisper'])if(patch[key]!==undefined){if(!object(patch[key]))throw new Error('PC 模型 API 設定格式錯誤。');const value=devLlmEndpoint(patch[key].endpoint);if(new URL(value).pathname!=='/')throw new Error('OCR 與 Whisper 端點請填本機 HTTP 根位址。');allowed[key]={endpoint:value};}
    if(patch.policy){const p=patch.policy;if(!['resident','preferred','offload'].includes(p.mode)||!['llm','ocr','whisper'].includes(p.preferred)||!Number.isFinite(p.idleMs)||p.idleMs<1000||p.idleMs>86400000)throw new Error('模型策略或閒置時間不正確。');allowed.policy={mode:p.mode,preferred:p.preferred,idleMs:p.idleMs};}
    const current=this.store.read().settings;
    if(allowed.preferredLanguage!==undefined&&allowed.preferredLanguage!==current.preferredLanguage)this.cancelChat();
    if(allowed.personalProfile!==undefined&&JSON.stringify(profileContext(allowed.personalProfile))!==JSON.stringify(profileContext(current.personalProfile))){this.cancelChat();this.cancelPolish();this.cancelMailAnalysis();}
    if(allowed.llmPrompts)for(const [task,cancel] of Object.entries({mail:'cancelMailAnalysis',polish:'cancelPolish',chat:'cancelChat',translate:'cancelTranslation'}))if(JSON.stringify(allowed.llmPrompts[task])!==JSON.stringify(current.llmPrompts?.[task]))this[cancel]();
    const changed=key=>allowed[key]!==undefined&&JSON.stringify(allowed[key])!==JSON.stringify(current[key]);
    if(changed('localBackend'))this.cancelModelRuns('local',['llm','ocr','whisper']);
    for(const [setting,kind] of Object.entries({devLlm:'llm',devOcr:'ocr',devWhisper:'whisper'}))if(changed(setting))this.cancelModelRuns('local',[kind]);
    if(changed('api')){
      const fields=['endpoint','model','ocrModel','transcriptionModel','temperature'].filter(key=>allowed.api[key]!==current.api[key]);
      const kinds=new Set();
      if(fields.includes('endpoint'))for(const kind of ['llm','ocr','whisper'])kinds.add(kind);
      if(fields.some(key=>['model','temperature'].includes(key)))kinds.add('llm');
      if(fields.some(key=>['ocrModel','temperature'].includes(key)))kinds.add('ocr');
      if(fields.includes('transcriptionModel'))kinds.add('whisper');
      this.cancelModelRuns('cloud',[...kinds]);
    }
    return this.change(d=>Object.assign(d.settings,allowed),'更新設定');
  }
  async ingestAsset(source,{category='attachment',limit=200*1024*1024}={}){const st=await fs.stat(source);if(!st.isFile()||st.size===0||st.size>limit)throw new Error(`檔案必須非空白，且小於 ${Math.round(limit/1024/1024)} MB。`);const name=safeName(source),id=randomUUID(),ext=path.extname(name).toLowerCase();const file=path.join(this.dataDir,'files',id+ext);await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(source,file);const asset={id,name,file:id+ext,size:st.size,mimeType:mimeType(name),category,createdAt:new Date().toISOString()};try{this.store.update(d=>d.assets.push(asset));}catch(e){await fs.unlink(file).catch(()=>{});throw e;}return asset;}
  async ingestBuffer(buffer,{name='clipboard.png',category='ocr',mime='image/png'}={}){if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>40*1024*1024)throw new Error('圖片必須小於 40 MB。');const id=randomUUID(),file=id+path.extname(safeName(name));await fs.mkdir(path.join(this.dataDir,'files'),{recursive:true});await fs.writeFile(path.join(this.dataDir,'files',file),buffer);const asset={id,name:safeName(name),file,size:buffer.length,mimeType:mime,category,hash:digest(buffer),createdAt:new Date().toISOString()};try{this.store.update(d=>d.assets.push(asset));}catch(e){await fs.unlink(path.join(this.dataDir,'files',file)).catch(()=>{});throw e;}return asset;}
  asset(id){const a=this.store.read().assets.find(a=>a.id===id);if(!a)throw new Error('找不到來源檔案。');const full=path.resolve(this.dataDir,'files',a.file);if(path.dirname(full)!==path.resolve(this.dataDir,'files'))throw new Error('來源路徑錯誤。');return{...a,path:full};}
  async importMails(paths){
    if(!Array.isArray(paths)||paths.length>200)throw new Error('每次最多匯入 200 封郵件。');
    let added=0,duplicate=0,updated=0;const errors=[];
    for(const source of paths){
      try{
        if(path.extname(source).toLowerCase()!=='.eml')throw new Error('請選擇 .eml 郵件檔。');
        const stat=await fs.stat(source);if(!stat.isFile()||stat.size>30*1024*1024)throw new Error('郵件檔必須小於 30 MB。');
        const buffer=await fs.readFile(source),hash=digest(buffer),existing=this.store.read().messages.find(m=>m.localHash===hash);
        if(existing?.htmlVersion===1){duplicate++;continue;}
        const parsed=await parseEml(buffer,{accountId:'local'}),attachments=[];
        for(const [index,attachment] of (parsed.attachments||[]).entries()){
          const previous=existing?.attachments?.[index];
          const metadata={contentId:attachment.contentId,contentDisposition:attachment.contentDisposition,inline:!!attachment.inline};
          if(previous?.assetId){attachments.push({...previous,...metadata});continue;}
          if(attachment.content){
            const asset=await this.ingestBuffer(Buffer.isBuffer(attachment.content)?attachment.content:Buffer.from(attachment.content,'base64'),{name:attachment.name,category:'attachment',mime:attachment.mimeType});
            attachments.push({name:asset.name,mimeType:asset.mimeType,size:asset.size,assetId:asset.id,...metadata});
          }
        }
        this.store.update(state=>{
          if(existing){const current=state.messages.find(item=>item.id===existing.id);if(current){current.html=parsed.html;current.htmlVersion=parsed.htmlVersion;current.attachments=attachments;}}
          else state.messages.push({...parsed,id:'local:'+hash,accountId:'local',source:'本機',localHash:hash,attachments,read:false,star:false,folder:'inbox',labels:[],done:false,level:null,analysis:null});
        });
        if(existing){duplicate++;updated++;}else added++;
      }catch(error){errors.push({name:safeName(source),message:error.message});}
    }
    this.store.appendLog('匯入本機郵件',String(added)+' 封新增、'+duplicate+' 封重複、'+errors.length+' 封失敗',errors.length?'partial':'success');
    this.onChange();return{added,duplicate,errors,...(updated?{updated}:{} )};
  }
  updateLocalMessages(ids,patch){const allowed={};for(const k of ['read','star','done'])if(patch[k]!==undefined)allowed[k]=!!patch[k];if(patch.level!==undefined){if(patch.level!==null&&![0,1,2].includes(patch.level))throw new Error('優先程度錯誤。');allowed.level=patch.level;allowed.prioritySource='manual';}if(patch.folder!==undefined){if(!['inbox','archive','trash','spam','sent','drafts'].includes(patch.folder))throw new Error('郵件資料夾錯誤。');allowed.folder=patch.folder;}if(patch.labels!==undefined){if(!Array.isArray(patch.labels)||patch.labels.length>50)throw new Error('標籤格式錯誤。');allowed.labels=patch.labels.map(v=>String(v).trim().slice(0,60)).filter(Boolean);}return this.change(d=>{for(const id of ids){const m=d.messages.find(m=>m.id===id);if(m)Object.assign(m,allowed);}},'更新郵件',`${ids.length} 封`);}
  async importMedia(paths,language='zh-TW',source='local'){
    modelSource(source);
    if(this.mediaClearing)throw Object.assign(new Error('正在刪除會議檔案，請稍後再匯入。'),{code:'MEDIA_BUSY'});
    this.mediaImports=(this.mediaImports||0)+1;this.onChange();
    try{return await this._importMedia(paths,language,source);}finally{this.mediaImports--;this.onChange();}
  }
  async _importMedia(paths,language='zh-TW',source='local'){const executionSource=modelSource(source);if(!LANGUAGES.has(language))throw new Error('不支援的語言。');if(!Array.isArray(paths)||paths.length>30)throw new Error('每次最多匯入 30 個影音檔。');const imported=[],errors=[];for(const source of paths){try{const type=fileType(source);if(!['audio','video'].includes(type))throw new Error('不支援這個影音副檔名。');const asset=await this.ingestAsset(source,{category:'recording',limit:2*1024*1024*1024});const recording={id:randomUUID(),name:asset.name,assetId:asset.id,type,source:executionSource,lang:language,size:asset.size,duration:null,progress:0,state:'waiting-model',segments:[],textOnly:null,transcriptSource:null,createdAt:new Date().toISOString(),error:''};this.store.update(d=>{d.assets.find(item=>item.id===asset.id).mediaType=type;d.recordings.unshift(recording);});imported.push(recording.id);}catch(e){errors.push({name:safeName(source),message:e.message});}}this.store.appendLog('匯入會議影音',`${imported.length} 個新增、${errors.length} 個失敗`,errors.length?'partial':'success');this.onChange();return{imported,errors};}
  updateRecording(id,patch){
    if(!object(patch))throw new Error('會議設定格式錯誤。');
    const current=this.store.read().recordings.find(recording=>recording.id===id);if(!current)throw new Error('找不到會議紀錄。');
    if(Object.hasOwn(patch,'source'))modelSource(patch.source);
    if(patch.lang!==undefined&&!LANGUAGES.has(patch.lang))throw new Error('語言格式錯誤。');
    const sourceChanged=patch.source!==undefined&&patch.source!==selectedSource(undefined,current.source);
    if(sourceChanged&&(this.active.has('recording:'+id)||['running','queued','scheduled','loading'].includes(current.state))||patch.lang!==undefined&&patch.lang!==current.lang&&this.active.has('recording:'+id))this.pauseRecording(id);
    return this.change(d=>{const r=d.recordings.find(r=>r.id===id);if(patch.source!==undefined)r.source=patch.source;if(patch.lang!==undefined)r.lang=patch.lang;if(patch.name!==undefined)r.name=safeName(patch.name);if(patch.duration!==undefined&&Number.isFinite(patch.duration)&&patch.duration>0)r.duration=patch.duration;},null);
  }
  saveTranscript(id,{format,text}){if(typeof text!=='string'||text.length>2000000)throw new Error('逐字稿太長。');if(!['srt','txt'].includes(format))throw new Error('請選擇 SRT 或 TXT 格式。');const segments=format==='srt'?parseSrt(text):[];this.active.get('recording:'+id)?.abort();this.active.delete('recording:'+id);const result=this.change(d=>{const r=d.recordings.find(r=>r.id===id);if(!r)throw new Error('找不到會議紀錄。');r.segments=segments;r.textOnly=format==='txt'&&text.trim()?text:null;r.state=text.trim()?'done':'waiting-model';r.progress=text.trim()?100:0;r.transcriptSource=text.trim()?'manual':null;r.error='';clearRecordingSchedule(r);},'保存人工逐字稿');this.wakeRecordingScheduler();return result;}
  removeRecording(id){this.active.get('recording:'+id)?.abort();this.active.delete('recording:'+id);const result=this.change(d=>{d.recordings=d.recordings.filter(r=>r.id!==id);},'移除會議紀錄');this.wakeRecordingScheduler();return result;}
  async runRecording(id,{fromQueue=false}={}){
    if(this.mediaClearing)throw Object.assign(new Error('正在刪除會議檔案，請稍後再轉錄。'),{code:'MEDIA_BUSY'});
    const recording=this.store.read().recordings.find(r=>r.id===id);if(!recording)throw new Error('找不到會議紀錄。');
    const source=selectedSource(undefined,recording.source);
    if(recording.segments?.length||recording.textOnly)throw new Error('已有逐字稿，請先清空內容再重新轉錄。');
    const queueIntent=fromQueue&&['queued','scheduled'].includes(recording.state)?{queuedAt:recording.queuedAt,queueOrder:recording.queueOrder,scheduledAt:recording.scheduledAt}:null;
    const key='recording:'+id,controller=trackModelRun(new AbortController(),'whisper',source);this.active.get(key)?.abort();this.active.set(key,controller);
    const current=()=>!controller.signal.aborted&&this.active.get(key)===controller;
    try{this.change(d=>{const r=d.recordings.find(r=>r.id===id);Object.assign(r,{source,state:'running',error:'',progress:0,processedSeconds:0});clearRecordingSchedule(r);},queueIntent&&recording.queueRetryAt?null:'開始語音轉錄','','started');}
    catch(error){if(this.active.get(key)===controller)this.active.delete(key);throw error;}
    try{
      const result=await abortable(()=>{const work=Promise.resolve(this.models.run('whisper',{
        task:'transcribe',source,input:{filePath:this.asset(recording.assetId).path,language:recording.lang},signal:controller.signal,
        onProgress:(progress,details={})=>{
          if(!current())return;
          const percentage=Math.min(99,Math.max(0,Number(progress)||0));
          const latest=this.store.read().recordings.find(r=>r.id===id);
          if(!latest||Math.floor(latest.progress||0)===Math.floor(percentage)&&latest.processedSeconds===details.processedSeconds)return;
          this.change(d=>{const r=d.recordings.find(r=>r.id===id);if(r){r.progress=Math.max(r.progress||0,percentage);if(Number.isFinite(details.processedSeconds))r.processedSeconds=details.processedSeconds;if(Number.isFinite(details.durationSeconds))r.duration=details.durationSeconds;}},null);
        },
      }));this.recordingModelWork??=new Set();this.recordingModelWork.add(work);const settled=()=>{this.recordingModelWork.delete(work);this.wakeRecordingScheduler();};work.then(settled,settled);return work;},controller.signal);
      if(!current())return this.snapshot();
      const segments=validateSegments(result.segments),meta=modelMeta(result.meta,source);
      this.change(d=>{const r=d.recordings.find(r=>r.id===id);if(r)Object.assign(r,{segments,textOnly:null,state:segments.length?'done':'no-speech',progress:100,transcriptSource:'model',error:'',...(Number.isFinite(result.duration)?{duration:result.duration,processedSeconds:result.duration}:{}),...(meta?{meta}:{}),detectedLanguage:typeof result.language==='string'?result.language:''});},segments.length?'語音轉錄完成':'語音辨識完成：沒有語音');
    }catch(error){
      if(!current())return this.snapshot();
      if(queueIntent&&error.code==='MODEL_API_BUSY')return this.waitForRecordingService(id,queueIntent,{logWait:!recording.queueRetryAt});
      this.change(d=>{const r=d.recordings.find(r=>r.id===id);if(r){r.state=error.code==='MODEL_NOT_CONFIGURED'?'waiting-model':'error';r.error=failureText(error);if(Number.isFinite(error.processedSeconds))r.processedSeconds=error.processedSeconds;}},error.code==='MODEL_NOT_CONFIGURED'?'等待語音模型':'語音轉錄失敗','',error.code==='MODEL_NOT_CONFIGURED'?'blocked':'error');
    }finally{if(this.active.get(key)===controller)this.active.delete(key);this.wakeRecordingScheduler();}
    return this.snapshot();
  }
  pauseRecording(id){this.active.get('recording:'+id)?.abort();this.active.delete('recording:'+id);const result=this.change(d=>{const r=d.recordings.find(r=>r.id===id);if(r){if(r.state!=='done')r.state='paused';if(r.queueRetryAt)r.error='';clearRecordingSchedule(r);}},'暫停語音轉錄');this.wakeRecordingScheduler();return result;}
  async setOcrImage(asset){this.active.get('ocr')?.abort();return this.change(d=>{d.ocr={imageId:asset.id,text:'',imageName:asset.name,source:restoredSource(d.ocr.source),status:'waiting-model',revision:d.ocr.revision+1,error:''};},'接收 OCR 圖片');}
  cancelOcr(){
    this.active.get('ocr')?.abort();this.active.delete('ocr');
    if(this.store.read().ocr.status!=='running')return this.snapshot();
    return this.change(d=>{d.ocr.status='cancelled';d.ocr.error='';d.ocr.revision++;},'已取消文字識別');
  }
  async runOcr(source,{preserveSelection=false}={}){
    const input=this.store.read().ocr;
    source=selectedSource(source,input.source);
    if(!input.imageId)throw new Error('請先匯入或擷取圖片。');
    const controller=trackModelRun(new AbortController(),'ocr',source);this.active.get('ocr')?.abort();this.active.set('ocr',controller);
    const current=()=>!controller.signal.aborted&&this.active.get('ocr')===controller&&this.store.read().ocr.revision===input.revision;
    try{this.change(d=>{if(!preserveSelection)d.ocr.source=source;d.ocr.runningSource=source;d.ocr.status='running';d.ocr.error='';d.ocr.progress=0;},'開始文字識別','','started');}
    catch(error){controller.abort();if(this.active.get('ocr')===controller)this.active.delete('ocr');throw error;}
    try{
      const result=await abortable(()=>this.models.run('ocr',{task:'recognize',source,input:{filePath:this.asset(input.imageId).path},signal:controller.signal,onProgress:progress=>{if(current())this.change(d=>{d.ocr.progress=Math.min(99,Math.max(0,Number(progress)||0));},null);}}),controller.signal);
      if(!current())return this.snapshot();
      if(!object(result)||typeof result.text!=='string'||result.text.length>1000000)throw Object.assign(new Error('OCR 沒有回傳有效文字。'),{code:'MODEL_INVALID_OUTPUT'});
      const text=result.text.trim(),meta=modelMeta(result.meta,source);
      this.change(d=>{Object.assign(d.ocr,{text,status:text?'done':'no-text',error:'',progress:100,regions:Array.isArray(result.regions)?result.regions:[],...(meta?{meta}:{})});},'文字識別完成');
    }catch(error){
      if(!current())return this.snapshot();
      this.change(d=>{Object.assign(d.ocr,{status:error.code==='MODEL_NOT_CONFIGURED'?'waiting-model':'error',error:failureText(error)});},error.code==='MODEL_NOT_CONFIGURED'?'等待 OCR 模型':'文字識別失敗','',error.code==='MODEL_NOT_CONFIGURED'?'blocked':'error');
    }finally{if(this.active.get('ocr')===controller)this.active.delete('ocr');}
    return this.snapshot();
  }
  saveOcrText(text){if(typeof text!=='string'||text.length>1000000)throw new Error('文字太長。');if(this.store.read().ocr.text===text)return this.snapshot();this.active.get('ocr')?.abort();this.active.delete('ocr');return this.change(d=>{d.ocr.text=text;d.ocr.status=text?'manual':d.ocr.imageId?'waiting-model':'empty';d.ocr.error='';delete d.ocr.meta;delete d.ocr.regions;d.ocr.revision++;},null);}
  savePolish(patch){
    if(!object(patch))throw new Error('潤句內容格式錯誤。');
    if(patch.input!==undefined&&(typeof patch.input!=='string'||patch.input.length>100000))throw new Error('輸入文字超過 100,000 字元。');
    if(patch.use!==undefined&&!['document','email','message'].includes(patch.use))throw new Error('用途錯誤。');
    if(patch.tone!==undefined&&!['polite','casual','formal'].includes(patch.tone))throw new Error('語氣錯誤。');
    if(patch.output!==undefined&&(typeof patch.output!=='string'||patch.output.length>200000))throw new Error('輸出太長。');
    const current=this.store.read().polish;
    const changed=['input','use','tone'].some(key=>patch[key]!==undefined&&patch[key]!==current[key]);
    const editedOutput=patch.output!==undefined&&patch.output!==current.output;
    if(!changed&&!editedOutput)return this.snapshot();
    this.active.get('polish')?.abort();this.active.delete('polish');
    return this.change(d=>{
      const p=d.polish;for(const key of ['input','use','tone'])if(patch[key]!==undefined)p[key]=patch[key];
      if(changed){p.output='';p.status=p.input.trim()?'waiting-model':'empty';delete p.meta;}
      else{p.output=patch.output;p.status=patch.output?'manual':'empty';delete p.meta;}
      p.revision++;p.error='';
    },null);
  }
  cancelPolish(){
    this.active.get('polish')?.abort();this.active.delete('polish');
    if(this.store.read().polish.status!=='running')return this.snapshot();
    return this.change(d=>{d.polish.status='cancelled';d.polish.error='';d.polish.revision++;},'已取消文章潤句');
  }
  async runPolish(source){
    const p=this.store.read().polish;source=selectedSource(source,p.source);if(!p.input.trim())return this.snapshot();
    const controller=trackModelRun(new AbortController(),'llm',source);this.active.get('polish')?.abort();this.active.set('polish',controller);
    const current=()=>!controller.signal.aborted&&this.active.get('polish')===controller;
    try{this.change(d=>{d.polish.source=source;d.polish.status='running';d.polish.output='';d.polish.error='';delete d.polish.meta;},'開始文章潤句','','started');}
    catch(error){controller.abort();if(this.active.get('polish')===controller)this.active.delete('polish');throw error;}
    try{
      const result=await abortable(()=>this.models.run('llm',{task:'polish',source,input:{text:p.input,use:p.use,tone:p.tone},signal:controller.signal}),controller.signal);
      if(!current())return this.snapshot();
      if(!object(result)||typeof result.text!=='string'||!result.text.trim()||result.text.length>200000)throw Object.assign(new Error('模型沒有回傳有效文字。'),{code:'MODEL_API_INVALID_OUTPUT'});
      const meta=modelMeta(result.meta,source);
      this.change(d=>{if(d.polish.revision===p.revision)Object.assign(d.polish,{output:result.text,status:'done',error:'',...(meta?{meta}:{})});},'文章潤句完成');
    }catch(e){
      if(!current())return this.snapshot();
      this.change(d=>{if(d.polish.revision===p.revision)Object.assign(d.polish,{status:e.code==='MODEL_NOT_CONFIGURED'?'waiting-model':'error',error:failureText(e)});},e.code==='MODEL_NOT_CONFIGURED'?'等待文字模型':'文章潤句失敗','',e.code==='MODEL_NOT_CONFIGURED'?'blocked':'error');
    }finally{if(this.active.get('polish')===controller)this.active.delete('polish');}
    return this.snapshot();
  }
  cancelMailAnalysis(){
    this.active.get('mail-analysis')?.abort();this.active.delete('mail-analysis');
    if(this.store.read().mailAnalysis.status!=='running')return this.snapshot();
    return this.change(d=>{d.mailAnalysis.status='cancelled';d.mailAnalysis.error='';resetMailProgress(d.mailAnalysis);},'已取消郵件分析');
  }
  async analyzeMail(source,{categorize=false,onlyChanged=false,ids}={}){
    const batch=this.store.read();source=selectedSource(source,categorize?defaultModelSource(batch.settings,'llm'):batch.mailAnalysis.source);
    if(this.active.has('mail-analysis'))throw Object.assign(new Error('郵件正在分析，請先完成或取消。'),{code:'MAIL_ANALYSIS_BUSY'});
    if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string'||!batch.messages.some(m=>m.id===id&&m.folder==='inbox'))))throw new Error('請選擇有效的收件匣郵件。');
    // A batch uses one reference time even if processing crosses midnight.
    // A later batch refreshes priorities once the Taipei calendar date changes.
    const referenceTime=new Date().toISOString(),referenceDate=mailReferenceDate(referenceTime);
    const candidates=batch.messages.filter(m=>m.folder==='inbox'&&(categorize||!m.done)&&(!ids||ids.includes(m.id))).map(mail=>{
      const input=mailInput(mail),recipient=mailRecipient(mail,batch.accounts);
      // Retain the complete original for cache/race checks and reading. Only
      // this message's top content may reach summary generation or fallback.
      // An inherited reply subject can describe an old event absent from this
      // body. Exclude it even when no current body remains; do not invent one.
      const summaryInput={...input,subject:MAIL_REPLY_SUBJECT.test(input.subject)?'':input.subject,
        body:splitMailThread(input.body,{firstOnly:true}).current,contentContext:getMailContentContext(mail,{firstOnly:true})};
      const prepared=prepareMailAnalysisInput(summaryInput);
      return{input,summaryInput,recipient,prepared,fingerprint:mailFingerprint(input,recipient,batch.settings,source,referenceDate),previous:mail.analysis};
    });
    const mails=candidates.filter(({fingerprint,previous})=>!categorize||!onlyChanged||previous?.fingerprint!==fingerprint||previous.categoryStatus!=='done'||!validMailCategory(previous.category));
    if(!mails.length){
      if(!categorize)throw new Error('目前沒有待分析的郵件。');
      return this.change(d=>{d.mailAnalysis={...MAIL_ANALYSIS_DEFAULT,source,status:'done',unchanged:candidates.length};},'郵件整理完成','沒有新增或需要更新的信件');
    }
    const controller=trackModelRun(new AbortController(),'llm',source);
    this.active.set('mail-analysis',controller);
    const current=()=>!controller.signal.aborted&&this.active.get('mail-analysis')===controller;
    let firstError='';
    try{
      this.change(d=>{d.mailAnalysis={...MAIL_ANALYSIS_DEFAULT,source,status:'running',total:mails.length,...(categorize?{unchanged:candidates.length-mails.length,phase:'summary',currentId:''}:{})};},'開始郵件分析','','started');
      for(const {input,summaryInput,recipient,prepared,fingerprint,previous} of mails){
        if(!current())return this.snapshot();
        const same=state=>sameMailContext(state,input,recipient,categorize)&&(!categorize||mailFingerprint(input,recipient,state.settings,source,referenceDate)===fingerprint);
        if(!same(this.store.read())){
          this.change(d=>{d.mailAnalysis.processed++;d.mailAnalysis.skipped++;resetMailProgress(d.mailAnalysis);},null);continue;
        }
        let summarySaved=false;
        try{
          if(categorize)this.change(d=>{resetMailProgress(d.mailAnalysis,'summary',input.id);},null);
          if(typeof input.id!=='string'||!input.id||(!summaryInput.subject.trim()&&!summaryInput.body.trim()))throw invalidAnalysis('郵件沒有可供分析的主旨或內文。');
          let analysis;
          if(categorize&&onlyChanged&&previous?.summaryFingerprint===fingerprint&&previous.summary){analysis={...previous};}
          else{
            let acceptingProgress=true,result;
            const onProgress=(_percentage,details)=>{
              if(!acceptingProgress||!current())return;
              const progress=mailProgress(details);if(!progress)return;
              const latest=this.store.read(),state=latest.mailAnalysis;
              if(state.status!=='running'||!same(latest)||state.currentId===input.id&&state.phase===progress.phase&&state.chunkIndex===progress.chunkIndex&&state.chunkTotal===progress.chunkTotal)return;
              this.change(d=>{Object.assign(d.mailAnalysis,progress,{currentId:input.id});},null);
            };
            try{result=await abortable(()=>this.models.run('llm',{task:'mail',source,input:{messages:[{...prepared.input,to:[...prepared.input.to],cc:[...prepared.input.cc]}],referenceTime,recipient},signal:controller.signal,onProgress}),controller.signal);}
            finally{acceptingProgress=false;}
            analysis=validateMailAnalysis(result,prepared.input,source);
            if(prepared.changed)analysis=validateMailAnalysis({analyses:[{...analysis,id:input.id,evidence:prepared.restoreEvidence(analysis.evidence)}],meta:result.meta},summaryInput,source);
            // The capacity fallback can only make a validated result more
            // conservative. Its facts use only this message's top content.
            if(result.meta?.processingMode==='source-excerpts')analysis.quality={issues:['model-capacity-limited'],summaryMode:'source-excerpts',priorityReview:true};
          }
          analysis=traditionalMailAnalysis(applyMailQuality({input:summaryInput,analysis,recipient,referenceTime}));
          if(!current())return this.snapshot();
          if(!same(this.store.read())){this.change(d=>{d.mailAnalysis.processed++;d.mailAnalysis.skipped++;resetMailProgress(d.mailAnalysis);},null);continue;}
          if(categorize){
            const savePendingClassification=()=>{
              delete analysis.category;delete analysis.categoryError;delete analysis.categoryMeta;delete analysis.fingerprint;
              Object.assign(analysis,{summaryFingerprint:fingerprint,categoryStatus:'pending'});
              this.change(d=>{
                const mail=d.messages.find(m=>m.id===input.id);mail.analysis=analysis;delete mail.analysisError;
                resetMailProgress(d.mailAnalysis,'classification',input.id);
                applyMailPriority(mail,analysis);
              },null);
              summarySaved=true;
            };
            savePendingClassification();
            for(let classificationRound=0;classificationRound<2;classificationRound++){
              const classifiedSummary=analysis.summary;
              const categoryResult=await abortable(()=>this.models.run('llm',{task:'mail-classify',source,input:{summary:classifiedSummary},signal:controller.signal}),controller.signal);
              if(!current())return this.snapshot();
              if(!validMailCategory(categoryResult?.category))throw invalidAnalysis('模型回傳的郵件分類無效，已保留重點摘要。');
              Object.assign(analysis,{category:categoryResult.category,categoryStatus:'done',categoryMeta:modelMeta(categoryResult.meta,source),fingerprint});
              analysis=traditionalMailAnalysis(applyMailQuality({input:summaryInput,analysis,recipient,referenceTime,category:categoryResult.category}));
              if(analysis.summary===classifiedSummary||!same(this.store.read()))break;
              // Classification-dependent checks can replace generated text
              // with source excerpts. Classify that saved text once more so a
              // cancelled or failed retry cannot retain the old text's category.
              savePendingClassification();
              if(classificationRound>0)throw invalidAnalysis('摘要檢查後內容再次變更，已保留更新的摘要，請重新分類。');
            }
          }
          this.change(d=>{
            const mail=d.messages.find(m=>m.id===input.id);d.mailAnalysis.processed++;resetMailProgress(d.mailAnalysis);
            if(!same(d)){d.mailAnalysis.skipped++;return;}
            mail.analysis=analysis;delete mail.analysisError;
            applyMailPriority(mail,analysis);
          },null);
        }catch(error){
          if(!current())return this.snapshot();
          const message=failureText(error);
          this.change(d=>{
            const mail=d.messages.find(m=>m.id===input.id);d.mailAnalysis.processed++;resetMailProgress(d.mailAnalysis);
            if(!same(d)){d.mailAnalysis.skipped++;return;}
            if(!firstError)firstError=message;
            d.mailAnalysis.failed++;mail.analysisError=message;
            if(summarySaved&&mail.analysis?.summaryFingerprint===fingerprint){mail.analysis.categoryStatus='error';mail.analysis.categoryError=message;}
            d.mailAnalysis.error=firstError;
          },null);
          if(error.code==='MODEL_NOT_CONFIGURED'){
            this.change(d=>{d.mailAnalysis.status='error';d.mailAnalysis.error=message;resetMailProgress(d.mailAnalysis);},'等待郵件分析模型','','blocked');
            throw error;
          }
        }
      }
      if(current()){
        const state=this.store.read().mailAnalysis;
        this.change(d=>{d.mailAnalysis.status=state.failed?'error':'done';d.mailAnalysis.error=state.failed?`${state.failed} 封郵件分析失敗，已保留成功結果。${firstError}`:'';resetMailProgress(d.mailAnalysis);},
          state.failed?'郵件分析部分失敗':'郵件分析完成',`${state.processed-state.failed-state.skipped} 封成功、${state.failed} 封失敗、${state.skipped} 封略過`,state.failed||state.skipped?'partial':'success');
      }
    }finally{if(this.active.get('mail-analysis')===controller)this.active.delete('mail-analysis');}
    return this.snapshot();
  }
}
Object.assign(AppService.prototype,chatMethods);
Object.assign(AppService.prototype,translationMethods);
Object.assign(AppService.prototype,recordingQueueMethods);
module.exports={AppService,DEFAULT_SETTINGS};

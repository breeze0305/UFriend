'use strict';
(() => {
  const i18n=window.UFriendI18n.create({catalogs:{en:window.UFriendEnglish||{}}}),tr=i18n.tr,uiText=i18n.text;
  window.UFriendUi=i18n;
  const bridge=window.ufriend;
  const api=bridge&&{...bridge,call:async(name,args={})=>{const response=await bridge.request(name,args);if(!response.ok){const error=new Error(tr(response.error?.message||'操作未完成。'));error.code=response.error?.code||'ACTION_FAILED';throw error;}return response.value;}};
  const root=document.getElementById('ufriend-app'),page=document.getElementById('mf-page'),top=document.getElementById('mf-top'),overlay=document.getElementById('mf-overlay'),toastNode=document.getElementById('mf-toast');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ico=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const btn=(text,action,icon='',extra='',attrs='')=>`<button type="button" class="mf-action ${extra}" data-action="${action}" ${attrs}>${icon?ico(icon):''}${text}</button>`;
  const icon=(text,action,name,attrs='')=>btn('',action,name,'mf-icon mf-plain',`aria-label="${esc(text)}" ${attrs}`);
  const checked=value=>value?' checked':'';
  const disabled=value=>value?' disabled':'';
  const selected=(a,b)=>a===b?' selected':'';
  const idAttr=id=>`data-id="${esc(id)}"`;
  const drawIcons=()=>{if(window.lucide)window.lucide.createIcons({attrs:{width:16,height:16}});};
  const sizes=bytes=>bytes>=1024**3?(bytes/1024**3).toFixed(2)+' GB':bytes>=1024**2?(bytes/1024**2).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
  const time=iso=>{if(!iso)return'';const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleTimeString(i18n.locale,{hour:'2-digit',minute:'2-digit',hour12:false});};
  const day=iso=>{if(!iso)return tr('日期不明');const d=new Date(iso);return Number.isNaN(d.getTime())?tr('日期不明'):d.toLocaleDateString(i18n.locale);};
  const dateLabel=()=>new Date().toLocaleDateString(i18n.locale,{month:'long',day:'numeric',weekday:'long'});
  const langNames=i18n.labels({'auto':'自動偵測','zh-TW':'繁體中文','zh':'中文','en':'English','ja':'日本語','ko':'한국어','es':'Español','fr':'Français','de':'Deutsch'});
  const translationLanguages=i18n.labels({'auto':'自動偵測','zh-TW':'繁體中文','zh-CN':'簡體中文','en':'English','ja':'日本語','ko':'한국어','es':'Español','fr':'Français','de':'Deutsch'});
  const promptTasks=i18n.labels({mail:'郵件分析',polish:'文章潤句',chat:'LLM 對話',translate:'文字翻譯'});
  const promptUi={task:'chat',catalog:null,endpoint:'',source:'local',loading:false,loadRevision:0,error:'',drafts:{},pending:new Set(),messages:{}};
  const polishUi={sourceDirty:false,outputDirty:false,composing:false,requestRevision:null,cancelling:null};
  const sourceUi={selections:new Map(),recordings:new Map()};
  const modelDefaultUi={pending:new Map(),queue:Promise.resolve(),errors:new Map()};
  const mailScheduleUi={saving:false,error:'',saved:false};
  const profileFields=i18n.labels({name:{id:'name',label:'姓名',type:'text',max:120,autocomplete:'name'},phone:{id:'phone',label:'電話',type:'tel',max:80,autocomplete:'tel'},personalEmail:{id:'personal-email',label:'常用 Email',type:'email',max:254,autocomplete:'section-personal email'},workEmail:{id:'work-email',label:'公司 Email',type:'email',max:254,autocomplete:'section-work email'},company:{id:'company',label:'公司',type:'text',max:120,autocomplete:'organization'},jobTitle:{id:'job-title',label:'職稱',type:'text',max:120,autocomplete:'organization-title'},notes:{id:'notes',label:'補充背景',max:2000}});
  const profileUi={draft:null,base:null,revision:0,saving:false,error:'',saved:false};
  const rendererErrorNames=new Set(['Error','TypeError','RangeError','SyntaxError','ReferenceError','URIError','EvalError','AggregateError']);
  const rendererReports={recent:new Map(),sent:[],inFlight:false};
  const modelNames={llm:'LLM',ocr:'OCR',whisper:'Whisper'};
  const uses=i18n.labels({document:'正式公文',email:'信件寄送',message:'一般通訊軟體'}),tones=i18n.labels({polite:'自然禮貌',casual:'輕鬆閒聊',formal:'正式'});
  const levels=i18n.labels(['優先回覆','今日處理','稍後處理']);
  const mailCategories=i18n.labels({work:'工作與協作',meeting:'會議與活動',finance:'帳務與交易',account:'帳號與服務',promotion:'行銷與電子報',personal:'個人往來',other:'其他'});
  const modelCapabilityNames=i18n.labels({llm:'文字 LLM',ocr:'OCR 圖片文字',whisper:'Whisper 語音轉錄'});
  const folders=i18n.labels({inbox:'收件夾',starred:'已加星號',sent:'寄件備份',drafts:'草稿',archive:'封存',spam:'垃圾郵件',trash:'垃圾桶',all:'全部郵件'});
  const statuses=i18n.labels({'waiting-model':'尚未接入模型',running:'處理中',queued:'等待處理',paused:'已暫停',cancelled:'已取消',done:'已完成',error:'處理失敗',manual:'人工編輯',empty:'等待輸入','no-text':'沒有辨識到文字','no-speech':'沒有辨識到語音'});
  let data,toastTimer,polishTimer,ocrTimer,draftTimer,chatTimer,translationTimer,returnFocus,draftSaveQueue=Promise.resolve(),chatSaveQueue=Promise.resolve(),translationSaveQueue=Promise.resolve(),polishSaveQueue=Promise.resolve();
  const ui={view:'home',mailId:null,folder:'inbox',query:'',sender:'',recentDays:'',category:'',sources:new Set(),selected:new Set(),modal:null,busy:new Set(),policyDraft:null,polishRevision:0,translationRevision:0,chatHistoryOpen:window.innerWidth>960&&window.innerHeight>620,chatHistoryCompact:window.innerWidth<=960||window.innerHeight<=620,chatHistoryBusy:false,modelConfigTab:'local',devApiHealth:null,devApiHealthRevision:0,mediaHealth:{},mediaHealthRevision:{ocr:0,whisper:0},cloudHealth:{},cloudHealthRevision:{llm:0,ocr:0,whisper:0}};
  const assetUrl=id=>'ufriend-asset://file/'+encodeURIComponent(id);
  const mediaDragFeedback=document.getElementById('media-drag-feedback');
  let fileDragDepth=0,mediaImporting=false;
  let mailBodyController=null,mailBodyKey=null;
  const toast=text=>{clearTimeout(toastTimer);toastNode.textContent=text;toastNode.hidden=false;toastTimer=setTimeout(()=>{toastNode.hidden=true;},5000);};
  const message=id=>data.messages.find(m=>m.id===id);
  const accountLabel=id=>data.accounts.find(a=>a.id===id)?.email||tr('本機草稿');
  const allSources=state=>[...new Set([...(state?.messages||[]).map(m=>m.source||'本機'),...(state?.drafts||[]).map(d=>d.accountId==='local'?'本機':'Gmail')])];
  const sourceLabel=source=>!source||source==='本機'?tr('本機'):source;
  const provider=source=>`<span class="mf-provider ${['Gmail','Outlook','Yahoo'].includes(source)?source:''}">${esc(sourceLabel(source))}</span>`;
  const normalizeSource=value=>value==='cloud'?'cloud':'local';
  const aiSourceLabel=value=>value==='cloud'?tr('雲端'):tr('本地');
  const taskSourceState=kind=>data?.[kind==='mail'?'mailAnalysis':kind]||{};
  const taskCapability=kind=>kind==='ocr'||kind==='whisper'?kind:'llm';
  const defaultTaskSource=kind=>normalizeSource(data?.settings?.modelDefaults?.[taskCapability(kind)]);
  const taskSource=kind=>normalizeSource(sourceUi.selections.get(kind)||defaultTaskSource(kind));
  const resetTaskSource=kind=>sourceUi.selections.delete(kind);
  const selectedTaskSource=kind=>normalizeSource(document.getElementById('ai-source-'+kind)?.value||taskSource(kind));
  const taskSourceBusy=kind=>taskSourceState(kind).status==='running'||ui.busy.has(({mail:'analyze',ocr:'ocr-start',polish:'polish-start',translation:'translation-start',chat:'chat-send'})[kind]+':');
  const chatControlsBusy=()=>ui.chatHistoryBusy;
  const resultSourceBadge=meta=>['local','cloud'].includes(meta?.source)?'<span class="mf-result-source" data-result-source="'+meta.source+'">'+esc(uiText`結果來源：${aiSourceLabel(meta.source)}`)+'</span>':'';
  const resultSourceStatus=(text,job)=>text+(!job.error&&job.transcriptSource!=='manual'&&['done','no-text','no-speech'].includes(job.status||job.state)&&['local','cloud'].includes(job.meta?.source)?' · '+uiText`結果來源：${aiSourceLabel(job.meta.source)}`:'');
  function aiSourceOptions(value){return '<option value="local"'+selected(normalizeSource(value),'local')+'>'+esc(tr('本地'))+'</option><option value="cloud"'+selected(normalizeSource(value),'cloud')+'>'+esc(tr('雲端'))+'</option>';}
  function sourceConfiguration(kind,source){const capability=kind==='whisper'||kind==='ocr'?kind:'llm';return data?.models?.sources?.[source]?.[capability]||(source==='local'?data?.models?.[capability]:null);}
  function sourceHint(kind,source,{locked=false,elementId=''}={}){
    const cloudText=kind==='chat'?tr('本次問題與目前整段對話歷史（含先前本地回覆）會傳送至雲端。'):kind==='mail'?tr('本次待分析郵件的文字會傳送至雲端。'):kind==='whisper'?tr('會議音訊會傳送至設定的雲端服務。'):kind==='ocr'?tr('目前圖片會傳送至設定的雲端服務。'):tr('本次文字會傳送至設定的雲端服務。');
    const text=locked?tr('請先暫停或取消排程，再變更轉錄來源。'):source==='cloud'?cloudText:'';
    const missing=sourceConfiguration(kind,source)?.configured===false;
    return '<span class="mf-ai-source-hint"'+(elementId?' id="'+esc(elementId)+'"':'')+' role="status">'+(text?'<span>'+esc(text)+'</span>':'')+(missing?'<span>'+esc(tr('此來源尚未設定完成。'))+'</span>'+btn(tr('前往模型設定'),'model-settings','settings','mf-source-settings-link','data-config-source="'+source+'"'):'')+'</span>';
  }
  function taskSourceControl(kind){const source=taskSource(kind),running=taskSourceState(kind).status==='running';return '<label class="mf-ai-source-control" for="ai-source-'+kind+'"><span>'+esc(running?tr('下次 AI 來源'):tr('AI 來源'))+'</span><select class="mf-input mf-ai-source-select" id="ai-source-'+kind+'" data-ai-source-kind="'+kind+'"'+disabled(taskSourceBusy(kind)||kind==='chat'&&ui.chatHistoryBusy)+'>'+aiSourceOptions(source)+'</select></label>';}
  function taskActionMarkup(kind,actions){return taskSourceControl(kind)+'<span class="mf-task-action-items">'+actions+'</span>';}
  function taskSourceHint(kind){const state=taskSourceState(kind),running=state.status==='running',source=running?normalizeSource(state.runningSource||state.source):taskSource(kind);return(running?'<span class="mf-ai-source-running" role="status">'+esc(uiText`目前執行來源：${aiSourceLabel(source)}`)+'</span>':'')+sourceHint(kind,source);}
  async function saveTaskSource(kind,source){
    if(!['mail','ocr','polish','translation','chat'].includes(kind)||taskSourceBusy(kind))return;
    source=normalizeSource(source);if(source===taskSource(kind))return;
    sourceUi.selections.set(kind,source);updateModelUi();
  }
  const recordingSource=r=>normalizeSource(sourceUi.recordings.get(r.id)?.source||r.source);
  const recordingSourceLocked=r=>['running','queued','scheduled'].includes(r.state)||sourceUi.recordings.has(r.id);
  function recordingSourceControl(r,{dialog=false}={}){return '<label class="mf-ai-source-control mf-recording-source-control"'+(recordingSourceLocked(r)?' title="'+esc(tr('請先暫停或取消排程，再變更轉錄來源。'))+'"':'')+'><span>'+esc(tr('轉錄來源'))+'</span><select class="mf-input mf-ai-source-select"'+(dialog?' id="recording-source"':'')+' data-recording-source="'+esc(r.id)+'"'+disabled(recordingSourceLocked(r))+'>'+aiSourceOptions(recordingSource(r))+'</select></label>';}
  async function saveRecordingSource(id,source){
    const recording=data.recordings.find(item=>item.id===id);if(!recording||recordingSourceLocked(recording))return;
    source=normalizeSource(source);if(source===recordingSource(recording))return;
    const pending={source};sourceUi.recordings.set(id,pending);updateRecordingSourceUi();
    try{await api.call('media.update',{id,patch:{source}});await refresh(false);}
    finally{if(sourceUi.recordings.get(id)===pending)sourceUi.recordings.delete(id);updateRecordingSourceUi();}
  }
  function updateRecordingSourceUi(){
    for(const field of root.querySelectorAll('[data-recording-source]')){const r=data.recordings.find(item=>item.id===field.dataset.recordingSource);if(!r)continue;field.disabled=recordingSourceLocked(r);field.value=recordingSource(r);const control=field.closest('.mf-recording-source-control');if(control)control.title=recordingSourceLocked(r)?tr('請先暫停或取消排程，再變更轉錄來源。'):'';}
    for(const hint of root.querySelectorAll('[data-recording-source-hint]')){const r=data.recordings.find(item=>item.id===hint.dataset.recordingSourceHint);if(r)setLiveMarkup(hint,sourceHint('whisper',recordingSource(r)));}
    if(ui.modal?.type==='media'){const r=data.recordings.find(item=>item.id===ui.modal.id);if(r)setLiveMarkup(document.getElementById('recording-source-hint'),sourceHint('whisper',recordingSource(r),{locked:['running','queued','scheduled'].includes(r.state)}));}
  }
  const navLabels=i18n.labels({inbox:'郵件收件夾',meetings:'會議記錄',ocr:'OCR 文字識別',polish:'文章潤句',translation:'文字翻譯',chat:'LLM 對話',logs:'系統紀錄',settings:'設定'});
  let appliedUiLocale=null;
  function applyUiLanguage(){
    const previous=i18n.locale;i18n.setLocale(data?.settings?.uiLanguage);
    if(appliedUiLocale===i18n.locale)return false;appliedUiLocale=i18n.locale;
    document.documentElement.lang=i18n.locale==='en'?'en':'zh-Hant';
    for(const element of document.querySelectorAll('[data-ui-text]'))element.textContent=tr(element.dataset.uiText);
    for(const element of document.querySelectorAll('[data-ui-aria]'))element.setAttribute('aria-label',tr(element.dataset.uiAria));
    for(const element of document.querySelectorAll('[data-ui-alt]'))element.setAttribute('alt',tr(element.dataset.uiAlt));
    for(const element of root.querySelectorAll('.mf-navbtn[data-nav]')){const label=navLabels[element.dataset.nav];element.setAttribute('aria-label',label);element.querySelector('.mf-navtext').textContent=label;}
    return previous!==i18n.locale;
  }
  function setTheme(){root.style.colorScheme=data.settings.theme==='system'?'light dark':data.settings.theme;mailBodyController?.setTheme(data.settings.theme);}
  function updateAppVersion(){const label=document.getElementById('mf-app-version'),version=String(data.version||'').trim();label.textContent=version?'v'+version:'';label.title=version?uiText`UFriend 版本 ${version}`:'';label.hidden=!version;}
  function mergePolishSnapshot(next){return data?.polish?.revision>next?.polish?.revision?{...next,polish:data.polish}:next;}
  function mergeChatStreamSnapshot(next){
    const previous=data?.chat,incoming=next?.chat;
    if(previous?.status==='running'&&incoming?.status==='running'&&incoming.streamId&&incoming.streamId===previous.streamId&&next.chatHistory?.activeId===data.chatHistory?.activeId&&typeof previous.partialText==='string'&&typeof incoming.partialText==='string'&&previous.partialText.length>incoming.partialText.length&&previous.partialText.startsWith(incoming.partialText))return{...next,chat:{...incoming,partialText:previous.partialText}};
    return next;
  }
  function acceptSnapshot(next){if(data&&data.ocr?.imageId!==next.ocr?.imageId)resetTaskSource('ocr');if(data&&data.chatHistory?.activeId!==next.chatHistory?.activeId)resetTaskSource('chat');data=mergePolishSnapshot(mergeChatStreamSnapshot(next));}
  async function refresh(renderPage=true){acceptSnapshot(await api.call('bootstrap'));applyUiLanguage();setTheme();if(renderPage&&!ui.modal)render();else{updateSyncButtons();updateModelUi();}return data;}
  async function operation(name,args={},success=''){const result=await api.call(name,args);if(['ocr.import','ocr.capture','ocr.clear'].includes(name)&&!result?.cancelled&&!result?.skipped)resetTaskSource('ocr');await refresh();if(success)toast(success);return result;}
  function header(title,actions,stable=false){top.dataset.view=ui.view;const markup=`<h1>${esc(title)}</h1><div class="mf-flex">${actions??`<span class="mf-sub mf-date">${dateLabel()}</span>`}</div>`;if(stable)return setLiveMarkup(top,markup,false);top._mfMarkup=markup;top.innerHTML=markup;return true;}
  function empty(text,actions=''){return `<div class="mf-empty"><p>${esc(text)}</p>${actions?`<div class="mf-flex" style="justify-content:center;margin-top:16px">${actions}</div>`:''}</div>`;}
  function meetingImportMarkup(){return uiText`<button type="button" class="mf-drop mf-meeting-drop" id="meeting-drop-zone" data-action="add-media">${ico('upload')}<strong>將音訊或影片拖到此頁，即可匯入</strong><span>支援 MP3、WAV、M4A、MP4 等格式，可一次拖入多個檔案或點此匯入</span></button><p class="mf-inline-status" data-media-import-status role="status" aria-live="polite" hidden></p>`;}
  function localDateInput(value=Date.now()+10*60000){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  function scheduledTime(value){const date=new Date(value);if(!value||!Number.isFinite(date.getTime())||date.getTime()<=Date.now())throw new Error(tr('請選擇未來的轉錄開始時間。'));return date.toISOString();}
  function recordingStateLabel(r){
    const now=Date.now(),isDue=item=>item.state==='queued'||item.state==='scheduled'&&Date.parse(item.scheduledAt)<=now;
    if(r.state==='scheduled'&&!isDue(r))return uiText`已排程：${new Date(r.scheduledAt).toLocaleString(i18n.locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}`;
    if(isDue(r)){const pending=data.recordings.filter(isDue).sort((a,b)=>(a.queueOrder||0)-(b.queueOrder||0));return uiText`排隊第 ${Math.max(1,pending.findIndex(item=>item.id===r.id)+1)} 個`;}
    return r.transcriptSource==='manual'?tr('人工逐字稿'):statuses[r.state]||r.state;
  }
  const videoExportActive=job=>['choosing','running','cancelling'].includes(job?.status);
  function videoExportLabel(job){
    if(job.status==='choosing')return tr('正在選擇影片儲存位置…');
    if(job.status==='running')return Number.isFinite(job.progress)?uiText`正在匯出字幕影片 ${Math.floor(job.progress*100)}%`:tr('正在匯出字幕影片…');
    if(job.status==='cancelling')return tr('正在取消影片匯出…');
    if(job.status==='done')return uiText`含字幕影片已匯出：${job.fileName}`;
    if(job.status==='cancelled')return tr('影片匯出已取消。');
    if(job.status==='error')return tr(job.error||'影片匯出失敗，請稍後重試。');
    return '';
  }
  function videoExportCardStatus(r){const job=data.videoExport;return job?.recordingId===r.id&&job.status!=='idle'?'<span class="mf-help mf-video-export-card">'+esc(videoExportLabel(job))+'</span>':'';}
  function recordingWorkActions(r,compact=false){
    const control=(label,action,glyph,extra='')=>compact?icon(label,action,glyph,idAttr(r.id)+disabled(sourceUi.recordings.has(r.id))):btn(label,action,glyph,extra,idAttr(r.id)+disabled(sourceUi.recordings.has(r.id)));
    if(r.state==='running')return control(tr('暫停'),'media-pause','pause');
    if(['queued','scheduled'].includes(r.state))return control(tr('取消排程'),'media-pause','x')+control(tr('修改排程'),'media-schedule','calendar-clock');
    if(r.segments?.length||r.textOnly)return '';
    return control(tr('加入轉錄佇列'),'media-start','play','mf-primary')+control(tr('排程轉錄'),'media-schedule','calendar-clock');
  }
  function updateUploadFiles(){
    if(ui.modal?.type!=='upload')return;
    const files=document.getElementById('upload-files');if(files){files.replaceChildren();for(const file of ui.modal.paths){const item=document.createElement('li');item.textContent=file.split(/[\\/]/).at(-1);files.append(item);}files.hidden=!ui.modal.paths.length;}
    const count=document.getElementById('upload-file-count');if(count)count.textContent=ui.modal.paths.length?uiText`已選擇 ${ui.modal.paths.length} 個檔案`:tr('尚未選擇檔案');
    updateMediaImportUi();
  }
  function stageMeetingFiles(paths){
    if(mediaImporting)return;
    if(ui.modal?.type!=='upload'){openMeetingUpload(paths);return;}
    const combined=[...new Set([...ui.modal.paths,...paths])];if(combined.length>30)throw new Error(tr('每次最多匯入 30 個影音檔。'));
    ui.modal.paths=combined;updateUploadFiles();
  }
  function openMeetingUpload(paths=[]){
    if(mediaImporting)return;if(paths.length>30)throw new Error(tr('每次最多匯入 30 個影音檔。'));
    ui.modal={type:'upload',paths:[...new Set(paths)],source:defaultTaskSource('whisper')};
    modal(tr('匯入音訊或影片'),uiText`<div class="mf-drop" id="media-drop">${ico('upload')}<p>拖曳音訊或影片到這裡</p>${btn(tr('選擇檔案'),'choose-media','folder-open')}</div><p id="upload-file-count" class="mf-sub" role="status"></p><ul id="upload-files" class="mf-upload-files"></ul><div class="mf-transcription-options"><label class="mf-field">轉錄語言<select id="upload-language" class="mf-input">${langOptions('zh-TW')}</select></label><label class="mf-field">轉錄來源<select id="upload-source" class="mf-input">${aiSourceOptions(ui.modal.source)}</select></label></div><div id="upload-source-hint">${sourceHint('whisper',ui.modal.source)}</div><label class="mf-field">匯入後的動作<select id="upload-transcription" class="mf-input"><option value="manual">只匯入，稍後再轉錄</option><option value="queue">立即加入轉錄佇列</option><option value="schedule">指定開始時間</option></select></label><label id="upload-schedule-field" class="mf-field" hidden>開始時間<input id="upload-scheduled-at" class="mf-input" type="datetime-local" value="${localDateInput()}" min="${localDateInput(Date.now())}"></label><p class="mf-help">排程時間使用這台電腦的時區。UFriend 需保持開啟或留在系統匣；關閉期間到期的工作會在下次開啟後排隊。</p><p class="mf-inline-status" data-media-import-status role="status" aria-live="polite" hidden></p>`,btn(tr('取消'),'modal-close')+btn(tr('確認匯入'),'confirm-media-import','upload','mf-primary'));
    updateUploadFiles();
  }
  function openRecordingSchedule(id){
    const r=data.recordings.find(item=>item.id===id);if(!r)throw new Error(tr('找不到會議紀錄。'));
    ui.modal={type:'schedule-media',id,source:recordingSource(r)};
    modal(tr('排程轉錄'),'<p class="mf-pre">'+esc(r.name)+'</p>'+uiText`<div class="mf-transcription-options"><label class="mf-field">執行方式<select id="schedule-mode" class="mf-input"><option value="queue"${selected(r.state!=='scheduled',true)}>立即加入轉錄佇列</option><option value="schedule"${selected(r.state==='scheduled',true)}>指定開始時間</option></select></label><label class="mf-field">轉錄來源<select id="schedule-source" class="mf-input"${disabled(recordingSourceLocked(r))}>${aiSourceOptions(recordingSource(r))}</select></label></div><div id="schedule-source-hint">${sourceHint('whisper',recordingSource(r),{locked:recordingSourceLocked(r)})}</div><label id="recording-schedule-field" class="mf-field"${r.state==='scheduled'?'':' hidden'}>開始時間<input id="recording-scheduled-at" class="mf-input" type="datetime-local" value="${localDateInput(r.scheduledAt&&Date.parse(r.scheduledAt)>Date.now()?r.scheduledAt:undefined)}" min="${localDateInput(Date.now())}"></label><p class="mf-help">一次只轉錄一個檔案。指定時間到達後會加入佇列，等待目前工作完成。</p><p class="mf-help">排程時間使用這台電腦的時區。UFriend 需保持開啟或留在系統匣；關閉期間到期的工作會在下次開啟後排隊。</p>`,btn(tr('取消'),'cancel-media-schedule')+btn(tr('保存排程'),'confirm-media-schedule','calendar-clock','mf-primary'));
  }
  function updateMediaImportUi(){
    for(const button of root.querySelectorAll('[data-action="add-media"],[data-action="choose-media"]'))button.disabled=mediaImporting||ui.busy.has(button.dataset.action+':'+(button.dataset.id||''));
    const confirm=document.querySelector('[data-action="confirm-media-import"]');if(confirm)confirm.disabled=mediaImporting||!ui.modal?.paths?.length;
    for(const field of overlay.querySelectorAll('#upload-language,#upload-source,#upload-transcription,#upload-scheduled-at'))field.disabled=mediaImporting;
    for(const status of root.querySelectorAll('[data-media-import-status]')){status.hidden=!mediaImporting;status.textContent=mediaImporting?tr('正在匯入檔案…'):'';}
    updateFileDragUi();
  }
  function updateFileDragUi(){
    const visible=fileDragDepth>0&&!mediaImporting&&(ui.modal?.type==='upload'||(!ui.modal&&ui.view==='meetings'));
    mediaDragFeedback.hidden=!visible;
    for(const drop of root.querySelectorAll('#meeting-drop-zone,#media-drop')){if(visible)drop.dataset.drag='true';else delete drop.dataset.drag;}
  }
  function resetFileDrag(){fileDragDepth=0;updateFileDragUi();}
  function hasDroppedFiles(event){return [...(event.dataTransfer?.types||[])].includes('Files')||event.dataTransfer?.files?.length>0;}
  function fileDropTarget(event){
    if(ui.modal)return ui.modal.type==='upload'&&overlay.contains(event.target)&&!mediaImporting?'media':null;
    if(ui.view==='meetings')return mediaImporting?null:'media';
    if(ui.view==='ocr')return'ocr';
    if(ui.view==='inbox'&&!ui.mailId)return'mail';
    return null;
  }
  async function importMeetingMedia(args){
    if(mediaImporting)return;
    const upload=ui.modal?.type==='upload'?ui.modal:null;
    mediaImporting=true;resetFileDrag();updateMediaImportUi();
    try{
      const result=await api.call('media.import',args);
      await refresh(false);
      if(ui.view==='meetings'&&!ui.modal)render();
      // An import finishing in the background must not close a newer editor/dialog.
      if(result.imported.length&&upload&&ui.modal===upload)await closeModal();
      if(result.imported.length||result.errors.length){const error=result.errors[0];toast(uiText`${result.imported.length} 個檔案已匯入${error?uiText`；${result.errors.length} 個未匯入：${error.name}（${error.message}）`:''}`+(result.queueError?uiText`；轉錄未排程：${result.queueError}`:''));}
      return result;
    }finally{mediaImporting=false;updateMediaImportUi();}
  }
  async function importDroppedFiles(files,target,language){
    // Convert FileList in the page's world before crossing the isolated preload bridge.
    const paths=api.filePaths(files);
    if(!paths.length){toast(tr('無法讀取拖入的檔案，請從檔案總管拖入本機檔案。'));return;}
    if(target==='media')stageMeetingFiles(paths);
    else if(target==='ocr')await operation('ocr.import',{paths});
    else if(target==='mail')await operation('mail.import',{paths});
  }
  function renderKeepFocus(fn=render){const el=document.activeElement;const state=el?.id&&page.contains(el)?{id:el.id,start:el.selectionStart,end:el.selectionEnd}:null;const scroll=page.scrollTop;fn();page.scrollTop=scroll;if(state){const next=document.getElementById(state.id);if(next){next.focus();try{if(state.start!==null)next.setSelectionRange(state.start,state.end);}catch{}}}}
  async function flushEdits(){if(ui.modal?.sending)throw new Error(tr('郵件正在寄送，請稍候。'));if(ui.modal?.type==='compose')await persistDraft(false);if(ui.view==='ocr')await saveOcr();if(ui.view==='chat')await saveChatDraft();if(ui.view==='translation')await saveTranslation();if(ui.view==='llm-debug')capturePromptDraft();if(ui.view==='settings')capturePersonalProfileDraft();if(ui.view==='polish'){ui.polishRevision++;let revision;do{revision=ui.polishRevision;await savePolish();}while(ui.view==='polish'&&revision!==ui.polishRevision);polishUi.composing=false;}}
  window.flushUFriend=flushEdits;
  async function navigate(view){resetFileDrag();if(ui.modal?.sending)throw new Error(tr('郵件正在寄送，請稍候。'));await flushEdits();if(ui.modal)await closeModal();sourceUi.selections.clear();ui.view=view;ui.mailId=null;ui.selected.clear();ui.policyDraft=null;root.querySelectorAll('[data-nav]').forEach(el=>{if(el.dataset.nav===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});render();page.scrollTop=0;}
  function render(){if(!data)return;if(!ui.mailId){mailBodyController?.dispose();mailBodyController=null;mailBodyKey=null;}updateAppVersion();page.dataset.view=ui.view;setTheme();if(ui.mailId)return renderMail();({home:renderHome,inbox:renderInbox,meetings:renderMeetings,ocr:renderOcr,polish:renderPolish,translation:renderTranslation,chat:renderChat,logs:renderLogs,settings:renderSettings,'llm-debug':renderPromptDebug}[ui.view]||renderHome)();drawIcons();updateSyncButtons();updateModelUi();}

  function syncButton(label=tr('同步'),accountId='',extra=''){
    const busy=!!data.syncing,unavailable=accountId&&!data.accounts.some(a=>a.id===accountId&&a.connected!==false);
    return btn('<span class="mf-sync-indicator" aria-hidden="true">'+ico('refresh-cw')+'</span><span class="mf-sync-label">'+(busy?tr('同步中…'):esc(label))+'</span>',accountId?'sync-account':'sync',null,'mf-sync-button '+extra,(accountId?idAttr(accountId):'')+' data-sync-label="'+esc(label)+'" aria-busy="'+busy+'"'+disabled(busy||unavailable));
  }
  function updateSyncButtons(){
    if(!data)return;
    for(const button of root.querySelectorAll('.mf-sync-button')){
      const accountId=button.dataset.id,busy=!!data.syncing;
      const unavailable=accountId&&!data.accounts.some(a=>a.id===accountId&&a.connected!==false);
      button.disabled=busy||!!unavailable||ui.busy.has(button.dataset.action+':'+(accountId||''));
      button.setAttribute('aria-busy',String(busy));
      const label=button.querySelector('.mf-sync-label');if(label)label.textContent=busy?tr('同步中…'):button.dataset.syncLabel;
    }
  }
  function accountActions(account){return syncButton(tr('同步'),account.id)+btn(account.connected===false?tr('重新連接'):tr('中斷'),account.connected===false?'connect-gmail':'disconnect-gmail',account.connected===false?'link':'unlink','',idAttr(account.id));}

  function setLiveMarkup(element,markup,icons=true){if(element&&element._mfMarkup!==markup){element._mfMarkup=markup;element.innerHTML=markup;if(icons)drawIcons();return true;}return false;}
  function setTaskActions(element,markup){
    if(!element||element._mfMarkup===markup)return false;
    const field=element.querySelector('[data-ai-source-kind]'),actions=element.querySelector('.mf-task-action-items');
    if(!field||!actions)return setLiveMarkup(element,markup);
    const template=document.createElement('template');template.innerHTML=markup;
    const nextField=template.content.querySelector('[data-ai-source-kind]'),nextActions=template.content.querySelector('.mf-task-action-items');
    // Update the next source in place so keyboard selection keeps its focus.
    field.disabled=nextField.disabled;
    for(const name of ['aria-disabled','aria-busy']){const value=nextField.getAttribute(name);if(value===null)field.removeAttribute(name);else field.setAttribute(name,value);}
    field.previousElementSibling.textContent=nextField.previousElementSibling.textContent;
    for(let index=0;index<field.options.length;index++)field.options[index].textContent=nextField.options[index].textContent;
    field.value=nextField.value;
    setLiveMarkup(actions,nextActions.innerHTML);element._mfMarkup=markup;return true;
  }
  function modelSpinner(){return '<span class="mf-progress-indicator" aria-hidden="true">'+ico('loader-circle')+'</span>';}
  function mailCategory(m){return !m.analysisError&&m.analysis?.categoryStatus==='done'&&Object.hasOwn(mailCategories,m.analysis.category)?m.analysis.category:'unclassified';}
  function mailClassifying(m){return m.analysis?.categoryStatus==='pending'&&data.mailAnalysis?.status==='running'&&data.mailAnalysis.currentId===m.id&&data.mailAnalysis.phase==='classification';}
  function mailCategoryBadge(m){const category=mailCategory(m),failed=!!m.analysisError||m.analysis?.categoryStatus==='error',pending=mailClassifying(m),label=category==='unclassified'?tr('未分類'):mailCategories[category];return '<span class="mf-mail-category" data-category="'+category+'" data-category-status="'+(failed?'error':pending?'pending':category==='unclassified'?'empty':'done')+'" title="'+esc(failed?tr('整理未完成，可至收件匣重試'):pending?tr('摘要已完成，正在分類…'):uiText`郵件分類：${label}`)+'">'+esc(label)+(failed?' · '+esc(tr('失敗')):pending?' · '+esc(tr('分類中')):'')+'</span>';}
  function analysisActions(){
    const running=data.mailAnalysis?.status==='running';
    return taskActionMarkup('mail',btn((running?modelSpinner():'')+(running?tr('整理中…'):tr('整理新增／變動郵件')),'analyze',running?'':'sparkles','','aria-busy="'+running+'"'+disabled(taskSourceBusy('mail')))+(running?btn(tr('取消整理'),'cancel-analysis','x','',''+disabled(ui.busy.has('cancel-analysis:'))):'')+taskSourceHint('mail'));
  }
  function analysisProgress(){
    const state=data.mailAnalysis;if(!state||state.status==='idle')return '';
    const failed=state.failed||0,skipped=state.skipped||0,unchanged=state.unchanged||0,current=state.status==='running'&&state.currentId?message(state.currentId):null;
    const unchangedMarkup=unchanged>0?'<span class="mf-sub">'+esc(uiText`已略過 ${unchanged} 封未變動信件`)+'</span>':'';
    if(state.status==='done'&&(state.total||0)===0)return '<div class="mf-analysis-progress" data-status="done" data-phase="'+esc(state.phase||'')+'"><span>'+esc(tr('沒有新增或需要更新的信件'))+'</span>'+unchangedMarkup+'</div>';
    const progress=state.status==='running'?({summary:tr('正在產生摘要'),chunking:tr('正在分段分析'),merging:tr('正在彙整摘要'),classification:tr('正在分類')})[state.phase]||tr('正在整理郵件'):({done:tr('郵件整理完成'),cancelled:tr('已取消整理'),error:tr('郵件整理未完成')})[state.status]||state.status;
    const chunks=state.status==='running'&&state.phase==='chunking'&&Number.isSafeInteger(state.chunkTotal)&&state.chunkTotal>=1&&state.chunkTotal<=128&&Number.isSafeInteger(state.chunkIndex)&&state.chunkIndex>=0&&state.chunkIndex<=state.chunkTotal?'<span class="mf-sub">'+esc(uiText`已完成 ${state.chunkIndex} / ${state.chunkTotal} 段`)+'</span>':'';
    return '<div class="mf-analysis-progress" data-status="'+esc(state.status)+'" data-phase="'+esc(state.phase||'')+'"><span>'+esc(progress)+' · '+(state.processed||0)+' / '+(state.total||0)+tr(' 封</span><span class="mf-sub">失敗 ')+failed+tr(' 封 · 略過 ')+skipped+tr(' 封</span>')+chunks+unchangedMarkup+(current?'<p class="mf-analysis-current">'+esc(uiText`正在處理：${current.subject||tr('（無主旨）')}`)+'</p>':'')+(state.error?'<p class="mf-help">'+esc(tr(state.error))+'</p>':'')+'</div>';
  }
  function analysisScope(){return tr('<p class="mf-mail-organize-scope">逐封產生摘要，再依摘要分類。整理收件匣新增或有變動的郵件，包含已讀及已處理郵件。</p>');}
  function mailPriorityGroup(m){return m.prioritySource!=='manual'&&m.analysis?.quality?.priorityReview===true?'review':Number.isInteger(m.level)&&m.level>=0&&m.level<=2?m.level:null;}
  function mailPriorityOptions(m){const group=mailPriorityGroup(m);return '<option value=""'+selected(group===null||group==='review',true)+'>'+esc(group==='review'?tr('待核對'):tr('待分析'))+'</option>'+levels.map((name,i)=>'<option value="'+i+'"'+selected(group,i)+'>'+esc(name)+'</option>').join('');}
  function mailAnalysisBadges(m){return(m.analysis?.quality?.summaryMode==='source-excerpts'?'<span class="mf-analysis-mode">'+esc(tr('原文摘錄'))+'</span>':'')+(mailPriorityGroup(m)==='review'?'<span class="mf-priority-review">'+esc(tr('待核對'))+'</span>':'');}
  function mailAnalysisResult(m){
    const summary=m.analysis?.summary;
    return tr('<div class="mf-analysis"><div class="mf-content-head"><h2>摘要與分類</h2>')+mailCategoryBadge(m)+'</div>'+(summary?'<p class="mf-analysis-summary">'+esc(summary)+'</p>':tr('<p class="mf-help">尚未產生摘要，可至收件匣整理郵件。</p>'))+'</div>';
  }
  function updateMailAnalysisUi(){
    if(ui.mailId){const m=message(ui.mailId);if(m)setLiveMarkup(document.getElementById('mail-analysis-result'),mailAnalysisResult(m));return;}
    setTaskActions(document.getElementById('mail-analysis-actions'),analysisActions());
    setLiveMarkup(document.getElementById('mail-analysis-progress'),analysisProgress());
  }
  function polishActions(p){const running=p.status==='running';return taskActionMarkup('polish',btn((running?modelSpinner():'')+(running?tr('產生中…'):tr('產生文字')),'polish-start',running?'':'sparkles','','aria-busy="'+running+'"'+disabled(!p.input.trim()||running||polishUi.composing||ui.busy.has('polish-start:')))+(running?btn(tr('取消'),'polish-cancel','x','',''+disabled(ui.busy.has('polish-cancel:'))):'')+btn(tr('複製'),'polish-copy','copy','',disabled(!p.output.trim()))+taskSourceHint('polish'));}
  function updatePolishUi(){
    const input=document.getElementById('polish-input'),output=document.getElementById('polish-output');if(!input||!output)return;
    const p=data.polish,changed=input.value!==p.input||document.getElementById('polish-use').value!==p.use||document.getElementById('polish-tone').value!==p.tone;
    const current=changed||polishUi.sourceDirty||polishUi.outputDirty?{...p,input:input.value,output:polishUi.outputDirty?output.value:'',status:polishUi.outputDirty?(output.value?'manual':'empty'):input.value.trim()?'waiting-model':'empty',error:''}:p;
    output.readOnly=current.status==='running';if(document.activeElement!==output&&output.value!==current.output)output.value=current.output;
    setTaskActions(document.getElementById('polish-actions'),polishActions(current));
    const status=document.getElementById('polish-status');if(status)status.textContent=resultSourceStatus(tr(current.error)||(current.status==='waiting-model'||current.status==='empty'&&current.input.trim()?tr('按下「產生文字」，依用途與語氣產生結果。'):statuses[current.status])||'',current);
  }
  function updateModelUi(){if(!data)return;if(ui.mailId||ui.view==='home'||ui.view==='inbox'){updateMailAnalysisUi();if(!ui.mailId&&ui.view==='inbox')updateInboxResults();}else if(ui.view==='polish')updatePolishUi();else if(ui.view==='translation')updateTranslationUi();else if(ui.view==='llm-debug')updatePromptStatus();else if(ui.view==='chat')updateChatUi();else if(ui.view==='ocr')updateOcrUi();if(ui.view==='meetings'||ui.modal?.type==='media')updateRecordingSourceUi();if(ui.view==='settings'||ui.view==='logs')updateDiagnosticsUi();if(ui.view==='settings'){updatePersonalProfileUi();updateModelDefaultUi();updateMailScheduleUi();}}

  function renderHome(){
    const pending=data.messages.filter(m=>m.folder==='inbox'&&!m.done);
    const mailAction=data.accounts.some(a=>a.connected!==false)?syncButton(tr('同步郵件'),'','mf-primary'):btn(tr('連接信箱'),'mail-settings','mail','mf-primary');
    header(tr('首頁'),`<span class="mf-sub mf-date">${dateLabel()}</span><div id="mail-analysis-actions" class="mf-flex">${analysisActions()}</div>`);
    page.innerHTML=analysisScope()+uiText`<div id="mail-analysis-progress" aria-live="polite">${analysisProgress()}</div><div class="mf-stats"><div class="mf-total"><span class="mf-count">${pending.length}</span><span class="mf-sub">待處理<br>郵件</span></div><div class="mf-stat-items">${levels.map((name,i)=>`<span class="mf-urgency mf-level-${i}"><span class="mf-dot"></span>${name}<strong>${pending.filter(m=>mailPriorityGroup(m)===i).length}</strong></span>`).join('')}</div></div>${pending.length?uiText`<p class="mf-filter-summary">待處理郵件中，未分級 ${pending.filter(m=>mailPriorityGroup(m)===null||mailPriorityGroup(m)==='review').length} 封；分類與優先程度分開呈現。</p>`:empty(tr('尚無待處理郵件'),btn(tr('匯入郵件'),'import-mail','file-up')+mailAction)}${[0,1,2,'review',null].map(level=>{const list=pending.filter(m=>mailPriorityGroup(m)===level);return !list.length?'':`<div class="mf-sectionline"><h2>${level==='review'?tr('待核對'):level===null?tr('待分析'):levels[level]}</h2><span class="mf-count-small">${list.length}</span></div>${list.map(m=>`<button type="button" class="mf-mailcard" data-action="open-mail" ${idAttr(m.id)} data-level="${level??''}"><div class="mf-between"><span class="mf-sub">${esc(m.sender||m.email)}</span><span class="mf-sub">${day(m.date)} ${time(m.date)}</span></div><div class="mf-mailtitle">${esc(m.subject||tr('（無主旨）'))}</div><p class="mf-sub mf-mail-card-summary">${esc((m.analysis?.summary||m.body||'').slice(0,180))}</p><div class="mf-cardfoot"><span class="mf-reason">${m.prioritySource==='manual'?tr('人工分級'):esc(m.analysis?.reason||m.reason||tr('尚未整理'))}</span><span class="mf-mail-card-tags">${mailAnalysisBadges(m)}${mailCategoryBadge(m)}${provider(m.source)}</span></div></button>`).join('')}`;}).join('')}`;
  }
  function visibleMails(){let list=data.messages.filter(m=>ui.folder==='all'||ui.folder==='starred'?ui.folder==='all'||m.star:m.folder===ui.folder);list=list.filter(m=>ui.sources.has(m.source||'本機'));if(ui.query.trim()){const q=ui.query.trim().toLocaleLowerCase();list=list.filter(m=>[m.sender,m.email,m.subject,m.body,m.to,m.cc,m.analysis?.summary,mailCategories[mailCategory(m)]].some(v=>String(v||'').toLocaleLowerCase().includes(q)));}if(ui.category)list=list.filter(m=>mailCategory(m)===ui.category);if(ui.sender)list=list.filter(m=>m.email===ui.sender);if(ui.recentDays){const since=Date.now()-Number(ui.recentDays)*86400000;list=list.filter(m=>new Date(m.date).getTime()>=since);}return list.sort((a,b)=>new Date(b.date)-new Date(a.date));}
  function recentSenders(){const since=Date.now()-30*86400000;const map=new Map();data.messages.filter(m=>new Date(m.date).getTime()>=since).sort((a,b)=>new Date(b.date)-new Date(a.date)).forEach(m=>{if(m.email&&!map.has(m.email))map.set(m.email,m.sender||m.email);});return[...map];}
  function renderInbox(){
    header(tr('郵件收件夾'),syncButton()+btn(tr('匯入'),'import-mail','file-up')+btn(tr('撰寫'),'compose','square-pen','mf-primary'));
    const sources=allSources(data);
    page.innerHTML='<div id="mail-analysis-actions" class="mf-mail-organize-toolbar">'+analysisActions()+'</div>'+analysisScope()+'<div id="mail-analysis-progress" aria-live="polite">'+analysisProgress()+'</div>'+uiText`<div class="mf-searchgrid"><div class="mf-searchwrap">${ico('search')}<input id="mail-query" class="mf-input" placeholder="搜尋郵件文字或寄件者" aria-label="搜尋郵件" value="${esc(ui.query)}"></div><select id="mail-sender" class="mf-input" aria-label="近 30 天的寄件者"><option value="">近 30 天所有寄件者</option>${recentSenders().map(([email,name])=>`<option value="${esc(email)}"${selected(ui.sender,email)}>${esc(name)} · ${esc(email)}</option>`).join('')}</select></div><div class="mf-filters"><div class="mf-flex">${sources.map(source=>`<label class="mf-check"><input type="checkbox" data-source="${esc(source)}"${checked(ui.sources.has(source))}>${provider(source)}</label>`).join('')}</div><div class="mf-flex"><select id="mail-category" class="mf-input mf-compact-select" aria-label="郵件分類"${disabled(ui.folder==='drafts')}><option value="">所有分類</option>${Object.entries(mailCategories).map(([key,name])=>'<option value="'+key+'"'+selected(ui.category,key)+'>'+esc(name)+'</option>').join('')}<option value="unclassified"${selected(ui.category,'unclassified')}>未分類（含未整理與失敗）</option></select><select id="mail-recent" class="mf-input mf-compact-select" aria-label="收信範圍"><option value="">不限日期</option>${[[7,tr('近 7 天')],[30,tr('近 30 天')],[90,tr('近 90 天')]].map(([v,n])=>`<option value="${v}"${selected(ui.recentDays,String(v))}>${n}</option>`).join('')}</select><select id="mail-folder" class="mf-input mf-compact-select" aria-label="郵件資料夾">${Object.entries(folders).map(([key,name])=>`<option value="${key}"${selected(ui.folder,key)}>${name}</option>`).join('')}</select></div></div><div id="mail-results">${inboxResultsMarkup()}</div>`;
  }
  function inboxResultsMarkup(){
    if(ui.folder==='drafts')return renderDrafts();
    const list=visibleMails(),visible=new Set(list.map(m=>m.id));ui.selected=new Set([...ui.selected].filter(id=>visible.has(id)));
    return uiText`<div class="mf-mailtools"><label class="mf-check"><input type="checkbox" id="mail-all" aria-label="選取畫面中的郵件"${checked(list.length>0&&ui.selected.size===list.length)}><span>${ui.selected.size?uiText`已選 ${ui.selected.size} 封`:uiText`${list.length} 封郵件`}</span></label><div class="mf-flex">${icon(tr('標為已讀'),'bulk-read','mail-open',disabled(!ui.selected.size))}${icon(tr('標為未讀'),'bulk-unread','mail',disabled(!ui.selected.size))}${icon(tr('封存'),'bulk-archive','archive',disabled(!ui.selected.size))}${icon(tr('移到垃圾桶'),'bulk-trash','trash-2',disabled(!ui.selected.size))}${icon(tr('移到收件夾'),'bulk-inbox','inbox',disabled(!ui.selected.size))}${icon(tr('標籤與移動'),'bulk-labels','tag',disabled(!ui.selected.size))}</div></div>${list.length?list.map(m=>uiText`<div class="mf-mailrow ${m.read?'':'mf-unread'}"><input type="checkbox" data-select="${esc(m.id)}" aria-label="選取 ${esc(m.subject)}"${checked(ui.selected.has(m.id))}><button type="button" class="mf-rowstar" data-action="star" ${idAttr(m.id)} data-star="${!!m.star}" aria-label="${m.star?tr('移除星號'):tr('加上星號')}">${ico('star')}</button><button type="button" class="mf-rowopen" data-action="open-mail" ${idAttr(m.id)}><span class="mf-subject">${esc(m.sender||m.email)}</span><span class="mf-mail-preview"><span class="mf-mail-preview-subject">${esc(m.subject||tr('（無主旨）'))}</span><span class="mf-mail-summary">${esc(m.analysis?.summary||tr('尚未產生摘要'))}</span>${mailAnalysisBadges(m)}${mailCategoryBadge(m)}</span><span class="mf-rowmeta">${provider(m.source)}<span class="mf-sub">${day(m.date)} ${time(m.date)}</span></span></button></div>`).join(''):empty(tr('目前沒有符合條件的郵件'))}`;
  }
  function updateInboxResults(){
    const results=document.getElementById('mail-results');if(!results)return;
    const active=document.activeElement,focus=results.contains(active)?{id:active.id,action:active.dataset.action,item:active.dataset.id,select:active.dataset.select}:null;
    if(setLiveMarkup(results,inboxResultsMarkup())&&focus){const next=[...results.querySelectorAll('button,input')].find(field=>focus.id?field.id===focus.id:focus.select?field.dataset.select===focus.select:field.dataset.action===focus.action&&field.dataset.id===focus.item);next?.focus({preventScroll:true});}
  }
  function renderDrafts(){
    const drafts=data.drafts.map(d=>({...d,action:'edit-draft',source:d.accountId==='local'?'本機':'Gmail',email:accountLabel(d.accountId)}));
    const keys=new Set(drafts.filter(d=>d.remoteDraftId).map(d=>d.accountId+':'+d.remoteDraftId));
    for(const m of data.messages.filter(m=>m.folder==='drafts'&&m.draftId&&!keys.has(m.accountId+':'+m.draftId)))drafts.push({...m,action:'edit-remote-draft',status:'synced',updatedAt:m.date});
    const query=ui.query.trim().toLocaleLowerCase(),since=ui.recentDays?Date.now()-Number(ui.recentDays)*86400000:0;
    const visible=drafts.filter(d=>ui.sources.has(d.source)&&(!query||[d.subject,d.body,d.to,d.cc,d.email].some(v=>String(v||'').toLocaleLowerCase().includes(query)))&&(!ui.sender||d.email===ui.sender)&&(!since||new Date(d.updatedAt).getTime()>=since)).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
    return visible.length?visible.map(d=>`<div class="mf-mailrow"><span>${ico('file-pen')}</span><span></span><button type="button" class="mf-rowopen" data-action="${d.action}" ${idAttr(d.id)}><span class="mf-subject">${esc(d.to||tr('未填收件者'))}</span><span class="mf-subject">${esc(d.subject||tr('（無主旨）'))}</span><span class="mf-rowmeta">${provider(d.source)}<span class="mf-sub">${d.status==='synced'?tr('已同步'):tr('本機保存')} · ${time(d.updatedAt)}</span></span></button></div>`).join(''):empty(tr('目前沒有符合條件的草稿'),btn(tr('撰寫郵件'),'compose','square-pen'));
  }
  function renderMail(){const m=message(ui.mailId);if(!m){ui.mailId=null;return render();}let markupChanged=header(tr('郵件'),icon(tr('返回'),'mail-back','arrow-left')+icon(m.star?tr('移除星號'):tr('加上星號'),'star','star',idAttr(m.id))+icon(m.read?tr('標為未讀'):tr('標為已讀'),m.read?'mail-unread':'mail-read',m.read?'mail':'mail-open',idAttr(m.id))+icon(tr('封存'),'mail-archive','archive',idAttr(m.id))+icon(tr('移到垃圾桶'),'mail-trash','trash-2',idAttr(m.id)),true);
    const visibleAttachments=(m.attachments||[]).map((a,i)=>({a,i})).filter(({a})=>!(m.html&&(a.inline||a.contentDisposition==='inline')));
    const before=uiText`<h2 class="mf-detail-title">${esc(m.subject||tr('（無主旨）'))}</h2><div class="mf-detailmeta"><span class="mf-avatar">${esc((m.sender||m.email||'?')[0])}</span><div class="mf-grow"><div>${esc(m.sender)} <span class="mf-sub">&lt;${esc(m.email)}&gt;</span></div><p class="mf-sub">收件者：${esc(m.to||tr('未提供'))}</p>${m.cc?uiText`<p class="mf-sub">副本：${esc(m.cc)}</p>`:''}<p class="mf-sub">${day(m.date)} ${time(m.date)}</p></div>${provider(m.source)}</div><div class="mf-detail-tools"><label class="mf-field">優先程度<select class="mf-input mf-compact-select" id="mail-level">${mailPriorityOptions(m)}</select></label><div class="mf-detail-actions">${btn(m.done?tr('恢復待處理'):tr('標記已處理'),'mail-done','check', '',idAttr(m.id))}${btn(tr('標籤／移動'),'mail-labels','tag','',idAttr(m.id))}${btn(tr('垃圾郵件'),'mail-spam','shield-alert','',idAttr(m.id))}${m.folder!=='inbox'?btn(tr('移回收件夾'),'mail-inbox','inbox','',idAttr(m.id)):''}${m.source==='Gmail'?btn(tr('開啟原信'),'mail-source','external-link','',idAttr(m.id)):''}</div></div><div id="mail-analysis-result"></div>${m.labels?.length?`<div class="mf-labels">${m.labels.map(label=>`<span class="mf-labelchip">${esc(typeof label==='object'?label.name:label)}</span>`).join('')}</div>`:''}`,after=`${visibleAttachments.length?`<div class="mf-attachments">${visibleAttachments.map(({a,i})=>btn(esc(a.name),'mail-attachment','paperclip','',`data-index="${i}" ${idAttr(m.id)}`)).join('')}</div>`:''}<div class="mf-flex mf-bottom-space">${btn(tr('回覆'),'reply','reply','mf-primary',idAttr(m.id))}${btn(tr('回覆所有人'),'reply-all','reply-all','',idAttr(m.id))}${btn(tr('轉寄'),'forward','forward','',idAttr(m.id))}</div>`;
    let body=document.getElementById('mail-body-view');
    if(body?.dataset.messageId===m.id){markupChanged=setLiveMarkup(document.getElementById('mail-message-header'),before,false)||markupChanged;markupChanged=setLiveMarkup(document.getElementById('mail-message-footer'),after,false)||markupChanged;}
    else{
      mailBodyController?.dispose();mailBodyController=null;mailBodyKey=null;
      page.innerHTML='<div id="mail-message-header">'+before+'</div><div id="mail-body-view"></div><div id="mail-message-footer">'+after+'</div>';
      body=document.getElementById('mail-body-view');body.dataset.messageId=m.id;
      document.getElementById('mail-message-header')._mfMarkup=before;document.getElementById('mail-message-footer')._mfMarkup=after;markupChanged=true;
    }
    markupChanged=setLiveMarkup(document.getElementById('mail-analysis-result'),mailAnalysisResult(m),false)||markupChanged;
    const contentKey={id:m.id,html:m.html,htmlVersion:m.htmlVersion,body:m.body};
    if(!mailBodyController||Object.keys(contentKey).some(key=>contentKey[key]!==mailBodyKey?.[key])){
      mailBodyController?.dispose();mailBodyKey=contentKey;
      mailBodyController=window.UFriendMailView.mount(body,m,{
        theme:data.settings.theme,
        content:()=>api.call('mail.content',{id:m.id}),image:(source,options={})=>api.call('mail.image',{id:m.id,source,refresh:!!options.refresh}),openLink:href=>api.call('mail.openLink',{id:m.id,href}),
        onContent:value=>{const current=message(m.id);if(current&&ui.mailId===m.id){Object.assign(current,value);mailBodyKey={id:current.id,html:current.html,htmlVersion:current.htmlVersion,body:current.body};renderMail();}}
      });
    }
    if(markupChanged)drawIcons();
  }

  function renderMeetings(){
    header(tr('會議紀錄'),'');
    const counts={running:0,queued:0,scheduled:0};for(const r of data.recordings)if(Object.hasOwn(counts,r.state))counts[r.state]++;
    const summary=counts.running+counts.queued+counts.scheduled?'<p class="mf-recording-queue-status" role="status">'+uiText`轉錄中 ${counts.running} · 排隊中 ${counts.queued} · 已排程 ${counts.scheduled}`+'</p>':'';
    page.innerHTML=meetingImportMarkup()+summary+(data.recordings.length?'':empty(tr('尚無會議紀錄，拖入檔案後會顯示在這裡。')))+data.recordings.map(r=>
      '<div class="mf-meeting" data-action="media-open" '+idAttr(r.id)+'><div class="mf-meeting-fill" style="width:'+Math.max(0,Math.min(100,r.progress||0))+'%"></div><button type="button" class="mf-meeting-open" data-action="media-open" '+idAttr(r.id)+'><span class="mf-fileicon">'+ico(r.type==='video'?'film':'audio-lines')+'</span><span class="mf-filetext"><h3>'+esc(r.name)+'</h3><span class="mf-filemeta"><span>'+sizes(r.size)+'</span><span>'+langNames[r.lang]+'</span><span>'+recordingStateLabel(r)+'</span>'+(r.state==='running'?'<span>'+Math.round(r.progress||0)+'%</span>':'')+(r.transcriptSource==='model'?resultSourceBadge(r.meta):'')+'</span>'+(r.error?'<span class="mf-help">'+esc(tr(r.error))+'</span>':'')+videoExportCardStatus(r)+(r.state==='error'&&r.processedSeconds?'<span class="mf-help">'+uiText`已處理至 ${Math.floor(r.processedSeconds/60)} 分 ${Math.floor(r.processedSeconds%60)} 秒，尚未完成整份轉錄。`+'</span>':'')+'</span></button><div class="mf-meeting-controls"><div class="mf-fileactions">'+recordingSourceControl(r)+recordingWorkActions(r,true)+icon(tr('查看內容'),'media-open','file-text',idAttr(r.id))+icon(tr('移除紀錄'),'media-remove','trash-2',idAttr(r.id))+'</div><div data-recording-source-hint="'+esc(r.id)+'">'+sourceHint('whisper',recordingSource(r))+'</div></div></div>'
    ).join('');updateMediaImportUi();
  }
  function ocrActions(o){return taskActionMarkup('ocr',btn(tr('開始識別'),'ocr-start','scan-text','',disabled(!o.imageId||o.status==='running'||ui.busy.has('ocr-start:')))+(o.status==='running'?btn(tr('取消'),'ocr-cancel','x'):'')+btn(tr('清除'),'ocr-clear','x','',disabled(!o.imageId&&!o.text))+taskSourceHint('ocr'));}
  function updateOcrUi(){
    const output=document.getElementById('ocr-text');if(!output)return;
    const o=data.ocr,wasReadOnly=output.readOnly;output.readOnly=o.status==='running';
    if((document.activeElement!==output||output.readOnly||wasReadOnly)&&output.value!==o.text)output.value=o.text;
    setTaskActions(document.getElementById('ocr-actions'),ocrActions(o));
    const status=document.getElementById('ocr-status');if(status)status.textContent=resultSourceStatus(tr(o.error)||statuses[o.status]||'',o);
    const copy=document.querySelector('[data-action="ocr-copy"]');if(copy)copy.disabled=!output.value.trim();
  }
  function renderOcr(){
    const o=data.ocr;header(tr('OCR 文字識別'),btn(tr('匯入圖片'),'ocr-import','image-up'));
    page.innerHTML=tr('<div class="mf-toolrow"><span class="mf-shortcut">Windows 截圖：Win + Shift + S</span><label class="mf-auto-switch"><input id="ocr-auto" type="checkbox"')+checked(data.settings.ocrAuto)+tr('>自動接收剪貼簿圖片</label></div><div class="mf-ocr-grid"><div><div class="mf-content-head"><h2>來源圖片</h2>')+btn(tr('讀取剪貼簿'),'ocr-capture','clipboard-paste')+'</div>'+
      (o.imageId?tr('<button type="button" class="mf-imagebox" data-action="ocr-image" aria-label="放大來源圖片"><img src="')+assetUrl(o.imageId)+tr('" alt="目前 OCR 來源圖片"></button><p class="mf-sourceinfo">')+esc(o.imageName||tr('圖片'))+'</p>':tr('<div class="mf-ocr-empty"><p>截圖後可在此讀取，或匯入圖片。</p></div>'))+
      '<p class="mf-help">'+(data.settings.ocrAuto?(data.clipboard.status==='listening'?tr('正在背景接收新的剪貼簿圖片。'):tr('背景接收狀態：')+clipboardStatusLabel()):tr('自動接收已關閉；手動讀取仍可使用。'))+'</p><p class="mf-help mf-ocr-auto-source">'+esc(tr('自動識別只使用本地模型；下方來源選擇僅用於手動識別。'))+'</p><div class="mf-save-row" id="ocr-actions">'+ocrActions(o)+tr('</div></div><div><div class="mf-content-head"><h2>文字結果</h2>')+btn(tr('複製'),'ocr-copy','copy','',disabled(!o.text.trim()))+tr('</div><textarea class="mf-input mf-result-area" id="ocr-text" aria-label="OCR 文字結果" placeholder="辨識後可在這裡校對文字，再複製使用。"')+(o.status==='running'?' readonly':'')+'>'+esc(o.text)+'</textarea><p id="ocr-status" class="mf-toolstatus" aria-live="polite">'+esc(o.error||statuses[o.status]||'')+'</p></div></div>';
  }
  function clipboardStatusLabel(){return({listening:tr('接收中'),disabled:tr('已關閉'),starting:tr('啟動中'),unavailable:tr('通知元件未建置'),unsupported:tr('此系統不支援'),error:tr('接收失敗，請關閉後再啟用'),'test-disabled':tr('測試期間停用')})[data.clipboard.status]||data.clipboard.status;}
  function renderCredentialNotice(){if(!data.secrets.error)return;const notice=document.createElement('div');notice.className='mf-notice';notice.setAttribute('role','status');notice.innerHTML=uiText`<p>${esc(data.secrets.error)} 本機檔案仍可使用。</p><div class="mf-save-row">${btn(tr('重設憑證'),'reset-secrets','key-round')}</div>`;page.prepend(notice);}
  function updateAccountStatus(){for(const a of data.accounts){const card=[...page.querySelectorAll('[data-account-id]')].find(el=>el.dataset.accountId===a.id);if(!card)continue;const status=card.querySelector('.mf-accountname .mf-sub');if(status)status.textContent=(a.connected===false?tr('已中斷連接'):a.lastSyncAt?tr('上次同步 ')+day(a.lastSyncAt)+' '+time(a.lastSyncAt):tr('尚未同步'))+(a.error?' · '+a.error:'');const buttons=card.querySelector(':scope > .mf-flex'),connection=buttons?.querySelector('[data-action="connect-gmail"],[data-action="disconnect-gmail"]');if(buttons&&connection?.dataset.action!==(a.connected===false?'connect-gmail':'disconnect-gmail'))buttons.innerHTML=accountActions(a);}updateSyncButtons();drawIcons();}
  function chatMessages(){
    const chat=data.chat;
    const rows=chat.messages.map(message=>'<article class="mf-chat-message mf-chat-'+message.role+'"><div class="mf-chat-message-head"><strong>'+esc(message.role==='user'?tr('你'):'UFriend')+'</strong>'+(message.role==='assistant'?resultSourceBadge(message.meta)+icon(tr('複製回覆'),'chat-copy','copy',idAttr(message.id)):'')+'</div><div class="mf-chat-text">'+esc(message.content)+'</div></article>').join('');
    const pending=chat.pendingText?tr('<article class="mf-chat-message mf-chat-user"><div class="mf-chat-message-head"><strong>你</strong></div><div class="mf-chat-text">')+esc(chat.pendingText)+'</div></article>':'';
    const streaming=chat.status==='running'?'<article id="chat-stream-message" class="mf-chat-message mf-chat-assistant mf-chat-streaming" data-conversation-id="'+esc(activeChatId()||'')+'" data-stream-id="'+esc(chat.streamId||'')+tr('" aria-busy="true" aria-live="off"><div class="mf-chat-message-head"><strong>UFriend</strong><span class="mf-chat-stream-label">生成中 · 尚未完成</span></div><div id="chat-stream-text" class="mf-chat-text"></div><div id="chat-stream-waiting" class="mf-chat-pending mf-chat-stream-waiting">')+modelSpinner()+tr('正在思考…</div></article>'):'';
    return rows+pending+streaming||'<div class="mf-chat-empty"><span class="mf-chat-symbol">'+ico('messages-square')+tr('</span><h2>想聊些什麼？</h2><p>問一個問題，或接著上一個回答繼續聊。</p></div>');
  }
  const activeChatId=()=>data.chatHistory?.activeId;
  const chatConversations=()=>data.chatHistory?.conversations||[];
  function currentChatIsEmpty(){const chat=data?.chat;if(!chat)return true;const input=ui.view==='chat'?document.getElementById('chat-input'):null,draft=input?input.value:chat.draft||'';return!chat.messages?.length&&!draft.trim()&&!chat.pendingText?.trim()&&chat.status!=='running';}
  function chatFollowsLatest(log){const selection=window.getSelection();return log.scrollHeight-log.clientHeight-log.scrollTop<80&&!(selection&&!selection.isCollapsed&&log.contains(selection.anchorNode));}
  function updateChatStreamText(follow){
    const chat=data?.chat,log=document.getElementById('chat-log'),bubble=document.getElementById('chat-stream-message'),text=document.getElementById('chat-stream-text');
    if(ui.view!=='chat'||chat?.status!=='running'||!log||!bubble||!text||bubble.dataset.conversationId!==String(activeChatId()||'')||bubble.dataset.streamId!==String(chat.streamId||''))return;
    const value=typeof chat.partialText==='string'?chat.partialText:'';if(text.textContent===value)return;
    const keepFollowing=follow??chatFollowsLatest(log),scroll=log.scrollTop;
    text.textContent=value;
    const waiting=document.getElementById('chat-stream-waiting');if(waiting)waiting.hidden=!!value;
    if(keepFollowing)log.scrollTop=log.scrollHeight;else log.scrollTop=scroll;
  }
  function receiveChatStream(payload){
    const chat=data?.chat;
    if(!payload||chat?.status!=='running'||typeof payload.conversationId!=='string'||payload.conversationId!==activeChatId()||typeof payload.streamId!=='string'||!payload.streamId||payload.streamId!==chat.streamId||typeof payload.partialText!=='string'||payload.partialText.length>16000)return;
    const previous=typeof chat.partialText==='string'?chat.partialText:'';
    if(!payload.partialText.startsWith(previous)||payload.partialText===previous)return;
    chat.partialText=payload.partialText;
    updateChatStreamText();
  }
  function chatHistoryRows(){
    return chatConversations().map(entry=>{
      const active=entry.id===activeChatId(),rounds=Math.floor((entry.chat?.messages?.length||0)/2),draft=!!entry.chat?.draft?.trim();
      return '<div class="mf-chat-history-row" data-current="'+active+'"><button type="button" class="mf-chat-history-select" data-action="chat-select" '+idAttr(entry.id)+tr(' aria-label="開啟對話：')+esc(entry.title)+'"'+(active?' aria-current="true"':'')+disabled(chatControlsBusy())+'><span class="mf-chat-history-title">'+esc(entry.title)+'</span><span class="mf-chat-history-meta">'+day(entry.updatedAt)+' · '+rounds+tr(' 輪')+(draft?tr(' · 草稿'):'')+'</span></button><div class="mf-chat-history-tools">'+icon(tr('重新命名對話：')+entry.title,'chat-rename','pencil',idAttr(entry.id)+disabled(chatControlsBusy()))+icon(tr('刪除對話：')+entry.title,'chat-delete','trash-2',idAttr(entry.id)+disabled(chatControlsBusy()))+'</div></div>';
    }).join('')||tr('<p class="mf-help">新增一段對話，聊天內容會保存在這台電腦。</p>');
  }
  function updateChatHistoryUi(){
    const layout=document.getElementById('chat-layout'),panel=document.getElementById('chat-history-panel'),list=document.getElementById('chat-history-list');if(!layout||!panel||!list)return;
    layout.dataset.historyOpen=String(ui.chatHistoryOpen);panel.hidden=!ui.chatHistoryOpen;
    const scroll=list.scrollTop,focused=list.contains(document.activeElement)?{action:document.activeElement.dataset.action,id:document.activeElement.dataset.id}:null;
    setLiveMarkup(list,chatHistoryRows());list.scrollTop=scroll;
    if(focused){const next=[...list.querySelectorAll('[data-action]')].find(button=>button.dataset.action===focused.action&&button.dataset.id===focused.id);if(next&&document.activeElement!==next)next.focus({preventScroll:true});}
    const toggle=top.querySelector('[data-action="chat-history-toggle"]');if(toggle)toggle.setAttribute('aria-expanded',String(ui.chatHistoryOpen));
    const create=top.querySelector('[data-action="chat-new"]');if(create)create.disabled=chatControlsBusy()||ui.busy.has('chat-new:')||currentChatIsEmpty();
    const current=document.getElementById('chat-current-title');if(current)current.textContent=chatConversations().find(entry=>entry.id===activeChatId())?.title||tr('新對話');
  }
  function updateChatUi(){
    const input=document.getElementById('chat-input'),log=document.getElementById('chat-log');if(!input||!log)return;
    const chat=data.chat,running=chat.status==='running',follow=chatFollowsLatest(log),scroll=log.scrollTop,previousStatus=log.dataset.chatStatus;
    log.dataset.chatStatus=chat.status;log.dataset.streaming=String(running);
    setLiveMarkup(log,chatMessages());updateChatStreamText(false);if(follow)log.scrollTop=log.scrollHeight;else log.scrollTop=scroll;
    input.readOnly=running||chatControlsBusy();if(running||previousStatus==='running'||document.activeElement!==input)input.value=chat.draft;
    const status=document.getElementById('chat-status');if(status)status.textContent=tr(chat.error)||(chat.status==='cancelled'?tr('已停止產生回覆，問題已保留。'):'');
    const details=document.getElementById('chat-error-details');if(details){const parts=[];if(typeof chat.errorCode==='string'&&chat.errorCode.trim())parts.push(tr('錯誤代碼：')+chat.errorCode.trim().slice(0,100));if(typeof chat.errorRequestId==='string'&&chat.errorRequestId.trim())parts.push(tr('請求 ID：')+chat.errorRequestId.trim().slice(0,120));details.textContent=parts.join(' · ');details.hidden=!parts.length;}
    setTaskActions(document.getElementById('chat-actions'),taskActionMarkup('chat',(running?btn(tr('停止產生'),'chat-cancel','square','',disabled(chatControlsBusy())):btn(tr('傳送'),'chat-send','arrow-up','mf-primary',disabled(chatControlsBusy()||!input.value.trim()||ui.busy.has('chat-send:'))))+taskSourceHint('chat')));
    updateChatHistoryUi();
  }
  function renderChat(){
    const label=(full,compact)=>'<span class="mf-chat-action-label">'+full+'</span><span class="mf-chat-action-compact" aria-hidden="true">'+compact+'</span>';
    header(tr('LLM 對話'),btn(label(tr('聊天紀錄'),tr('紀錄')),'chat-history-toggle','panel-left','',tr('aria-label="聊天紀錄" title="聊天紀錄" aria-controls="chat-history-panel" aria-expanded="')+ui.chatHistoryOpen+'"')+btn(label(tr('新增對話'),tr('新增')),'chat-new','plus','',tr('aria-label="新增對話" title="新增對話"')+disabled(chatControlsBusy()||ui.busy.has('chat-new:')||currentChatIsEmpty())));
    page.innerHTML='<div id="chat-layout" class="mf-chat-layout" data-history-open="'+ui.chatHistoryOpen+tr('"><aside id="chat-history-panel" class="mf-chat-history" aria-label="已保存的聊天紀錄"')+(ui.chatHistoryOpen?'':' hidden')+tr('><div class="mf-chat-history-head"><h2>聊天紀錄</h2><span class="mf-sub">保存在本機</span></div><div id="chat-history-list" class="mf-chat-history-list"></div></aside><section class="mf-chat"><h2 id="chat-current-title" class="mf-chat-current-title"></h2><div class="mf-chat-log" id="chat-log" role="log" aria-label="對話內容" aria-live="polite">')+chatMessages()+tr('</div><div class="mf-chat-compose"><label class="mf-sr-only" for="chat-input">輸入問題</label><textarea class="mf-input mf-chat-input" id="chat-input" maxlength="16000" rows="3" placeholder="輸入問題…"')+(data.chat.status==='running'?' readonly':'')+'>'+esc(data.chat.draft)+tr('</textarea><div class="mf-chat-compose-foot"><span class="mf-sub">Enter 傳送 · Shift + Enter 換行</span><div id="chat-actions"></div></div><p id="chat-status" class="mf-help" role="status"></p><p id="chat-error-details" class="mf-chat-error-details" hidden></p></div></section></div>');
    updateChatUi();const log=document.getElementById('chat-log');log.scrollTop=log.scrollHeight;
  }
  async function saveChatDraft(){
    clearTimeout(chatTimer);const input=document.getElementById('chat-input');if(!input||input.readOnly)return chatSaveQueue;
    const text=input.value,id=activeChatId();chatSaveQueue=chatSaveQueue.catch(()=>{}).then(()=>id!==activeChatId()?{skipped:true}:api.call('chat.save',{text,...(id?{id}:{})}));return chatSaveQueue;
  }
  async function sendChat(){
    const input=document.getElementById('chat-input');if(!input||input.readOnly||chatControlsBusy()||!input.value.trim())return;
    const text=input.value,id=activeChatId(),source=selectedTaskSource('chat');await saveChatDraft();if(chatControlsBusy()||id!==activeChatId())return;
    try{await api.call('chat.send',{text,source,...(id?{id}:{})});}finally{if(id===activeChatId()){await refresh(false);if(id===activeChatId()&&ui.view==='chat'&&!ui.modal){const composer=document.getElementById('chat-input');if(composer)composer.value=data.chat.draft;updateChatUi();composer?.focus();}}}
  }
  async function changeChatConversation(action,args={}){
    if(chatControlsBusy()||action==='chat.new'&&currentChatIsEmpty())return;
    const saving=saveChatDraft();ui.chatHistoryBusy=true;updateChatUi();
    try{
      await saving;await api.call(action,args);if(action==='chat.new'||action==='chat.select')resetTaskSource('chat');await refresh(false);
      if(window.innerWidth<=960||window.innerHeight<=620)ui.chatHistoryOpen=false;
    }finally{
      ui.chatHistoryBusy=false;
      if(ui.view==='chat'&&!ui.modal){renderChat();drawIcons();document.getElementById('chat-input')?.focus();}
    }
  }
  function renderPolish(){if(document.getElementById('polish-input')&&(polishUi.sourceDirty||polishUi.outputDirty||polishUi.composing)){updatePolishUi();return;}const p=data.polish;header(tr('文章潤句'));page.innerHTML=uiText`<div class="mf-polish-options"><label class="mf-field">用途<select id="polish-use" class="mf-input">${Object.entries(uses).map(([v,n])=>`<option value="${v}"${selected(p.use,v)}>${n}</option>`).join('')}</select></label><label class="mf-field">語氣<select id="polish-tone" class="mf-input">${Object.entries(tones).map(([v,n])=>`<option value="${v}"${selected(p.tone,v)}>${n}</option>`).join('')}</select></label></div><div class="mf-polish-block"><div class="mf-content-head"><h2>想表達的內容</h2></div><textarea id="polish-input" class="mf-input mf-polish-input" placeholder="例如：提醒老闆明天要開會">${esc(p.input)}</textarea></div><div class="mf-polish-block"><div class="mf-content-head"><h2>潤句結果</h2><div id="polish-actions" class="mf-flex">${polishActions(p)}</div></div><textarea id="polish-output" class="mf-input mf-polish-output" placeholder="按下「產生文字」後，結果會顯示在這裡。" aria-label="潤句結果"${p.status==='running'?' readonly':''}>${esc(p.output)}</textarea><p id="polish-status" class="mf-toolstatus" aria-live="polite">${esc(p.error||statuses[p.status]||'')}</p></div>`;}
  const translationState=()=>data.translation||{input:'',sourceLanguage:'auto',targetLanguage:'zh-TW',output:'',status:'empty',error:''};
  function translationActions(t){const running=t.status==='running';return taskActionMarkup('translation',btn((running?modelSpinner():'')+(running?tr('翻譯中…'):tr('開始翻譯')),'translation-start',running?'':'languages','mf-primary','aria-busy="'+running+'"'+disabled(!t.input.trim()||running||ui.busy.has('translation-start:')))+(running?btn(tr('取消'),'translation-cancel','x','',disabled(ui.busy.has('translation-cancel:'))):'')+btn(tr('複製譯文'),'translation-copy','copy','',disabled(running||!t.output.trim())));}
  function translationForm(){const input=document.getElementById('translation-input'),source=document.getElementById('translation-source'),target=document.getElementById('translation-target');return input&&source&&target?{input:input.value,sourceLanguage:source.value,targetLanguage:target.value}:null;}
  function updateTranslationUi(){
    const patch=translationForm(),input=document.getElementById('translation-input'),output=document.getElementById('translation-output');if(!patch||!output)return;
    const saved=translationState(),changed=Object.entries(patch).some(([key,value])=>saved[key]!==value);
    const current=changed?{...saved,...patch,output:'',status:patch.input.trim()?'waiting-model':'empty',error:''}:saved;
    const running=current.status==='running';input.readOnly=running;
    document.getElementById('translation-source').disabled=running;document.getElementById('translation-target').disabled=running;
    if(output.value!==current.output)output.value=current.output;
    setTaskActions(document.getElementById('translation-actions'),translationActions(current));
    setLiveMarkup(document.getElementById('translation-source-hint'),taskSourceHint('translation'));
    const status=document.getElementById('translation-status');if(status){status.textContent=resultSourceStatus(tr(current.error)||({empty:tr('輸入文字並選擇語言，開始翻譯。'),'waiting-model':tr('按下「開始翻譯」產生譯文。'),running:tr('正在翻譯，完成後可複製譯文。'),cancelled:tr('已取消翻譯，原文已保留。'),done:tr('翻譯完成。')})[current.status]||statuses[current.status]||'',current);status.dataset.state=current.error?'unavailable':current.status;}
    const count=document.getElementById('translation-count');if(count)count.textContent=patch.input.length.toLocaleString()+' / 16,000';
  }
  function renderTranslation(){
    const t=translationState(),options=(value,target=false)=>Object.entries(translationLanguages).filter(([key])=>!target||key!=='auto').map(([key,label])=>'<option value="'+key+'"'+selected(value,key)+'>'+esc(label)+'</option>').join('');
    header(tr('文字翻譯'));
    page.innerHTML=tr('<div class="mf-translation-options"><label class="mf-field" for="translation-source">來源語言<select id="translation-source" class="mf-input">')+options(t.sourceLanguage)+tr('</select></label><label class="mf-field" for="translation-target">目標語言<select id="translation-target" class="mf-input">')+options(t.targetLanguage,true)+tr('</select></label></div><div class="mf-translation-grid"><section class="mf-translation-column"><div class="mf-content-head"><h2><label for="translation-input">原文</label></h2><span id="translation-count" class="mf-sub"></span></div><textarea id="translation-input" class="mf-input mf-translation-text" maxlength="16000" placeholder="貼上或輸入想翻譯的文字…">')+esc(t.input)+tr('</textarea></section><section class="mf-translation-column"><div class="mf-content-head"><h2><label for="translation-output">譯文</label></h2></div><textarea id="translation-output" class="mf-input mf-translation-text" readonly placeholder="翻譯結果會顯示在這裡。">')+esc(t.output)+'</textarea></section></div><div class="mf-translation-footer"><p id="translation-status" class="mf-toolstatus" role="status"></p><div id="translation-actions" class="mf-flex">'+translationActions(t)+'</div><div id="translation-source-hint">'+taskSourceHint('translation')+'</div></div>';
    updateTranslationUi();
  }
  async function saveTranslation(){
    clearTimeout(translationTimer);const patch=translationForm();if(!patch||document.getElementById('translation-input').readOnly)return translationSaveQueue;
    translationSaveQueue=translationSaveQueue.catch(()=>{}).then(()=>api.call('translation.save',patch));return translationSaveQueue;
  }
  function translationEdited(){
    const patch=translationForm();if(!patch)return;ui.translationRevision++;
    data.translation={...translationState(),...patch,output:'',status:patch.input.trim()?'waiting-model':'empty',error:''};updateTranslationUi();
    clearTimeout(translationTimer);translationTimer=setTimeout(()=>saveTranslation().catch(error=>toast(error.message)),450);
  }
  async function startTranslation(){
    if(data.translation?.status==='running')return;
    const revision=ui.translationRevision,source=selectedTaskSource('translation');await saveTranslation();if(revision!==ui.translationRevision)return;
    try{await api.call('translation.start',{source});}finally{await refresh(false);if(ui.view==='translation'&&!ui.modal)updateTranslationUi();}
  }
  function renderDiagnosticsPanel(){return tr('<section id="diagnostics-panel" class="mf-settingsection mf-diagnostics-panel"><div class="mf-diagnostics-heading"><h2>診斷紀錄</h2><div class="mf-flex">')+btn(tr('開啟診斷位置'),'diagnostics-open','folder-open')+btn(tr('匯出診斷紀錄'),'diagnostics-export','download')+tr('</div></div><p class="mf-help">查看程式與模型的執行狀態，協助排查問題。</p><p class="mf-diagnostics-path"><span class="mf-sub">保存位置</span><code id="diagnostics-directory"></code></p><p id="diagnostics-retention" class="mf-help"></p><p id="diagnostics-status" class="mf-diagnostics-status" role="status" aria-live="polite"></p></section>');}
  function updateDiagnosticsUi(){
    const panel=document.getElementById('diagnostics-panel');if(!panel)return;
    const info=data?.diagnostics,directory=typeof info?.directory==='string'?info.directory:'',error=typeof info?.error==='string'?info.error:'',retainedFiles=info?.retainedFiles,maxBytes=info?.maxBytes;
    document.getElementById('diagnostics-directory').textContent=directory||tr('尚未取得診斷位置');
    document.getElementById('diagnostics-retention').textContent=Number.isSafeInteger(retainedFiles)&&retainedFiles>0&&Number.isSafeInteger(maxBytes)&&maxBytes>0?tr('最多保留 ')+retainedFiles+tr(' 個檔案（含目前檔案），每檔上限 ')+sizes(maxBytes)+tr('；超過上限時自動輪替。'):tr('尚未取得保留設定。');
    const status=document.getElementById('diagnostics-status');status.textContent=error||(!directory?tr('診斷紀錄尚未就緒。'):'');status.hidden=!status.textContent;panel.dataset.status=error?'error':directory?'ready':'unavailable';
    for(const button of panel.querySelectorAll('[data-action]'))button.disabled=!directory||ui.busy.has(button.dataset.action+':');
  }
  function rendererErrorPayload(error,kind,line,column){
    let name,code;try{name=error?.name;}catch{}try{code=error?.code;}catch{}
    const position=value=>Number.isSafeInteger(value)&&value>=0&&value<=10000000?value:0;
    return{errorName:rendererErrorNames.has(name)?name:'Error',code:typeof code==='string'&&(/^MODEL_[A-Z0-9_]{1,80}$/.test(code)||code==='RENDERER_ERROR'||code==='UNHANDLED_REJECTION')?code:kind==='UNHANDLED_REJECTION'?'UNHANDLED_REJECTION':'RENDERER_ERROR',line:position(line),column:position(column)};
  }
  function reportRendererException(error,kind,line,column){
    if(!api||rendererReports.inFlight)return;
    try{
      const payload=rendererErrorPayload(error,kind,line,column),now=Date.now(),key=[payload.errorName,payload.code,payload.line,payload.column].join(':');
      rendererReports.sent=rendererReports.sent.filter(at=>now-at<60000);
      for(const [entry,at] of rendererReports.recent)if(now-at>=10000)rendererReports.recent.delete(entry);
      if(rendererReports.sent.length>=10||rendererReports.recent.has(key))return;
      rendererReports.recent.set(key,now);rendererReports.sent.push(now);rendererReports.inFlight=true;
      Promise.resolve().then(()=>api.call('diagnostics.report',payload)).then(()=>{rendererReports.inFlight=false;},()=>{rendererReports.inFlight=false;});
    }catch{rendererReports.inFlight=false;}
  }
  function renderLogs(){header(tr('系統紀錄'),btn(tr('匯出紀錄'),'logs-export','download'));let last='';page.innerHTML=renderDiagnosticsPanel()+(data.logs.length?data.logs.map(log=>{const stamp=log.createdAt||log.timestamp||log.date||new Date().toISOString();const date=day(stamp);let heading='';if(date!==last){last=date;heading=`<p class="mf-logdate">${date}</p>`;}return`${heading}<div class="mf-logrow"><time class="mf-logtime">${time(stamp)||esc(log.time||'')}</time><div><p>${esc(log.text||log.message||log.action)}</p>${log.detail?`<p class="mf-sub">${esc(log.detail)}</p>`:''}<span class="mf-sub">${({success:tr('完成'),error:tr('失敗'),blocked:tr('等待接入'),partial:tr('部分完成'),started:tr('開始')})[log.status]||''}</span></div></div>`;}).join(''):empty(tr('尚無系統紀錄')));updateDiagnosticsUi();}

  function googleButton(label=tr('使用 Google 帳號連接'),attrs=''){return '<button type="button" class="mf-action mf-google-button" data-action="connect-gmail" '+attrs+'><img class="mf-google-mark" src="assets/google-g.png" alt="" width="20" height="20">'+esc(label)+'</button>';}
  function renderGmailSettings(){
    const s=data.settings,auth=data.gmailAuth||{};
    return tr('<section class="mf-settingsection" id="gmail-settings"><h2>郵件帳戶</h2>')+
      tr('<div class="mf-gmail-connect"><div><strong>連接你的 Gmail</strong><p class="mf-help">在 Google 官方頁面選擇帳號並同意授權，UFriend 就會開始同步郵件。</p></div>')+googleButton(data.accounts.length?tr('連接另一個 Google 帳號'):undefined)+
      '<p class="mf-help">'+(auth.configured?tr('Google 連接已就緒。授權資料會加密保存在這台電腦。'):tr('此開發版本尚未完成首次設定。設定一次後，使用者就能直接登入。'))+'</p>'+(!auth.configured?btn(tr('首次設定說明'),'gmail-setup','circle-help'):'')+'</div>'+
      data.accounts.map(a=>'<div class="mf-account" data-account-id="'+esc(a.id)+'"><div class="mf-accountname"><span class="mf-mailmark">G</span><div><span>'+esc(a.email||'Gmail')+'</span><p class="mf-sub">'+esc(a.connected===false?tr('已中斷連接'):a.lastSyncAt?tr('上次同步 ')+day(a.lastSyncAt)+' '+time(a.lastSyncAt):tr('尚未同步'))+(a.error?' · '+esc(a.error):'')+'</p></div></div><div class="mf-flex">'+accountActions(a)+'</div></div>').join('')+
      tr('<details class="mf-gmail-sync"><summary>同步偏好</summary><div class="mf-cloudfields"><label class="mf-field">首次同步最近幾天<input id="gmail-days" class="mf-input" type="number" min="1" max="3650" value="')+s.initialDays+tr('"></label><label class="mf-field">自動同步間隔（分鐘）<input id="gmail-interval" class="mf-input" type="number" min="1" max="1440" value="')+s.syncMinutes+'"></label></div><div class="mf-save-row">'+btn(tr('保存同步偏好'),'save-gmail-sync','save')+'</div></details>'+
      tr('<details id="gmail-advanced" class="mf-gmail-advanced"><summary>進階設定（開發者）</summary><p class="mf-help">')+(auth.source==='bundled'?tr('目前使用此版本內建的 Google 連接設定。'):auth.hasOverride?tr('目前使用這台電腦匯入或手動設定的 Google 用戶端。'):tr('首次啟用時，由開發者建立 Google 用戶端並匯入設定檔。'))+tr(' 一般使用者不需要調整這裡。</p>')+(auth.error?'<p class="mf-notice">'+esc(auth.error)+'</p>':'')+
      '<div class="mf-flex">'+btn(tr('匯入 Google 設定檔'),'gmail-import-config','file-up')+btn(tr('首次設定說明'),'gmail-setup','circle-help')+tr('</div><details class="mf-gmail-manual"><summary>手動填寫 Client ID</summary><label class="mf-field">Google Desktop OAuth Client ID<input class="mf-input" id="gmail-client-id" value="')+esc(s.gmailClientId)+tr('" placeholder="…apps.googleusercontent.com" autocomplete="off"></label><label class="mf-field">Client Secret（Google 提供時填入）<input class="mf-input" id="gmail-client-secret" type="password" placeholder="')+(data.secrets.gmailSecretSet?tr('同一 Client ID 留空表示保留'):tr('未設定'))+'" autocomplete="off"></label><div class="mf-save-row">'+btn(tr('保存開發者設定'),'save-gmail','save')+'</div></details>'+
      (auth.hasOverride?'<div class="mf-save-row">'+btn(auth.bundledConfigured?tr('恢復此版本的預設設定'):tr('清除本機連接設定'),'gmail-clear-config','rotate-ccw')+'</div>':'')+'</details>'+
      [['Outlook','O'],['Yahoo Mail','Y'],[tr('其他郵件'),'＋']].map(([name,mark])=>'<div class="mf-account"><div class="mf-accountname"><span class="mf-mailmark">'+mark+'</span>'+name+tr('</div><span class="mf-sub">待開發</span></div>')).join('')+'</section>'+renderMailScheduleSettings();
  }
  function mailScheduleSettings(){return{enabled:data.settings.mailSchedule?.enabled===true,time:data.settings.mailSchedule?.time||'09:00'};}
  function renderMailScheduleSettings(){
    const schedule=mailScheduleSettings(),zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    return uiText`<section id="mail-schedule-settings" class="mf-settingsection"><h2>每日郵件整理</h2><p class="mf-help">逐封產生摘要，再依摘要分類；只整理收件匣新增或有變動的郵件，包含已讀及已處理郵件。</p><div id="mail-schedule-form" class="mf-mail-schedule-form"><label class="mf-auto-switch"><input id="mail-schedule-enabled" type="checkbox"${checked(schedule.enabled)}>每天自動整理郵件</label><div class="mf-mail-schedule-time"><label class="mf-field" for="mail-schedule-time">每天整理時間<input id="mail-schedule-time" class="mf-input" type="time" step="60" value="${esc(schedule.time)}" required></label>${btn(tr('保存每日整理'),'save-mail-schedule','calendar-clock','mf-primary')}</div><p id="mail-schedule-save-status" class="mf-help" role="status" hidden></p></div><p class="mf-help">${esc(uiText`時間依這台電腦的時區（${zone}）。`)}</p><p class="mf-help">UFriend 需保持開啟或留在系統匣。關機或休眠錯過時間，恢復後只補當日一次，不會補跑多天。</p><p id="mail-schedule-source" class="mf-help"></p><div id="mail-schedule-source-hint"></div><p id="mail-schedule-status" class="mf-mail-schedule-status" role="status"></p></section>`;
  }
  function updateMailScheduleUi(){
    const enabled=document.getElementById('mail-schedule-enabled'),clock=document.getElementById('mail-schedule-time');if(!enabled||!clock)return;
    const saved=mailScheduleSettings();
    for(const [field,value] of [[enabled,saved.enabled],[clock,saved.time]]){
      if(!Object.hasOwn(field,'_settingsBase')||settingsFieldValue(field)===field._settingsBase){if(field.type==='checkbox')field.checked=value;else field.value=value;}
      field._settingsBase=value;
    }
    const dirty=enabled.checked!==saved.enabled||clock.value!==saved.time;
    const save=document.querySelector('[data-action="save-mail-schedule"]');if(save){save.disabled=mailScheduleUi.saving||ui.busy.has('save-mail-schedule:');save.setAttribute('aria-busy',String(mailScheduleUi.saving));}
    const feedback=document.getElementById('mail-schedule-save-status');feedback.textContent=mailScheduleUi.error||(mailScheduleUi.saving?tr('正在保存每日整理設定…'):dirty?tr('有尚未保存的每日整理設定。'):mailScheduleUi.saved?tr('每日整理設定已保存。'):'');feedback.hidden=!feedback.textContent;feedback.dataset.state=mailScheduleUi.error?'error':dirty?'unsaved':'saved';
    const source=defaultTaskSource('llm');document.getElementById('mail-schedule-source').textContent=uiText`每日整理使用預設文字 LLM：${aiSourceLabel(source)}。`;
    setLiveMarkup(document.getElementById('mail-schedule-source-hint'),sourceHint('mail',source));
    const run=data.mailScheduleState||{},parts=[({running:tr('自動整理執行中'),done:tr('上次自動整理完成'),error:tr('上次自動整理未完成'),cancelled:tr('上次自動整理已取消')})[run.status]||tr('尚未執行自動整理。')];
    if(run.lastAttemptAt)parts.push(uiText`最近執行：${day(run.lastAttemptAt)} ${time(run.lastAttemptAt)}`);
    if(run.lastCompletedAt)parts.push(uiText`最近完成：${day(run.lastCompletedAt)} ${time(run.lastCompletedAt)}`);
    if(run.error)parts.push(tr(run.error));
    const status=document.getElementById('mail-schedule-status');status.textContent=parts.join('\n');status.dataset.state=run.error?'error':run.status||'idle';
  }
  async function saveMailSchedule(){
    const enabled=document.getElementById('mail-schedule-enabled'),clock=document.getElementById('mail-schedule-time');if(!enabled||!clock||mailScheduleUi.saving||!clock.reportValidity())return;
    const schedule={enabled:enabled.checked,time:clock.value};mailScheduleUi.saving=true;mailScheduleUi.saved=false;mailScheduleUi.error='';updateMailScheduleUi();
    try{const result=await api.call('settings.save',{mailSchedule:schedule});data.settings.mailSchedule=result.settings.mailSchedule;mailScheduleUi.saved=true;}
    catch(error){mailScheduleUi.error=error.message;throw error;}
    finally{mailScheduleUi.saving=false;if(ui.view==='settings')updateMailScheduleUi();}
  }
  function gmailSetupModal(){
    ui.modal={type:'gmail-setup'};
    const ready=data.gmailAuth?.configured;
    modal(ready?tr('Google 連接設定'):tr('啟用 Gmail 連接'),
      '<p>'+(ready?tr('這台電腦已完成連接設定，可以直接登入 Google。'):tr('首次設定由 UFriend 開發者完成一次。之後每位使用者只要選擇自己的 Google 帳號並同意授權。'))+'</p>'+
      tr('<ol class="mf-setup-steps"><li><strong>建立 UFriend 專案</strong><p>在 Google Cloud 建立專案，搜尋並啟用 Gmail API。</p></li><li><strong>設定授權畫面與測試帳號</strong><p>在 Google Auth Platform 填寫 UFriend 名稱與聯絡信箱；選擇 External，將自己的 Gmail 加入測試使用者，並在 Data Access 加入 gmail.modify 權限。</p></li><li><strong>建立桌面用戶端</strong><p>在 Clients 建立 OAuth 用戶端，類型選「Desktop app／電腦應用程式」，下載 JSON 設定檔。</p></li><li><strong>匯入後登入</strong><p>回到 UFriend 按「匯入 Google 設定檔」，選擇剛下載的 JSON，再連接 Google 帳號。</p></li></ol>')+
      tr('<p class="mf-help">不需要建立 API Key，也不需要把 Google 密碼填進 UFriend。Testing 模式的授權約 7 天需重連；正式公開版本另需完成 Google 權限驗證。</p>'),
      btn(tr('開啟 Google Cloud'),'gmail-open-console','external-link')+btn(tr('匯入 Google 設定檔'),'gmail-import-config','file-up')+(ready?googleButton():'')
    );
  }
  function updateOAuthDialog(){
    if(ui.modal?.type!=='oauth'||ui.modal.error)return;
    const phase=data.gmailAuth?.phase||'opening';
    const state=document.getElementById('gmail-auth-status'),help=document.getElementById('gmail-auth-help');
    const labels={opening:[tr('正在開啟 Google 登入頁…'),tr('請在系統預設瀏覽器中繼續。')],waiting:[tr('請在 Google 頁面選擇帳號並同意授權'),tr('如果沒有看到登入頁，可以取消後重新開啟。')],completing:[tr('正在完成帳號連接…'),tr('已收到 Google 的授權回應，正在確認 Gmail 存取權限。')],syncing:[tr('帳號已連接，正在同步郵件…'),tr('首次同步可能需要一點時間，你可以關閉這個提示。')]};
    const [title,description]=labels[phase]||labels.opening;
    if(state)state.textContent=title;if(help)help.textContent=description;
    const cancel=overlay.querySelector('[data-action="cancel-oauth"]');if(cancel)cancel.textContent=phase==='syncing'?tr('關閉提示'):tr('取消連接');
  }
  async function connectGoogle(id){
    await flushEdits();if(ui.modal)await closeModal();await refresh(false);
    if(!data.gmailAuth?.configured){gmailSetupModal();return;}
    const entry={type:'oauth',accountId:id};ui.modal=entry;
    modal(tr('連接 Gmail'),tr('<div class="mf-oauth-progress"><img class="mf-google-mark" src="assets/google-g.png" alt="" width="20" height="20"><strong id="gmail-auth-status" role="status" aria-live="polite">正在開啟 Google 登入頁…</strong><p id="gmail-auth-help" class="mf-help">請在系統預設瀏覽器中繼續。</p></div><p class="mf-help">登入與授權都在 Google 官方頁面完成。UFriend 不會取得你的 Google 密碼。</p>'),btn(tr('取消連接'),'cancel-oauth','x'));
    try{
      const result=await api.call('gmail.connect',id?{id}:{});await refresh(false);for(const source of allSources(data))ui.sources.add(source);
      if(ui.modal===entry){ui.modal=null;await closeModal();await openSettings('mail');}
      toast(result.connection?.syncError?tr('Gmail 已連接；首次同步尚未完成，可在帳號旁按「同步」重試。'):(result.connection?.email||'Gmail')+tr(' 已連接。'));
    }catch(e){
      await refresh(false);
      if(e.code==='AUTH_CANCELLED'){if(ui.modal===entry){ui.modal=null;await closeModal();}toast(tr('已取消 Gmail 連接。'));return;}
      if(ui.modal===entry){entry.error=true;const denied=e.code==='AUTH_DENIED';modal(denied?tr('尚未完成授權'):tr('Gmail 尚未連接'),'<p class="mf-notice" role="alert">'+esc(denied?tr('Google 授權未完成。你可以重新連接，選擇帳號並同意 Gmail 存取權限。'):e.message)+tr('</p><p class="mf-help">若 Google 顯示無法存取，請確認帳號已加入測試使用者，且用戶端類型為 Desktop app。</p>'),btn(tr('查看首次設定說明'),'gmail-setup','circle-help')+googleButton(tr('重新開啟 Google 登入'),id?idAttr(id):''));}
      else toast(e.message);
    }
  }
  function devApiStatus(){const health=ui.devApiHealth;if(!health)return tr('<span class="mf-sub">尚未測試連線；保存後可用於本地 AI 工作。</span>');if(health.status==='running')return modelSpinner()+tr('<span>正在測試連線…</span>');if(health.status==='error')return '<span class="mf-help">'+esc(health.error)+'</span>';const info=health.value;return '<span>'+esc(info.ready?tr('模型已就緒'):tr('服務已回應，模型尚未就緒'))+'</span><span class="mf-sub">'+esc(info.model||tr('未提供模型名稱'))+(info.quantization?' · '+esc(info.quantization):'')+' · '+esc(info.backend||'PC API')+'</span>';}
  const mediaServices=i18n.labels([{kind:'ocr',label:'OCR 文字識別',setting:'devOcr',port:8767},{kind:'whisper',label:'Whisper 會議轉錄',setting:'devWhisper',port:8768}]);
  function mediaApiStatus(kind){
    const health=ui.mediaHealth[kind];if(!health)return tr('<span class="mf-sub">尚未測試連線</span>');
    if(health.status==='running')return modelSpinner()+tr('<span>正在測試連線…</span>');
    if(health.status==='error')return '<span class="mf-help">'+esc(health.error)+'</span>';
    return tr('<span>模型已就緒</span><span class="mf-sub">')+esc(health.value.model)+'</span>';
  }
  function renderDevApiSettings(){
    const endpoint=data.settings.devLlm?.endpoint||'http://127.0.0.1:8765';
    if(ui.devApiHealth&&ui.devApiHealth.endpoint!==endpoint){ui.devApiHealthRevision++;ui.devApiHealth=null;}
    return tr('<div class="mf-dev-api"><p class="mf-help">先啟動要使用的獨立服務，再測試連線。三種模型可各自啟用。</p><div class="mf-api-service"><h3>LLM 文字與對話</h3><label class="mf-field">本機服務端點<input id="dev-api-endpoint" class="mf-input" type="url" value="')+esc(endpoint)+'" placeholder="http://127.0.0.1:8765" spellcheck="false"></label><div class="mf-save-row">'+btn(tr('測試連線'),'test-dev-api','plug','',''+disabled(ui.devApiHealth?.status==='running'))+'</div><div id="dev-api-status" class="mf-dev-api-status" role="status" aria-live="polite">'+devApiStatus()+'</div></div>'+
      mediaServices.map(service=>{
        const value=data.settings[service.setting]?.endpoint||'http://127.0.0.1:'+service.port;
        if(ui.mediaHealth[service.kind]&&ui.mediaHealth[service.kind].endpoint!==value){ui.mediaHealthRevision[service.kind]++;delete ui.mediaHealth[service.kind];}
        return '<div class="mf-api-service"><h3>'+service.label+tr('</h3><label class="mf-field">本機服務端點<input id="dev-')+service.kind+'-endpoint" class="mf-input" type="url" value="'+esc(value)+'" placeholder="http://127.0.0.1:'+service.port+'" spellcheck="false"></label><div class="mf-save-row">'+btn(tr('測試連線'),'test-media-api','plug','','data-kind="'+service.kind+'" data-id="'+service.kind+'"'+disabled(ui.mediaHealth[service.kind]?.status==='running'))+'</div><div id="dev-'+service.kind+'-status" class="mf-dev-api-status" role="status" aria-live="polite">'+mediaApiStatus(service.kind)+'</div></div>';
      }).join('')+'<div class="mf-save-row">'+btn(tr('保存本地設定'),'save-dev-api','save','mf-primary')+'</div></div>';
  }
  async function testMediaApi(kind){
    if(!mediaServices.some(service=>service.kind===kind))return;
    const endpoint=document.getElementById('dev-'+kind+'-endpoint').value,revision=++ui.mediaHealthRevision[kind];
    ui.mediaHealth[kind]={status:'running',endpoint};updateDevApiStatus();
    try{const value=await api.call('models.health',{source:'local',kind,endpoint});if(ui.mediaHealthRevision[kind]===revision)ui.mediaHealth[kind]={status:'done',endpoint,value};}
    catch(error){if(ui.mediaHealthRevision[kind]===revision)ui.mediaHealth[kind]={status:'error',endpoint,error:error.message};}
    finally{updateDevApiStatus();}
  }
  function updateDevApiStatus(){for(const service of mediaServices){setLiveMarkup(document.getElementById('dev-'+service.kind+'-status'),mediaApiStatus(service.kind));const test=document.querySelector('[data-action="test-media-api"][data-kind="'+service.kind+'"]');if(test)test.disabled=ui.mediaHealth[service.kind]?.status==='running';}setLiveMarkup(document.getElementById('dev-api-status'),devApiStatus());const button=document.querySelector('[data-action="test-dev-api"]');if(button)button.disabled=ui.devApiHealth?.status==='running'||ui.busy.has('test-dev-api:');}
  async function testDevApi(){const endpoint=document.getElementById('dev-api-endpoint').value,revision=++ui.devApiHealthRevision;ui.devApiHealth={status:'running',endpoint};updateDevApiStatus();try{const value=await api.call('models.health',{source:'local',kind:'llm',endpoint});if(revision===ui.devApiHealthRevision)ui.devApiHealth={status:'done',endpoint,value};}catch(error){if(revision===ui.devApiHealthRevision)ui.devApiHealth={status:'error',endpoint,error:error.message};}finally{updateDevApiStatus();}}
  const cloudHealthKey=()=>JSON.stringify([data.settings.api,data.secrets.cloudKeySet]);
  function invalidateCloudApiHealth(){for(const kind of ['llm','ocr','whisper'])ui.cloudHealthRevision[kind]++;ui.cloudHealth={};}
  function cloudApiStatus(kind){
    const health=ui.cloudHealth[kind];if(!health||health.key!==cloudHealthKey())return tr('<span class="mf-sub">尚未測試已保存設定</span>');
    if(health.status==='running')return modelSpinner()+tr('<span>正在測試連線…</span>');
    if(health.status==='error')return '<span class="mf-help">'+esc(health.error)+'</span>';
    return '<span>'+esc(health.value.ready?tr('模型已就緒'):tr('服務已回應，模型尚未就緒'))+'</span><span class="mf-sub">'+esc(health.value.model||'')+'</span>';
  }
  function updateCloudApiStatus(){for(const kind of ['llm','ocr','whisper']){setLiveMarkup(document.getElementById('cloud-'+kind+'-status'),cloudApiStatus(kind));const button=document.querySelector('[data-action="test-cloud-api"][data-kind="'+kind+'"]');if(button)button.disabled=ui.cloudHealth[kind]?.status==='running'&&ui.cloudHealth[kind]?.key===cloudHealthKey();}}
  async function testCloudApi(kind){
    if(!['llm','ocr','whisper'].includes(kind))return;
    const revision=++ui.cloudHealthRevision[kind],key=cloudHealthKey();ui.cloudHealth[kind]={status:'running',key};updateCloudApiStatus();
    try{const value=await api.call('models.health',{source:'cloud',kind});if(revision===ui.cloudHealthRevision[kind]&&key===cloudHealthKey())ui.cloudHealth[kind]={status:'done',key,value};}
    catch(error){if(revision===ui.cloudHealthRevision[kind]&&key===cloudHealthKey())ui.cloudHealth[kind]={status:'error',key,error:error.message};}
    finally{updateCloudApiStatus();}
  }
  const settingsCategories=i18n.labels([
    {id:'general',label:'一般',icon:'sliders-horizontal',description:'外觀、語言與資料清理'},
    {id:'profile',label:'個人資訊',icon:'user-round',description:'姓名、聯絡方式與背景'},
    {id:'mail',label:'郵件帳戶',icon:'mail',description:'Gmail 與每日整理'},
    {id:'models',label:'模型與運算',icon:'cpu',description:'本地與雲端服務'},
    {id:'prompts',label:'Prompt 設定',icon:'square-pen',description:'各項 AI 任務的指示'},
    {id:'diagnostics',label:'診斷紀錄',icon:'file-text',description:'執行狀態與問題排查'}
  ]);
  function settingsFieldValue(field){return field.type==='checkbox'?field.checked:field.value;}
  function captureSettingsForms(){
    const content=document.getElementById('settings-content');
    if(!content)return null;
    const fields=new Map([...content.querySelectorAll('input[id],select[id],textarea[id]')].filter(field=>!field.closest('#personal-profile-form')&&!field.dataset.modelDefaultKind&&Object.hasOwn(field,'_settingsBase')&&settingsFieldValue(field)!==field._settingsBase).map(field=>[field.id,settingsFieldValue(field)]));
    // Duration and its unit must survive together when a saved value is
    // normalized from seconds to minutes during a settings refresh.
    const policyFields=['pool-preferred','pool-idle','pool-unit'];
    if(policyFields.some(id=>fields.has(id)))for(const id of policyFields){const field=document.getElementById(id);if(field)fields.set(id,settingsFieldValue(field));}
    const details=[...content.querySelectorAll('[data-settings-panel]')].flatMap(panel=>[...panel.querySelectorAll('details')].map((item,index)=>[panel.dataset.settingsPanel+':'+index,item.open]));
    const active=document.activeElement,focus=page.contains(active)&&active.id?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
    return{fields,details:new Map(details),focus,scroll:content.scrollTop,category:content.dataset.category};
  }
  function restoreSettingsForms(snapshot){
    const content=document.getElementById('settings-content');
    for(const field of content.querySelectorAll('input[id],select[id],textarea[id]')){
      if(field.closest('#personal-profile-form'))continue;
      field._settingsBase=settingsFieldValue(field);
      if(snapshot?.fields.has(field.id)){
        if(field.type==='checkbox')field.checked=snapshot.fields.get(field.id);
        else field.value=snapshot.fields.get(field.id);
      }
    }
    for(const panel of content.querySelectorAll('[data-settings-panel]'))[...panel.querySelectorAll('details')].forEach((item,index)=>{
      const key=panel.dataset.settingsPanel+':'+index;if(snapshot?.details.has(key))item.open=snapshot.details.get(key);
    });
    if(snapshot?.category===ui.settingsCategory)content.scrollTop=snapshot.scroll;
    if(snapshot?.focus){
      const field=document.getElementById(snapshot.focus.id);
      if(field?.checkVisibility()){if(field.matches('[data-settings-tab]'))focusSettingsTab(field);else field.focus({preventScroll:true});try{if(snapshot.focus.start!==null)field.setSelectionRange(snapshot.focus.start,snapshot.focus.end);}catch{}}
    }
  }
  function discardSettingsFields(ids){
    for(const id of ids){const field=document.getElementById(id);if(field)field._settingsBase=settingsFieldValue(field);}
  }
  function clearSavedPassword(id,value){
    const field=document.getElementById(id);if(field?.value===value){field.value='';field._settingsBase='';}
  }
  function focusSettingsTab(tab){
    tab.focus({preventScroll:true});
    const menu=tab.closest('.mf-settings-menu'),item=tab.getBoundingClientRect(),bounds=menu.getBoundingClientRect();
    if(item.top<bounds.top)menu.scrollTop-=bounds.top-item.top;
    else if(item.bottom>bounds.bottom)menu.scrollTop+=item.bottom-bounds.bottom;
  }
  function setSettingsCategory(category,{focus=false}={}){
    if(ui.view!=='settings'||!settingsCategories.some(item=>item.id===category))return;
    const changed=ui.settingsCategory!==category;
    ui.settingsCategory=category;
    const content=document.getElementById('settings-content');if(!content)return;
    content.dataset.category=category;
    for(const tab of page.querySelectorAll('[data-settings-tab]')){
      const active=tab.dataset.settingsTab===category;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
      if(active&&focus)focusSettingsTab(tab);
    }
    for(const panel of content.querySelectorAll('[data-settings-panel]'))panel.hidden=panel.dataset.settingsPanel!==category;
    if(changed)content.scrollTop=0;
  }
  function updateSettingsOrientation(){page.querySelector('[role="tablist"]')?.setAttribute('aria-orientation',window.matchMedia('(max-width:900px), (max-height:620px)').matches?'horizontal':'vertical');}
  async function openSettings(category){await navigate('settings');setSettingsCategory(category,{focus:true});}
  const cleanupKinds=i18n.labels({
    media:{title:'會議音檔',button:'刪除全部會議音檔',description:'刪除已匯入的音檔副本、會議項目與對應逐字稿。保留影片及電腦上的原始來源檔案。'},
    chat:{title:'LLM 對話紀錄',button:'刪除全部對話紀錄',description:'刪除所有對話、訊息及未送出的草稿，停止正在產生的回覆。'},
    logs:{title:'系統紀錄',button:'刪除全部系統紀錄',description:'清除 UFriend 的操作紀錄與診斷紀錄。之後使用程式仍會產生新紀錄。'}
  });
  function cleanupCount(target,info=data.cleanup){
    const item=info?.[target];if(!item)return tr('正在讀取…');
    if(target==='media')return uiText`${item.records} 個音檔項目 · ${item.files} 份檔案副本${item.importing?tr(' · 正在匯入，請稍候'):''}`;
    if(target==='chat')return uiText`${item.conversations} 個對話 · ${item.messages} 則訊息`;
    return uiText`${item.entries} 筆操作紀錄${Number.isInteger(item.files)?uiText` · ${item.files} 份診斷檔案`:tr(' · 含診斷檔案')}`;
  }
  function cleanupUnavailable(target,info=data.cleanup){
    if(!info||info.busy)return true;
    if(target==='media')return info.media.importing||(!info.media.records&&!info.media.files);
    if(target==='chat')return !info.chat.conversations&&!info.chat.running;
    return false;
  }
  function renderDataCleanupSettings(){
    return tr('<section id="data-cleanup-settings" class="mf-settingsection"><h2>資料清理</h2><p class="mf-help">分別清理不再需要的資料。刪除前會顯示範圍並請你確認。</p><div class="mf-cleanup-list">')+Object.entries(cleanupKinds).map(([target,kind])=>'<div class="mf-cleanup-card"><div><h3>'+kind.title+'</h3><p class="mf-help">'+kind.description+'</p><p id="data-cleanup-count-'+target+'" class="mf-sub" aria-live="polite">'+cleanupCount(target)+'</p></div>'+btn(kind.button,'clear-data','trash-2','mf-danger',`data-target="${target}"`+disabled(cleanupUnavailable(target)))+'</div>').join('')+'</div></section>';
  }
  function updateDataCleanupUi(){
    for(const target of Object.keys(cleanupKinds)){
      const count=document.getElementById('data-cleanup-count-'+target);if(count)count.textContent=cleanupCount(target);
      const button=page.querySelector('[data-action="clear-data"][data-target="'+target+'"]');if(button)button.disabled=cleanupUnavailable(target)||ui.busy.has('clear-data:');
    }
    if(ui.modal?.type==='clear-data'){
      const clearing=ui.modal.clearing;
      overlay.querySelectorAll('button').forEach(button=>{button.disabled=!!clearing;});
      const confirm=overlay.querySelector('[data-action="confirm-clear-data"]');
      if(confirm){confirm.disabled=clearing||cleanupUnavailable(ui.modal.target,ui.modal.info);confirm.setAttribute('aria-busy',String(!!clearing));confirm.textContent=clearing?tr('正在刪除…'):cleanupKinds[ui.modal.target].button;}
    }
  }
  function renderCleanupDialog(){
    const entry=ui.modal,kind=cleanupKinds[entry.target],info=entry.info;
    const extra=entry.target==='media'?((info.media.running?tr('<p>正在轉錄的音檔會停止處理。</p>'):'')+(info.media.sharedFiles?tr('<p>另有 ')+info.media.sharedFiles+tr(' 份副本仍被其他項目使用，將保留共用檔案。</p>'):'')):'';
    modal(uiText`確認刪除${kind.title}？`,'<p class="mf-cleanup-total">'+cleanupCount(entry.target,info)+'</p><p>'+kind.description+'</p>'+extra+tr('<p class="mf-help">本機自動備份也會同步清除，刪除後無法從程式復原。</p><p id="data-cleanup-error" class="mf-cleanup-error" role="alert"')+(entry.error?'':' hidden')+'>'+esc(entry.error||'')+'</p>',btn(tr('取消'),'cancel-clear-data')+btn(kind.button,'confirm-clear-data','trash-2','mf-danger'),'mf-cleanup-dialog');
    updateDataCleanupUi();overlay.querySelector('[data-action="cancel-clear-data"]')?.focus();
  }
  async function openDataCleanup(target){
    if(!Object.hasOwn(cleanupKinds,target))return;
    await flushEdits();const info=await api.call('data.cleanupInfo');data.cleanup=info;
    if(ui.view!=='settings'||ui.modal)return;
    ui.modal={type:'clear-data',target,info,clearing:false,error:''};renderCleanupDialog();
  }
  async function confirmDataCleanup(){
    const entry=ui.modal;if(entry?.type!=='clear-data'||entry.clearing)return;
    entry.clearing=true;entry.error='';const errorBox=document.getElementById('data-cleanup-error');if(errorBox)errorBox.hidden=true;updateDataCleanupUi();
    try{
      const result=await api.call('data.clear',{target:entry.target,confirmed:true});data.cleanup=result.info;entry.info=result.info;
      if(result.remainingFiles){entry.error=uiText`已刪除音檔項目與逐字稿，仍有 ${result.remainingFiles} 份檔案未刪除。請關閉使用這些檔案的程式，再按刪除重試。`;return;}
      entry.clearing=false;await closeModal();toast(uiText`已清除${cleanupKinds[entry.target].title}。`);
      page.querySelector('[data-action="clear-data"][data-target="'+entry.target+'"]')?.focus();
    }catch(error){
      entry.error=tr('部分資料可能已清除。')+(error.message||tr('刪除未完成，請重試。'));
      try{entry.info=await api.call('data.cleanupInfo');data.cleanup=entry.info;}catch{}
    }finally{
      entry.clearing=false;if(ui.modal===entry){renderCleanupDialog();}updateDataCleanupUi();
    }
  }
  function mediaRuntimeSettingsMarkup(){
    const runtime=data.mediaRuntime||{},busy=runtime.installing||ui.busy.has('media-runtime-download:')||ui.busy.has('media-runtime-folder:');
    if(runtime.bundled)return uiText`<h2>影音元件</h2><p class="mf-help">此版本內含 FFmpeg，可直接匯出字幕影片與處理雲端語音轉錄的音訊。</p><p id="media-runtime-status" role="status" aria-live="polite">影音元件已內建，無需另外安裝。</p>`;
    const status=runtime.installing?tr('正在下載與驗證影音元件…'):runtime.installed?tr('影音元件已就緒。'):tr('尚未安裝影音元件。');
    const locked=disabled(busy||runtime.installed||!runtime.available);
    return uiText`<h2>影音元件</h2><p class="mf-help">匯出字幕影片與雲端語音轉錄需要 FFmpeg；只安裝一次，更新程式後仍可用。</p><p class="mf-help">自動下載需要 7-Zip，也可選取已解壓的官方套件。</p><p id="media-runtime-status" role="status" aria-live="polite">${esc(status)}</p>${runtime.error?'<p class="mf-notice" role="alert">'+esc(tr(runtime.error))+'</p>':''}<div class="mf-flex">${btn(tr('下載並安裝影音元件'),'media-runtime-download','download','',locked)}${btn(tr('選擇已解壓的套件'),'media-runtime-folder','folder-open','',locked)}${btn(tr('影音元件安裝說明'),'media-runtime-help','circle-help')}</div>`;
  }
  function renderMediaRuntimeSettings(){return '<section class="mf-settingsection" id="media-runtime-settings">'+mediaRuntimeSettingsMarkup()+'</section>';}
  function updateMediaRuntimeUi(){setLiveMarkup(document.getElementById('media-runtime-settings'),mediaRuntimeSettingsMarkup());}
  function renderGeneralSettings(){
    const s=data.settings;
    return uiText`<section class="mf-settingsection"><h2>外觀</h2><div class="mf-segment" role="group" aria-label="外觀模式">${[['light','Light','sun'],['dark','Dark','moon'],['system',tr('跟隨系統'),'monitor']].map(([v,n,i])=>`<button type="button" data-action="theme" data-theme="${v}" aria-pressed="${s.theme===v}">${ico(i)}${n}</button>`).join('')}</div></section>${renderUiLanguageSettings()}${renderLanguageSettings()}<section class="mf-settingsection"><h2>背景與資料</h2><label class="mf-auto-switch"><input id="keep-background" type="checkbox"${checked(s.keepBackground)}>關閉視窗後留在系統匣</label><p class="mf-help">程式仍在執行時可同步郵件及接收剪貼簿圖片。需要重啟 UFriend 時，可在系統匣選「重新啟動 UFriend」；選「結束 UFriend」可完全關閉。</p><div class="mf-save-row">${btn(tr('開啟資料位置'),'data-open','folder-open')}<span class="mf-sub">版本 ${esc(data.version)}</span></div></section>${renderMediaRuntimeSettings()}${renderDataCleanupSettings()}`;
  }
  function renderUgenSettings(){
    const policy=ui.policyDraft||data.settings.policy,units=policy.idleMs%60000===0?'minutes':'seconds',idle=policy.idleMs/(units==='minutes'?60000:1000);
    return uiText`<p class="mf-notice">UGen 300 尚未接入，目前無法執行本地 AI 工作。</p><div class="mf-save-row">${btn(tr('保存本地設定'),'save-local-backend','save','mf-primary')}</div><details id="ugen-preview" class="mf-ugen-preview"><summary>裝置與載入策略預覽</summary><p class="mf-help">以下預覽使用模擬裝置，實體裝置接入後才可用於 AI 工作。</p><div class="mf-pool-section"><h2 class="mf-model-section-title">模型載入策略</h2><div class="mf-policy-list">${[['resident',tr('常駐最後使用模型'),tr('任務結束後保留模型，直到需要切換。')],['preferred',tr('返回優先模型'),tr('閒置到期後，整個裝置池至少保留一份優先模型。')],['offload',tr('閒置後卸載'),tr('閒置到期後清空模型，下一次再按需載入。')]].map(([value,name,help])=>`<label class="mf-policy-option"><input type="radio" name="policy-mode" value="${value}"${checked(policy.mode===value)}><span><strong>${name}</strong><span class="mf-sub">${help}</span></span></label>`).join('')}</div><div class="mf-policy-fields"><label class="mf-field">優先模型<select id="pool-preferred" class="mf-input"${disabled(policy.mode!=='preferred')}>${Object.entries(modelNames).map(([value,name])=>`<option value="${value}"${selected(policy.preferred,value)}>${name}</option>`).join('')}</select></label><label class="mf-field">模型閒置時間<div class="mf-duration-fields"><input id="pool-idle" type="number" min="1" max="86400" value="${idle}" class="mf-input"${disabled(policy.mode==='resident')}><select id="pool-unit" class="mf-input" aria-label="閒置時間單位"${disabled(policy.mode==='resident')}><option value="seconds"${selected(units,'seconds')}>秒</option><option value="minutes"${selected(units,'minutes')}>分鐘</option></select></div></label></div>${btn(tr('套用策略'),'save-policy',null,'mf-primary')}</div><div class="mf-pool-section"><div class="mf-model-head"><h2>Ugen 300 裝置池</h2>${btn(tr('模擬插入'),'pool-add','plus')}</div><p class="mf-sub">初期排程政策：每個裝置同時服務一種模型。實體裝置支援待接入。</p><div id="pool-live"></div><div id="pool-jobs" class="mf-pool-jobs"></div><details class="mf-pool-test"><summary>測試模型調度</summary><p class="mf-help">每筆測試使用 5 秒計時，僅檢查排隊與閒置策略。</p><div class="mf-flex">${Object.entries(modelNames).map(([value,name])=>btn(name+tr(' 工作'),'pool-test',null,'',`data-model="${value}"`)).join('')}</div></details></div></details>`;
  }
  function renderModelDefaultChoices(source){
    return '<div class="mf-model-defaults">'+Object.entries(modelCapabilityNames).map(([kind,label])=>{
      const current=modelDefaultUi.pending.get(kind)||defaultTaskSource(kind),id='model-default-'+source+'-'+kind;
      return '<div class="mf-model-default-row"><span>'+esc(label)+'</span><label class="mf-model-default-control" for="'+id+'"><input id="'+id+'" type="checkbox" role="switch" data-model-default-kind="'+kind+'" data-model-default-source="'+source+'"'+checked(current===source)+' aria-label="'+esc(uiText`將${label}的${aiSourceLabel(source)}設為預設`)+'" aria-describedby="model-default-help"'+(modelDefaultUi.pending.has(kind)?' aria-disabled="true" aria-busy="true"':'')+'><span>'+esc(tr('設為預設'))+'</span></label></div>';
    }).join('')+'</div>';
  }
  function updateModelDefaultUi(){
    for(const field of root.querySelectorAll('[data-model-default-kind]')){
      const kind=field.dataset.modelDefaultKind,pending=modelDefaultUi.pending.has(kind),source=modelDefaultUi.pending.get(kind)||defaultTaskSource(kind);
      field.checked=field.dataset.modelDefaultSource===source;field._settingsBase=field.checked;
      for(const name of ['aria-disabled','aria-busy']){if(pending)field.setAttribute(name,'true');else field.removeAttribute(name);}
    }
    const status=document.getElementById('model-default-status');if(status){status.textContent=modelDefaultUi.errors.size?[...modelDefaultUi.errors].map(([kind,error])=>modelCapabilityNames[kind]+'：'+error).join(' · '):modelDefaultUi.pending.size?tr('正在保存預設來源…'):'';status.hidden=!status.textContent;status.dataset.state=modelDefaultUi.errors.size?'error':'saving';}
  }
  async function saveModelDefault(kind,source){
    if(!Object.hasOwn(modelCapabilityNames,kind)||modelDefaultUi.pending.has(kind)){updateModelDefaultUi();return;}
    source=normalizeSource(source);if(source===defaultTaskSource(kind)){updateModelDefaultUi();return;}
    modelDefaultUi.pending.set(kind,source);modelDefaultUi.errors.delete(kind);updateModelDefaultUi();
    const work=modelDefaultUi.queue.catch(()=>{}).then(async()=>{
      const defaults=Object.fromEntries(Object.keys(modelCapabilityNames).map(name=>[name,defaultTaskSource(name)]));
      const result=await api.call('settings.save',{modelDefaults:{...defaults,[kind]:source}});data.settings.modelDefaults=result.settings.modelDefaults;
    });modelDefaultUi.queue=work;
    try{await work;}catch(error){modelDefaultUi.errors.set(kind,error.message);throw error;}
    finally{modelDefaultUi.pending.delete(kind);if(ui.view==='settings'){updateModelDefaultUi();updateMailScheduleUi();}}
  }
  const cloudCapabilities=i18n.labels([{kind:'llm',field:'model',id:'api-model',label:'文字與對話模型'},{kind:'ocr',field:'ocrModel',id:'api-ocr-model',label:'圖片文字模型'},{kind:'whisper',field:'transcriptionModel',id:'api-transcription-model',label:'語音轉錄模型'}]);
  function renderCloudSettings(){
    const config=data.settings.api||{};
    return uiText`<h2>雲端模型設定</h2>${renderModelDefaultChoices('cloud')}<p class="mf-help">填入 OpenAI 相容服務的連線設定，並指定要使用的模型。</p><div class="mf-cloudfields"><label class="mf-field mf-span2">API 端點<input id="api-endpoint" class="mf-input" type="url" value="${esc(config.endpoint)}" placeholder="https://…/v1" spellcheck="false"></label><label class="mf-field mf-span2">API Key<input id="api-key" class="mf-input" type="password" placeholder="${data.secrets.cloudKeySet?tr('已加密保存，留空表示保留'):tr('尚未設定')}" autocomplete="off"></label>${cloudCapabilities.map(item=>'<div class="mf-cloud-model-field mf-span2"><label class="mf-field" for="'+item.id+'">'+esc(item.label)+'<input id="'+item.id+'" class="mf-input" value="'+esc(config[item.field]||'')+'" spellcheck="false" autocomplete="off"></label>'+btn(tr('測試模型'),'test-cloud-api','plug','','data-kind="'+item.kind+'" data-id="'+item.kind+'" aria-label="'+esc(uiText`測試${item.label}`)+'"'+disabled(ui.cloudHealth[item.kind]?.status==='running'))+'<div id="cloud-'+item.kind+'-status" class="mf-dev-api-status" role="status" aria-live="polite">'+cloudApiStatus(item.kind)+'</div></div>').join('')}<label class="mf-field mf-span2">文字生成溫度<input id="api-temperature" class="mf-input mf-temperature-input" type="number" min="0" max="2" step="0.1" value="${Number.isFinite(config.temperature)?config.temperature:''}" placeholder="${tr('使用服務預設')}"><span class="mf-help">留空使用服務預設；填入時可使用 0 至 2。</span></label><div class="mf-span2 mf-flex">${btn(tr('保存雲端設定'),'save-api','save','mf-primary')}${btn(tr('移除金鑰'),'clear-api','key-round','',disabled(!data.secrets.cloudKeySet))}</div></div><p class="mf-help">請先保存設定，再測試各模型。API Key 會加密保存在這台電腦。</p>`;
  }
  function renderComputeSettings(){
    const backend=data.settings.localBackend==='ugen300'?'ugen300':'pc-api';
    return uiText`<section class="mf-settingsection mf-model-config"><p id="model-default-help" class="mf-help">三類模型分別設定預設來源。每類只有一個預設，關閉開關會改用另一個來源，變更立即保存。</p><p class="mf-help">功能頁可暫時切換來源；返回頁面或建立新工作時恢復預設，正在執行的工作不受影響。</p><p id="model-default-status" class="mf-help" role="status" hidden></p><div class="mf-segment mf-model-config-tabs" role="tablist" aria-label="模型來源設定" aria-orientation="horizontal">${[['local',tr('本地模型'),'monitor'],['cloud',tr('雲端模型'),'cloud']].map(([source,label,glyph])=>'<button type="button" role="tab" id="model-config-tab-'+source+'" data-action="model-config-tab" data-model-config="'+source+'" aria-controls="model-config-'+source+'" aria-selected="'+(ui.modelConfigTab===source)+'" tabindex="'+(ui.modelConfigTab===source?'0':'-1')+'">'+ico(glyph)+esc(label)+'</button>').join('')}</div><div id="model-config-local" class="mf-model-config-panel" role="tabpanel" aria-labelledby="model-config-tab-local"${ui.modelConfigTab==='local'?'':' hidden'}><h2>本地模型設定</h2>${renderModelDefaultChoices('local')}<label class="mf-field mf-local-backend-field" for="local-backend">本地執行環境<select id="local-backend" class="mf-input" data-local-backend="${backend}"><option value="pc-api"${selected(backend,'pc-api')}>PC 本機服務</option><option value="ugen300"${selected(backend,'ugen300')}>UGen 300（尚未接入）</option></select></label><div id="local-pc-settings"${backend==='pc-api'?'':' hidden'}>${renderDevApiSettings()}</div><div id="local-ugen-settings"${backend==='ugen300'?'':' hidden'}>${renderUgenSettings()}</div></div><div id="model-config-cloud" class="mf-model-config-panel" role="tabpanel" aria-labelledby="model-config-tab-cloud"${ui.modelConfigTab==='cloud'?'':' hidden'}>${renderCloudSettings()}</div></section>`;
  }
  function updateModelConfigTabs({focus=false}={}){
    for(const source of ['local','cloud']){const tab=document.getElementById('model-config-tab-'+source),panel=document.getElementById('model-config-'+source),active=ui.modelConfigTab===source;if(tab){tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();}if(panel)panel.hidden=!active;}
  }
  function updateLocalBackendFields(){const field=document.getElementById('local-backend');if(!field)return;const backend=field.value==='ugen300'?'ugen300':'pc-api';field.dataset.localBackend=backend;document.getElementById('local-pc-settings').hidden=backend!=='pc-api';document.getElementById('local-ugen-settings').hidden=backend!=='ugen300';}
  function renderSettings(){
    capturePersonalProfileDraft();const snapshot=captureSettingsForms();
    if(!settingsCategories.some(item=>item.id===ui.settingsCategory))ui.settingsCategory='general';
    header(tr('設定'));
    const sections={general:renderGeneralSettings,profile:renderPersonalProfileSettings,mail:renderGmailSettings,models:renderComputeSettings,prompts:renderPromptSettings,diagnostics:renderDiagnosticsPanel};
    page.innerHTML=tr('<div class="mf-settings-layout"><div class="mf-settings-menu"><p class="mf-settings-menu-label">設定分類</p><div class="mf-settings-tabs" role="tablist" aria-label="設定分類">')+settingsCategories.map(item=>'<button type="button" id="settings-tab-'+item.id+'" class="mf-settings-tab" role="tab" data-settings-tab="'+item.id+'" aria-controls="settings-panel-'+item.id+'" aria-selected="'+(item.id===ui.settingsCategory)+'" tabindex="'+(item.id===ui.settingsCategory?'0':'-1')+'">'+ico(item.icon)+'<span><span class="mf-settings-tab-label">'+item.label+'</span><span class="mf-settings-tab-description">'+item.description+'</span></span></button>').join('')+'</div></div><div id="settings-content" class="mf-settings-content" data-category="'+ui.settingsCategory+'">'+settingsCategories.map(item=>'<div id="settings-panel-'+item.id+'" class="mf-settings-panel" role="tabpanel" data-settings-panel="'+item.id+'" aria-labelledby="settings-tab-'+item.id+'" tabindex="0"'+(item.id===ui.settingsCategory?'':' hidden')+'>'+sections[item.id]()+'</div>').join('')+'</div></div>';
    renderCredentialNotice();renderPool();updatePersonalProfileUi();restoreSettingsForms(snapshot);updateModelDefaultUi();updateMailScheduleUi();updateModelConfigTabs();updateLocalBackendFields();updateSettingsOrientation();
  }
  function renderUiLanguageSettings(){return uiText`<section id="ui-language-settings" class="mf-settingsection"><h2>軟體介面語言</h2><p id="ui-language-help" class="mf-help">選擇選單、按鈕與提示使用的語言，保存後立即套用。</p><div class="mf-language-preference"><label class="mf-field" for="ui-language">介面語言<select id="ui-language" class="mf-input" aria-describedby="ui-language-help ui-language-scope"><option value="zh-TW"${selected(data.settings.uiLanguage,'zh-TW')}>繁體中文</option><option value="en"${selected(data.settings.uiLanguage,'en')}>English</option></select></label>${btn(tr('保存介面語言'),'save-ui-language','check','mf-primary')}</div><p id="ui-language-scope" class="mf-help">此設定與 LLM 常用語言分開；不會翻譯郵件、輸入內容或模型回覆。</p></section>`;}
  function renderLanguageSettings(){const preferred=data.settings.preferredLanguage,language=preferred!=='auto'&&Object.hasOwn(translationLanguages,preferred)?preferred:'zh-TW';return tr('<section id="language-settings" class="mf-settingsection"><h2>LLM 常用語言</h2><p id="preferred-language-help" class="mf-help">LLM 對話會優先以常用語言回覆；若提問明確要求其他語言，則依提問使用該語言。</p><div class="mf-language-preference"><label class="mf-field" for="preferred-language">對話語言<select id="preferred-language" class="mf-input" aria-describedby="preferred-language-help">')+Object.entries(translationLanguages).filter(([value])=>value!=='auto').map(([value,label])=>'<option value="'+value+'"'+selected(language,value)+'>'+esc(label)+'</option>').join('')+'</select></label>'+btn(tr('保存語言'),'save-preferred-language','check','mf-primary')+'</div></section>';}
  function personalProfileState(){const saved=data.settings.personalProfile||{};return{enabled:saved.enabled!==false,...Object.fromEntries(Object.keys(profileFields).map(key=>[key,typeof saved[key]==='string'?saved[key]:'']))};}
  function personalProfileDirty(){return!!profileUi.draft&&JSON.stringify(profileUi.draft)!==JSON.stringify(profileUi.base);}
  function personalProfileDraft(){const saved=personalProfileState();if(!profileUi.draft||!profileUi.saving&&!personalProfileDirty()){profileUi.draft=saved;profileUi.base={...saved};}return profileUi.draft;}
  function personalProfileForm(){const enabled=document.getElementById('profile-enabled');if(!enabled)return null;const fields={enabled:enabled.checked};for(const [key,field] of Object.entries(profileFields)){const input=document.getElementById('profile-'+field.id);if(!input)return null;fields[key]=input.value;}return fields;}
  function capturePersonalProfileDraft(){const fields=personalProfileForm();if(!fields)return;if(!profileUi.draft)personalProfileDraft();if(JSON.stringify(fields)!==JSON.stringify(profileUi.draft)){profileUi.draft=fields;profileUi.revision++;profileUi.error='';profileUi.saved=false;}}
  function applyPersonalProfileForm(profile){const enabled=document.getElementById('profile-enabled');if(!enabled)return;enabled.checked=profile.enabled;for(const [key,field] of Object.entries(profileFields)){const input=document.getElementById('profile-'+field.id);if(input&&input.value!==profile[key])input.value=profile[key];}}
  function updatePersonalProfileUi(){
    const form=document.getElementById('personal-profile-form');if(!form)return;
    capturePersonalProfileDraft();const previous=profileUi.draft,current=personalProfileDraft();if(current!==previous)applyPersonalProfileForm(current);
    const button=form.querySelector('[data-action="save-personal-profile"]');if(button){button.disabled=profileUi.saving||ui.busy.has('save-personal-profile:');button.setAttribute('aria-busy',String(profileUi.saving));}
    const count=document.getElementById('profile-notes-count');if(count)count.textContent=current.notes.length.toLocaleString()+' / 2,000';
    const status=document.getElementById('profile-status');if(status){status.textContent=profileUi.error||(profileUi.saving?tr('正在保存個人資訊…'):personalProfileDirty()?tr('有尚未保存的個人資訊。'):profileUi.saved?tr('個人資訊已保存。'):'');status.dataset.state=profileUi.error?'error':profileUi.saving?'saving':personalProfileDirty()?'unsaved':'saved';status.hidden=!status.textContent;}
  }
  function renderPersonalProfileSettings(){
    const profile=personalProfileDraft();
    return tr('<section id="personal-profile-settings" class="mf-settingsection"><h2>個人資訊</h2><p id="profile-use-help" class="mf-help">保存後供 LLM 對話、文章潤句與郵件分析使用；翻譯不使用個人背景。</p><form id="personal-profile-form" class="mf-personal-profile-form"><label class="mf-auto-switch"><input id="profile-enabled" type="checkbox"')+checked(profile.enabled)+tr(' aria-describedby="profile-use-help profile-optional-help">提供個人背景給 LLM</label><p id="profile-optional-help" class="mf-help">所有欄位皆可留白，空白欄位不會提供給模型；停用後仍保留填寫內容。</p><div class="mf-personal-profile-grid">')+Object.entries(profileFields).map(([key,field])=>'<label class="mf-field'+(key==='notes'?' mf-profile-wide':'')+'" for="profile-'+field.id+'">'+(key==='notes'?'<span class="mf-profile-notes-head"><span>'+field.label+'</span><span id="profile-notes-count" class="mf-sub">'+profile.notes.length.toLocaleString()+' / 2,000</span></span>':field.label)+(key==='notes'?'<textarea id="profile-notes" class="mf-input" maxlength="'+field.max+tr('" placeholder="例如：工作領域、回覆偏好或常用稱呼">')+esc(profile[key])+'</textarea>':'<input id="profile-'+field.id+'" class="mf-input" type="'+field.type+'" maxlength="'+field.max+'" autocomplete="'+field.autocomplete+'" value="'+esc(profile[key])+'">')+'</label>').join('')+'</div><div class="mf-save-row">'+btn(tr('保存個人資訊'),'save-personal-profile','check','mf-primary','aria-busy="'+profileUi.saving+'"'+disabled(profileUi.saving||ui.busy.has('save-personal-profile:')))+'<p id="profile-status" class="mf-profile-status" role="status" aria-live="polite"></p></div></form></section>';
  }
  async function savePersonalProfile(){
    const form=document.getElementById('personal-profile-form');if(!form||profileUi.saving||!form.reportValidity())return;
    capturePersonalProfileDraft();const profile={...profileUi.draft},revision=profileUi.revision;profileUi.saving=true;profileUi.error='';profileUi.saved=false;updatePersonalProfileUi();
    try{
      const result=await api.call('settings.save',{personalProfile:profile});data.settings.personalProfile=result.settings.personalProfile;const saved=personalProfileState();profileUi.base={...saved};
      if(revision===profileUi.revision){profileUi.draft=saved;applyPersonalProfileForm(saved);}profileUi.saved=true;
    }catch(error){profileUi.error=error.message||tr('個人資訊尚未保存。');throw error;}
    finally{profileUi.saving=false;if(ui.view==='settings')updatePersonalProfileUi();}
  }
  function renderPromptSettings(){return tr('<section class="mf-settingsection"><h2>LLM Prompt</h2><p class="mf-help">調整郵件分析、文章潤句、聊天及翻譯的指示與文字模板。</p><div class="mf-save-row">')+btn(tr('開啟 Prompt 除錯'),'prompt-debug-open','sliders-horizontal')+'</div></section>';}
  const promptSource=()=>defaultTaskSource('llm');
  const promptEndpoint=()=>promptSource()==='cloud'?data.settings.api?.endpoint||tr('雲端模型'):data.settings.devLlm?.endpoint||'http://127.0.0.1:8765';
  const promptReady=()=>!!promptUi.catalog&&promptUi.source===promptSource()&&promptUi.endpoint===promptEndpoint()&&!promptUi.loading&&!promptUi.error;
  function validatePromptCatalog(value){
    if(value?.apiVersion!=='1'||!value.tasks||Object.keys(promptTasks).some(task=>{const item=value.tasks[task];return !item||typeof item.system!=='string'||typeof item.user!=='string'||!Array.isArray(item.variables)||!Array.isArray(item.requiredVariables)||item.variables.some(name=>typeof name!=='string')||item.requiredVariables.some(name=>typeof name!=='string');}))throw new Error(tr('模型服務回傳的 Prompt 目錄不完整。'));
    return value;
  }
  function syncPromptDrafts(discardTask){
    for(const task of Object.keys(promptTasks)){
      const base=data.settings.llmPrompts?.[task]||promptUi.catalog.tasks[task],previous=promptUi.drafts[task];
      const keep=previous?.dirty&&task!==discardTask;
      const draft={system:keep?previous.system:base.system,user:keep?previous.user:base.user,baseSystem:base.system,baseUser:base.user};
      draft.dirty=draft.system!==draft.baseSystem||draft.user!==draft.baseUser;promptUi.drafts[task]=draft;
    }
  }
  function capturePromptDraft(){
    const system=document.getElementById('prompt-system'),user=document.getElementById('prompt-user'),draft=promptUi.drafts[promptUi.task];if(!system||!user||!draft)return;
    draft.system=system.value;draft.user=user.value;draft.dirty=draft.system!==draft.baseSystem||draft.user!==draft.baseUser;
  }
  function updatePromptStatus(){
    const task=promptUi.task,draft=promptUi.drafts[task],ready=promptReady(),pending=promptUi.pending.has(task),message=promptUi.messages[task];
    const status=document.getElementById('prompt-status');
    if(status){status.textContent=promptUi.loading?tr('正在讀取目前服務的預設 Prompt…'):promptUi.error||(pending?uiText`正在更新「${promptTasks[task]}」的 Prompt…`:message?.text||(!ready?tr('請讀取目前 LLM 服務的預設 Prompt 後再編輯。'):draft?.dirty?tr('此任務有尚未保存的修改；切換任務會保留草稿。'):tr('選擇任務並編輯，保存後才會生效。')));status.dataset.state=promptUi.error||message?.error?'unavailable':'ready';}
    const mode=document.getElementById('prompt-mode');if(mode)mode.textContent=draft?.dirty?tr('尚未保存'):data.settings.llmPrompts?.[task]?tr('目前使用自訂 Prompt'):tr('目前使用服務預設');
    const source=document.getElementById('prompt-source');if(source)source.textContent=tr('預設來源：')+aiSourceLabel(promptUi.catalog?promptUi.source:promptSource())+' · '+(promptUi.catalog?promptUi.endpoint:promptEndpoint())+(promptUi.catalog&&(promptUi.endpoint!==promptEndpoint()||promptUi.source!==promptSource())?tr('（服務已變更，請重新讀取）'):'');
    for(const name of ['system','user']){const field=document.getElementById('prompt-'+name);if(field)field.readOnly=!ready||pending;}
    for(const [name,limit] of [['system',12000],['user',16000]]){const count=document.getElementById('prompt-'+name+'-count');if(count)count.textContent=(draft?.[name]?.length||0).toLocaleString()+' / '+limit.toLocaleString();}
    for(const name of ['save','reset']){const button=document.querySelector('[data-action="prompt-'+name+'"]');if(button)button.disabled=!ready||promptUi.pending.size>0;}
    const refreshButton=document.querySelector('[data-action="prompt-refresh"]');if(refreshButton)refreshButton.disabled=promptUi.loading||promptUi.pending.size>0;
  }
  function renderPromptDebug(){
    const task=promptUi.task,ready=promptReady(),draft=promptUi.drafts[task],metadata=ready?promptUi.catalog.tasks[task]:null,pending=promptUi.pending.has(task);
    header(tr('Prompt 除錯'),btn(tr('返回設定'),'prompt-back','arrow-left'));
    const editor=ready&&draft?tr('<div class="mf-prompt-variables" id="prompt-variables"><h2>可用變數</h2><div class="mf-prompt-variable-list">')+metadata.variables.map(name=>'<span><code>'+esc('{{'+name+'}}')+'</code>'+(metadata.requiredVariables.includes(name)?tr('<span class="mf-prompt-required">必要</span>'):'')+'</span>').join('')+tr('</div><p class="mf-help">在 User 模板中使用變數，執行時會替換成 JSON 編碼的工作資料。</p></div><div class="mf-prompt-editors"><label class="mf-field" for="prompt-system"><span class="mf-prompt-field-head"><strong>System 指示</strong><span id="prompt-system-count" class="mf-sub"></span></span><textarea id="prompt-system" class="mf-input mf-prompt-editor" maxlength="12000" spellcheck="false"')+(pending?' readonly':'')+'>'+esc(draft.system)+tr('</textarea></label><label class="mf-field" for="prompt-user"><span class="mf-prompt-field-head"><strong>User 模板</strong><span id="prompt-user-count" class="mf-sub"></span></span><textarea id="prompt-user" class="mf-input mf-prompt-editor" maxlength="16000" spellcheck="false"')+(pending?' readonly':'')+'>'+esc(draft.user)+'</textarea></label></div>':'<div class="mf-prompt-unavailable">'+(promptUi.loading?modelSpinner():'')+'<p>'+esc(promptUi.loading?tr('正在取得服務提供的預設內容。'):tr('尚未取得目前服務的預設內容。已有草稿會保留，重新讀取後可繼續編輯。'))+'</p></div>';
    page.innerHTML=tr('<section class="mf-prompt-debug"><div class="mf-prompt-intro"><div><p>各任務分別設定 System 指示與 User 模板。</p><p id="prompt-source" class="mf-help">預設來源：<code>')+esc(promptEndpoint())+'</code></p></div>'+btn(tr('重新讀取預設'),'prompt-refresh','refresh-cw','',disabled(promptUi.loading||promptUi.pending.size>0))+tr('</div><div class="mf-prompt-taskrow"><label class="mf-field" for="prompt-task">任務<select id="prompt-task" class="mf-input">')+Object.entries(promptTasks).map(([name,label])=>'<option value="'+name+'"'+selected(task,name)+'>'+label+'</option>').join('')+'</select></label><span id="prompt-mode" class="mf-model-badge"></span></div>'+editor+'<div class="mf-prompt-actions">'+btn(uiText`保存「${promptTasks[task]}」Prompt`,'prompt-save','save','mf-primary','data-id="'+task+'"'+disabled(!ready||pending))+btn(uiText`恢復「${promptTasks[task]}」預設`,'prompt-reset','rotate-ccw','','data-id="'+task+'"'+disabled(!ready||pending))+'</div><p id="prompt-status" class="mf-toolstatus" role="status"></p></section>';
    updatePromptStatus();
  }
  function redrawPromptDebug(){if(ui.view==='llm-debug'&&!ui.modal){const scroll=page.scrollTop;renderPromptDebug();drawIcons();page.scrollTop=scroll;}}
  async function loadPromptDefaults(){
    if(promptUi.pending.size)return;capturePromptDraft();
    const revision=++promptUi.loadRevision,endpoint=promptEndpoint(),source=promptSource();promptUi.loading=true;promptUi.error='';redrawPromptDebug();
    try{
      const catalog=validatePromptCatalog(await api.call('llm.prompts.get',{source}));if(revision!==promptUi.loadRevision)return;
      await refresh(false);if(revision!==promptUi.loadRevision)return;
      if(endpoint!==promptEndpoint()||source!==promptSource())throw new Error(tr('服務端點已變更，請重新讀取預設 Prompt。'));
      promptUi.catalog=catalog;promptUi.endpoint=endpoint;promptUi.source=source;syncPromptDrafts();
    }catch(error){if(revision===promptUi.loadRevision)promptUi.error=tr('無法讀取預設 Prompt：')+error.message;}
    finally{if(revision===promptUi.loadRevision){promptUi.loading=false;redrawPromptDebug();}}
  }
  async function savePromptDefaults(reset=false){
    capturePromptDraft();const task=promptUi.task,endpoint=promptEndpoint(),source=promptSource();if(!promptReady()||promptUi.pending.size)return;
    const draft=promptUi.drafts[task],payload={task,system:draft.system,user:draft.user};promptUi.pending.add(task);delete promptUi.messages[task];redrawPromptDebug();
    try{
      let catalog;
      if(reset){catalog=validatePromptCatalog(await api.call('llm.prompts.get',{source}));if(endpoint!==promptEndpoint()||source!==promptSource())throw new Error(tr('服務端點已變更，請重新讀取預設 Prompt。'));}
      await api.call(reset?'llm.prompts.reset':'llm.prompts.save',reset?{task}:payload);await refresh(false);
      if(reset){promptUi.catalog=catalog;promptUi.endpoint=endpoint;promptUi.source=source;syncPromptDrafts(task);}
      else{draft.baseSystem=payload.system;draft.baseUser=payload.user;draft.dirty=draft.system!==draft.baseSystem||draft.user!==draft.baseUser;}
      promptUi.messages[task]={text:reset?uiText`「${promptTasks[task]}」已恢復目前服務預設，將套用至後續請求。`:uiText`「${promptTasks[task]}」Prompt 已保存，將套用至後續請求。`};
    }catch(error){promptUi.messages[task]={text:error.message,error:true};}
    finally{promptUi.pending.delete(task);redrawPromptDebug();}
  }
  function policyFromUi(){const current=data.settings.policy;return{mode:page.querySelector('input[name="policy-mode"]:checked')?.value||current.mode,preferred:document.getElementById('pool-preferred')?.value||current.preferred,idleMs:Number(document.getElementById('pool-idle')?.value||current.idleMs/1000)*(document.getElementById('pool-unit')?.value==='minutes'?60000:1000)};}
  function renderPool(){const container=document.getElementById('pool-live'),jobs=document.getElementById('pool-jobs');if(!container||!data.pool)return;const pool=data.pool;container.innerHTML=pool.devices.length?pool.devices.map(d=>uiText`<div class="mf-device-row"><div class="mf-device-main"><span class="mf-device-symbol">${ico('cpu')}</span><div><div class="mf-device-name">${esc(d.name)} <span class="mf-model-badge">${d.model?modelNames[d.model]:d.target?modelNames[d.target]:tr('未載入')}</span></div><p class="mf-device-state">${({empty:tr('未載入模型'),ready:tr('閒置'),running:tr('執行中'),loading:tr('載入中'),unloading:tr('卸載中')})[d.state]} · 模擬裝置${d.remainingMs>0?' · '+Math.ceil(d.remainingMs/1000)+tr(' 秒'):''}</p></div></div>${icon(tr('模擬拔除'),'pool-remove','unplug',idAttr(d.id))}</div>`).join(''):uiText`<p class="mf-pool-empty">尚無裝置。可加入模擬裝置測試調度。</p>`;const active=pool.jobs.filter(j=>['queued','preparing','loading','running'].includes(j.state));jobs.innerHTML=active.length?uiText`<h3>工作佇列 · ${active.length}</h3>${active.map(j=>`<div class="mf-pool-job"><div><span>${esc(j.label)}</span><p>${({queued:tr('排隊中'),preparing:tr('準備模型'),loading:tr('載入中'),running:tr('執行中')})[j.state]}${j.deviceId?' · '+esc(pool.devices.find(d=>d.id===j.deviceId)?.name||''):''}</p></div>${icon(tr('取消工作'),'pool-cancel','x',idAttr(j.id))}</div>`).join('')}`:'';drawIcons();}

  function modal(title,body,footer='',className=''){window.UFriendRecordingPlayer?.dispose(overlay.querySelector('video,audio'));resetFileDrag();returnFocus=document.activeElement;overlay.hidden=false;overlay.innerHTML=`<section class="mf-dialog ${className}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="mf-dialogtop"><h2 id="dialog-title">${esc(title)}</h2>${icon(tr('關閉'),'modal-close','x')}</div><div class="mf-dialogbody">${body}</div>${footer?`<div class="mf-dialogfoot">${footer}</div>`:''}</section>`;if(ui.modal?.type==='compose')updateDraftNotice();drawIcons();updateMediaImportUi();overlay.querySelector('input:not([type=hidden]),textarea,select,button')?.focus();}
  function updateDraftNotice(){if(ui.modal?.type!=='compose')return;const d=ui.modal.draft,body=overlay.querySelector('.mf-dialogbody');if(!body)return;body.querySelector('.mf-draft-notice')?.remove();if(!d.remoteDraftId&&!d.error)return;const notice=document.createElement('div');notice.className='mf-notice mf-draft-notice';notice.innerHTML=`${d.error?`<p>${esc(d.error)}</p>`:''}${d.remoteDraftId?`<div class="mf-save-row">${btn(tr('保留本機副本並載入 Gmail 最新版本'),'draft-reload-remote','refresh-cw')}</div>`:''}`;body.append(notice);drawIcons();}
  async function closeModal(){if(ui.modal?.clearing)throw new Error(tr('資料正在刪除，請稍候。'));if(ui.modal?.sending)throw new Error(tr('郵件正在寄送，請稍候。'));if(ui.modal?.type==='oauth')await api.call('gmail.cancel');if(ui.modal?.type==='compose'){await persistDraft(false);}clearTimeout(draftTimer);window.UFriendRecordingPlayer?.dispose(overlay.querySelector('video,audio'));ui.modal=null;overlay.hidden=true;overlay.innerHTML='';await refresh();if(returnFocus?.isConnected)returnFocus.focus();}
  function langOptions(value){return Object.entries(langNames).map(([v,name])=>`<option value="${v}"${selected(value,v)}>${name}</option>`).join('');}
  function readCompose(){const d=ui.modal.draft;return{...d,to:document.getElementById('compose-to')?.value??d.to,cc:document.getElementById('compose-cc')?.value??d.cc,bcc:document.getElementById('compose-bcc')?.value??d.bcc,subject:document.getElementById('compose-subject')?.value??d.subject,body:document.getElementById('compose-body')?.value??d.body,accountId:document.getElementById('compose-account')?.value??d.accountId};}
  async function persistDraft(remote){clearTimeout(draftTimer);if(ui.modal?.type!=='compose'||ui.modal.sending)return;const entry=ui.modal;entry.draft=readCompose();const payload=structuredClone(entry.draft);draftSaveQueue=draftSaveQueue.catch(()=>{}).then(async()=>{const result=await api.call('draft.save',{...payload,localOnly:!remote});entry.draft={...entry.draft,id:result.draft.id,remoteDraftId:result.draft.remoteDraftId,remoteMessageId:result.draft.remoteMessageId,status:result.draft.status,error:result.draft.error};if(ui.modal===entry)updateDraftNotice();if(result.warning)toast(result.warning);return result;});return draftSaveQueue;}
  function composeModal(){const d=ui.modal.draft;modal(d.createdAt?tr('編輯草稿'):tr('撰寫郵件'),uiText`<div class="mf-formstack"><label class="mf-field">寄件帳號<select id="compose-account" class="mf-input"><option value="local"${selected(d.accountId,'local')}>本機草稿（尚未選擇寄件帳號）</option>${data.accounts.filter(a=>a.connected!==false).map(a=>`<option value="${esc(a.id)}"${selected(d.accountId,a.id)}>${esc(a.email)}</option>`).join('')}</select></label><label class="mf-field">收件者<input id="compose-to" class="mf-input" value="${esc(d.to)}" placeholder="name@example.com"></label><div class="mf-cloudfields" style="margin-top:0"><label class="mf-field">副本 CC<input id="compose-cc" class="mf-input" value="${esc(d.cc)}"></label><label class="mf-field">密件副本 BCC<input id="compose-bcc" class="mf-input" value="${esc(d.bcc)}"></label></div><label class="mf-field">主旨<input id="compose-subject" class="mf-input" value="${esc(d.subject)}"></label><label class="mf-field">內文<textarea id="compose-body" class="mf-input mf-editor">${esc(d.body)}</textarea></label><div class="mf-attachments">${(d.attachments||[]).map((a,i)=>`<span class="mf-attachment">${ico('paperclip')}${esc(a.name)} · ${sizes(a.size)}${icon(tr('移除附件'),'remove-draft-attachment','x',`data-index="${i}"`)}</span>`).join('')}</div><div class="mf-flex">${btn(tr('加入附件'),'draft-attach','paperclip')}<span class="mf-sub">關閉前會保存本機草稿</span></div>${['send-error','send-uncertain'].includes(d.status)?tr('<p class="mf-notice">上次寄送未確認。請先檢查 Gmail 寄件備份，再決定是否重試。</p>'):''}</div>`,`${data.drafts.some(item=>item.id===d.id)?btn(tr('刪除草稿'),'draft-delete','trash-2','mf-danger'):''}${btn(tr('保存草稿'),'draft-save','save')}${btn(tr('寄送'),'draft-send','send','mf-primary')}`);}
  async function openCompose(draft=null,mode=null,m=null){const defaultAccount=data.accounts.find(a=>a.connected!==false)?.id||'local';let d=draft?structuredClone(draft):{id:crypto.randomUUID(),accountId:defaultAccount,to:'',cc:'',bcc:'',subject:'',body:'',attachments:[]};if(m){const self=data.accounts.find(a=>a.id===m.accountId)?.email?.toLowerCase();d.accountId=m.accountId==='local'?defaultAccount:m.accountId;d.replyToId=m.id;const isForward=mode==='forward';d.to=isForward?'':m.replyTo||m.email;d.cc=mode==='reply-all'?[m.to,m.cc].filter(Boolean).join(', ').split(',').filter(x=>!self||!x.toLowerCase().includes(self)).filter(x=>!x.includes(m.email)).join(', '):'';d.subject=(isForward?/^(fw|fwd):/i:/^re:/i).test(m.subject)?m.subject:(isForward?'Fwd: ':'Re: ')+m.subject;d.body=`\n\n${isForward?'---------- 轉寄郵件 ----------':`於 ${day(m.date)} ${time(m.date)}，${m.sender||m.email} 寫道：`}\n${m.body||''}`;if(isForward){d.attachments=(m.attachments||[]).filter(a=>a.assetId).map(a=>({...a}));if((m.attachments||[]).some(a=>!a.assetId))toast(tr('遠端附件請先下載，再加入轉寄郵件。'));}}ui.modal={type:'compose',draft:d};composeModal();}
  function transcriptMarkup(r){
    if(r.segments?.length)return '<div class="mf-transcript">'+r.segments.map((segment,index)=>{const seconds=Math.max(0,Number(segment.start)||0),timestamp=Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');return '<div class="mf-transcriptrow" data-segment-index="'+index+'"><button type="button" class="mf-subtle-link" data-action="seek-media" data-time="'+seconds+'" aria-label="'+esc(uiText`跳至 ${timestamp}`)+'">'+timestamp+'</button><p>'+esc(segment.text)+'</p></div>';}).join('')+'</div>';
    if(r.textOnly)return '<div class="mf-transcript"><p class="mf-pre">'+esc(r.textOnly)+'</p></div>';
    return '<p class="mf-missing">'+(r.state==='no-speech'?tr('已完成整份檔案辨識，沒有辨識到語音。'):r.state==='running'?tr('正在轉錄，完成後會顯示帶時間點的逐字稿。'):tr('選擇語言後開始轉錄，也可以匯入 SRT／TXT 或手動編輯逐字稿。'))+'</p>';
  }
  function recordingActions(r){const hasText=!!(r.textOnly||r.segments?.length);return recordingWorkActions(r)+btn(tr('匯入文字'),'transcript-import','file-up')+btn(tr('編輯文字'),'transcript-edit','square-pen')+btn(tr('匯出 TXT'),'export-txt','download','',disabled(!hasText))+btn(tr('匯出 SRT'),'export-srt','download','',disabled(!r.segments?.length));}
  function videoExportMarkup(r){
    const job=data.videoExport||{status:'idle'},active=videoExportActive(job),own=job.recordingId===r.id,hasTimes=!!r.segments?.length;
    const actions=own&&active?btn(tr('取消匯出'),'cancel-video-export','x','',idAttr(r.id)+disabled(job.status==='cancelling')):btn(tr('匯出含字幕影片'),'export-video','clapperboard','mf-primary',idAttr(r.id)+disabled(!hasTimes||active))+(own&&job.status==='done'?btn(tr('開啟輸出位置'),'reveal-video-export','folder-open','',idAttr(r.id)):'');
    const help=active?(own?tr('關閉此視窗仍會繼續匯出；結束 UFriend 會取消匯出。'):tr('另一部影片正在匯出，請等候完成。')):hasTimes?tr('將目前字幕固定在畫面上，另存為 MP4，保留原影片。'):tr('先完成轉錄或匯入含時間點的 SRT，即可匯出字幕影片。');
    return '<div class="mf-video-export-actions">'+actions+'</div><p class="mf-help">'+esc(help)+'</p>'+(own&&job.status!=='idle'?'<p class="mf-video-export-status" role="status" aria-live="polite">'+esc(videoExportLabel(job))+'</p>':'')+(own&&['running','cancelling'].includes(job.status)?'<progress class="mf-video-export-progress" max="1"'+(Number.isFinite(job.progress)?' value="'+Math.max(0,Math.min(1,job.progress))+'"':'')+' aria-label="'+esc(tr('影片匯出進度'))+'"></progress>':'');
  }
  function updateMediaDialog(){
    if(ui.modal?.type!=='media')return;const r=data.recordings.find(r=>r.id===ui.modal.id);if(!r)return;
    const status=document.getElementById('recording-status');if(status)status.textContent=resultSourceStatus(recordingStateLabel(r)+(r.state==='running'?' · '+Math.round(r.progress||0)+'%':'')+(r.error?' · '+tr(r.error):''),r);
    setLiveMarkup(document.getElementById('recording-transcript'),transcriptMarkup(r));
    const footer=overlay.querySelector('.mf-dialogfoot');if(footer)setLiveMarkup(footer,recordingActions(r));
    const language=document.getElementById('recording-language');if(language)language.disabled=r.state==='running';
    updateRecordingSourceUi();
    setLiveMarkup(document.getElementById('recording-video-export'),videoExportMarkup(r));
    ui.modal.player?.update({segments:r.segments,language:r.lang,label:tr('轉錄字幕'),transcript:document.getElementById('recording-transcript')});
  }
  function openMedia(r){
    if(!r)return;
    ui.modal={type:'media',id:r.id};
    const isVideo=r.type==='video',tag=isVideo?'video':'audio';
    const playback='<div class="mf-recording-playback"><'+tag+' id="recording-player" class="mf-preview-media" controls preload="metadata" src="'+assetUrl(r.assetId)+'" data-recording="'+esc(r.id)+'" aria-label="'+esc(r.name)+'"></'+tag+'><p id="media-play-status" class="mf-help" role="status"></p>'+(isVideo?'<div class="mf-recording-tools"><button type="button" class="mf-action mf-caption-toggle" data-action="media-captions" aria-controls="recording-player" aria-pressed="false" disabled>'+esc(tr('字幕 CC'))+'</button><span id="recording-captions-hint" class="mf-help">'+esc(tr('字幕需要包含時間點的逐字稿。'))+'</span></div><section id="recording-video-export" class="mf-video-export" aria-label="'+esc(tr('匯出含字幕影片'))+'">'+videoExportMarkup(r)+'</section>':'')+'</div>';
    const timeline='<section class="mf-recording-timeline" aria-label="'+esc(tr('時間軸逐字稿'))+'"><div class="mf-recording-settings"><div class="mf-transcription-options"><label class="mf-field">'+esc(tr('轉錄語言'))+'<select class="mf-input" id="recording-language"'+disabled(r.state==='running')+'>'+langOptions(r.lang)+'</select></label>'+recordingSourceControl(r,{dialog:true})+'</div><div id="recording-source-hint"></div><p id="recording-status" class="mf-inline-status" role="status"></p></div><div id="recording-transcript" tabindex="0" aria-label="'+esc(tr('時間軸逐字稿'))+'">'+transcriptMarkup(r)+'</div></section>';
    modal(r.name,'<div class="mf-recording-layout">'+playback+timeline+'</div>',recordingActions(r),'mf-recording-dialog'+(isVideo?' mf-recording-video':''));
    const media=overlay.querySelector('video,audio');
    if(media)ui.modal.player=window.UFriendRecordingPlayer.attach(media,{onCaptionState:state=>{const button=overlay.querySelector('[data-action="media-captions"]'),hint=document.getElementById('recording-captions-hint');if(button){button.disabled=!state.available;button.setAttribute('aria-pressed',String(state.enabled));button.title=state.enabled?tr('關閉字幕'):tr('開啟字幕');}if(hint)hint.hidden=state.available;}});
    updateMediaDialog();
    media?.addEventListener('loadedmetadata',()=>{if(Number.isFinite(media.duration))api.call('media.update',{id:r.id,patch:{duration:media.duration}}).catch(()=>{});});
    media?.addEventListener('error',()=>{const status=document.getElementById('media-play-status');if(status)status.textContent=tr('內建播放器不支援此檔案的編碼。原檔已保存，仍可嘗試轉錄。');});
  }
  function transcriptEditor(r){const format=r.segments?.length?'srt':'txt';ui.modal={type:'transcript',id:r.id};modal(tr('編輯逐字稿'),uiText`<label class="mf-field">格式<select id="transcript-format" class="mf-input"><option value="txt"${selected(format,'txt')}>TXT（純文字）</option><option value="srt"${selected(format,'srt')}>SRT（包含時間點）</option></select></label><p class="mf-help">SRT 保留每段起訖時間；純文字不會自動產生時間點。</p><textarea class="mf-input mf-transcript-editor" id="transcript-text" aria-label="逐字稿內容">${esc(format==='srt'?localSrt(r.segments):r.textOnly||'')}</textarea>`,btn(tr('保存'),'transcript-save','save','mf-primary'));}
  function localSrt(segments){const fmt=seconds=>{const ms=Math.round(seconds*1000);return`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};return segments.map((s,i)=>`${i+1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}`).join('\n\n');}
  async function labelsModal(ids){const messages=ids.map(message),accounts=[...new Set(messages.map(m=>m.accountId))];if(accounts.length!==1){toast(tr('標籤操作請選擇同一個帳號的郵件。'));return;}const accountId=accounts[0];const labels=accountId==='local'?[...new Set(data.messages.flatMap(m=>m.labels||[]))].map(name=>({id:name,name})):await api.call('gmail.labels',{id:accountId});ui.modal={type:'labels',ids,accountId};modal(tr('標籤與移動'),uiText`<label class="mf-field">資料夾<select id="label-folder" class="mf-input"><option value="">保持目前位置</option>${['inbox','archive','spam','trash'].map(v=>`<option value="${v}">${folders[v]}</option>`).join('')}</select></label><label class="mf-field" style="margin-top:14px">加入標籤<select id="label-add" class="mf-input"><option value="">不新增</option>${labels.filter(l=>l.type!=='system').map(l=>`<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></label><label class="mf-field" style="margin-top:14px">移除標籤<select id="label-remove" class="mf-input"><option value="">不移除</option>${labels.filter(l=>l.type!=='system').map(l=>`<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></label><label class="mf-field" style="margin-top:14px">或建立新標籤<input id="label-new" class="mf-input" maxlength="60" placeholder="標籤名稱"></label>`,btn(tr('套用'),'labels-save',null,'mf-primary'));}

  async function updateMail(ids,patch){const result=await operation('mail.modify',{ids,patch});if(result.failed?.length)toast(uiText`已完成 ${result.succeeded.length} 封；${result.failed.length} 封未完成：${result.failed[0].error}`);return result;}
  async function handleAction(action,target){const id=target.dataset.id;switch(action){
    case 'import-mail':{const r=await operation('mail.import');toast(uiText`匯入 ${r.added} 封；重複 ${r.duplicate} 封${r.updated?tr('；已更新 ')+r.updated+tr(' 封排版'):''}${r.errors?.length?'；'+r.errors.length+tr(' 封失敗：')+r.errors[0].message:''}`);for(const source of data.messages.map(m=>m.source||'本機'))ui.sources.add(source);return render();}
    case 'analyze':if(data.mailAnalysis?.status==='running')return;return operation('mail.analyze',{source:selectedTaskSource('mail'),onlyChanged:true});
    case 'cancel-analysis':return operation('mail.cancelAnalysis');
    case 'sync':case 'sync-account':{const result=await operation('gmail.sync',id?{id}:{});for(const source of data.messages.map(m=>m.source||'本機'))ui.sources.add(source);render();toast(result.length?(result.some(r=>r.error)?tr('部分帳號同步失敗，請查看系統紀錄。'):tr('郵件已同步。')):tr('請先連接 Gmail 帳號。'));return;}
    case 'open-mail':{resetTaskSource('mail');ui.mailId=id;renderMail();const m=message(id);if(!m.read)updateMail([id],{read:true}).catch(e=>toast(tr('郵件可閱讀；已讀狀態未同步：')+e.message));return;}
    case 'mail-back':resetTaskSource('mail');ui.mailId=null;return render();
    case 'star':return updateMail([id],{star:!message(id).star});
    case 'mail-read':return updateMail([id],{read:true});case 'mail-unread':return updateMail([id],{read:false});
    case 'mail-archive':return updateMail([id],{folder:'archive'});case 'mail-trash':return updateMail([id],{folder:'trash'});case 'mail-spam':return updateMail([id],{folder:'spam'});case 'mail-inbox':return updateMail([id],{folder:'inbox'});
    case 'mail-done':return updateMail([id],{done:!message(id).done});
    case 'mail-source':return api.call('mail.openSource',{id});case 'mail-attachment':{const result=await api.call('mail.attachment',{messageId:id,index:Number(target.dataset.index)});if(result.saved)toast(tr('附件已保存。'));return;}
    case 'bulk-read':return updateMail([...ui.selected],{read:true});case 'bulk-unread':return updateMail([...ui.selected],{read:false});case 'bulk-archive':return updateMail([...ui.selected],{folder:'archive'});case 'bulk-trash':return updateMail([...ui.selected],{folder:'trash'});case 'bulk-inbox':return updateMail([...ui.selected],{folder:'inbox'});
    case 'mail-labels':return labelsModal([id]);case 'bulk-labels':return labelsModal([...ui.selected]);
    case 'labels-save':{const entry=ui.modal,folder=document.getElementById('label-folder').value,newName=document.getElementById('label-new').value.trim(),remove=document.getElementById('label-remove').value;let add=document.getElementById('label-add').value;if(newName)add=entry.accountId==='local'?newName:(await api.call('gmail.labelCreate',{id:entry.accountId,name:newName})).id;if(entry.accountId==='local'){for(const id of entry.ids){let labels=[...(message(id).labels||[])].filter(v=>v!==remove);if(add&&!labels.includes(add))labels.push(add);await updateMail([id],{labels,...(folder?{folder}:{})});}}else await updateMail(entry.ids,{...(folder?{folder}:{}),addLabelIds:add?[add]:[],removeLabelIds:remove?[remove]:[]});return closeModal();}
    case 'compose':return openCompose();case 'edit-draft':return openCompose(data.drafts.find(d=>d.id===id));case 'edit-remote-draft':return openCompose(await api.call('draft.openRemote',{id}));case 'reply':case 'reply-all':case 'forward':return openCompose(await api.call('draft.fromMail',{id,mode:action}));
    case 'draft-attach':{ui.modal.draft=readCompose();const attachments=await api.call('draft.attach');ui.modal.draft.attachments.push(...attachments);return composeModal();}
    case 'remove-draft-attachment':ui.modal.draft=readCompose();ui.modal.draft.attachments.splice(Number(target.dataset.index),1);return composeModal();
    case 'draft-save':{const result=await persistDraft(true);if(result&&!result.warning)toast(tr('草稿已保存。'));return;}
    case 'draft-reload-remote':{const entry=ui.modal;await persistDraft(false);const draft=await api.call('draft.reloadRemote',{id:entry.draft.id});if(ui.modal===entry){entry.draft=draft;composeModal();}toast(tr('已保留本機副本，並載入 Gmail 最新版本。'));return;}
    case 'draft-delete':{const entry=ui.modal;await api.call('draft.remove',{id:entry.draft.id});ui.modal=null;return closeModal();}
    case 'draft-send':{const entry=ui.modal;entry.draft=readCompose();clearTimeout(draftTimer);entry.sending=true;overlay.querySelectorAll('button,input,textarea,select').forEach(el=>{el.disabled=true;});try{await draftSaveQueue.catch(()=>{});const result=await api.call('draft.send',entry.draft);if(result.sent&&ui.modal===entry){entry.sending=false;ui.modal=null;await closeModal();toast(result.warning||tr('郵件已寄送。'));}}finally{entry.sending=false;if(ui.modal===entry){await refresh(false);const saved=data.drafts.find(d=>d.id===entry.draft.id);if(saved)entry.draft={...entry.draft,status:saved.status};composeModal();}}return;}
    case 'reset-secrets':ui.modal={type:'reset-secrets'};return modal(tr('重設加密憑證'),tr('<p>將保留無法解密的舊檔並建立空白憑證庫。郵件與檔案不受影響；Gmail 與 API Key 需重新設定。</p>'),btn(tr('重設憑證'),'confirm-reset-secrets','key-round','mf-danger'));
    case 'confirm-reset-secrets':await api.call('secrets.reset');invalidateCloudApiHealth();return closeModal();
    case 'modal-close':return closeModal();
    case 'add-media':return openMeetingUpload();
    case 'choose-media':{const upload=ui.modal;if(upload?.type!=='upload')return;const paths=await api.call('media.choose');if(ui.modal===upload&&paths.length)stageMeetingFiles(paths);return;}
    case 'confirm-media-import':{if(ui.modal?.type!=='upload'||!ui.modal.paths.length)return;const transcription=document.getElementById('upload-transcription').value,source=normalizeSource(document.getElementById('upload-source').value);return importMeetingMedia({paths:[...ui.modal.paths],language:document.getElementById('upload-language').value,source,transcription,...(transcription==='schedule'?{scheduledAt:scheduledTime(document.getElementById('upload-scheduled-at').value)}:{})});}
    case 'media-start':{if(sourceUi.recordings.has(id))return;const r=data.recordings.find(item=>item.id===id);if(!r)return;return operation('media.start',{id,source:recordingSource(r)});}case 'media-pause':return operation('media.pause',{id});
    case 'media-schedule':return openRecordingSchedule(id);
    case 'cancel-media-schedule':return closeModal();
    case 'confirm-media-schedule':{const entry=ui.modal;if(entry?.type!=='schedule-media')return;const scheduledAt=document.getElementById('schedule-mode').value==='schedule'?scheduledTime(document.getElementById('recording-scheduled-at').value):null,source=normalizeSource(document.getElementById('schedule-source').value);await api.call('media.schedule',{ids:[entry.id],scheduledAt,source});if(ui.modal===entry)await closeModal();else await refresh(false);return;}
    case 'media-open':return openMedia(data.recordings.find(r=>r.id===id));
    case 'media-remove':ui.modal={type:'remove-media',id};return modal(tr('移除會議紀錄'),tr('<p>將從 UFriend 清單移除此紀錄。你的原始檔案不受影響。</p>'),btn(tr('移除'),'confirm-remove-media','trash-2','mf-danger'));
    case 'confirm-remove-media':await api.call('media.remove',{id:ui.modal.id});return closeModal();
    case 'transcript-import':{const id=ui.modal.id;await api.call('transcript.import',{id});await refresh(false);return openMedia(data.recordings.find(r=>r.id===id));}
    case 'transcript-edit':return transcriptEditor(data.recordings.find(r=>r.id===ui.modal.id));
    case 'transcript-save':{const id=ui.modal.id;await api.call('transcript.save',{id,format:document.getElementById('transcript-format').value,text:document.getElementById('transcript-text').value});await refresh(false);return openMedia(data.recordings.find(r=>r.id===id));}
    case 'export-txt':case 'export-srt':{const result=await api.call('transcript.export',{id:ui.modal.id,format:action==='export-srt'?'srt':'txt'});if(result.saved)toast(tr('逐字稿已匯出。'));return;}
    case 'export-video':await api.call('video.export',{id});return refresh(false);
    case 'cancel-video-export':await api.call('video.cancel',{id});return refresh(false);
    case 'reveal-video-export':return api.call('video.reveal',{id});
    case 'seek-media':ui.modal?.player?.seek(target.dataset.time);return;
    case 'media-captions':ui.modal?.player?.toggleCaptions();return;
    case 'ocr-import':return operation('ocr.import');case 'ocr-capture':return operation('ocr.capture');case 'ocr-start':if(data.ocr.status==='running')return;return operation('ocr.start',{source:selectedTaskSource('ocr')});case 'ocr-clear':return operation('ocr.clear');case 'ocr-cancel':return operation('ocr.cancel');
    case 'ocr-copy':await saveOcr();await api.call('clipboard.write',{text:document.getElementById('ocr-text').value});return toast(tr('文字已複製。'));
    case 'ocr-image':ui.modal={type:'image'};return modal(tr('來源圖片'),uiText`<img class="mf-image-detail" src="${assetUrl(data.ocr.imageId)}" alt="OCR 來源圖片">`);
    case 'chat-send':return sendChat();
    case 'chat-cancel':{const conversationId=activeChatId();if(ui.chatHistoryBusy)return;await api.call('chat.cancel');if(conversationId===activeChatId()){await refresh(false);if(conversationId===activeChatId()&&ui.view==='chat'){document.getElementById('chat-input').value=data.chat.draft;updateChatUi();}}return;}
    case 'chat-history-toggle':ui.chatHistoryCompact=window.innerWidth<=960||window.innerHeight<=620;ui.chatHistoryOpen=!ui.chatHistoryOpen;updateChatHistoryUi();if(ui.chatHistoryOpen)document.querySelector('#chat-history-list [aria-current="true"]')?.focus();return;
    case 'chat-new':return changeChatConversation('chat.new');
    case 'chat-select':return changeChatConversation('chat.select',{id});
    case 'chat-rename':{if(ui.chatHistoryBusy)return;await saveChatDraft();const entry=chatConversations().find(item=>item.id===id);if(!entry)throw new Error(tr('找不到這段對話。'));ui.modal={type:'rename-chat',id};modal(tr('重新命名對話'),tr('<label class="mf-field" for="chat-rename-title">對話名稱<input id="chat-rename-title" class="mf-input" type="text" maxlength="80" value="')+esc(entry.title)+tr('" autocomplete="off"></label><p class="mf-help">最多 80 字元。</p>'),btn(tr('保存名稱'),'confirm-chat-rename','check','mf-primary'));document.getElementById('chat-rename-title')?.select();return;}
    case 'confirm-chat-rename':{const title=document.getElementById('chat-rename-title').value.trim();if(!title)throw new Error(tr('請輸入對話名稱。'));await api.call('chat.rename',{id:ui.modal.id,title});return closeModal();}
    case 'chat-delete':{if(ui.chatHistoryBusy)return;await saveChatDraft();const entry=chatConversations().find(item=>item.id===id);if(!entry)throw new Error(tr('找不到這段對話。'));ui.modal={type:'delete-chat',id};return modal(tr('刪除對話'),uiText`<p>刪除「${esc(entry.title)}」及其中的訊息與草稿。此操作無法復原。</p>`+(id===activeChatId()&&data.chat.status==='running'?tr('<p class="mf-help">正在產生的回覆也會停止。</p>'):''),btn(tr('刪除對話'),'confirm-chat-delete','trash-2','mf-danger'));}
    case 'confirm-chat-delete':await changeChatConversation('chat.delete',{id:ui.modal.id});return closeModal();
    case 'chat-copy':{const message=data.chat.messages.find(message=>message.id===id&&message.role==='assistant');if(message){await api.call('clipboard.write',{text:message.content});toast(tr('回覆已複製。'));}return;}
    case 'polish-start':await savePolish(true);return;
    case 'polish-cancel':clearTimeout(polishTimer);ui.polishRevision++;await cancelPolishWork();return refresh(false);
    case 'polish-copy':await api.call('clipboard.write',{text:document.getElementById('polish-output').value});return toast(tr('文字已複製。'));
    case 'translation-start':return startTranslation();
    case 'translation-cancel':clearTimeout(translationTimer);ui.translationRevision++;await translationSaveQueue.catch(()=>{});await api.call('translation.cancel');return refresh(false);
    case 'translation-copy':await api.call('clipboard.write',{text:document.getElementById('translation-output').value});return toast(tr('譯文已複製。'));
    case 'prompt-debug-open':await navigate('llm-debug');return loadPromptDefaults();
    case 'prompt-back':return openSettings('prompts');
    case 'prompt-refresh':return loadPromptDefaults();
    case 'prompt-save':return savePromptDefaults();
    case 'prompt-reset':return savePromptDefaults(true);
    case 'theme':return operation('settings.save',{theme:target.dataset.theme});
    case 'model-config-tab':ui.modelConfigTab=target.dataset.modelConfig==='cloud'?'cloud':'local';updateModelConfigTabs();return;
    case 'model-settings':ui.modelConfigTab=target.dataset.configSource==='cloud'?'cloud':'local';await openSettings('models');updateModelConfigTabs();return;
    case 'save-local-backend':{const localBackend=document.getElementById('local-backend').value;await api.call('settings.save',{localBackend});discardSettingsFields(['local-backend']);await refresh();return toast(tr('本地設定已保存。'));}
    case 'save-ui-language':{const value=document.getElementById('ui-language').value;await api.call('settings.save',{uiLanguage:value});discardSettingsFields(['ui-language']);await refresh();toast(tr('介面語言已保存。'));return;}
    case 'save-preferred-language':return operation('settings.save',{preferredLanguage:document.getElementById('preferred-language').value},tr('常用語言已保存。'));
    case 'save-personal-profile':return savePersonalProfile();
    case 'save-mail-schedule':return saveMailSchedule();
    case 'save-gmail-sync':return operation('settings.save',{initialDays:Number(document.getElementById('gmail-days').value),syncMinutes:Number(document.getElementById('gmail-interval').value)},tr('同步偏好已保存。'));
    case 'save-gmail':{const secret=document.getElementById('gmail-client-secret').value;await api.call('gmail.configure',{clientId:document.getElementById('gmail-client-id').value,clientSecret:secret});clearSavedPassword('gmail-client-secret',secret);await refresh();return toast(tr('Google 連接設定已保存，可以登入帳號。'));}
    case 'gmail-setup':return gmailSetupModal();
    case 'gmail-open-console':return api.call('gmail.openConsole');
    case 'gmail-import-config':{const entry=ui.modal;const result=await api.call('gmail.importConfig');if(result.cancelled)return;discardSettingsFields(['gmail-client-id','gmail-client-secret']);await refresh(false);if(ui.modal===entry&&entry?.type==='gmail-setup')gmailSetupModal();else if(!ui.modal)render();toast(tr('Google 設定已匯入，可以直接連接帳號。'));return;}
    case 'gmail-clear-config':{await api.call('gmail.clearConfig');discardSettingsFields(['gmail-client-id','gmail-client-secret']);await refresh();return toast(data.gmailAuth?.bundledConfigured?tr('已恢復此版本的預設設定。'):tr('已清除本機連接設定。已連接帳號不受影響。'));}
    case 'mail-settings':return openSettings('mail');
    case 'connect-gmail':return connectGoogle(id);
    case 'cancel-oauth':await api.call('gmail.cancel');ui.modal=null;return closeModal();
    case 'disconnect-gmail':ui.modal={type:'disconnect',id};return modal(tr('中斷 Gmail 連接'),tr('<p>停止同步並移除此電腦上的連接憑證。</p><label class="mf-auto-switch" style="margin-top:15px"><input id="disconnect-revoke" type="checkbox">同時向 Google 撤銷授權</label><label class="mf-auto-switch" style="margin-top:10px"><input id="disconnect-remove" type="checkbox">同時移除此帳號的本機郵件副本</label>'),btn(tr('中斷連接'),'confirm-disconnect','unlink','mf-danger'));
    case 'confirm-disconnect':await api.call('gmail.disconnect',{id:ui.modal.id,revoke:document.getElementById('disconnect-revoke').checked,removeLocal:document.getElementById('disconnect-remove').checked});return closeModal();
    case 'save-dev-api':{await api.call('settings.save',{localBackend:document.getElementById('local-backend').value,devLlm:{endpoint:document.getElementById('dev-api-endpoint').value},devOcr:{endpoint:document.getElementById('dev-ocr-endpoint').value},devWhisper:{endpoint:document.getElementById('dev-whisper-endpoint').value}});discardSettingsFields(['local-backend','dev-api-endpoint','dev-ocr-endpoint','dev-whisper-endpoint']);await refresh();return toast(tr('本地設定已保存。'));}
    case 'test-dev-api':return testDevApi();
    case 'test-media-api':return testMediaApi(target.dataset.kind);
    case 'test-cloud-api':return testCloudApi(target.dataset.kind);
    case 'save-api':{const key=document.getElementById('api-key').value,temperature=document.getElementById('api-temperature').value.trim();await api.call('settings.save',{api:{endpoint:document.getElementById('api-endpoint').value,model:document.getElementById('api-model').value,ocrModel:document.getElementById('api-ocr-model').value,transcriptionModel:document.getElementById('api-transcription-model').value,temperature:temperature===''?null:Number(temperature)}});if(key)await api.call('secrets.save',{kind:'cloud-api',value:key});clearSavedPassword('api-key',key);discardSettingsFields(['api-endpoint','api-model','api-ocr-model','api-transcription-model','api-temperature']);invalidateCloudApiHealth();await refresh();return toast(tr('雲端設定已保存。'));}
    case 'clear-api':{await api.call('secrets.save',{kind:'cloud-api',clear:true});invalidateCloudApiHealth();discardSettingsFields(['api-key']);await refresh();return toast(tr('金鑰已移除。'));}
    case 'save-policy':{const policy=policyFromUi();ui.policyDraft=null;return operation('settings.save',{policy},tr('模型策略已保存。'));}
    case 'pool-add':return operation('pool.add');case 'pool-remove':return operation('pool.remove',{id});case 'pool-test':return operation('pool.test',{model:target.dataset.model});case 'pool-cancel':return operation('pool.cancel',{id});
    case 'logs-export':{const result=await api.call('logs.export');if(result.saved)toast(tr('系統紀錄已匯出。'));return;}
    case 'diagnostics-open':return api.call('diagnostics.open');
    case 'diagnostics-export':{const result=await api.call('diagnostics.export');if(result.saved)toast(tr('診斷紀錄已匯出。'));return;}
    case 'clear-data':return openDataCleanup(target.dataset.target);
    case 'cancel-clear-data':return closeModal();
    case 'confirm-clear-data':return confirmDataCleanup();
    case 'data-open':return api.call('data.open');
    case 'media-runtime-download':case 'media-runtime-folder':{try{const result=await api.call('mediaRuntime.install',{mode:action==='media-runtime-folder'?'folder':'download'});if(result.installed)toast(tr('影音元件已就緒。'));}finally{await refresh();}return;}
    case 'media-runtime-help':return api.call('mediaRuntime.help');
  }}
  async function saveOcr(){clearTimeout(ocrTimer);const el=document.getElementById('ocr-text');if(!el)return;await api.call('ocr.save',{text:el.value});}
  function polishForm(){const input=document.getElementById('polish-input'),use=document.getElementById('polish-use'),tone=document.getElementById('polish-tone'),output=document.getElementById('polish-output');return input&&use&&tone&&output?{input:input.value,use:use.value,tone:tone.value,output:output.value}:null;}
  function cancelPolishWork(){
    if(polishUi.cancelling)return polishUi.cancelling;
    const pending=api.call('polish.cancel');polishUi.cancelling=pending;
    const release=()=>{if(polishUi.cancelling===pending)polishUi.cancelling=null;};pending.then(release,release);return pending;
  }
  function polishEdited(outputEdited=false,immediate=false){
    const form=polishForm();if(!form)return;
    const running=data.polish.status==='running'||polishUi.requestRevision!==null;
    ui.polishRevision++;
    if(outputEdited)polishUi.outputDirty=true;
    else{polishUi.sourceDirty=true;polishUi.outputDirty=false;form.output='';document.getElementById('polish-output').value='';}
    data.polish={...data.polish,...form,status:outputEdited?(form.output?'manual':'empty'):form.input.trim()?'waiting-model':'empty',error:''};
    if(running)cancelPolishWork().catch(error=>toast(error.message));
    updatePolishUi();clearTimeout(polishTimer);
    if(immediate)return savePolish();
    if(!polishUi.composing)polishTimer=setTimeout(()=>savePolish().catch(error=>toast(error.message)),outputEdited?400:650);
  }
  async function savePolish(runModel=false){
    if(runModel&&polishUi.composing)return;
    clearTimeout(polishTimer);const form=polishForm();if(ui.view!=='polish'||!form)return polishSaveQueue;
    const revision=ui.polishRevision,sourceDirty=polishUi.sourceDirty,outputDirty=polishUi.outputDirty,source=selectedTaskSource('polish');
    polishSaveQueue=polishSaveQueue.catch(()=>{}).then(async()=>{
      if(polishUi.cancelling)await polishUi.cancelling;
      if(revision!==ui.polishRevision)return;
      let saved=await api.call('polish.save',{input:form.input,use:form.use,tone:form.tone,...(sourceDirty?{output:''}:{})});
      if(outputDirty&&revision===ui.polishRevision)saved=await api.call('polish.save',{output:form.output});
      if(revision===ui.polishRevision){polishUi.sourceDirty=false;polishUi.outputDirty=false;if(saved?.polish)data.polish=saved.polish;if(ui.view==='polish')updatePolishUi();}
    });
    await polishSaveQueue;
    if(!runModel||revision!==ui.polishRevision||ui.view!=='polish'||polishUi.composing)return;
    polishUi.requestRevision=revision;data.polish={...data.polish,status:'running',output:'',error:''};updatePolishUi();
    try{await api.call('polish.start',{source});}finally{if(polishUi.requestRevision===revision)polishUi.requestRevision=null;await refresh(false);if(!ui.modal&&ui.view==='polish')updatePolishUi();}
  }
  root.addEventListener('input',event=>{if(event.target.id==='translation-input')translationEdited();});
  root.addEventListener('input',event=>{if(event.target.closest('#personal-profile-form'))updatePersonalProfileUi();});
  root.addEventListener('change',event=>{if(event.target.closest('#personal-profile-form'))updatePersonalProfileUi();});
  root.addEventListener('submit',event=>{if(event.target.id==='personal-profile-form')event.preventDefault();});
  root.addEventListener('compositionstart',event=>{if(['polish-input','polish-output'].includes(event.target.id)){polishUi.composing=true;clearTimeout(polishTimer);updatePolishUi();}});
  root.addEventListener('compositionend',event=>{if(['polish-input','polish-output'].includes(event.target.id)){polishUi.composing=false;polishEdited(event.target.id==='polish-output');}});
  root.addEventListener('change',event=>{if(['translation-source','translation-target'].includes(event.target.id))translationEdited();});
  root.addEventListener('input',event=>{if(['prompt-system','prompt-user'].includes(event.target.id)&&!event.target.readOnly){capturePromptDraft();delete promptUi.messages[promptUi.task];updatePromptStatus();}});
  root.addEventListener('change',event=>{if(event.target.id==='prompt-task'&&Object.hasOwn(promptTasks,event.target.value)){capturePromptDraft();promptUi.task=event.target.value;if(!promptReady())loadPromptDefaults().catch(error=>toast(error.message));else redrawPromptDebug();document.getElementById('prompt-task')?.focus();}});
  root.addEventListener('change',event=>{
    const field=event.target;
    if(field.dataset.aiSourceKind){if(field.disabled||taskSourceBusy(field.dataset.aiSourceKind)){field.value=taskSource(field.dataset.aiSourceKind);return;}saveTaskSource(field.dataset.aiSourceKind,field.value).catch(error=>toast(error.message));}
    if(field.dataset.modelDefaultKind){const source=field.checked?field.dataset.modelDefaultSource:field.dataset.modelDefaultSource==='local'?'cloud':'local';saveModelDefault(field.dataset.modelDefaultKind,source).catch(error=>toast(error.message));}
    if(field.dataset.recordingSource)saveRecordingSource(field.dataset.recordingSource,field.value).catch(error=>toast(error.message));
    if(field.id==='local-backend')updateLocalBackendFields();
    if(field.id==='upload-source'&&ui.modal?.type==='upload'){ui.modal.source=normalizeSource(field.value);setLiveMarkup(document.getElementById('upload-source-hint'),sourceHint('whisper',ui.modal.source));}
    if(field.id==='schedule-source'&&ui.modal?.type==='schedule-media'){ui.modal.source=normalizeSource(field.value);setLiveMarkup(document.getElementById('schedule-source-hint'),sourceHint('whisper',ui.modal.source));}
  });
  root.addEventListener('pointerdown',event=>{if(event.target.closest('[data-model-default-kind][aria-disabled="true"]'))event.preventDefault();});
  root.addEventListener('keydown',event=>{if(event.target.closest('[data-model-default-kind][aria-disabled="true"]')&&!['Tab','Escape'].includes(event.key))event.preventDefault();});
  for(const eventName of ['input','change'])root.addEventListener(eventName,event=>{if(['mail-schedule-enabled','mail-schedule-time'].includes(event.target.id)){mailScheduleUi.error='';mailScheduleUi.saved=false;updateMailScheduleUi();}});
  root.addEventListener('keydown',event=>{
    const tab=event.target.closest('[data-model-config]');if(!tab||event.altKey||event.ctrlKey||event.metaKey)return;
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();ui.modelConfigTab=event.key==='Home'?'local':event.key==='End'?'cloud':ui.modelConfigTab==='local'?'cloud':'local';updateModelConfigTabs({focus:true});
  });
  root.addEventListener('click',event=>{const tab=event.target.closest('[data-settings-tab]');if(tab&&!ui.modal)setSettingsCategory(tab.dataset.settingsTab);});
  root.addEventListener('keydown',event=>{
    const tab=event.target.closest('[data-settings-tab]');
    if(!tab||ui.modal||event.altKey||event.ctrlKey||event.metaKey)return;
    const index=settingsCategories.findIndex(item=>item.id===tab.dataset.settingsTab),last=settingsCategories.length-1;
    const next=event.key==='Home'?0:event.key==='End'?last:['ArrowDown','ArrowRight'].includes(event.key)?(index+1)%(last+1):['ArrowUp','ArrowLeft'].includes(event.key)?(index+last)%(last+1):null;
    if(next===null)return;event.preventDefault();setSettingsCategory(settingsCategories[next].id,{focus:true});
  });
  window.addEventListener('resize',updateSettingsOrientation);
  root.addEventListener('click',event=>{if(event.target.closest('.mf-recording-source-control'))return;const nav=event.target.closest('[data-nav]');if(nav){navigate(nav.dataset.nav).catch(e=>toast(e.message));return;}const target=event.target.closest('[data-action]');if(!target||target.disabled)return;const key=target.dataset.action+':'+(target.dataset.id||'');if(ui.busy.has(key))return;ui.busy.add(key);target.disabled=true;Promise.resolve(handleAction(target.dataset.action,target)).catch(e=>toast(e.message)).finally(()=>{ui.busy.delete(key);if(target.isConnected)target.disabled=false;updateSyncButtons();updateModelUi();updateDevApiStatus();updateCloudApiStatus();updateDataCleanupUi();updateMediaRuntimeUi();});});
  root.addEventListener('input',event=>{const el=event.target;if(ui.modal?.type==='compose'&&!ui.modal.sending&&overlay.contains(el)){clearTimeout(draftTimer);draftTimer=setTimeout(()=>persistDraft(false).catch(e=>toast(e.message)),700);}if(el.id==='chat-input'){data.chat.draft=el.value;clearTimeout(chatTimer);chatTimer=setTimeout(()=>saveChatDraft().catch(error=>toast(error.message)),500);updateChatUi();}for(const service of mediaServices)if(el.id==='dev-'+service.kind+'-endpoint'){ui.mediaHealthRevision[service.kind]++;delete ui.mediaHealth[service.kind];updateDevApiStatus();}if(el.id==='mail-query'){ui.query=el.value;renderKeepFocus(renderInbox);drawIcons();}if(el.id==='ocr-text'){data.ocr.text=el.value;const copy=page.querySelector('[data-action="ocr-copy"]');if(copy)copy.disabled=!el.value.trim();clearTimeout(ocrTimer);ocrTimer=setTimeout(()=>saveOcr().catch(e=>toast(e.message)),400);}if(el.id==='dev-api-endpoint'){ui.devApiHealthRevision++;ui.devApiHealth=null;updateDevApiStatus();}if(el.id==='polish-input')polishEdited();if(el.id==='polish-output'&&!el.readOnly)polishEdited(true);});
  root.addEventListener('change',event=>{const el=event.target;Promise.resolve((async()=>{if(el.dataset.source){if(el.checked)ui.sources.add(el.dataset.source);else ui.sources.delete(el.dataset.source);return render();}if(el.dataset.select){if(el.checked)ui.selected.add(el.dataset.select);else ui.selected.delete(el.dataset.select);return render();}if(el.id==='mail-all'){ui.selected=new Set(el.checked?visibleMails().map(m=>m.id):[]);return render();}if(el.id==='mail-folder'){ui.folder=el.value;ui.selected.clear();renderKeepFocus(renderInbox);drawIcons();return;}if(el.id==='mail-category'){ui.category=el.value;ui.selected.clear();updateInboxResults();return;}if(el.id==='mail-sender'){ui.sender=el.value;updateInboxResults();return;}if(el.id==='mail-recent'){ui.recentDays=el.value;updateInboxResults();return;}if(el.id==='mail-level')return updateMail([ui.mailId],{level:el.value===''?null:Number(el.value)});if(el.id==='ocr-auto')return operation('settings.save',{ocrAuto:el.checked});if(['polish-use','polish-tone'].includes(el.id))return polishEdited(false,true);if(el.name==='policy-mode'){ui.policyDraft=policyFromUi();return render();}if(el.id==='keep-background')return operation('settings.save',{keepBackground:el.checked});if(el.id==='recording-language')return api.call('media.update',{id:ui.modal.id,patch:{lang:el.value}});})()).catch(e=>toast(e.message));});
  root.addEventListener('dragenter',event=>{if(!hasDroppedFiles(event))return;event.preventDefault();fileDragDepth++;updateFileDragUi();});
  root.addEventListener('change',event=>{
    if(event.target.id==='upload-transcription')document.getElementById('upload-schedule-field').hidden=event.target.value!=='schedule';
    if(event.target.id==='schedule-mode')document.getElementById('recording-schedule-field').hidden=event.target.value!=='schedule';
  });
  root.addEventListener('dragover',event=>{if(!hasDroppedFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect=fileDropTarget(event)?'copy':'none';updateFileDragUi();});
  root.addEventListener('dragleave',event=>{if(!hasDroppedFiles(event))return;fileDragDepth=Math.max(0,fileDragDepth-1);updateFileDragUi();});
  root.addEventListener('drop',event=>{
    if(!hasDroppedFiles(event))return;
    event.preventDefault();const target=fileDropTarget(event);resetFileDrag();if(!target)return;
    const files=Array.from(event.dataTransfer.files),language=document.getElementById('upload-language')?.value||'zh-TW';
    importDroppedFiles(files,target,language).catch(error=>toast(error.message||tr('檔案未能匯入，請稍後再試。')));
  });
  root.addEventListener('dragend',resetFileDrag);
  window.addEventListener('blur',resetFileDrag);
  root.addEventListener('paste',event=>{if(ui.view==='ocr'&&[...event.clipboardData.items].some(item=>item.type.startsWith('image/'))){event.preventDefault();operation('ocr.capture').catch(e=>toast(e.message));}});
  document.addEventListener('keydown',event=>{if(event.target.id==='chat-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();page.querySelector('[data-action="chat-send"]')?.click();}if(ui.modal&&event.key==='Escape'){event.preventDefault();if(ui.modal.type==='oauth')api.call('gmail.cancel').catch(()=>{});closeModal().catch(e=>toast(e.message));}if(ui.modal&&event.key==='Tab'){const focusable=[...overlay.querySelectorAll('button,input,select,textarea,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&ui.modal?.type==='compose'){event.preventDefault();persistDraft(true).then(result=>{if(result&&!result.warning)toast(tr('草稿已保存。'));}).catch(e=>toast(e.message));}});
  window.addEventListener('error',event=>{reportRendererException(event.error,'RENDERER_ERROR',event.lineno,event.colno);});
  window.addEventListener('unhandledrejection',event=>{reportRendererException(event.reason,'UNHANDLED_REJECTION');let message=tr('操作未完成。');try{if(typeof event.reason?.message==='string')message=event.reason.message;}catch{}toast(message);});
  window.addEventListener('resize',()=>{const compact=window.innerWidth<=960||window.innerHeight<=620;if(compact&&!ui.chatHistoryCompact){ui.chatHistoryOpen=false;if(data&&ui.view==='chat')updateChatHistoryUi();}ui.chatHistoryCompact=compact;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!ui.modal&&ui.view==='chat'&&ui.chatHistoryOpen){ui.chatHistoryOpen=false;updateChatHistoryUi();top.querySelector('[data-action="chat-history-toggle"]')?.focus();}});
  if(!api){page.innerHTML=empty(tr('請從 UFriend 桌面程式開啟此頁面。'));return;}
  if(typeof api.onChatStream==='function')api.onChatStream(receiveChatStream);
  api.onChange(next=>{const previousImage=data?.ocr?.imageId,previousChatId=data?.chatHistory?.activeId,previousSources=new Set(allSources(data));acceptSnapshot(next);const languageChanged=applyUiLanguage();for(const source of allSources(next))if(!previousSources.has(source))ui.sources.add(source);setTheme();updateSyncButtons();updateModelUi();if(ui.modal){updateOAuthDialog();updateMediaDialog();return;}const editing=page.contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);if(ui.view==='settings'){if(languageChanged){render();return;}updateAccountStatus();renderPool();updateDataCleanupUi();updateMediaRuntimeUi();return;}if(ui.view==='polish')return;if(ui.view==='chat'){if(previousChatId!==activeChatId()){renderChat();drawIcons();}return;}if(ui.view==='ocr'&&previousImage!==data.ocr.imageId){render();return;}if(!editing)render();});
  setInterval(()=>{if((ui.view==='settings'||ui.view==='logs')&&!ui.modal)api.call('bootstrap').then(next=>{if(!data)return;data.diagnostics=next.diagnostics;updateDiagnosticsUi();if(ui.view==='settings'){data.pool=next.pool;data.cleanup=next.cleanup;data.mailScheduleState=next.mailScheduleState;renderPool();updateDataCleanupUi();updateMailScheduleUi();}}).catch(()=>{});},500);
  refresh(false).then(()=>{ui.sources=new Set(allSources(data));render();}).catch(e=>{page.innerHTML=empty(tr('無法載入工作空間：')+e.message);});
})();

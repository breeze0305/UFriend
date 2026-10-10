'use strict';
const {app,BrowserWindow,ipcMain,dialog,clipboard,nativeImage,nativeTheme,safeStorage,shell,protocol,Tray,Menu}=require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {randomUUID}=require('node:crypto');
const {Store}=require('./services/store.cjs');
const {Diagnostics}=require('./services/diagnostics.cjs');
const {GmailService}=require('./services/gmail.cjs');
const {normalizeGoogleOAuthConfig,readGoogleOAuthConfig,resolveGoogleOAuthConfig}=require('./services/google-oauth-config.cjs');
const {replyRecipients}=require('./services/mail-util.cjs');
const {Vault}=require('./services/vault.cjs');
const {AppService}=require('./services/core.cjs');
const {MailScheduler}=require('./services/mail-scheduler.cjs');
const {defaultModelSource}=require('./services/model-source.cjs');
const {meetingCleanupInfo,clearMeetingMedia}=require('./services/media-cleanup.cjs');
const {clearAllChats,clearAllLogs}=require('./services/data-cleanup.cjs');
const {loadRemoteImage,imageDataUrl}=require('./services/mail-images.cjs');
const {assetResponse}=require('./services/asset-protocol.cjs');
const {VideoExportJobs}=require('./services/video-export-jobs.cjs');
const {resolveVideoFfmpegPath}=require('./services/video-runtime.cjs');
const {ModelAdapters,modelSource}=require('./models/adapters.cjs');
const {CloudApiAdapter}=require('./models/cloud-api.cjs');
const {LocalLlmApiAdapter}=require('./models/local-llm-api.cjs');
const {TASK_VARIABLES,validatePrompt}=require('./services/llm-prompts.cjs');
const {LocalMediaApiAdapter}=require('./models/local-media-api.cjs');
const {ModelPoolScheduler}=require('./services/model-pool.cjs');
const {fileType,safeName,exportSrt,exportTxt,digest}=require('./services/formats.cjs');

app.setName('UFriend');
const modelSmoke=process.argv.includes('--model-smoke-test');
const clipboardSmoke=process.argv.includes('--clipboard-smoke-test');
const llmFeaturesSmoke=process.argv.includes('--llm-features-smoke-test');
const smoke=process.argv.includes('--smoke-test')||modelSmoke||clipboardSmoke||llmFeaturesSmoke;
const dataOverride=smoke?path.join(__dirname,'..','.test-data',clipboardSmoke?'clipboard-smoke':modelSmoke?'model-smoke':llmFeaturesSmoke?'llm-features-smoke':'smoke'):process.env.UFRIEND_DATA_DIR;
if(smoke){
  const projectDir=path.resolve(__dirname,'..'),realProject=fs.realpathSync(projectDir);
  for(const target of [path.join(projectDir,'.test-data'),dataOverride,path.join(dataOverride,'workspace')]){
    try{fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const expected=path.join(realProject,path.relative(projectDir,target));
    if(fs.realpathSync(target).toLowerCase()!==expected.toLowerCase())throw new Error('Smoke data must remain in its isolated project directory.');
  }
}
if(dataOverride)app.setPath('userData',path.resolve(dataOverride));
protocol.registerSchemesAsPrivileged([{scheme:'ufriend-asset',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
let win,tray,store,core,vault,gmail,pool,llmApi,ocrApi,whisperApi,videoExports,diagnostics,clipboardProcess,clipboardStatus='disabled',clipboardGeneration=0;
let quitting=false,closing=false,broadcastTimer,lastClipboardHash='',syncTimer,syncing=false,ocrInputRevision=0,clipboardReadSequence=0,ocrUserInputRevision=0;
const shellI18n=require('./i18n.js').create({catalogs:{en:{...require('./locales/en-common.js'),...require('./locales/en-settings.js'),...require('./locales/en-native.js'),...require('./locales/en-extra.js')}}});
const tr=source=>{shellI18n.setLocale(store?.read()?.settings?.uiLanguage);return shellI18n.tr(source);};
function updateShellLanguage(){const title=tr('UFriend | 你的本地助手');tray?.setToolTip?.(title);if(tray)tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));win?.setTitle?.(title);}
const uiUrl=pathToFileURL(path.join(__dirname,'index.html')).href;
const dataDir=path.join(app.getPath('userData'),'workspace');
const managedFiles=path.join(dataDir,'files');
let simulatedPolicyTimer;
let mailScheduler;
let cleanupBusy='';
const knownSecretKeys=new Set(['cloud-api','gmail-client']);
let bundledGoogleOAuth=null,bundledGoogleOAuthError='',gmailAuthFlow=null;
try{bundledGoogleOAuth=readGoogleOAuthConfig(path.join(__dirname,'config','google-oauth.json'),{optional:true});}catch(e){bundledGoogleOAuthError=e.message;}

function gmailAuthStatus(){
  const settings=store.read().settings||{};
  try{const config=resolveGoogleOAuthConfig({settings,bundled:bundledGoogleOAuth,getManualSecret:()=>''});return{configured:!!config,source:config?.source||'none',hasOverride:!!settings.gmailClientId,bundledConfigured:!!bundledGoogleOAuth,error:config?'':bundledGoogleOAuthError,phase:gmailAuthFlow?.phase||'idle'};}
  catch(e){return{configured:false,source:'manual',hasOverride:!!settings.gmailClientId,bundledConfigured:!!bundledGoogleOAuth,error:e.message,phase:gmailAuthFlow?.phase||'idle'};}
}
function requireAuthIdle(){if(gmailAuthFlow)throw Object.assign(new Error(tr('Gmail 正在連接，請先完成或取消。')),{code:'AUTH_BUSY'});}
function setGmailAuthPhase(phase){if(gmailAuthFlow){gmailAuthFlow.phase=phase;broadcast();}}
function saveGoogleOAuthOverride(config){
  requireAuthIdle();
  const previous=vault.get('gmail-client');
  try{if(config?.clientSecret)vault.set('gmail-client',{clientSecret:config.clientSecret});else vault.delete('gmail-client');core.settings({gmailClientId:config?.clientId||''});}
  catch(e){try{if(previous)vault.set('gmail-client',previous);else vault.delete('gmail-client');}catch{}throw e;}
  broadcast();return publicState();
}
async function connectGmail(args={}){
  requireAuthIdle();
  const config=resolveGoogleOAuthConfig({settings:store.read().settings,bundled:bundledGoogleOAuth,getManualSecret:()=>vault.get('gmail-client')?.clientSecret||''});
  if(!config)throw Object.assign(new Error(tr('此版本尚未完成 Gmail 首次設定，請匯入 Google 設定檔。')),{code:'AUTH_NOT_CONFIGURED'});
  const flow={phase:'opening'};gmailAuthFlow=flow;broadcast();let connection;
  try{
    const loginHint=args.id?gmail.listAccounts().find(a=>a.id===args.id)?.email:undefined;
    const account=await gmail.connect({clientId:config.clientId,clientSecret:config.clientSecret,days:store.read().settings.initialDays,loginHint});
    if(!smoke&&win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}
    setGmailAuthPhase('syncing');let syncError='';
    try{const results=await syncAccounts(account.id);syncError=results.find(r=>r.error)?.error||'';}catch(e){syncError=e.message;}
    connection={email:account.email,syncError};
  }finally{if(gmailAuthFlow===flow)gmailAuthFlow=null;broadcast();}
  return{...publicState(),connection};
}

function credentialStatus(){try{return vault.status?vault.status():{available:vault.available(),cloudKeySet:!!vault.get('cloud-api'),gmailSecretSet:!!vault.get('gmail-client')?.clientSecret,error:null};}catch(e){return{available:vault.available(),cloudKeySet:false,gmailSecretSet:false,error:e.message};}}
function cleanupSummary(state=core.snapshot()){
  const conversations=state.chatHistory.conversations.filter(entry=>entry.chat.messages.length||entry.chat.draft||entry.chat.pendingText||entry.chat.status==='running'||entry.title!=='新對話');
  return{busy:cleanupBusy,media:meetingCleanupInfo(core,{state}),chat:{conversations:conversations.length,messages:conversations.reduce((sum,entry)=>sum+entry.chat.messages.length,0),running:state.chat.status==='running'},logs:{entries:state.logs.length}};
}
async function cleanupInfo(){const info=cleanupSummary();try{info.logs={...info.logs,...await diagnostics.cleanupInfo()};}catch{info.logs.error='診斷檔案目前無法讀取，刪除時會顯示未完成原因。';}return info;}
async function clearData(args){
  if(!['media','chat','logs'].includes(args.target)||args.confirmed!==true)throw new Error(tr('請先確認要刪除的資料。'));
  if(cleanupBusy)throw new Error(tr('資料正在刪除，請等待完成。'));
  cleanupBusy=args.target;broadcast();let result;
  try{
    if(args.target==='media')result=await clearMeetingMedia(core);
    else if(args.target==='chat')result=clearAllChats(core);
    else result=await clearAllLogs({store,diagnostics,onChange:broadcast});
  }finally{cleanupBusy='';core.wakeRecordingScheduler();broadcast();}
  return{...result,info:await cleanupInfo()};
}
function publicState(){const state=core.snapshot();const accountList=gmail.listAccounts();return{...state,accounts:accountList,dataPath:dataDir,version:app.getVersion(),secrets:credentialStatus(),gmailAuth:gmailAuthStatus(),clipboard:{status:clipboardStatus},pool:pool.snapshot(),videoExport:videoExports?.snapshot()||{status:'idle'},diagnostics:diagnostics.info(),cleanup:cleanupSummary(state),syncing};}
function broadcast(){if(broadcastTimer)return;broadcastTimer=setTimeout(()=>{broadcastTimer=null;if(win&&!win.isDestroyed())win.webContents.send('ufriend:change',publicState());},70);}
function log(text,detail='',status='success'){store.appendLog(text,detail,status);broadcast();}
function getMessage(id){const m=store.read().messages.find(m=>m.id===id);if(!m)throw new Error(tr('找不到這封郵件。'));return m;}
const mailImageCache=new Map();let mailImageCacheBytes=0;
async function mailContent(id){
  let message=getMessage(id);
  if(message.source==='Gmail'&&message.htmlVersion!==1)message=await gmail.ensureMessageContent(id);
  return{id:message.id,body:message.body,html:message.html??null,htmlVersion:message.htmlVersion,attachments:message.attachments};
}
async function mailImage({id,source,refresh=false}){
  const message=getMessage(id);
  if(typeof source!=='string'||source.length>12*1024*1024)throw new Error(tr('郵件圖片來源格式錯誤。'));
  const key=id+':'+digest(Buffer.from(source));
  if(refresh&&mailImageCache.has(key)){mailImageCacheBytes-=mailImageCache.get(key).bytes;mailImageCache.delete(key);}
  if(mailImageCache.has(key))return mailImageCache.get(key).promise;
  const entry={bytes:0,promise:null};
  entry.promise=(async()=>{
    if(/^cid:/i.test(source)){
      const normalize=value=>{try{return decodeURIComponent(String(value||'')).replace(/^<|>$/g,'').toLowerCase();}catch{return '';}};
      const cid=normalize(source.slice(4)),attachment=message.attachments?.find(item=>cid&&normalize(item.contentId)===cid);
      if(!attachment)throw new Error(tr('找不到郵件內嵌圖片。'));
      if(attachment.size>8*1024*1024)throw new Error(tr('郵件圖片超過 8 MB。'));
      let bytes;
      if(attachment.assetId)bytes=await fsp.readFile(core.asset(attachment.assetId).path);
      else if(attachment.content)bytes=Buffer.from(attachment.content.data||attachment.content,typeof attachment.content==='string'?'base64':undefined);
      else if(message.source==='Gmail')bytes=await gmail.downloadAttachment(message.accountId,message.remoteId,attachment.attachmentId);
      else throw new Error(tr('郵件內嵌圖片尚未保存。'));
      return imageDataUrl(bytes,attachment.mimeType);
    }
    const embedded=/^data:([^;,]+);base64,([a-z\d+/=\r\n]+)$/i.exec(source);
    if(embedded)return imageDataUrl(Buffer.from(embedded[2],'base64'),embedded[1]);
    return loadRemoteImage(source);
  })();
  mailImageCache.set(key,entry);
  try{
    const result=await entry.promise;if(mailImageCache.get(key)!==entry)return result;entry.bytes=result.dataUrl.length;mailImageCacheBytes+=entry.bytes;
    while(mailImageCache.size>80||mailImageCacheBytes>32*1024*1024){const oldest=mailImageCache.keys().next().value;mailImageCacheBytes-=mailImageCache.get(oldest).bytes;mailImageCache.delete(oldest);}
    return result;
  }catch(error){if(mailImageCache.get(key)===entry)mailImageCache.delete(key);throw error;}
}
async function openMailLink({id,href}){
  getMessage(id);
  if(typeof href!=='string'||href.length>16384||/[\x00-\x1f\x7f]/.test(href))throw new Error(tr('郵件連結格式不支援。'));
  let url;try{url=new URL(href);}catch{throw new Error(tr('郵件連結格式不支援。'));}
  if(!['http:','https:','mailto:'].includes(url.protocol)||url.username||url.password)throw new Error(tr('郵件連結格式不支援。'));
  await shell.openExternal(url.href);return{opened:true};
}
function accountAvailable(id){return gmail.listAccounts().some(a=>a.id===id&&a.connected!==false);}
function nativeParent(){return win&&!win.isDestroyed()?win:undefined;}
async function chooseFiles(filters,multiple=true){const result=await dialog.showOpenDialog(nativeParent(),{properties:['openFile',...(multiple?['multiSelections']:[])],filters});return result.canceled?[]:result.filePaths;}
async function saveOutput(name,buffer,filters){const result=await dialog.showSaveDialog(nativeParent(),{defaultPath:safeName(name),filters});if(result.canceled||!result.filePath)return{cancelled:true};await fsp.writeFile(result.filePath,buffer);return{saved:true,name:path.basename(result.filePath)};}
function trimError(e){return{code:e.code||'ACTION_FAILED',message:String(e.message||'操作未完成。').slice(0,800)};}
async function flushWindow(){if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())await win.webContents.executeJavaScript('window.flushUFriend?.()');}
async function requestQuit({restart=false}={}){
  if(quitting||closing)return;closing=true;
  try{
    core?.stopRecordingScheduler?.();mailScheduler?.stop();videoExports?.setClosing(true);
    await flushWindow();await videoExports?.shutdown();core?.cancelMailAnalysis();core?.cancelPolish();core?.cancelChat();core?.cancelTranslation();core?.cancelOcr();
    for(const key of [...core?.active?.keys()||[]])if(key.startsWith('recording:'))core.pauseRecording(key.slice(10));
    const cleanup=await Promise.allSettled([ocrApi?.cancelAll(),whisperApi?.cancelAll(),...['llm','ocr','whisper'].map(kind=>core?.models?.get?.(kind,'cloud')?.cancelAll?.())]);
    const cleanupFailure=cleanup.find(result=>result.status==='rejected'&&result.reason?.code==='MODEL_TEMP_CLEANUP_FAILED');
    if(cleanupFailure){await diagnostics?.write({event:'cloud.temp_cleanup_failed',level:'error',code:'MODEL_TEMP_CLEANUP_FAILED'});await diagnostics?.flush();throw cleanupFailure.reason;}
    await diagnostics?.write({event:restart?'app.restarting':'app.stopped'});await diagnostics?.flush();
    if(restart)app.relaunch();quitting=true;app.quit();
  }catch(e){closing=false;videoExports?.setClosing(false);core?.startRecordingScheduler?.();mailScheduler?.start();if(win&&!win.isDestroyed())win.show();dialog.showErrorBox(restart?tr('尚未重新啟動 UFriend'):tr('尚未關閉 UFriend'),e.message||tr('資料尚未保存，請稍後再試。'));}
}
function trayMenuTemplate(){return[{label:tr('開啟 UFriend'),click:()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}}},{type:'separator'},{label:tr('重新啟動 UFriend'),click:()=>requestQuit({restart:true})},{label:tr('結束 UFriend'),click:()=>requestQuit()}];}

async function receiveClipboard(manual=false,generation=clipboardGeneration){
  if(!manual&&generation!==clipboardGeneration)return{skipped:true};
  // Keep async reads in order, without invalidating an image import for a
  // clipboard notification that ultimately contains no new image.
  const sequence=++clipboardReadSequence;let revision=ocrInputRevision;
  const stale=()=>sequence!==clipboardReadSequence||revision!==ocrInputRevision||(!manual&&generation!==clipboardGeneration);
  let img;
  try{
    const items=await clipboard.read();if(stale())return{skipped:true};
    const item=items.find(item=>item.types.includes('image/png')||item.types.includes('image/jpeg'));
    if(!item){if(manual)throw new Error(tr('剪貼簿目前沒有圖片。'));return{skipped:true};}
    const type=item.types.includes('image/png')?'image/png':'image/jpeg';
    const blob=await item.getType(type);if(stale())return{skipped:true};
    if(blob.size>40*1024*1024)throw new Error(tr('圖片必須小於 40 MB。'));
    const bytes=await blob.arrayBuffer();if(stale())return{skipped:true};
    img=nativeImage.createFromBuffer(Buffer.from(bytes));
  }catch(error){if(stale())return{skipped:true};throw error;}
  if(img.isEmpty()){if(manual)throw new Error(tr('剪貼簿目前沒有圖片。'));return{skipped:true};}
  const size=img.getSize();if(size.width*size.height>60_000_000||size.width>20000||size.height>20000)throw new Error(tr('圖片尺寸過大，請縮小截圖範圍。'));
  const buffer=img.toPNG(),hash=digest(buffer);if(!manual&&hash===lastClipboardHash)return{skipped:true};
  revision=++ocrInputRevision;
  const asset=await core.ingestBuffer(buffer,{name:'截圖-'+new Date().toISOString().replace(/[:.]/g,'-')+'.png'});
  if(revision!==ocrInputRevision||(!manual&&generation!==clipboardGeneration))return{skipped:true};
  lastClipboardHash=hash;await core.setOcrImage(asset);
  if(revision!==ocrInputRevision||(!manual&&generation!==clipboardGeneration))return{skipped:true};
  if(store.read().settings.ocrAuto)await core.runOcr('local',{preserveSelection:true});return publicState();
}
function stopClipboard(){clipboardGeneration++;clipboardStatus='disabled';const child=clipboardProcess;clipboardProcess=null;if(child){try{child.stdin.end('stop\n');}catch{}const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},1200);timer.unref();}}
// Explicit user input invalidates queued native notifications; an automatic
// image adoption must not discard a newer notification waiting behind it.
function startClipboard(){stopClipboard();if(smoke&&!clipboardSmoke){clipboardStatus='test-disabled';return;}if(process.platform!=='win32'){clipboardStatus='unsupported';return;}const exe=path.join(__dirname,'native','ClipboardListener.exe');if(!fs.existsSync(exe)){clipboardStatus='unavailable';log('剪貼簿監聽無法啟動','找不到 Windows 通知元件，請執行 npm run build:native。','error');return;}const generation=clipboardGeneration;let child;try{child=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(e){clipboardStatus='error';log('剪貼簿監聽無法啟動',e.message,'error');return;}clipboardProcess=child;clipboardStatus='starting';let pending=false,queuedRevision=null;const lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}if(child!==clipboardProcess)return;if(event.type==='ready'){clipboardStatus='listening';broadcast();}if(event.type==='error'){clipboardStatus='error';log('剪貼簿監聽失敗',event.message,'error');}if(event.type==='clipboard'){const processImage=async(userRevision)=>{if(userRevision!==ocrUserInputRevision)return;if(pending){queuedRevision=userRevision;return;}pending=true;try{await receiveClipboard(false,generation);}catch(e){log('讀取剪貼簿圖片失敗',e.message,'error');}finally{pending=false;const next=queuedRevision;queuedRevision=null;if(next!==null)processImage(next);}};processImage(ocrUserInputRevision);}});child.on('error',e=>{if(child!==clipboardProcess)return;clipboardStatus='error';log('剪貼簿監聽失敗',e.message,'error');});child.stderr.on('data',()=>{});child.on('exit',code=>{lines.close();if(child===clipboardProcess){clipboardProcess=null;clipboardStatus='error';log('剪貼簿監聽已停止',`元件結束（${code??'中斷'}），可關閉再啟用。`,'error');}});}

async function syncAccounts(accountId){if(syncing)throw new Error(tr('郵件正在同步，請稍候。'));syncing=true;broadcast();const results=[];try{const accounts=gmail.listAccounts().filter(a=>(!accountId||a.id===accountId)&&a.connected!==false);for(const a of accounts){try{results.push({id:a.id,...await gmail.sync(a.id,{days:store.read().settings.initialDays})});}catch(e){results.push({id:a.id,error:e.message});log('郵件同步失敗',a.email||'Gmail','error');}}return results;}finally{syncing=false;broadcast();}}
function scheduleSync(){clearInterval(syncTimer);syncTimer=setInterval(()=>{if(!syncing&&!mailScheduler?.running&&gmail.listAccounts().some(a=>a.connected!==false))syncAccounts().catch(()=>{});},store.read().settings.syncMinutes*60000);syncTimer.unref();}
function withMailScheduleSlot(work){
  if(mailScheduler?.running)throw Object.assign(new Error(tr('自動郵件整理正在執行，請稍候。')),{code:'MAIL_ANALYSIS_BUSY'});
  return work();
}
function createMailScheduler(){
  return new MailScheduler({read:()=>store.read(),save:state=>core.change(d=>{d.mailScheduleState=state;},null),
    isBusy:()=>syncing||!!gmailAuthFlow||closing||quitting||['mail-analysis','chat','translation','polish'].some(kind=>core.active.has(kind)),
    onError:()=>log('自動郵件整理狀態保存失敗','','error'),
    run:async settings=>{
      const source=defaultModelSource(settings,'llm'),synced=await syncAccounts();
      if(closing||quitting)throw Object.assign(new Error('自動郵件整理已中斷，可手動重新整理。'),{code:'MODEL_CANCELLED'});
      const result=await core.analyzeMail(source,{categorize:true,onlyChanged:true}),analysis=result.mailAnalysis;
      const syncFailures=synced.filter(item=>item.error).length;
      const error=[syncFailures?`${syncFailures} 個郵件帳戶同步失敗，已整理本機可用的信件。`:'',analysis.error].filter(Boolean).join(' ');
      return{status:analysis.status==='cancelled'?'cancelled':error?'error':'done',error};
    }});
}
function getRemoteChanges(patch){const addLabelIds=[],removeLabelIds=[];if(patch.read!==undefined)(patch.read?removeLabelIds:addLabelIds).push('UNREAD');if(patch.star!==undefined)(patch.star?addLabelIds:removeLabelIds).push('STARRED');if(patch.folder){if(patch.folder==='inbox'){addLabelIds.push('INBOX');removeLabelIds.push('TRASH','SPAM');}if(patch.folder==='archive')removeLabelIds.push('INBOX','TRASH','SPAM');if(patch.folder==='trash'){addLabelIds.push('TRASH');removeLabelIds.push('INBOX','SPAM');}if(patch.folder==='spam'){addLabelIds.push('SPAM');removeLabelIds.push('INBOX','TRASH');}}if(patch.addLabelIds)addLabelIds.push(...patch.addLabelIds);if(patch.removeLabelIds)removeLabelIds.push(...patch.removeLabelIds);return{addLabelIds:[...new Set(addLabelIds)],removeLabelIds:[...new Set(removeLabelIds)]};}
async function modifyMail({ids,patch}){if(!Array.isArray(ids)||ids.length>1000||!patch||typeof patch!=='object')throw new Error(tr('郵件操作格式錯誤。'));const messages=ids.map(getMessage),groups=new Map(),local=[],failed=[],succeeded=[];const remotePatch=getRemoteChanges(patch);for(const m of messages){if(m.accountId==='local'||(!remotePatch.addLabelIds.length&&!remotePatch.removeLabelIds.length))local.push(m.id);else{if(!groups.has(m.accountId))groups.set(m.accountId,[]);groups.get(m.accountId).push(m);}}for(const [accountId,list] of groups){try{const result=await gmail.modify(accountId,list.map(m=>m.remoteId),remotePatch);const successful=new Set(result.succeeded||[]);const ids=list.filter(m=>successful.has(m.remoteId)).map(m=>m.id);if(ids.length){const localFields={};for(const k of ['done','level'])if(patch[k]!==undefined)localFields[k]=patch[k];if(Object.keys(localFields).length)core.updateLocalMessages(ids,localFields);succeeded.push(...ids);}failed.push(...(result.failed||[]));}catch(e){failed.push(...list.map(m=>({id:m.id,error:e.message})));}}if(local.length){core.updateLocalMessages(local,patch);succeeded.push(...local);}broadcast();return{succeeded,failed};}

async function materializeAttachments(message){const attachments=[];let total=0;for(const a of message.attachments||[]){total+=a.size||0;if(total>20*1024*1024)throw new Error(tr('附件合計超過 20 MB，請先個別下載。'));if(a.assetId){attachments.push({...a});continue;}const buffer=await gmail.downloadAttachment(message.accountId,message.remoteId,a.attachmentId);const asset=await core.ingestBuffer(buffer,{name:a.name,category:'attachment',mime:a.mimeType});attachments.push({assetId:asset.id,name:asset.name,mimeType:asset.mimeType,size:asset.size});}return attachments;}
async function openRemoteDraft(id){const m=getMessage(id);if(!m.draftId)throw new Error(tr('找不到 Gmail 草稿識別碼，請先重新同步。'));const existing=store.read().drafts.find(d=>d.accountId===m.accountId&&d.remoteDraftId===m.draftId);if(existing)return existing;const draft={id:randomUUID(),accountId:m.accountId,to:m.to||'',cc:m.cc||'',bcc:m.bcc||'',subject:m.subject||'',body:m.body||'',attachments:await materializeAttachments(m),remoteDraftId:m.draftId,remoteMessageId:m.remoteId,inReplyTo:m.inReplyTo||'',references:m.references||[],threadId:m.threadId,replyToId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'synced'};store.update(d=>{d.drafts.unshift(draft);});broadcast();return draft;}
async function composeFromMail({id,mode}){const m=getMessage(id);if(!['reply','reply-all','forward'].includes(mode))throw new Error(tr('回覆模式錯誤。'));const self=store.read().accounts.find(a=>a.id===m.accountId)?.email||'';const accountId=m.accountId==='local'?(gmail.listAccounts().find(a=>a.connected)?.id||'local'):m.accountId;const forwarding=mode==='forward';return{id:randomUUID(),accountId,...(forwarding?{to:'',cc:'',bcc:''}:replyRecipients(m,self,mode==='reply-all')),subject:(forwarding?/^(fw|fwd):/i:/^re:/i).test(m.subject)?m.subject:(forwarding?'Fwd: ':'Re: ')+(m.subject||''),body:`\n\n${forwarding?'---------- 轉寄郵件 ----------':`${m.date||''}，${m.sender||m.email} 寫道：`}\n${m.body||''}`,attachments:forwarding?await materializeAttachments(m):[],replyToId:forwarding?null:m.id};}
async function reloadRemoteDraft(id){
  const local=store.read().drafts.find(d=>d.id===id);if(!local?.remoteDraftId)throw new Error(tr('這份草稿沒有 Gmail 版本。'));
  const latest=await gmail.getDraft(local.accountId,local.remoteDraftId),attachments=await materializeAttachments(latest);
  const draft={id:randomUUID(),accountId:local.accountId,to:latest.to||'',cc:latest.cc||'',bcc:latest.bcc||'',subject:latest.subject||'',body:latest.body||'',attachments,remoteDraftId:latest.draftId,remoteMessageId:latest.remoteId,inReplyTo:latest.inReplyTo||'',references:latest.references||[],threadId:latest.threadId,replyToId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'synced'};
  store.update(d=>{const copy=d.drafts.find(x=>x.id===id);if(copy){copy.remoteDraftId=null;copy.remoteMessageId=null;copy.status='local-copy';copy.error='';}d.drafts.unshift(draft);});log('保留本機草稿副本並載入 Gmail 最新版本');return draft;
}

function cleanDraft(args){
  const text=(v,max=10000)=>String(v??'').slice(0,max);
  const original=args.id?store.read().drafts.find(d=>d.id===args.id):null;
  const accountId=text(args.accountId,300)||'local',sameAccount=original?.accountId===accountId;
  const retainedStatus=sameAccount&&['send-uncertain','send-error','sync-error','conflict'].includes(original?.status)?original.status:'local';
  return{id:original?.id||(/^[0-9a-f-]{36}$/i.test(args.id||'')?args.id:randomUUID()),accountId,to:text(args.to),cc:text(args.cc),bcc:text(args.bcc),subject:text(args.subject,1000),body:text(args.body,2_000_000),attachments:(args.attachments||[]).map(a=>{const asset=core.asset(typeof a==='string'?a:a.assetId);return{assetId:asset.id,name:asset.name,mimeType:asset.mimeType,size:asset.size};}),remoteDraftId:sameAccount?(original?.remoteDraftId||null):null,remoteMessageId:sameAccount?(original?.remoteMessageId||null):null,replyToId:original?.replyToId||args.replyToId||null,inReplyTo:original?.inReplyTo||'',references:original?.references||[],threadId:sameAccount?original?.threadId:null,createdAt:original?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),status:retainedStatus,error:retainedStatus!=='local'?original.error||'':''};
}
async function draftPayload(draft){
  let total=0;const attachments=[];
  for(const a of draft.attachments){total+=a.size;if(total>20*1024*1024)throw new Error(tr('附件合計超過 20 MB，請移除部分附件再寄送。'));attachments.push({name:a.name,contentType:a.mimeType,content:await fsp.readFile(core.asset(a.assetId).path)});}
  const original=draft.replyToId?store.read().messages.find(m=>m.id===draft.replyToId):null;
  const reply=original?{inReplyTo:original.messageId,references:[...(original.references||[]),...(original.messageId?[original.messageId]:[])],...(original.accountId===draft.accountId&&original.source==='Gmail'?{threadId:original.threadId}:{})}:{inReplyTo:draft.inReplyTo,references:draft.references,threadId:draft.threadId};
  return{to:draft.to,cc:draft.cc,bcc:draft.bcc,subject:draft.subject,body:draft.body,attachments,...reply};
}
async function saveDraft(args,{remote=true}={}){
  const draft=cleanDraft(args);store.update(d=>{const i=d.drafts.findIndex(x=>x.id===draft.id);if(i>=0)d.drafts[i]=draft;else d.drafts.unshift(draft);});broadcast();
  if(remote&&draft.accountId!=='local'){
    try{const result=await gmail.saveDraft(draft.accountId,{draftId:draft.remoteDraftId||undefined,expectedMessageId:draft.remoteMessageId||undefined,...await draftPayload(draft)});store.update(d=>{const x=d.drafts.find(x=>x.id===draft.id);if(x){x.remoteDraftId=result.draftId;x.remoteMessageId=result.remoteId;x.status='synced';x.error='';}});}
    catch(e){store.update(d=>{const x=d.drafts.find(x=>x.id===draft.id);if(x){x.status=e.code==='DRAFT_CONFLICT'?'conflict':'sync-error';x.error=e.message;}});log('草稿已保存在本機','Gmail 草稿同步未完成。','partial');return{draft:store.read().drafts.find(d=>d.id===draft.id),warning:'已保存本機草稿；Gmail 同步失敗：'+e.message};}
  }
  if(remote)log('保存郵件草稿');return{draft:store.read().drafts.find(d=>d.id===draft.id)};
}
async function sendDraft(args){
  const {draft}=await saveDraft(args,{remote:false});
  if(draft.accountId==='local')throw new Error(tr('草稿已保存在本機。請連接 Gmail 並選擇寄件帳號。'));
  let result,warning;
  try{result=await gmail.send(draft.accountId,{draftId:draft.remoteDraftId||undefined,expectedMessageId:draft.remoteMessageId||undefined,...await draftPayload(draft)});}
  catch(e){
    if(e.code==='SEND_CONFIRMED_LOCAL_ERROR')warning='Gmail 已確認寄出，但本機保存未完成。請同步寄件備份，不要重寄。';
    else{store.update(d=>{const x=d.drafts.find(x=>x.id===draft.id);if(x){x.status=e.code==='SEND_UNCERTAIN'?'send-uncertain':e.code==='DRAFT_CONFLICT'?'conflict':'send-error';x.error=e.message;}});log(e.code==='SEND_UNCERTAIN'?'郵件寄送結果待確認':'郵件未寄出',e.code==='SEND_UNCERTAIN'?'請先檢查 Gmail 寄件備份，再決定是否重試。':'草稿保留。','error');throw e;}
  }
  try{store.update(d=>{d.drafts=d.drafts.filter(x=>x.id!==draft.id);});log('郵件寄送成功');}catch{warning='Gmail 已確認寄出，本機草稿清理失敗。請勿重寄這封信。';}
  syncAccounts(draft.accountId).catch(()=>{});return{sent:true,result,warning};
}

const actions={
  'bootstrap':()=>publicState(),
  'model.source':args=>core.setTaskSource(args.kind,args.source),
  'settings.save':args=>{const oldAuto=store.read().settings.ocrAuto;const result=core.settings(args);nativeTheme.themeSource=result.settings.theme;updateShellLanguage();pool.setPolicy(result.settings.policy);scheduleSync();if(oldAuto!==result.settings.ocrAuto){if(result.settings.ocrAuto)startClipboard();else stopClipboard();}broadcast();return publicState();},
  'secrets.save':args=>{if(!knownSecretKeys.has(args.kind))throw new Error(tr('金鑰類型錯誤。'));if(args.clear)vault.delete(args.kind);else if(args.kind==='gmail-client')vault.set(args.kind,{clientSecret:String(args.value||'').slice(0,1000)});else vault.set(args.kind,{key:String(args.value||'').slice(0,5000)});if(args.kind==='cloud-api')core.cancelModelRuns('cloud',['llm','ocr','whisper']);log('更新加密憑證');return publicState();},
  'secrets.reset':()=>{vault.reset();core.cancelModelRuns('cloud',['llm','ocr','whisper']);gmail.cancelConnect?.();gmail.tokens?.clear();store.update(d=>{for(const a of d.accounts){a.connected=false;a.status='reauth-required';a.error='憑證已重設，請重新連接。';}});log('重設本機加密憑證','原憑證檔已另存保留。');return publicState();},
  'gmail.connect':connectGmail,
  'gmail.configure':args=>{requireAuthIdle();const config=normalizeGoogleOAuthConfig({clientId:args.clientId,clientSecret:args.clientSecret??''});if(!config)throw new Error(tr('請匯入 Google 設定檔，或填入 Desktop OAuth Client ID。'));if(!config.clientSecret&&config.clientId===store.read().settings.gmailClientId)config.clientSecret=vault.get('gmail-client')?.clientSecret||'';return saveGoogleOAuthOverride(config);},
  'gmail.importConfig':async()=>{requireAuthIdle();const files=await chooseFiles([{name:tr('Google 桌面應用程式設定'),extensions:['json']}],false);if(!files.length)return{cancelled:true};const config=readGoogleOAuthConfig(files[0]);if(!config)throw new Error(tr('設定檔沒有 Google Desktop OAuth Client ID。'));return{...saveGoogleOAuthOverride(config),imported:true};},
  'gmail.clearConfig':()=>saveGoogleOAuthOverride(null),
  'gmail.openConsole':()=>shell.openExternal('https://console.cloud.google.com/auth/overview'),
  'gmail.cancel':()=>{gmail.cancelConnect?.();return{cancelled:true};},
  'gmail.disconnect':async args=>{await gmail.disconnect(args.id,{revoke:!!args.revoke,removeLocal:!!args.removeLocal});broadcast();return publicState();},
  'gmail.sync':args=>syncAccounts(args.id),
  'gmail.labels':args=>gmail.listLabels(args.id),
  'gmail.labelCreate':args=>gmail.createLabel(args.id,args.name),
  'mail.import':async args=>core.importMails(args.paths||await chooseFiles([{name:tr('郵件檔'),extensions:['eml']}])) ,
  'mail.modify':modifyMail,
  'mail.content':args=>mailContent(args.id),
  'mail.image':args=>mailImage(args),
  'mail.openLink':args=>openMailLink(args),
  'mail.openSource':async args=>{const m=getMessage(args.id);if(m.source!=='Gmail'||!m.threadId)throw new Error(tr('這封信沒有外部來源連結。'));await shell.openExternal('https://mail.google.com/mail/u/'+encodeURIComponent(store.read().accounts.find(a=>a.id===m.accountId)?.email||'0')+'/#all/'+encodeURIComponent(m.threadId));return{opened:true};},
  'mail.attachment':async args=>{const m=getMessage(args.messageId),attachment=m.attachments[args.index];if(!attachment)throw new Error(tr('找不到附件。'));const buffer=attachment.assetId?await fsp.readFile(core.asset(attachment.assetId).path):await gmail.downloadAttachment(m.accountId,m.remoteId,attachment.attachmentId);return saveOutput(attachment.name,buffer,[{name:tr('附件'),extensions:['*']}]);},
  'draft.attach':async()=>{const selected=await chooseFiles([{name:tr('所有檔案'),extensions:['*']}]);const attachments=[];for(const source of selected){const a=await core.ingestAsset(source,{category:'attachment',limit:20*1024*1024});attachments.push({assetId:a.id,name:a.name,mimeType:a.mimeType,size:a.size});}broadcast();return attachments;},
  'draft.openRemote':args=>openRemoteDraft(args.id),
  'draft.reloadRemote':args=>reloadRemoteDraft(args.id),
  'draft.fromMail':composeFromMail,
  'draft.save':args=>saveDraft(args,{remote:!args.localOnly}),
  'draft.remove':async args=>{const draft=store.read().drafts.find(d=>d.id===args.id);if(!draft)throw new Error(tr('找不到草稿。'));if(draft.remoteDraftId)await gmail.deleteDraft(draft.accountId,draft.remoteDraftId,{expectedMessageId:draft.remoteMessageId});store.update(d=>{d.drafts=d.drafts.filter(x=>x.id!==args.id);});log('刪除郵件草稿');return publicState();},
  'draft.send':sendDraft,
  'media.choose':()=>chooseFiles([{name:tr('音訊與影片'),extensions:['mp3','wav','m4a','aac','flac','ogg','opus','mp4','m4v','mov','webm','mkv','avi','wma','wmv']}]),
  'media.import':async args=>{
    const transcription=args.transcription||'manual';
    if(!['manual','queue','schedule'].includes(transcription))throw new Error(tr('請選擇有效的轉錄方式。'));
    if(transcription==='schedule'&&(typeof args.scheduledAt!=='string'||!Number.isFinite(Date.parse(args.scheduledAt))||Date.parse(args.scheduledAt)<=Date.now()))throw new Error(tr('請選擇未來的轉錄開始時間。'));
    const source=modelSource(args.source);
    const result=await core.importMedia(args.paths||await actions['media.choose'](),args.language,source);
    if(result.imported.length&&transcription!=='manual'){
      try{const scheduledAt=transcription==='schedule'&&Date.parse(args.scheduledAt)>Date.now()?args.scheduledAt:null;core.queueRecordings(result.imported,{scheduledAt});result.queued=result.imported.length;}
      catch(error){result.queueError=error.message||tr('轉錄排程未完成，請在會議卡片重試。');}
    }
    return result;
  },
  'media.update':args=>core.updateRecording(args.id,args.patch),
  'media.remove':async args=>{await videoExports.cancel(args.id);return core.removeRecording(args.id);},
  'media.start':args=>core.queueRecordings([args.id]),
  'media.schedule':args=>core.queueRecordings(args.ids,{scheduledAt:args.scheduledAt??null,source:args.source}),
  'video.export':args=>videoExports.start(args.id),
  'video.cancel':args=>videoExports.cancel(args.id),
  'video.reveal':async args=>{const file=videoExports.getOutput(args.id);if(typeof file!=='string'||!(await fsp.stat(file).catch(()=>null))?.isFile())throw new Error(tr('匯出的影片已移動或不存在。'));shell.showItemInFolder(file);return{opened:true};},
  'media.pause':args=>core.pauseRecording(args.id),
  'transcript.save':args=>core.saveTranscript(args.id,args),
  'transcript.import':async args=>{const files=await chooseFiles([{name:tr('逐字稿'),extensions:['srt','txt']}],false);if(!files.length)return{cancelled:true};const st=await fsp.stat(files[0]);if(st.size>8*1024*1024)throw new Error(tr('逐字稿檔案太大。'));return core.saveTranscript(args.id,{format:path.extname(files[0]).toLowerCase()==='.srt'?'srt':'txt',text:await fsp.readFile(files[0],'utf8')});},
  'transcript.export':async args=>{const r=store.read().recordings.find(r=>r.id===args.id);if(!r)throw new Error(tr('找不到會議紀錄。'));if(args.format==='srt'&&!r.segments?.length)throw new Error(tr('此逐字稿沒有時間點，請先匯入或編輯 SRT。'));const text=args.format==='srt'?exportSrt(r.segments):exportTxt(r);if(!text.trim())throw new Error(tr('目前沒有可匯出的逐字稿。'));return saveOutput(path.parse(r.name).name+'.'+(args.format==='srt'?'srt':'txt'),'\uFEFF'+text,[{name:args.format==='srt'?'SRT 字幕':'文字',extensions:[args.format==='srt'?'srt':'txt']}]);},
  'ocr.capture':()=>{ocrUserInputRevision++;return receiveClipboard(true);},
  'ocr.import':async args=>{const files=args.paths||await chooseFiles([{name:tr('圖片'),extensions:['png','jpg','jpeg','webp','bmp']}],false);if(!files.length)return{cancelled:true};if(files.length!==1||fileType(files[0])!=='image')throw new Error(tr('請選擇一張圖片。'));ocrUserInputRevision++;const revision=++ocrInputRevision;const st=await fsp.stat(files[0]);if(st.size>40*1024*1024)throw new Error(tr('圖片必須小於 40 MB。'));const img=nativeImage.createFromPath(files[0]);if(img.isEmpty())throw new Error(tr('無法讀取這張圖片。'));const size=img.getSize();if(size.width*size.height>60_000_000)throw new Error(tr('圖片像素過大。'));const asset=await core.ingestBuffer(img.toPNG(),{name:path.parse(files[0]).name+'.png'});if(revision!==ocrInputRevision)return{skipped:true};await core.setOcrImage(asset);if(store.read().settings.ocrAuto)await core.runOcr('local',{preserveSelection:true});return publicState();},
  'ocr.start':(args={})=>core.runOcr(args.source),
  'ocr.cancel':()=>core.cancelOcr(),
  'ocr.save':args=>core.saveOcrText(args.text),
  'ocr.clear':()=>{ocrUserInputRevision++;ocrInputRevision++;core.active.get('ocr')?.abort();return core.change(d=>{d.ocr={imageId:null,imageName:'',source:'local',text:'',status:'empty',revision:d.ocr.revision+1,error:''};},'清除 OCR 工作');},
  'polish.save':args=>core.savePolish(args),
  'polish.start':(args={})=>withMailScheduleSlot(()=>core.runPolish(args.source)),
  'polish.cancel':()=>core.cancelPolish(),
  'chat.save':args=>args.id!==undefined&&args.id!==store.read().chatHistory.activeId?{skipped:true}:core.saveChatDraft(args.text),
  'chat.send':args=>args.id!==undefined&&args.id!==store.read().chatHistory.activeId?{skipped:true}:withMailScheduleSlot(()=>core.sendChat(args.text,args.source)),
  'chat.cancel':()=>core.cancelChat(),
  'chat.new':()=>core.newChat(),
  'chat.select':args=>core.selectChat(args.id),
  'chat.rename':args=>core.renameChat(args.id,args.title),
  'chat.delete':args=>core.deleteChat(args.id),
  'translation.save':args=>core.saveTranslation(args),
  'translation.start':(args={})=>withMailScheduleSlot(()=>core.runTranslation(args.source)),
  'translation.cancel':()=>core.cancelTranslation(),
  'llm.prompts.get':(args={})=>core.models.get('llm',modelSource(args.source)).prompts(),
  'llm.prompts.save':args=>{const prompt=validatePrompt(args.task,args);return core.settings({llmPrompts:{...store.read().settings.llmPrompts,[args.task]:prompt}});},
  'llm.prompts.reset':args=>{if(!Object.hasOwn(TASK_VARIABLES,args.task))throw new Error(tr('Prompt 工作類型錯誤。'));const next={...store.read().settings.llmPrompts};delete next[args.task];return core.settings({llmPrompts:next});},
  'mail.analyze':(args={})=>withMailScheduleSlot(()=>core.analyzeMail(args.source,{categorize:true,onlyChanged:args.onlyChanged!==false,ids:args.ids})),
  'mail.cancelAnalysis':()=>core.cancelMailAnalysis(),
  'models.health':args=>{const source=modelSource(args.source),adapter=core.models.get(args.kind||'llm',source);if(!adapter)throw new Error(tr('模型類型錯誤。'));return adapter.health(source==='local'?{endpoint:args.endpoint}:{});},
  'clipboard.write':async args=>{if(typeof args.text!=='string'||args.text.length>2_000_000)throw new Error(tr('複製文字格式錯誤。'));await clipboard.writeText(args.text);return{copied:true};},
  'logs.export':()=>saveOutput('UFriend-logs-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(store.read().logs,null,2),[{name:tr('紀錄 JSON'),extensions:['json']}]),
  'data.cleanupInfo':()=>cleanupInfo(),
  'data.clear':args=>clearData(args),
  'diagnostics.open':async()=>{await diagnostics.flush();const error=await shell.openPath(diagnostics.directory);if(error)throw new Error(tr('無法開啟診斷紀錄資料夾，請從資料位置開啟 diagnostics。'));return{opened:true};},
  'diagnostics.export':async()=>saveOutput('UFriend-diagnostics-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(await diagnostics.export(),null,2),[{name:tr('診斷 JSON'),extensions:['json']}]),
  'diagnostics.report':args=>{diagnostics.write({event:'renderer.error',level:'error',source:'renderer',errorName:args.errorName,code:args.code,line:args.line,column:args.column});return{recorded:true};},
  'data.open':async()=>{await shell.openPath(dataDir);return{opened:true};},
  'pool.add':()=>{const d=pool.addDevice();broadcast();return d;},
  'pool.remove':args=>{pool.removeDevice(args.id);broadcast();return pool.snapshot();},
  'pool.test':args=>{if(!['llm','ocr','whisper'].includes(args.model))throw new Error(tr('模型類型錯誤。'));const id=pool.submit({model:args.model,label:'排程測試 · '+args.model.toUpperCase(),durationMs:5000});broadcast();return id;},
  'pool.cancel':args=>{pool.cancelJob(args.id);broadcast();return pool.snapshot();}
};

async function createWindow(){win=new BrowserWindow({width:1080,height:820,minWidth:640,minHeight:480,title:tr('UFriend | 你的本地助手'),icon:path.join(__dirname,'assets','ufriend.ico'),show:!smoke,backgroundColor:'#202321',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!==uiUrl)event.preventDefault();});win.webContents.on('will-frame-navigate',event=>{if(event.url!==uiUrl&&event.url!=='about:srcdoc')event.preventDefault();});win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));win.webContents.on('render-process-gone',()=>log('介面程序中斷','請重新開啟 UFriend。','error'));win.on('close',event=>{if(!quitting&&!smoke){event.preventDefault();if(store.read().settings.keepBackground&&tray){flushWindow().then(()=>win.hide()).catch(e=>dialog.showErrorBox(tr('資料尚未保存'),e.message));}else requestQuit();}});await win.loadFile(path.join(__dirname,'index.html'));}

app.whenReady().then(async()=>{
  fs.mkdirSync(dataDir,{recursive:true});diagnostics=new Diagnostics({directory:path.join(dataDir,'diagnostics'),version:app.getVersion()});await diagnostics.write({event:'app.started'});store=new Store({dataDir});vault=new Vault({dataDir,safeStorage});
  process.on('uncaughtExceptionMonitor',error=>diagnostics.writeFatal({event:'app.crashed',code:error.code||'UNCAUGHT_EXCEPTION',errorName:error.name}));
  core=new AppService({store,dataDir,models:new ModelAdapters(),onChange:broadcast});
  videoExports=new VideoExportJobs({core,onChange:broadcast,chooseOutput:({name})=>dialog.showSaveDialog(nativeParent(),{title:tr('匯出含字幕影片'),defaultPath:safeName(name),filters:[{name:tr('MP4 影片'),extensions:['mp4']}]}),resolveFfmpeg:()=>resolveVideoFfmpegPath({isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,projectRoot:path.resolve(__dirname,'..')})});
  core.onChatStream=payload=>{if(win&&!win.isDestroyed())win.webContents.send('ufriend:chat-stream',payload);};
  core.onChatError=details=>diagnostics.write({event:'chat.failed',level:'error',task:'chat',...details});
  llmApi=new LocalLlmApiAdapter({getSettings:()=>store.read().settings,onDiagnostic:entry=>diagnostics.write(entry)});core.models.register('llm',llmApi);
  ocrApi=new LocalMediaApiAdapter({kind:'ocr',getSettings:()=>store.read().settings});core.models.register('ocr',ocrApi);
  whisperApi=new LocalMediaApiAdapter({kind:'whisper',getSettings:()=>store.read().settings});core.models.register('whisper',whisperApi);
  for(const kind of ['llm','ocr','whisper'])core.models.register(kind,new CloudApiAdapter({kind,getSettings:()=>store.read().settings,getApiKey:()=>vault.get('cloud-api')?.key||'',onDiagnostic:entry=>diagnostics.write(entry),resolveFfmpeg:()=>resolveVideoFfmpegPath({isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,projectRoot:path.resolve(__dirname,'..')})}),{source:'cloud'});
  gmail=new GmailService({store,vault,openExternal:url=>shell.openExternal(url),onChange:broadcast,onAuthStatus:setGmailAuthPhase});
  pool=new ModelPoolScheduler({onEvent:event=>{if(['job-completed','device-added','device-removed','policy-changed'].includes(event.type))log('裝置池模擬',event.type);broadcast();}});pool.setPolicy(store.read().settings.policy);
  simulatedPolicyTimer=setInterval(()=>pool.tick(),100);simulatedPolicyTimer.unref();
  protocol.handle('ufriend-asset',request=>assetResponse(request,id=>core.asset(id)));
  ipcMain.handle('ufriend:call',async(event,name,args)=>{if(!win||win.isDestroyed()||event.senderFrame?.url!==uiUrl||event.sender!==win.webContents)return{ok:false,error:{code:'FORBIDDEN',message:'操作來源不受信任。'}};try{if(!Object.hasOwn(actions,name))throw new Error(tr('不支援的操作。'));if(args===null||typeof args!=='object')throw new Error(tr('操作格式錯誤。'));const value=await actions[name](args);return{ok:true,value};}catch(e){diagnostics.write({event:'ipc.failed',level:'error',action:Object.hasOwn(actions,name)?name:'unknown',code:e.code||'ACTION_FAILED',requestId:e.requestId,errorName:e.name});return{ok:false,error:trimError(e)};}});
  nativeTheme.themeSource=store.read().settings.theme;
  if(!smoke){const icon=nativeImage.createFromPath(path.join(__dirname,'assets','ufriend.png'));if(!icon.isEmpty()){tray=new Tray(icon);tray.setToolTip(tr('UFriend | 你的本地助手'));tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));tray.on('double-click',()=>{win.show();win.focus();});}}
  Menu.setApplicationMenu(null);await createWindow();log('開啟 UFriend');scheduleSync();core.startRecordingScheduler();if(!smoke){mailScheduler=createMailScheduler();mailScheduler.start();}if(!smoke&&store.read().settings.ocrAuto)startClipboard();
  win.webContents.on('render-process-gone',(_event,details)=>diagnostics.write({event:'renderer.gone',level:'error',reason:details.reason,exitCode:details.exitCode}));
  if(smoke){const run=require(clipboardSmoke?'../scripts/clipboard-smoke.cjs':modelSmoke?'../scripts/model-smoke.cjs':llmFeaturesSmoke?'../scripts/llm-features-smoke.cjs':'../scripts/smoke.cjs');try{await run({app,win,core,actions,dataDir,diagnostics,videoExports,...(clipboardSmoke?{getClipboardProcess:()=>clipboardProcess}:{})});await videoExports.shutdown();await diagnostics.flush();quitting=true;app.exit(0);}catch(e){await videoExports.shutdown();await diagnostics.flush();console.error(e);app.exit(1);}}
}).catch(async error=>{await diagnostics?.write({event:'app.startup.failed',level:'error',code:error.code||'STARTUP_FAILED',errorName:error.name});await diagnostics?.flush();console.error(error.message);if(!smoke)dialog.showErrorBox(tr('UFriend 無法開啟'),error.message);app.exit(1);});
app.on('before-quit',event=>{if(!quitting&&!smoke){event.preventDefault();requestQuit();return;}quitting=true;core?.stopRecordingScheduler?.();videoExports?.shutdown().catch(()=>{});stopClipboard();gmail?.cancelConnect();for(const controller of core?.active?.values()||[])controller.abort();clearInterval(syncTimer);clearInterval(simulatedPolicyTimer);});
app.on('window-all-closed',()=>{if(!tray||quitting||smoke)app.quit();});
app.on('activate',()=>{if(win&&!win.isDestroyed())win.show();});
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}});
if(!smoke&&!app.requestSingleInstanceLock()){app.quit();}

'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {fileType,safeName}=require('./formats.cjs');

function mediaPlan(state,includeVideo=false){
  const target=recording=>includeVideo||recording.type==='audio'||(!recording.type&&fileType(recording.name)==='audio');
  const recordings=state.recordings.filter(target),recordIds=new Set(recordings.map(recording=>recording.id));
  const assetIds=new Set(recordings.map(recording=>recording.assetId));
  const shared=new Set(state.recordings.filter(recording=>!recordIds.has(recording.id)).map(recording=>recording.assetId));
  for(const item of [...(state.messages||[]),...(state.drafts||[])])for(const attachment of item.attachments||[])if(attachment.assetId)shared.add(attachment.assetId);
  if(state.ocr?.imageId)shared.add(state.ocr.imageId);
  // Individual record removal in older versions left these managed copies behind.
  const candidates=(state.assets||[]).filter(asset=>assetIds.has(asset.id)||(asset.category==='recording'&&(includeVideo||(asset.mediaType||fileType(asset.name)||fileType(asset.file))==='audio')));
  return{recordings,recordIds,assets:candidates.filter(asset=>!shared.has(asset.id)),sharedFiles:candidates.filter(asset=>shared.has(asset.id)).length};
}

function meetingCleanupInfo(core,{includeVideo=false,state=core.store.read()}={}){
  const plan=mediaPlan(state,includeVideo);
  return{includeVideo,records:plan.recordings.length,files:plan.assets.length,bytes:plan.assets.reduce((sum,asset)=>sum+(Number.isFinite(asset.size)?asset.size:0),0),
    sharedFiles:plan.sharedFiles,running:plan.recordings.filter(recording=>core.active.has('recording:'+recording.id)).length,importing:(core.mediaImports||0)>0};
}

async function checkedFile(core,asset){
  const root=path.resolve(core.dataDir,'files'),file=path.resolve(root,asset.file||'');
  if(typeof asset.file!=='string'||path.dirname(file)!==root||path.basename(file)!==asset.file)throw new Error('會議檔案路徑不安全，未刪除檔案。');
  // Refuse a redirected files directory or entry; never follow a junction to user originals.
  try{
    const rootStat=await fs.lstat(root),realData=await fs.realpath(core.dataDir),realRoot=await fs.realpath(root);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||realRoot.toLowerCase()!==path.join(realData,'files').toLowerCase())throw new Error('會議檔案目錄不安全，未刪除檔案。');
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('會議檔案不是一般檔案，未刪除檔案。');
    if((await fs.realpath(file)).toLowerCase()!==path.join(realRoot,asset.file).toLowerCase())throw new Error('會議檔案路徑不安全，未刪除檔案。');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return file;
}

async function clearMeetingMedia(core,{includeVideo=false}={}){
  if(core.mediaClearing||(core.mediaImports||0)>0)throw Object.assign(new Error('正在匯入或刪除影音，請等待完成後再刪除。'),{code:'MEDIA_BUSY'});
  core.mediaClearing=true;core.onChange();
  try{
    const plan=mediaPlan(core.store.read(),includeVideo),prepared=[];
    // Validate every intended absolute target before deleting any record or file.
    for(const asset of plan.assets)prepared.push({asset,file:await checkedFile(core,asset)});
    if(!plan.recordings.length&&!prepared.length)return{deletedRecords:0,deletedFiles:0,remainingFiles:0,failed:[],sharedFiles:plan.sharedFiles};
    const ids=new Set(plan.assets.map(asset=>asset.id));
    core.store.purge(state=>{
      state.recordings=state.recordings.filter(recording=>!plan.recordIds.has(recording.id));
      // Keep a retryable index until unlink succeeds; no transcript remains in either snapshot.
      for(const asset of state.assets)if(ids.has(asset.id)){
        asset.category='recording';
        asset.mediaType=plan.recordings.find(recording=>recording.assetId===asset.id)?.type||asset.mediaType||fileType(asset.name)||fileType(asset.file);
      }
    });
    for(const id of plan.recordIds){const key='recording:'+id;core.active.get(key)?.abort();core.active.delete(key);}
    const deleted=new Set(),failed=[];
    for(const {asset} of prepared){
      try{
        const file=await checkedFile(core,asset);
        await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
        deleted.add(asset.id);
      }catch{failed.push({name:safeName(asset.name||asset.file),message:'檔案仍被使用或無法刪除，請關閉使用此檔案的程式後重試。'});}
    }
    if(deleted.size)core.store.purge(state=>{state.assets=state.assets.filter(asset=>!deleted.has(asset.id));});
    return{deletedRecords:plan.recordings.length,deletedFiles:deleted.size,remainingFiles:failed.length,failed,sharedFiles:plan.sharedFiles};
  }finally{core.mediaClearing=false;core.onChange();}
}

module.exports={meetingCleanupInfo,clearMeetingMedia};

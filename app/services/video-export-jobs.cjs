'use strict';

const path=require('node:path');
const {fileType,safeName,validateSegments}=require('./formats.cjs');
const burnVideoSubtitles=options=>require('./video-export.cjs').burnVideoSubtitles(options);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const ERROR_MESSAGES={
  VIDEO_EXPORT_BUSY:'已有影片正在匯出，請等待完成或先取消。',
  VIDEO_EXPORT_CLOSING:'程式正在結束，無法開始匯出。',
  VIDEO_EXPORT_NOT_FOUND:'找不到會議紀錄或來源影片。',
  VIDEO_EXPORT_INVALID_MEDIA:'只有影片可以匯出字幕影片。',
  VIDEO_EXPORT_INVALID_SUBTITLES:'請先完成轉錄或匯入含時間軸的 SRT 字幕。',
  VIDEO_EXPORT_FAILED:'字幕影片匯出失敗，請確認來源影片與儲存位置後重試。',
  VIDEO_INVALID_PATH:'請選擇有效的本機影片與輸出位置。',
  VIDEO_LOCAL_ONLY:'影片字幕匯出只接受本機檔案與資料夾。',
  VIDEO_OUTPUT_EXISTS:'輸出檔案已存在，請選擇新的檔名。',
  VIDEO_INVALID_SUBTITLES:'逐字稿必須包含有效文字，以及依序排列且結束晚於開始的時間。',
  VIDEO_INVALID_SOURCE:'無法讀取影片，請確認來源檔案包含可播放的影像。',
  VIDEO_PROGRESS_ERROR:'影片匯出進度回報失敗，請重新匯出。',
  VIDEO_INVALID_OUTPUT:'字幕影片請儲存為 MP4 檔案。',
  VIDEO_INVALID_FFMPEG:'影片匯出工具不完整，請重新取得完整的 UFriend 程式資料夾。',
  VIDEO_INVALID_PROGRESS:'影片匯出進度設定無效，請重新啟動 UFriend 後重試。',
  VIDEO_EMPTY_OUTPUT:'影片匯出工具沒有產生有效的影片，請確認來源可播放後重試。',
  VIDEO_PUBLISH_FAILED:'無法安全儲存影片，請改存到本機磁碟的其他資料夾。',
  VIDEO_FILE_ACCESS_FAILED:'無法存取影片或輸出位置，請確認檔案、資料夾與存取權限。',
  FFMPEG_NOT_FOUND:'影片匯出工具不完整，請重新取得完整的 UFriend 程式資料夾。',
  FFMPEG_START_FAILED:'無法啟動影片匯出工具，請檢查程式檔案與執行權限。',
};
const initialState=()=>({status:'idle',recordingId:null,name:'',fileName:'',seconds:0,progress:null,stage:'',error:'',code:''});

class VideoExportJobs{
  constructor({core,chooseOutput,resolveFfmpeg,onChange=()=>{},exporter=burnVideoSubtitles}){
    this.core=core;this.chooseOutput=chooseOutput;this.resolveFfmpeg=resolveFfmpeg;this.onChange=onChange;this.exporter=exporter;
    this.state=initialState();this.job=null;this.output=null;this.closing=false;
  }
  snapshot(){return{...this.state};}
  getOutput(id){return this.state.status==='done'&&this.state.recordingId===id?this.output:null;}
  setClosing(value){this.closing=!!value;}
  _set(patch){Object.assign(this.state,patch);try{this.onChange(this.snapshot());}catch{/* A closed renderer must not interrupt cleanup. */}}
  _error(error){const code=Object.hasOwn(ERROR_MESSAGES,error?.code)?error.code:'VIDEO_EXPORT_FAILED';return{code,error:ERROR_MESSAGES[code]};}
  _record(id){return this.core.store.read().recordings.find(recording=>recording.id===id);}
  _input(id){
    const recording=this._record(id);
    if(!recording)throw fail('VIDEO_EXPORT_NOT_FOUND',ERROR_MESSAGES.VIDEO_EXPORT_NOT_FOUND);
    if((recording.type||fileType(recording.name))!=='video')throw fail('VIDEO_EXPORT_INVALID_MEDIA',ERROR_MESSAGES.VIDEO_EXPORT_INVALID_MEDIA);
    let segments;
    try{
      if(recording.textOnly!=null||!recording.segments?.length||recording.segments.some(segment=>!segment||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<=segment.start))throw new Error();
      segments=validateSegments(recording.segments);
    }catch{throw fail('VIDEO_EXPORT_INVALID_SUBTITLES',ERROR_MESSAGES.VIDEO_EXPORT_INVALID_SUBTITLES);}
    let sourcePath;try{sourcePath=this.core.asset(recording.assetId).path;if(typeof sourcePath!=='string'||!sourcePath)throw new Error();}catch{throw fail('VIDEO_EXPORT_NOT_FOUND',ERROR_MESSAGES.VIDEO_EXPORT_NOT_FOUND);}
    return{recordingId:id,assetId:recording.assetId,name:safeName(recording.name),sourcePath,segments,durationSeconds:Number.isFinite(recording.duration)&&recording.duration>0?recording.duration:undefined};
  }
  _stillPresent(job){
    try{return this._record(job.recordingId)?.assetId===job.assetId&&this.core.asset(job.assetId).path===job.sourcePath&&!this.core.mediaClearing;}catch{return false;}
  }
  async start(id){
    if(this.closing)throw fail('VIDEO_EXPORT_CLOSING',ERROR_MESSAGES.VIDEO_EXPORT_CLOSING);
    if(this.job||this.core.mediaClearing)throw fail('VIDEO_EXPORT_BUSY',ERROR_MESSAGES.VIDEO_EXPORT_BUSY);
    const input=this._input(id),job={...input,controller:new AbortController(),work:null};
    this.job=job;this.output=null;this.state=initialState();
    const name=path.parse(input.name).name.slice(0,150)+'_字幕.mp4';
    this._set({status:'choosing',recordingId:id,name:input.name,fileName:name});
    try{
      const selected=await this.chooseOutput({name});
      if(this.job!==job||job.controller.signal.aborted)return{cancelled:true};
      if(selected?.canceled||!selected?.filePath){this.job=null;this._set({status:'cancelled'});return{cancelled:true};}
      if(this.closing||!this._stillPresent(job)){this.job=null;this._set({status:'cancelled'});return{cancelled:true};}
      job.outputPath=path.extname(selected.filePath)?selected.filePath:selected.filePath+'.mp4';
      job.work=Promise.resolve().then(()=>this._run(job));
      this._set({status:'running',fileName:safeName(job.outputPath),stage:'preparing'});
      // Keep the lock until exporter settlement, including abort and partial-file cleanup.
      return{started:true};
    }catch(error){
      if(this.job!==job||job.controller.signal.aborted)return{cancelled:true};
      this.job=null;const failure=this._error(error);this._set({status:'error',...failure});throw fail(failure.code,failure.error);
    }
  }
  _progress(job,update){
    if(this.job!==job||job.controller.signal.aborted||this.state.status!=='running'||!update)return;
    const seconds=Number.isFinite(update.seconds)?Math.max(this.state.seconds,Math.floor(update.seconds),0):this.state.seconds;
    const progress=Number.isFinite(update.progress)?Math.max(this.state.progress??0,Math.min(.99,Math.max(0,Math.floor(update.progress*100)/100))):this.state.progress;
    const normalizedStage={started:'preparing',processing:'encoding',complete:'finalizing'}[update.stage]||update.stage;
    const stage=['preparing','probing','encoding','finalizing'].includes(normalizedStage)?normalizedStage:this.state.stage;
    if(seconds!==this.state.seconds||progress!==this.state.progress||stage!==this.state.stage)this._set({seconds,progress,stage});
  }
  async _run(job){
    try{
      if(job.controller.signal.aborted||this.job!==job)return;
      const ffmpegPath=await this.resolveFfmpeg();
      if(job.controller.signal.aborted||this.job!==job)return;
      if(!this._stillPresent(job)){job.controller.abort();return;}
      const result=await this.exporter({sourcePath:job.sourcePath,outputPath:job.outputPath,segments:job.segments,ffmpegPath,signal:job.controller.signal,durationSeconds:job.durationSeconds,onProgress:update=>this._progress(job,update)});
      if(this.job!==job)return;
      // A fulfilled exporter has already published its file. Cancellation after that
      // commit point must not report that the completed output was discarded.
      this.output=typeof result?.outputPath==='string'&&result.outputPath?result.outputPath:job.outputPath;
      this._set({status:'done',stage:'',progress:1,seconds:Number.isFinite(result?.seconds)?Math.max(0,result.seconds):this.state.seconds});
    }catch(error){
      if(this.job!==job)return;
      if(!job.controller.signal.aborted&&error?.name!=='AbortError'&&!['ABORT_ERR','VIDEO_EXPORT_CANCELLED'].includes(error?.code))this._set({status:'error',stage:'',...this._error(error)});
    }finally{
      if(this.job===job){
        if(['running','cancelling'].includes(this.state.status))this._set({status:'cancelled',stage:'',error:'',code:''});
        this.job=null;
      }
    }
  }
  async cancel(id){
    const job=this.job;
    if(!job||(id!==undefined&&id!==job.recordingId))return this.snapshot();
    if(this.state.status==='done'||this.state.status==='error')return this.snapshot();
    job.controller.abort();
    if(this.state.status==='choosing'){
      this.job=null;this._set({status:'cancelled',stage:''});
    }else{
      this._set({status:'cancelling'});await job.work;
    }
    return this.snapshot();
  }
  async shutdown(){this.setClosing(true);await this.cancel();}
}

module.exports={VideoExportJobs};

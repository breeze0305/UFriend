'use strict';
const {modelSource,selectedSource}=require('./model-source.cjs');

const PENDING_STATES=new Set(['queued','scheduled']);
const RECHECK_MS=30000;
const BUSY_RETRY_MS=5000;
const clearRecordingSchedule=recording=>{delete recording.queuedAt;delete recording.queueOrder;delete recording.scheduledAt;delete recording.queueRetryAt;};
const validDate=value=>typeof value==='string'&&value.trim()!==''&&Number.isFinite(Date.parse(value));
const hasTranscript=recording=>!!(recording.segments?.length||recording.textOnly);

function initializeRecordingQueue(state){
  for(const recording of state.recordings){
    // Blank editor saves are an empty transcript, including records from older versions.
    if(typeof recording.textOnly==='string'&&!recording.textOnly.trim())recording.textOnly=null;
    const pending=PENDING_STATES.has(recording.state);
    const valid=pending&&validDate(recording.queuedAt)&&Number.isSafeInteger(recording.queueOrder)&&recording.queueOrder>0&&
      (recording.scheduledAt===null||validDate(recording.scheduledAt))&&!hasTranscript(recording);
    if(valid){if(!validDate(recording.queueRetryAt))delete recording.queueRetryAt;continue;}
    if(['running','queued','scheduled','loading'].includes(recording.state)){
      recording.state=hasTranscript(recording)?'done':'paused';recording.error='上次處理已中斷，可重新開始。';
    }
    clearRecordingSchedule(recording);
  }
}

const recordingQueueMethods={
  queueRecordings(ids,{scheduledAt=null,source}={}){
    if(source!==undefined)modelSource(source);
    if(this.mediaClearing)throw Object.assign(new Error('正在刪除會議檔案，請稍後再轉錄。'),{code:'MEDIA_BUSY'});
    if(!Array.isArray(ids)||!ids.length||ids.length>30||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('每次請選擇 1 至 30 個不同的會議紀錄。');
    const now=this.recordingSchedulerClock?.now()??Date.now();
    if(scheduledAt!==null&&(!validDate(scheduledAt)||Date.parse(scheduledAt)<=now))throw new Error('請選擇未來的轉錄時間。');
    const normalizedAt=scheduledAt===null?null:new Date(scheduledAt).toISOString(),state=this.store.read(),sources=new Map();
    for(const id of ids){
      const recording=state.recordings.find(item=>item.id===id);
      if(!recording)throw new Error('找不到會議紀錄。');
      if(hasTranscript(recording))throw new Error('已有逐字稿，請先清空內容再重新轉錄。');
      if(this.active.has('recording:'+id)||recording.state==='running')throw new Error('這個會議正在轉錄，請先暫停後再排程。');
      const previous=selectedSource(undefined,recording.source),next=selectedSource(source,previous);
      if(next!==previous&&PENDING_STATES.has(recording.state))throw new Error('請先暫停這個會議的排程，再變更模型來源。');
      sources.set(id,next);
    }
    let order=state.recordings.reduce((largest,recording)=>Math.max(largest,Number.isSafeInteger(recording.queueOrder)?recording.queueOrder:0),this.recordingQueueSequence||0);
    if(order>Number.MAX_SAFE_INTEGER-ids.length)throw new Error('轉錄佇列序號已達上限，請先完成現有佇列。');
    const snapshot=this.change(d=>{
      for(const id of ids){const recording=d.recordings.find(item=>item.id===id);clearRecordingSchedule(recording);Object.assign(recording,{source:sources.get(id),state:normalizedAt?'scheduled':'queued',scheduledAt:normalizedAt,queuedAt:new Date(now).toISOString(),queueOrder:++order,error:''});}
    },normalizedAt?'排程語音轉錄':'加入轉錄佇列',`${ids.length} 個會議`);
    this.recordingQueueSequence=order;
    this.wakeRecordingScheduler();return snapshot;
  },
  startRecordingScheduler({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    this.stopRecordingScheduler();this.recordingSchedulerClock={now,setTimer,clearTimer};
    this.recordingQueueSequence=this.store.read().recordings.reduce((largest,recording)=>Math.max(largest,Number.isSafeInteger(recording.queueOrder)?recording.queueOrder:0),this.recordingQueueSequence||0);
    this.recordingSchedulerEnabled=true;this.wakeRecordingScheduler();
  },
  stopRecordingScheduler(){
    this.recordingSchedulerEnabled=false;
    if(this.recordingSchedulerTimer!==undefined){this.recordingSchedulerClock?.clearTimer(this.recordingSchedulerTimer);this.recordingSchedulerTimer=undefined;}
  },
  wakeRecordingScheduler(){this._setRecordingSchedulerTimer(0);},
  waitForRecordingService(id,intent,{logWait=true}={}){
    const now=this.recordingSchedulerClock?.now()??Date.now(),retryAt=now+BUSY_RETRY_MS;
    this.recordingSchedulerRetryAt=Math.max(this.recordingSchedulerRetryAt||0,retryAt);
    return this.change(d=>{const recording=d.recordings.find(item=>item.id===id);if(recording)Object.assign(recording,intent,{state:'queued',queueRetryAt:new Date(retryAt).toISOString(),error:'語音服務忙碌中，將自動重試。'});},logWait?'等待語音服務':null,'','blocked');
  },
  _setRecordingSchedulerTimer(delay){
    if(!this.recordingSchedulerEnabled)return;
    if(this.recordingSchedulerTimer!==undefined)this.recordingSchedulerClock.clearTimer(this.recordingSchedulerTimer);
    this.recordingSchedulerTimer=this.recordingSchedulerClock.setTimer(()=>{
      this.recordingSchedulerTimer=undefined;
      // Persistence failures leave the durable intent intact for the next check.
      try{this._dispatchRecordingQueue();}catch{this._setRecordingSchedulerTimer(RECHECK_MS);}
    },delay);
    this.recordingSchedulerTimer?.unref?.();
  },
  _dispatchRecordingQueue(){
    if(!this.recordingSchedulerEnabled)return;
    const pending=this.store.read().recordings.filter(recording=>PENDING_STATES.has(recording.state)).sort((a,b)=>a.queueOrder-b.queueOrder);
    if(!pending.length)return;
    const now=this.recordingSchedulerClock.now(),dueScheduled=new Set(pending.filter(recording=>recording.state==='scheduled'&&Date.parse(recording.scheduledAt)<=now).map(recording=>recording.id));
    if(dueScheduled.size){
      this.change(d=>{for(const recording of d.recordings)if(dueScheduled.has(recording.id)&&recording.state==='scheduled')recording.state='queued';},null);
      for(const recording of pending)if(dueScheduled.has(recording.id))recording.state='queued';
    }
    if(this.mediaClearing||this.recordingSchedulerBusy||this.recordingModelWork?.size||[...this.active.keys()].some(key=>key.startsWith('recording:'))){this._setRecordingSchedulerTimer(RECHECK_MS);return;}
    const retryAt=Math.max(this.recordingSchedulerRetryAt||0,...pending.map(recording=>validDate(recording.queueRetryAt)?Date.parse(recording.queueRetryAt):0));
    if(retryAt>now){this._setRecordingSchedulerTimer(Math.min(RECHECK_MS,retryAt-now));return;}
    const due=pending.find(recording=>!recording.scheduledAt||Date.parse(recording.scheduledAt)<=now);
    if(!due){this._setRecordingSchedulerTimer(Math.min(RECHECK_MS,Math.max(1,Math.min(...pending.map(recording=>Date.parse(recording.scheduledAt)))-now)));return;}
    this.recordingSchedulerBusy=true;let retryDelay=0;
    Promise.resolve().then(()=>{
      // A cancellation, removal, or shutdown may happen before this microtask.
      const current=this.store.read().recordings.find(recording=>recording.id===due.id);
      if(!this.recordingSchedulerEnabled||!current||!PENDING_STATES.has(current.state)||current.queueOrder!==due.queueOrder)return;
      if(this.mediaClearing||this.recordingModelWork?.size||[...this.active.keys()].some(key=>key.startsWith('recording:')))return;
      if(current.scheduledAt&&Date.parse(current.scheduledAt)>this.recordingSchedulerClock.now())return;
      return this.runRecording(due.id,{fromQueue:true});
    }).catch(error=>{
      const current=this.store.read().recordings.find(recording=>recording.id===due.id);
      if(current&&(PENDING_STATES.has(current.state)&&current.queueOrder===due.queueOrder||current.state==='running'&&!this.active.has('recording:'+due.id))){
        this.change(d=>{const recording=d.recordings.find(item=>item.id===due.id);recording.state='error';recording.error=typeof error?.message==='string'?error.message.slice(0,500):'語音轉錄未能開始。';clearRecordingSchedule(recording);},'語音轉錄未能開始','','error');
      }
    }).catch(()=>{retryDelay=RECHECK_MS;}).finally(()=>{this.recordingSchedulerBusy=false;this._setRecordingSchedulerTimer(retryDelay);});
  },
};

module.exports={initializeRecordingQueue,clearRecordingSchedule,recordingQueueMethods};

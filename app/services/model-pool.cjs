/* Deterministic front-end simulation only; no hardware, SDK, or timers. */
class ModelPoolScheduler {
  constructor({clock = () => performance.now(), onEvent = () => {}, loadMs = 700, unloadMs = 250} = {}) {
    this.clock = clock; this.onEvent = onEvent;
    this.loadMs = this._ms(loadMs); this.unloadMs = this._ms(unloadMs);
    this.policy = {mode:'resident', preferred:'llm', idleMs:300000};
    this.devices = []; this.jobs = []; this.events = []; this.serial = 0; this.jobSerial = 0;
    this.busy = false; this.lastTime = -Infinity;
  }
  _ms(value) { if (!Number.isFinite(value) || value < 0) throw new RangeError('Expected nonnegative milliseconds'); return value; }
  _model(value) { if (!['llm','ocr','whisper'].includes(value)) throw new RangeError('Unknown model'); return value; }
  _now() { const n=this.clock(); if (!Number.isFinite(n) || n<this.lastTime) throw new RangeError('Clock must be monotonic'); this.lastTime=n; return n; }
  _emit(type, device, job, extra={}) { this.events.push({type,...(device?{deviceId:device.id}:{}),...(job?{jobId:job.id,model:job.model}:{}),...extra}); }
  _flush() {
    // Keep the guard while notifying: a UI callback may call tick().
    if (this.busy) return;
    this.busy=true;
    try { while(this.events.length) this.onEvent(this.events.shift(),this.snapshot()); }
    finally { this.busy=false; }
  }
  addDevice() {
    const id='device-'+(++this.serial);
    const d={id,name:'Ugen 300 '+this.serial,model:null,target:null,state:'empty',jobId:null,idleSince:this._now(),op:null};
    this.devices.push(d); this._emit('device-added',d); this.tick(); return id;
  }
  removeDevice(id) {
    const i=this.devices.findIndex(d=>d.id===id); if(i<0)return false;
    const d=this.devices[i],j=this.jobs.find(j=>j.id===d.jobId);
    this.devices.splice(i,1);
    if(j && ['preparing','running'].includes(j.state)) { j.state='failed';j.error='裝置已移除';j.deviceId=null;this._emit('job-failed',d,j,{message:j.error}); }
    this._emit('device-removed',d); this.tick(); return true;
  }
  setPolicy(update) {
    const p={...this.policy,...update};
    if(!['resident','preferred','offload'].includes(p.mode))throw new RangeError('Unknown policy');
    this._model(p.preferred);this._ms(p.idleMs);
    if(JSON.stringify(p)===JSON.stringify(this.policy))return;
    this.policy=p;
    // A policy operation is simulated and cancellable; demand preparation survives.
    for(const d of this.devices)if(d.op?.purpose==='policy') {
      const model=d.model||d.target;d.model=null;d.target=null;d.state='empty';d.op=null;d.idleSince=this._now();
      this._emit('model-unloaded',d,null,{model,message:'策略變更，取消預熱或閒置卸載'});
    }
    this._emit('policy-changed');this.tick();
  }
  submit({model,label='',durationMs=1000,onProgress}={}) {
    this._model(model);this._ms(durationMs);
    if(onProgress!==undefined && typeof onProgress!=='function')throw new TypeError('onProgress must be a function');
    const id='job-'+(++this.jobSerial);
    this.jobs.push({id,model,label,state:'queued',deviceId:null,progress:0,error:null,durationMs,onProgress,start:null,lastProgress:-1});
    this.tick();return id;
  }
  cancelJob(id) {
    const j=this.jobs.find(j=>j.id===id);if(!j||!['queued','preparing','running'].includes(j.state))return false;
    const d=this.devices.find(d=>d.jobId===id);
    j.state='cancelled';j.deviceId=null;
    if(d) {
      d.jobId=null;
      if(d.state==='running'){d.state='ready';d.idleSince=this._now();}
      else if(d.op){const model=d.model||d.target;d.model=null;d.target=null;d.state='empty';d.op=null;d.idleSince=this._now();this._emit('model-unloaded',d,null,{model,message:'取消工作準備'});}
    }
    this._emit('job-cancelled',d,j);this.tick();return true;
  }
  _load(d,model,purpose,now) {
    d.state='loading';d.model=null;d.target=model;d.idleSince=null;d.op={end:now+this.loadMs,purpose};
    this._emit('model-loading',d,this.jobs.find(j=>j.id===d.jobId),{model});
  }
  _unload(d,target,purpose,now) {
    d.state='unloading';d.target=target;d.idleSince=null;d.op={end:now+this.unloadMs,purpose};
    this._emit('model-unloading',d,this.jobs.find(j=>j.id===d.jobId),{model:d.model});
  }
  _start(d,j,now) { d.state='running';d.idleSince=null;d.jobId=j.id;j.deviceId=d.id;j.state='running';j.start=now;this._emit('job-started',d,j); }
  _progress(j,p) { j.progress=p; if(j.lastProgress!==p){j.lastProgress=p;if(j.onProgress)this.progressCalls.push([j.onProgress,p,j.id]);} }
  tick() {
    if(this.busy)return;
    this.busy=true;this.progressCalls=[];
    try {
      const now=this._now();
      for(const d of this.devices) {
        if(d.op && now>=d.op.end) {
          const op=d.op;
          if(d.state==='unloading') {
            const previous=d.model,target=d.target;d.model=null;d.target=null;d.state='empty';d.op=null;d.idleSince=now;
            this._emit('model-unloaded',d,null,{model:previous});
            if(target)this._load(d,target,op.purpose,now);
          }else if(d.state==='loading') {
            d.model=d.target;d.target=null;d.state='ready';d.op=null;d.idleSince=now;
            this._emit('model-ready',d,null,{model:d.model});
            const j=this.jobs.find(j=>j.id===d.jobId);
            if(j?.state==='preparing')this._start(d,j,now);
          }
        }
        if(d.state==='running') {
          const j=this.jobs.find(j=>j.id===d.jobId);
          const p=j.durationMs===0?100:Math.min(100,Math.floor(100*(now-j.start)/j.durationMs));
          this._progress(j,p);
          if(p===100){j.state='completed';d.jobId=null;d.state='ready';d.idleSince=now;this._emit('job-completed',d,j);}
        }
      }
      // Oldest queued work gets first choice of every available device.
      for(const j of this.jobs.filter(j=>j.state==='queued')) {
        const free=this.devices.filter(d=>d.state==='empty'||d.state==='ready');
        const d=free.find(d=>d.model===j.model)||free.find(d=>d.state==='empty')||free.sort((a,b)=>a.idleSince-b.idleSince)[0];
        if(!d)break;
        d.jobId=j.id;j.deviceId=d.id;
        if(d.model===j.model)this._start(d,j,now);
        else {j.state='preparing';if(d.model)this._unload(d,j.model,'demand',now);else this._load(d,j.model,'demand',now);}
      }
      if(!this.jobs.some(j=>j.state==='queued')) {
        for(const d of this.devices) {
          if(!['ready','empty'].includes(d.state)||now-d.idleSince<this.policy.idleMs)continue;
          if(this.policy.mode==='offload'&&d.model)this._unload(d,null,'policy',now);
          if(this.policy.mode==='preferred') {
            const preferred=this.policy.preferred;
            const covered=this.devices.some(x=>(x.model===preferred&&['ready','running'].includes(x.state))||x.target===preferred);
            if(!covered){if(d.model)this._unload(d,preferred,'policy',now);else this._load(d,preferred,'policy',now);}
            else if(d.model && (d.model!==preferred || this.devices.some(x=>x!==d&&((x.model===preferred&&['ready','running'].includes(x.state))||x.target===preferred))))this._unload(d,null,'policy',now);
          }
        }
      }
      // No nested tick or state evaluation from progress/event callbacks.
      for(const [fn,p,id] of this.progressCalls)fn(p,id);
    } finally { this.busy=false; }
    this._flush();
  }
  snapshot() {
    const now=this.clock();
    return {policy:{...this.policy},devices:this.devices.map(d=>({id:d.id,name:d.name,model:d.model,target:d.target,state:d.state,jobId:d.jobId,idleSince:d.idleSince,remainingMs:d.op?Math.max(0,d.op.end-now):d.state==='running'?Math.max(0,(this.jobs.find(j=>j.id===d.jobId).start+this.jobs.find(j=>j.id===d.jobId).durationMs)-now):0})),jobs:this.jobs.map(({id,model,label,state,deviceId,progress,error})=>({id,model,label,state,deviceId,progress,error})),queueLength:this.jobs.filter(j=>j.state==='queued').length};
  }
}
if(typeof module!=='undefined'&&module.exports)module.exports={ModelPoolScheduler};

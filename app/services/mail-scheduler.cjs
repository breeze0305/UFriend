'use strict';
const DEFAULT_MAIL_SCHEDULE=Object.freeze({enabled:false,time:'09:00'});
const DEFAULT_MAIL_SCHEDULE_STATE=Object.freeze({lastScheduledDate:'',lastAttemptAt:'',lastCompletedAt:'',status:'idle',error:''});
function mailSchedule(patch,current=DEFAULT_MAIL_SCHEDULE){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['enabled','time'].includes(key)))throw new Error('郵件整理排程格式錯誤。');
  const next={...DEFAULT_MAIL_SCHEDULE,...current};
  if(Object.hasOwn(patch,'enabled')){if(typeof patch.enabled!=='boolean')throw new Error('請選擇是否啟用郵件整理排程。');next.enabled=patch.enabled;}
  if(Object.hasOwn(patch,'time')){if(typeof patch.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.time))throw new Error('請輸入有效的每日整理時間。');next.time=patch.time;}
  return next;
}
function localDate(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
/** Claim a local date durably before dispatch. Missed days are never replayed. */
class MailScheduler{
  constructor({read,save,run,isBusy=()=>false,now=()=>new Date(),onError=()=>{}}){Object.assign(this,{read,save,run,isBusy,now,onError});this.running=false;this.timer=null;}
  start(){this.stop();this.timer=setInterval(()=>this.tick().catch(this.onError),15000);this.timer.unref?.();this.tick().catch(this.onError);}
  stop(){clearInterval(this.timer);this.timer=null;}
  async tick(){
    if(this.running||this.isBusy())return false;
    const data=this.read(),config=mailSchedule(data.settings.mailSchedule??{}),date=this.now(),day=localDate(date),state=data.mailScheduleState||{};
    const minutes=date.getHours()*60+date.getMinutes(),[h,m]=config.time.split(':').map(Number);
    if(!config.enabled||minutes<h*60+m||state.lastScheduledDate>=day)return false;
    this.running=true;
    try{
      this.save({...DEFAULT_MAIL_SCHEDULE_STATE,...state,lastScheduledDate:day,lastAttemptAt:date.toISOString(),status:'running',error:''});
      try{
        const result=await this.run(data.settings);
        this.save({...this.read().mailScheduleState,lastCompletedAt:this.now().toISOString(),status:result?.status||'done',error:result?.error||''});
      }catch(error){this.save({...this.read().mailScheduleState,status:error?.code==='MODEL_CANCELLED'?'cancelled':'error',error:String(error?.message||'自動郵件整理失敗。').slice(0,1000)});}
      return true;
    }finally{this.running=false;}
  }
}
module.exports={MailScheduler,mailSchedule,localDate,DEFAULT_MAIL_SCHEDULE,DEFAULT_MAIL_SCHEDULE_STATE};

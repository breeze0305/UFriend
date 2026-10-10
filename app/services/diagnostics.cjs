'use strict';

const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const TOKEN=/^[a-zA-Z0-9_.:-]{1,100}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const NUMBERS=['durationMs','inputCharacters','outputCharacters','promptCharacters','responseBytes','httpStatus','promptTokens','completionTokens','maxOutputTokens','contextTokens','exitCode','line','column'];
const LABELS=['event','task','action','code','stage','finishReason','backend','reason','source','errorName'];
function safeRecord(input,context){
  const record={timestamp:new Date().toISOString(),sessionId:context.sessionId,version:context.version,level:['debug','info','warn','error'].includes(input?.level)?input.level:'info'};
  for(const key of LABELS)if(typeof input?.[key]==='string'&&TOKEN.test(input[key]))record[key]=input[key];
  for(const key of ['requestId','serverRequestId','conversationId','streamId'])if(typeof input?.[key]==='string'&&UUID.test(input[key]))record[key]=input[key];
  for(const key of NUMBERS)if(Number.isFinite(input?.[key])&&input[key]>=0)record[key]=Math.round(input[key]);
  for(const key of ['promptHash','inputHash'])if(typeof input?.[key]==='string'&&/^[a-f0-9]{64}$/i.test(input[key]))record[key]=input[key];
  if(typeof input?.model==='string'&&/^[a-zA-Z0-9_.:/+-]{1,200}$/.test(input.model))record.model=input.model;
  if(typeof input?.endpoint==='string')try{const url=new URL(input.endpoint);if(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password)record.endpoint=url.origin;}catch{}
  return record;
}
class Diagnostics {
  constructor({directory,version='development',maxBytes=2*1024*1024,retainedFiles=5}={}){
    if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Diagnostics requires an absolute directory.');
    if(!Number.isInteger(maxBytes)||maxBytes<1024||!Number.isInteger(retainedFiles)||retainedFiles<1||retainedFiles>10)throw new Error('Invalid diagnostic retention.');
    this.directory=directory;this.file=path.join(directory,'events.jsonl');this.maxBytes=maxBytes;this.retainedFiles=retainedFiles;
    this.version=String(version).slice(0,40);this.sessionId=randomUUID();this.queue=Promise.resolve();this.error='';
  }
  fileAt(index){return index===0?this.file:path.join(this.directory,`events.${index}.jsonl`);}
  write(input){
    const line=JSON.stringify(safeRecord(input,this))+'\n';
    this.queue=this.queue.then(async()=>{
      await fs.mkdir(this.directory,{recursive:true});
      const size=await fs.stat(this.file).then(value=>value.size,error=>{if(error.code==='ENOENT')return 0;throw error;});
      if(size+Buffer.byteLength(line)>this.maxBytes){
        await fs.unlink(this.fileAt(this.retainedFiles-1)).catch(error=>{if(error.code!=='ENOENT')throw error;});
        for(let index=this.retainedFiles-2;index>=0;index--)await fs.rename(this.fileAt(index),this.fileAt(index+1)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
      await fs.appendFile(this.file,line,{encoding:'utf8',mode:0o600});this.error='';
    }).catch(()=>{this.error='診斷紀錄暫時無法寫入，請確認資料位置可寫入。';});
    return this.queue;
  }
  async flush(){await this.queue;}
  checkedDirectory(){
    try{
      const directory=path.resolve(this.directory),stat=fsSync.lstatSync(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('診斷紀錄目錄不安全，未清空紀錄。');
      const actual=fsSync.realpathSync(directory),expected=path.join(fsSync.realpathSync(path.dirname(directory)),path.basename(directory));
      const same=process.platform==='win32'?actual.toLowerCase()===expected.toLowerCase():actual===expected;
      if(!same)throw new Error('診斷紀錄目錄不安全，未清空紀錄。');
      return true;
    }catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  async cleanupInfo(){
    await this.flush();let files=0,bytes=0;
    if(!this.checkedDirectory())return{files,bytes};
    for(let index=0;index<10;index++){
      const stat=await fs.lstat(this.fileAt(index)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(stat?.isFile()){files++;bytes+=stat.size;}
    }
    return{files,bytes};
  }
  clear(){
    const clearing=this.queue.then(()=>{
      if(!this.checkedDirectory()){this.error='';return{deletedFiles:0};}
      // Every supported retention setting owns only these ten filenames.
      // Stay synchronous inside the queued task so writeFatal cannot rotate
      // an old file into a position that has already been cleared.
      let deletedFiles=0;
      for(let index=0;index<10;index++)try{fsSync.unlinkSync(this.fileAt(index));deletedFiles++;}catch(error){if(error.code!=='ENOENT')throw error;}
      this.error='';
      return{deletedFiles};
    });
    this.queue=clearing.catch(()=>{this.error='診斷紀錄暫時無法清空，請確認資料位置可寫入。';});
    return clearing;
  }
  writeFatal(input){
    // An uncaught exception may terminate before the asynchronous queue flushes.
    try{
      const line=JSON.stringify(safeRecord({...input,level:'error'},this))+'\n';fsSync.mkdirSync(this.directory,{recursive:true});
      let size=0;try{size=fsSync.statSync(this.file).size;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(size+Buffer.byteLength(line)>this.maxBytes){
        try{fsSync.unlinkSync(this.fileAt(this.retainedFiles-1));}catch(error){if(error.code!=='ENOENT')throw error;}
        for(let index=this.retainedFiles-2;index>=0;index--)try{fsSync.renameSync(this.fileAt(index),this.fileAt(index+1));}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      fsSync.appendFileSync(this.file,line,{encoding:'utf8',mode:0o600});
    }catch{/* Crash reporting must not replace the original exception. */}
  }
  info(){return{directory:this.directory,file:this.file,error:this.error,retainedFiles:this.retainedFiles,maxBytes:this.maxBytes};}
  async export(){
    await this.flush();const entries=[];
    for(let index=this.retainedFiles-1;index>=0;index--){
      const text=await fs.readFile(this.fileAt(index),'utf8').catch(error=>{if(error.code==='ENOENT')return'';throw error;});
      for(const line of text.split('\n'))if(line.trim())try{const value=JSON.parse(line);entries.push(value);}catch{}
    }
    return{format:'ufriend-diagnostics-v1',exportedAt:new Date().toISOString(),version:this.version,entries};
  }
}
module.exports={Diagnostics};

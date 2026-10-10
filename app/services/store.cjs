'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const clone = value => JSON.parse(JSON.stringify(value));
const emptyState = () => ({version:1,settings:{},accounts:[],messages:[],recordings:[],logs:[]});
const renameWait = new Int32Array(new SharedArrayBuffer(4));

function commitRename(temporary,target) {
  // Windows readers can briefly deny replacement after an antivirus/indexing
  // scan. Retry the same atomic rename; never remove the previous state first.
  for (let attempt=0;;attempt++) {
    try { fs.renameSync(temporary,target);return; }
    catch (error) {
      if (process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4) throw error;
      Atomics.wait(renameWait,0,0,10*2**attempt);
    }
  }
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('不支援的本機資料格式');
  for (const key of ['accounts','messages','recordings','logs']) if (!Array.isArray(value[key])) throw new Error(`本機資料 ${key} 格式錯誤`);
  if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('本機設定格式錯誤');
  return value;
}

/** Main-process, single-writer store. The Electron shell owns the instance lock. */
class Store {
  constructor({dataDir} = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('dataDir is required');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir,'state.json');
    this.backup = path.join(this.dataDir,'state.backup.json');
    fs.mkdirSync(this.dataDir,{recursive:true});
    this.writing = false;
    if (!fs.existsSync(this.file) && !fs.existsSync(this.backup)) {
      this.data = emptyState();
      this._atomicWrite(this.file,this.data);
    } else {
      try { this.data = validate(JSON.parse(fs.readFileSync(this.file,'utf8'))); }
      catch (error) {
        try { this.data = validate(JSON.parse(fs.readFileSync(this.backup,'utf8'))); }
        catch { throw new Error('本機資料與備份皆無法讀取，原始檔案已保留。請先備份資料目錄再修復。',{cause:error}); }
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file,path.join(this.dataDir,`state.corrupt-${randomUUID()}.json`));
        this.data.logs.unshift({id:randomUUID(),date:new Date().toISOString(),text:'由備份復原本機資料',detail:'原資料檔已另存保留',status:'warning'});
        this._atomicWrite(this.file,this.data);
      }
    }
  }

  _atomicWrite(target,value) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let fd,failed=false;
    try {
      fd = fs.openSync(temporary,'wx',0o600);
      fs.writeFileSync(fd,JSON.stringify(value,null,2),'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);fd=undefined;
      // Both files are in the same directory: rename is the commit point.
      commitRename(temporary,target);
    } catch (error) {
      failed=true;throw error;
    } finally {
      let cleanupError;
      if (fd !== undefined) try { fs.closeSync(fd); } catch (error) { cleanupError=error; }
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') cleanupError??=error; }
      // A locked temporary file must not hide the original failed write.
      if (cleanupError&&!failed) throw cleanupError;
    }
  }

  read() { return clone(this.data); }

  update(mutator) { return this._update(mutator,false); }

  // Explicit deletion must reach the recovery copy as well as the primary.
  // A failed primary write still rejects, with live state left unchanged.
  purge(mutator) { return this._update(mutator,true); }

  _update(mutator,purgeBackup) {
    if (typeof mutator !== 'function') throw new TypeError('update requires a synchronous function');
    if (this.writing) throw new Error('Nested store updates are not supported');
    this.writing = true;
    try {
      const draft = this.read();
      const result = mutator(draft);
      if (result && typeof result.then === 'function') throw new TypeError('Store mutators must be synchronous');
      const next = validate(clone(draft));
      this._atomicWrite(this.backup,purgeBackup?next:this.data);
      this._atomicWrite(this.file,next);
      this.data = next;
      return this.read();
    } finally { this.writing = false; }
  }

  appendLog(text,detail='',status='success') {
    const entry = typeof text === 'object' && text !== null ? {...text} : {text:String(text),detail:String(detail),status};
    const log = {id:randomUUID(),date:new Date().toISOString(),...entry};
    this.update(data => { data.logs.unshift(log);data.logs=data.logs.slice(0,2000); });
    return clone(log);
  }
}

module.exports = {Store,emptyState};

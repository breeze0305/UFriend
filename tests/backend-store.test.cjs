'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');

function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ufriend-backend-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('ufriend-backend-'));fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}

test('store starts empty, persists additions and never exposes mutable internal references',t=>{
  const dir=temporary(t),store=new Store({dataDir:dir});
  assert.deepEqual(store.read().messages,[]);assert.deepEqual(store.read().accounts,[]);
  store.update(state=>{state.messages.push({id:'local:one',body:'測試郵件',done:true});state.settings.theme='dark';});
  store.update(state=>state.messages.push({id:'local:two'}));
  const copy=store.read();copy.messages[0].done=false;copy.settings.theme='light';
  const reopened=new Store({dataDir:dir});
  assert.equal(reopened.read().messages[0].done,true);assert.equal(reopened.read().settings.theme,'dark');
  assert.deepEqual(fs.readdirSync(dir).sort(),['state.backup.json','state.json']);
});

test('failed mutation or commit leaves disk and memory at the previous complete state',t=>{
  const dir=temporary(t),store=new Store({dataDir:dir});
  store.update(state=>{state.settings.marker='before';});
  assert.throws(()=>store.update(state=>{state.messages.push({id:'never'});throw new Error('stop');}),/stop/);
  assert.throws(()=>store.update(state=>{state.version=999;}),/資料格式/);
  const original=store._atomicWrite.bind(store);
  store._atomicWrite=(target,value)=>{if(target===store.file)throw new Error('disk failure');original(target,value);};
  assert.throws(()=>store.update(state=>{state.settings.marker='after';}),/disk failure/);
  assert.equal(store.read().settings.marker,'before');
  assert.equal(new Store({dataDir:dir}).read().settings.marker,'before');
  assert.deepEqual(store.read().messages,[]);
});

test('corrupt primary recovers the last backup and preserves the damaged file; double corruption fails closed',t=>{
  const dir=temporary(t),store=new Store({dataDir:dir});
  store.update(state=>{state.settings.marker='backup';});
  store.update(state=>{state.settings.marker='latest';});
  fs.writeFileSync(store.file,'{"interrupted":');
  const recovered=new Store({dataDir:dir});
  assert.equal(recovered.read().settings.marker,'backup');
  assert.equal(recovered.read().logs[0].status,'warning');
  assert.ok(fs.readdirSync(dir).some(name=>name.startsWith('state.corrupt-')));
  fs.writeFileSync(store.file,'bad');fs.writeFileSync(store.backup,'bad');
  assert.throws(()=>new Store({dataDir:dir}),/原始檔案已保留/);
  assert.equal(fs.readFileSync(store.file,'utf8'),'bad');
});

test('logs retain dates and status, are bounded, and survive restart',t=>{
  const dir=temporary(t),store=new Store({dataDir:dir});
  store.update(state=>{state.logs=Array.from({length:2000},(_,i)=>({id:String(i),text:'old'}));});
  const log=store.appendLog('儲存草稿','本機','success');
  assert.ok(Number.isFinite(Date.parse(log.date)));assert.ok(log.id);log.text='mutated';
  const logs=new Store({dataDir:dir}).read().logs;
  assert.equal(logs.length,2000);assert.equal(logs[0].text,'儲存草稿');assert.equal(logs[0].status,'success');
});

test('a missing primary file recovers the backup rather than silently initializing an empty database',t=>{
  const dir=temporary(t),store=new Store({dataDir:dir});
  store.update(state=>{state.messages.push({id:'kept'});});
  store.update(state=>{state.settings.theme='dark';});
  fs.unlinkSync(store.file);
  const recovered=new Store({dataDir:dir});
  assert.equal(recovered.read().messages[0].id,'kept');
  assert.equal(recovered.read().logs[0].status,'warning');
});

test('Windows transient replacement locks retry the same complete file without removing the previous state',{skip:process.platform!=='win32'},t=>{
  for(const code of ['EPERM','EACCES','EBUSY']){
    const dir=temporary(t),store=new Store({dataDir:dir});store.update(state=>{state.settings.marker='before';});
    const before=fs.readFileSync(store.file),rename=fs.renameSync;let calls=0,temporaryFile;
    fs.renameSync=(source,target)=>{
      if(target!==store.file)return rename(source,target);
      calls++;temporaryFile??=source;assert.equal(source,temporaryFile);assert(fs.readFileSync(store.file).equals(before));
      assert.equal(JSON.parse(fs.readFileSync(source)).settings.marker,'after');
      if(calls<=2)throw Object.assign(new Error('Synthetic sharing violation'),{code});
      return rename(source,target);
    };
    try{store.update(state=>{state.settings.marker='after';});}finally{fs.renameSync=rename;}
    assert.equal(calls,3);assert.equal(store.read().settings.marker,'after');assert.equal(new Store({dataDir:dir}).read().settings.marker,'after');
    assert.deepEqual(fs.readdirSync(dir).sort(),['state.backup.json','state.json']);
  }
});

test('persistent replacement locks stop after a bounded retry and other disk errors fail immediately',t=>{
  for(const code of ['EPERM','EIO']){
    const dir=temporary(t),store=new Store({dataDir:dir});store.update(state=>{state.settings.marker='before';});
    const before=fs.readFileSync(store.file),rename=fs.renameSync,failure=Object.assign(new Error('Synthetic persistent failure'),{code});let calls=0;
    fs.renameSync=(source,target)=>{if(target!==store.file)return rename(source,target);calls++;throw failure;};
    try{assert.throws(()=>store.update(state=>{state.settings.marker='after';}),error=>error===failure);}finally{fs.renameSync=rename;}
    assert.equal(calls,process.platform==='win32'&&code==='EPERM'?5:1);assert(fs.readFileSync(store.file).equals(before));
    assert.equal(store.read().settings.marker,'before');assert.equal(store.writing,false);
    assert.deepEqual(fs.readdirSync(dir).sort(),['state.backup.json','state.json']);
    store.update(state=>{state.settings.marker='recovered';});assert.equal(new Store({dataDir:dir}).read().settings.marker,'recovered');
  }
});

test('a cleanup lock preserves the original commit error and the previous complete state',t=>{
  const dir=temporary(t),store=new Store({dataDir:dir});store.update(state=>{state.settings.marker='before';});
  const before=fs.readFileSync(store.file),rename=fs.renameSync,unlink=fs.unlinkSync,failure=Object.assign(new Error('Synthetic commit failure'),{code:'EPERM'});let temporaryFile;
  fs.renameSync=(source,target)=>{if(target!==store.file)return rename(source,target);temporaryFile=source;throw failure;};
  fs.unlinkSync=file=>{if(file===temporaryFile)throw Object.assign(new Error('Synthetic cleanup lock'),{code:'EBUSY'});return unlink(file);};
  try{assert.throws(()=>store.update(state=>{state.settings.marker='after';}),error=>error===failure);}finally{fs.renameSync=rename;fs.unlinkSync=unlink;}
  assert(fs.readFileSync(store.file).equals(before));assert.equal(store.read().settings.marker,'before');assert.equal(store.writing,false);
  assert.equal(JSON.parse(fs.readFileSync(temporaryFile)).settings.marker,'after');
});

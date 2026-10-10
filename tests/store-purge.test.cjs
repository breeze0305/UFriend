'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const root=path.resolve(__dirname,'../.test-data/store-purge-tests');
function fixture(t){
  fs.mkdirSync(root,{recursive:true});const dataDir=fs.mkdtempSync(path.join(root,'case-'));
  t.after(()=>{assert.equal(path.dirname(dataDir),root);fs.rmSync(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir});store.update(state=>{state.logs=[{id:'private-old-log'}];state.messages=[{id:'kept-message'}];state.settings.theme='dark';});
  return{store,dataDir};
}
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

test('purge writes the new state to primary and backup, and deleted records cannot return on recovery',t=>{
  const {store,dataDir}=fixture(t),before=store.read();
  const result=store.purge(state=>{state.logs=[];});
  assert.deepEqual(result,{...before,logs:[]});assert.deepEqual(read(store.file),result);assert.deepEqual(read(store.backup),result);
  result.messages.length=0;assert.deepEqual(store.read().messages,before.messages);
  fs.writeFileSync(store.file,'invalid primary');
  const recovered=new Store({dataDir}).read();
  assert.equal(recovered.logs.length,1);assert.equal(recovered.logs[0].status,'warning');
  assert(!JSON.stringify(recovered).includes('private-old-log'));assert.deepEqual(recovered.messages,before.messages);
});

for(const failingTarget of ['backup','file'])test('purge rejects a failed '+failingTarget+' write without committing live or primary state',t=>{
  const {store,dataDir}=fixture(t),before=store.read(),original=store._atomicWrite.bind(store),writes=[];
  store._atomicWrite=(target,value)=>{writes.push(target);if(target===store[failingTarget])throw new Error('fixture disk failure');return original(target,value);};
  assert.throws(()=>store.purge(state=>{state.logs=[];}),/fixture disk failure/);
  assert.deepEqual(store.read(),before);assert.deepEqual(read(store.file),before);assert.deepEqual(new Store({dataDir}).read(),before);
  assert.equal(store.writing,false);assert.deepEqual(writes,failingTarget==='backup'?[store.backup]:[store.backup,store.file]);
  if(failingTarget==='file')assert.deepEqual(read(store.backup).logs,[]);
  store._atomicWrite=original;store.purge(state=>{state.logs=[];});assert.deepEqual(read(store.backup).logs,[]);assert.deepEqual(store.read().logs,[]);
});

test('purge validates synchronous nonnested mutations before touching either persisted copy',t=>{
  const {store}=fixture(t),primary=fs.readFileSync(store.file,'utf8'),backup=fs.readFileSync(store.backup,'utf8');
  for(const mutate of [state=>{state.version=2;},()=>Promise.resolve(),()=>store.update(()=>{}),()=>store.purge(()=>{}),()=>{throw new Error('fixture rejected mutation');}])assert.throws(()=>store.purge(mutate));
  assert.throws(()=>store.purge(null),/synchronous function/);
  assert.equal(fs.readFileSync(store.file,'utf8'),primary);assert.equal(fs.readFileSync(store.backup,'utf8'),backup);assert.equal(store.writing,false);
  store.update(state=>{state.settings.theme='light';});assert.equal(read(store.backup).settings.theme,'dark');assert.equal(store.read().settings.theme,'light');
});

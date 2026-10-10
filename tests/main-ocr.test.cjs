'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {EventEmitter} = require('node:events');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

function imageItem(label, types=['image/png']) {
  const requested=[];
  const blobs=new Map(types.filter(type => type.startsWith('image/')).map(type => [type,new Blob([label+':'+type],{type})]));
  return {
    types,requested,blobs,
    async getType(type) {
      requested.push(type);
      assert.ok(blobs.has(type),'only an advertised image MIME type may be requested');
      return blobs.get(type);
    }
  };
}

// Electron 44's asynchronous surface, with an inert nativeImage decoder.
// Synthetic bytes never reach the OS clipboard, a model, or a window.
// app.whenReady never resolves; no file import or network is used.
function controllerHarness({read,writeText,size={width:1,height:1},listener=false}={}) {
  const mainFile=path.resolve(__dirname,'..','app','main.cjs');
  const moduleRequire=createRequire(mainFile);
  const decoded=[];
  const helper=new EventEmitter(),lines=new EventEmitter();
  helper.stdout=new EventEmitter();helper.stderr=new EventEmitter();helper.exitCode=null;
  helper.stdin={end(){helper.exitCode=0;helper.emit('exit',0);}};
  helper.kill=()=>{helper.exitCode=0;helper.emit('exit',0);};
  lines.close=()=>lines.removeAllListeners();
  let imageNumber=0;
  const electron={
    app:{setName(){},setPath(){},getPath(){return path.resolve(__dirname,'..','.test-data','inert-main');},getVersion(){return 'test';},whenReady(){return new Promise(() => {});},on(){},requestSingleInstanceLock(){return true;},quit(){}},
    protocol:{registerSchemesAsPrivileged(){}},
    clipboard:{
      read:read||async function(){return [imageItem('synthetic-image-'+(++imageNumber))];},
      writeText:writeText||async function(){}
    },
    nativeImage:{
      createFromPath(file){assert.equal(file,'C:/synthetic/import.png');return this.createFromBuffer(Buffer.from('imported-image'));},
      createFromBuffer(bytes) {
        assert.ok(Buffer.isBuffer(bytes));
        decoded.push(bytes.toString());
        return {isEmpty(){return false;},getSize(){return size;},toPNG(){return Buffer.concat([Buffer.from('PNG:'),bytes]);}};
      }
    }
  };
  const module={exports:{}};
  const source=fs.readFileSync(mainFile,'utf8')+`\n
    const clipboardCalls=new Set(),originalReceiveClipboard=receiveClipboard;
    receiveClipboard=(...args)=>{const promise=originalReceiveClipboard(...args);clipboardCalls.add(promise);promise.then(()=>clipboardCalls.delete(promise),()=>clipboardCalls.delete(promise));return promise;};
    module.exports={receiveClipboard,startClipboard,stopClipboard,actions,
      async waitForClipboardIdle(){do{await Promise.allSettled([...clipboardCalls]);await Promise.resolve();}while(clipboardCalls.size);},
      beginTestInput(){return ++ocrInputRevision;},getTestInputRevision(){return ocrInputRevision;},
      setTestContext(value){core=value.core;store=value.store;gmail=value.gmail;vault=value.vault;pool=value.pool;diagnostics={info:()=>({})};}};`;
  vm.runInNewContext(source,{
    require:name => {
      if(name==='electron')return electron;
      if(listener&&name==='node:child_process')return {spawn(file){assert.equal(path.basename(file),'ClipboardListener.exe');return helper;}};
      if(listener&&name==='node:readline')return {createInterface({input}){assert.equal(input,helper.stdout);return lines;}};
      if(listener&&name==='node:fs')return {...fs,existsSync(file){return path.basename(file)==='ClipboardListener.exe'||fs.existsSync(file);}};
      if(name==='node:fs/promises')return {...moduleRequire(name),async stat(file){assert.equal(file,'C:/synthetic/import.png');return {size:16};}};
      return moduleRequire(name);
    },module,
    __dirname:path.dirname(mainFile),__filename:mainFile,
    process:{argv:['node','test'],env:{},platform:'win32',on(){}},
    Buffer,URL,Response,setTimeout,clearTimeout,setInterval,clearInterval,console
  },{filename:mainFile});
  return {...module.exports,decoded,notifyClipboard(){lines.emit('line',JSON.stringify({type:'clipboard'}));}};
}

test('automatic OCR explicitly uses local even when the previous manual task selected cloud',async()=>{
  const harness=controllerHarness(),fixture=attachContext(harness),sources=[];
  fixture.state.settings.ocrAuto=true;fixture.state.ocr.source='cloud';
  const originalSetImage=fixture.context.core.setOcrImage;
  fixture.context.core.setOcrImage=async asset=>{await originalSetImage(asset);fixture.state.ocr.source='cloud';};
  fixture.context.core.runOcr=async (source,options)=>{sources.push({source,...options});};
  await harness.receiveClipboard(false);
  assert.deepEqual(sources,[{source:'local',preserveSelection:true}]);
  await harness.actions['ocr.import']({paths:['C:/synthetic/import.png']});
  assert.deepEqual(sources,[{source:'local',preserveSelection:true},{source:'local',preserveSelection:true}]);
});

function attachContext(harness,{ingestBuffer,auto=false}={}) {
  const state={settings:{ocrAuto:auto},recordings:[],assets:[],logs:[],chatHistory:{conversations:[]},chat:{},ocr:{imageId:'existing-image',text:'existing text',status:'completed',revision:1}};
  const ingested=[],applied=[],runs=[];
  const context={
    core:{
      active:new Map(),
      async ingestBuffer(buffer,options) {
        ingested.push({buffer,options});
        return ingestBuffer?ingestBuffer(buffer,options):{id:'asset-'+buffer.toString(),name:options.name};
      },
      async setOcrImage(asset){applied.push(asset.id);state.ocr={imageId:asset.id,text:'',status:'waiting-model',revision:state.ocr.revision+1};},
      async runOcr(){runs.push(state.ocr.imageId);},
      change(mutator){mutator(state);return state;},
      snapshot(){return state;}
    },
    store:{read(){return state;}},
    gmail:{listAccounts(){return [];}},
    vault:{available(){return true;},get(){return null;}},
    pool:{snapshot(){return {};}}
  };
  harness.setTestContext(context);
  return {state,ingested,applied,runs,context};
}

test('a slower previous manual capture cannot replace a newer completed OCR capture',async() => {
  const harness=controllerHarness();
  const writes=[],entered=[deferred(),deferred()];
  const {state,applied}=attachContext(harness,{ingestBuffer(){const pending=deferred();writes.push(pending);entered[writes.length-1].resolve();return pending.promise;}});
  const first=harness.receiveClipboard(true);
  await entered[0].promise;
  const second=harness.receiveClipboard(true);
  await entered[1].promise;
  writes[1].resolve({id:'new-capture',name:'new.png'});
  await second;
  assert.equal(state.ocr.imageId,'new-capture');
  writes[0].resolve({id:'old-capture',name:'old.png'});
  assert.equal((await first).skipped,true);
  assert.equal(state.ocr.imageId,'new-capture');
  assert.deepEqual(applied,['new-capture']);
});

test('clearing OCR while a capture is being saved does not restore the cleared image later',async() => {
  const harness=controllerHarness();
  const entered=deferred(),write=deferred();
  const {state,applied}=attachContext(harness,{ingestBuffer(){entered.resolve();return write.promise;}});
  const pending=harness.receiveClipboard(true);
  await entered.promise;
  harness.actions['ocr.clear']({});
  write.resolve({id:'capture-before-clear',name:'old.png'});
  assert.equal((await pending).skipped,true);
  assert.equal(state.ocr.imageId,null);
  assert.equal(state.ocr.status,'empty');
  assert.deepEqual(applied,[]);
});

test('an unreadable credential vault does not block opening unrelated local data',() => {
  const harness=controllerHarness();
  const recording={id:'local-recording',name:'saved.wav',type:'audio',textOnly:'saved local transcript'};
  harness.setTestContext({
    core:{active:new Map(),snapshot(){return {recordings:[recording],assets:[],logs:[],chatHistory:{conversations:[]},chat:{},ocr:{text:'manual text'}};}},
    store:{read(){return {settings:{ocrAuto:false}};}},
    gmail:{listAccounts(){return [];}},
    vault:{available(){return true;},get(){throw new Error('無法解密本機憑證');}},
    pool:{snapshot(){return {};}}
  });
  const result=harness.actions.bootstrap({});
  assert.deepEqual(result.recordings,[recording]);
  assert.equal(result.ocr.text,'manual text');
});

for(const stage of ['read','getType','arrayBuffer']) {
  for(const newerAction of ['capture','clear','stop-auto']) {
    test('a delayed '+stage+' cannot change OCR after '+newerAction,async() => {
      const entered=deferred(),gate=deferred(),old=imageItem('old'),fresh=imageItem('new');
      const oldBlob=old.blobs.get('image/png');
      const originalBytes=await oldBlob.arrayBuffer();
      let releaseValue=[old],reads=0;
      if(stage==='getType'){old.getType=async()=>{entered.resolve();return gate.promise;};releaseValue=oldBlob;}
      if(stage==='arrayBuffer'){oldBlob.arrayBuffer=async()=>{entered.resolve();return gate.promise;};releaseValue=originalBytes;}
      const harness=controllerHarness({read:async()=>{
        reads++;
        if(reads>1)return [fresh];
        if(stage==='read'){entered.resolve();return gate.promise;}
        return [old];
      }});
      const {state,ingested,applied,runs}=attachContext(harness,{auto:newerAction==='stop-auto'});
      const previous=harness.receiveClipboard(newerAction!=='stop-auto');
      await entered.promise;
      if(newerAction==='capture')await harness.receiveClipboard(true);
      if(newerAction==='clear')harness.actions['ocr.clear']({});
      if(newerAction==='stop-auto')harness.stopClipboard();
      const expected={...state.ocr};
      gate.resolve(releaseValue);
      assert.equal((await previous).skipped,true);
      assert.deepEqual({...state.ocr},expected);
      assert.equal(ingested.length,newerAction==='capture'?1:0);
      assert.equal(applied.length,newerAction==='capture'?1:0);
      assert.equal(harness.decoded.length,newerAction==='capture'?1:0);
      assert.equal(runs.length,0);
    });
  }
}

test('text-only clipboard contents preserve OCR without requesting text MIME data',async() => {
  let getTypeCalls=0;
  const harness=controllerHarness({read:async()=>[{types:['text/plain','text/html'],async getType(){getTypeCalls++;throw new Error('Text must not be read.');}}]});
  const {state,ingested}=attachContext(harness);
  const expected={...state.ocr};
  await assert.rejects(harness.receiveClipboard(true),/剪貼簿目前沒有圖片/);
  assert.equal((await harness.receiveClipboard(false)).skipped,true);
  assert.deepEqual(state.ocr,expected);
  assert.equal(getTypeCalls,0);
  assert.equal(ingested.length,0);
  assert.deepEqual(harness.decoded,[]);
});

for(const [types,selected] of [
  [['text/html','image/jpeg','image/png'],'image/png'],
  [['text/plain','image/jpeg'],'image/jpeg']
]) {
  test('clipboard capture selects '+selected+' and requests only that image representation',async() => {
    const item=imageItem('selected',types);
    const text={types:['text/plain'],async getType(){assert.fail('An earlier text-only item must be ignored.');}};
    const harness=controllerHarness({read:async()=>[text,item]});
    const {ingested,applied}=attachContext(harness);
    await harness.receiveClipboard(true);
    assert.deepEqual(item.requested,[selected]);
    assert.deepEqual(harness.decoded,['selected:'+selected]);
    assert.equal(ingested[0].buffer.toString(),'PNG:selected:'+selected);
    assert.match(ingested[0].options.name,/\.png$/);
    assert.equal(applied.length,1);
  });
}

test('a Blob over 40 MiB is rejected before arrayBuffer or native decoding',async() => {
  const item=imageItem('oversized'),blob=item.blobs.get('image/png');
  // Override metadata rather than allocate a 40 MiB fixture just for the limit.
  Object.defineProperty(blob,'size',{value:40*1024*1024+1});
  let arrayBufferCalls=0;
  blob.arrayBuffer=async()=>{arrayBufferCalls++;throw new Error('Oversized bytes must not be materialized.');};
  const harness=controllerHarness({read:async()=>[item]});
  const {state,ingested}=attachContext(harness);
  const expected={...state.ocr};
  await assert.rejects(harness.receiveClipboard(true),/圖片必須小於 40 MB/);
  assert.equal(arrayBufferCalls,0);
  assert.deepEqual(harness.decoded,[]);
  assert.equal(ingested.length,0);
  assert.deepEqual(state.ocr,expected);
});

for(const size of [{width:10001,height:6000},{width:20001,height:1},{width:1,height:20001}]) {
  test('decoded clipboard dimensions '+size.width+'x'+size.height+' are rejected before saving',async() => {
    const harness=controllerHarness({size});
    const {state,ingested}=attachContext(harness);
    const expected={...state.ocr};
    await assert.rejects(harness.receiveClipboard(true),/圖片尺寸過大/);
    assert.equal(harness.decoded.length,1);
    assert.equal(ingested.length,0);
    assert.deepEqual(state.ocr,expected);
  });
}

for(const notification of ['no-image','duplicate']) {
  for(const pendingKind of ['capture-save','image-import']) {
    test(notification+' auto notification does not invalidate a pending '+pendingKind,async() => {
      const seed=imageItem('seed'),newer=imageItem('newer'),entered=deferred(),save=deferred();
      let items=[seed],holdSave=false;
      const harness=controllerHarness({read:async()=>items});
      const {state,ingested,applied}=attachContext(harness,{ingestBuffer(buffer,options){
        if(holdSave){entered.resolve();return save.promise;}
        return {id:'asset-'+buffer.toString(),name:options.name};
      }});
      await harness.receiveClipboard(true);
      let pending;
      if(pendingKind==='capture-save') {
        holdSave=true;items=[newer];
        pending=harness.receiveClipboard(true);
        await entered.promise;
      } else {
        // Reserve the same controller revision as an import waiting on disk;
        // avoid exercising real filesystem input in this clipboard unit test.
        harness.beginTestInput();
      }
      const revision=harness.getTestInputRevision(),before={...state.ocr};
      const writesBefore=ingested.length;
      items=notification==='duplicate'?[seed]:[{types:['text/plain'],async getType(){assert.fail('No-op notification must not read text.');}}];
      assert.equal((await harness.receiveClipboard(false)).skipped,true);
      assert.equal(harness.getTestInputRevision(),revision);
      assert.deepEqual(state.ocr,before);
      assert.equal(ingested.length,writesBefore);
      if(pending) {
        save.resolve({id:'new-capture',name:'new.png'});
        await pending;
        assert.equal(state.ocr.imageId,'new-capture');
        assert.equal(applied.at(-1),'new-capture');
      }
    });
  }
}

test('clipboard.write returns copied only after asynchronous writeText succeeds',async() => {
  const write=deferred(),entered=deferred(),values=[];
  const harness=controllerHarness({writeText:async text=>{values.push(text);entered.resolve();await write.promise;}});
  let completed=false;
  const pending=harness.actions['clipboard.write']({text:'合成複製文字'}).then(value=>{completed=true;return value;});
  await entered.promise;
  await Promise.resolve();
  assert.equal(completed,false);
  assert.deepEqual(values,['合成複製文字']);
  write.resolve();
  assert.equal((await pending).copied,true);
  assert.equal(completed,true);
});

test('clipboard.write propagates an asynchronous writeText rejection',async() => {
  const write=deferred(),entered=deferred(),failure=new Error('Synthetic clipboard write failure');
  const harness=controllerHarness({writeText:async()=>{entered.resolve();await write.promise;}});
  const pending=harness.actions['clipboard.write']({text:'合成文字'});
  const rejected=assert.rejects(pending,error=>error===failure);
  await entered.promise;
  write.reject(failure);
  await rejected;
});

for(const explicitAction of ['clear','import','capture']) {
  test('a queued native clipboard notification cannot overwrite a later '+explicitAction,async t => {
    const initial=imageItem('initial-auto'),queued=imageItem('queued-auto'),manual=imageItem('manual');
    const running=deferred(),finishOcr=deferred();
    let items=[initial],ocrCalls=0,reads=0;
    const harness=controllerHarness({listener:true,read:async()=>{reads++;return items;}});
    const {state,context,applied}=attachContext(harness,{auto:true});
    context.core.runOcr=async()=>{if(++ocrCalls===1){running.resolve();await finishOcr.promise;}};
    context.store.appendLog=()=>assert.fail('The inert listener must not report a processing error.');
    harness.startClipboard();
    t.after(()=>harness.stopClipboard());
    harness.notifyClipboard();
    await running.promise;
    items=[queued];
    harness.notifyClipboard();
    assert.equal(reads,1,'the second notification must still be queued behind OCR');
    if(explicitAction==='clear')harness.actions['ocr.clear']({});
    if(explicitAction==='import')await harness.actions['ocr.import']({paths:['C:/synthetic/import.png']});
    if(explicitAction==='capture'){items=[manual];await harness.actions['ocr.capture']({});items=[queued];}
    const expected={...state.ocr},expectedApplications=[...applied],readsBeforeRelease=reads;
    finishOcr.resolve();
    await harness.waitForClipboardIdle();
    assert.deepEqual({...state.ocr},expected);
    assert.deepEqual(applied,expectedApplications);
    assert.equal(reads,readsBeforeRelease,'a superseded queued notification must be discarded before reading');
  });
}

test('a queued native notification still runs when only the preceding auto capture changes revision',async t => {
  const entered=deferred(),firstRead=deferred();
  let reads=0;
  const harness=controllerHarness({listener:true,read:async()=>{if(++reads===1){entered.resolve();return firstRead.promise;}return [imageItem('later-auto')];}});
  const {state,context,applied}=attachContext(harness,{auto:true});
  context.store.appendLog=()=>assert.fail('The inert listener must not report a processing error.');
  harness.startClipboard();
  t.after(()=>harness.stopClipboard());
  harness.notifyClipboard();
  await entered.promise;
  harness.notifyClipboard();
  assert.equal(reads,1);
  firstRead.resolve([imageItem('first-auto')]);
  await harness.waitForClipboardIdle();
  assert.equal(reads,2);
  assert.equal(applied.length,2);
  assert.match(state.ocr.imageId,/later-auto/);
});

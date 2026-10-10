'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');

const id='ufriend-test.apps.googleusercontent.com';
function harness(t,{bundled=null}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ufriend-google-controller-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('ufriend-google-controller-'));fs.rmSync(dir,{recursive:true,force:true});});
  const store=new Store({dataDir:dir}),core=new AppService({store,dataDir:dir,models:new ModelAdapters()});
  const credentials=new Map(),calls={connect:[],sync:[],focus:0,dialog:0};
  const vault={available:()=>true,get:key=>credentials.get(key)||null,set:(key,value)=>credentials.set(key,structuredClone(value)),delete:key=>credentials.delete(key),reset:()=>credentials.clear()};
  const gmail={listAccounts:()=>store.read().accounts,
    async connect(config){calls.connect.push(config);const account={id:'gmail:self@example.test',email:'self@example.test',connected:true};store.update(s=>{s.accounts=[account];});return account;},
    async sync(accountId){calls.sync.push(accountId);return{added:0};},cancelConnect(){}};
  const dialogs=[];
  const electron={app:{setName(){},setPath(){},getPath(){return dir;},getVersion(){return 'test';},whenReady(){return new Promise(()=>{});},on(){},requestSingleInstanceLock(){return true;},quit(){}},
    protocol:{registerSchemesAsPrivileged(){}},dialog:{async showOpenDialog(){calls.dialog++;return dialogs.shift()||{canceled:true,filePaths:[]};}}};
  const main=path.resolve(__dirname,'../app/main.cjs'),moduleRequire=createRequire(main),module={exports:{}};
  const source=fs.readFileSync(main,'utf8')+'\nmodule.exports={actions,publicState,setGmailAuthPhase,setContext(v){store=v.store;core=v.core;vault=v.vault;gmail=v.gmail;pool={snapshot(){return {}}};diagnostics={info:()=>({})};bundledGoogleOAuth=v.bundled;bundledGoogleOAuthError="";win=v.win;}};';
  vm.runInNewContext(source,{require:name=>name==='electron'?electron:moduleRequire(name),module,__dirname:path.dirname(main),__filename:main,process:{argv:['node','test'],env:{},platform:'win32'},Buffer,URL,Response,console,setTimeout(){return{unref(){}};},clearTimeout(){},setInterval(){return{unref(){}};},clearInterval(){}},{filename:main});
  module.exports.setContext({store,core,vault,gmail,bundled,win:{isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){calls.focus++;}}});
  return{...module.exports,store,core,vault,gmail,credentials,calls,dialogs,dir};
}

test('unconfigured Gmail reports setup status and refuses to start an authorization',async t=>{
  const h=harness(t);assert.equal(h.publicState().gmailAuth.configured,false);
  await assert.rejects(h.actions['gmail.connect']({}),e=>e.code==='AUTH_NOT_CONFIGURED');
  assert.equal(h.calls.connect.length,0);assert.equal(h.publicState().gmailAuth.phase,'idle');
});

test('preconfigured desktop login needs no manual fields and reports actual connection and sync phases',async t=>{
  const h=harness(t,{bundled:{clientId:id,clientSecret:'bundled-secret'}});
  h.vault.set('gmail-client',{clientSecret:'unrelated-manual-secret'});
  h.store.update(s=>{s.accounts=[{id:'gmail:self@example.test',email:'self@example.test',connected:false}];});
  const connect=h.gmail.connect,sync=h.gmail.sync,phases=[];
  h.gmail.connect=async config=>{phases.push(h.publicState().gmailAuth.phase);h.setGmailAuthPhase('completing');phases.push(h.publicState().gmailAuth.phase);return connect(config);};
  h.gmail.sync=async accountId=>{phases.push(h.publicState().gmailAuth.phase);return sync(accountId);};
  const result=await h.actions['gmail.connect']({id:'gmail:self@example.test'});
  assert.deepEqual(phases,['opening','completing','syncing']);
  assert.equal(h.calls.connect[0].clientId,id);assert.equal(h.calls.connect[0].clientSecret,'bundled-secret');
  assert.equal(h.calls.connect[0].loginHint,'self@example.test');assert.equal(h.store.read().settings.gmailClientId,'');
  assert.equal(result.connection.email,'self@example.test');assert.equal(result.connection.syncError,'');
  assert.equal(result.gmailAuth.phase,'idle');assert.equal(h.calls.focus,1);
  assert.equal(JSON.stringify(result).includes('bundled-secret'),false);
});

test('manual updates preserve a same-client secret but never reuse it with a different Client ID',t=>{
  const h=harness(t,{bundled:{clientId:'bundle.apps.googleusercontent.com',clientSecret:'bundle-secret'}});
  h.actions['gmail.configure']({clientId:id,clientSecret:'old-secret'});
  assert.equal(h.publicState().gmailAuth.source,'manual');
  h.actions['gmail.configure']({clientId:id,clientSecret:''});assert.equal(h.vault.get('gmail-client').clientSecret,'old-secret');
  h.actions['gmail.configure']({clientId:'new-client.apps.googleusercontent.com',clientSecret:''});
  assert.equal(h.vault.get('gmail-client'),null);
  h.actions['gmail.clearConfig']({});assert.equal(h.publicState().gmailAuth.source,'bundled');
  assert.equal(h.store.read().settings.gmailClientId,'');assert.equal(h.vault.get('gmail-client'),null);
});

test('Google JSON import uses the native picker, exposes no secret, and rejects web JSON without changing saved settings',async t=>{
  const h=harness(t),good=path.join(h.dir,'desktop.json'),bad=path.join(h.dir,'web.json');
  fs.writeFileSync(good,JSON.stringify({installed:{client_id:id,client_secret:'import-secret'}}));
  fs.writeFileSync(bad,JSON.stringify({web:{client_id:'web.apps.googleusercontent.com',client_secret:'web-secret'}}));
  h.dialogs.push({canceled:false,filePaths:[good]});
  const saved=await h.actions['gmail.importConfig']({paths:[bad]});
  assert.equal(saved.imported,true);assert.equal(saved.gmailAuth.configured,true);assert.equal(JSON.stringify(saved).includes('import-secret'),false);
  assert.equal(h.vault.get('gmail-client').clientSecret,'import-secret');
  assert.equal(fs.readFileSync(path.join(h.dir,'state.json'),'utf8').includes('import-secret'),false);
  h.dialogs.push({canceled:false,filePaths:[bad]});
  await assert.rejects(h.actions['gmail.importConfig']({}),e=>e.code==='GOOGLE_OAUTH_INVALID_CONFIG');
  assert.equal(h.store.read().settings.gmailClientId,id);assert.equal(h.vault.get('gmail-client').clientSecret,'import-secret');
  const cancelled=await h.actions['gmail.importConfig']({});assert.equal(cancelled.cancelled,true);
  assert.equal(h.calls.dialog,3);
});

test('a failed local config write rolls its paired secret back to the previous value',t=>{
  const h=harness(t);h.actions['gmail.configure']({clientId:id,clientSecret:'original-secret'});
  h.core.settings=()=>{throw new Error('synthetic disk failure');};
  assert.throws(()=>h.actions['gmail.configure']({clientId:'other.apps.googleusercontent.com',clientSecret:'replacement-secret'}),/synthetic disk failure/);
  assert.equal(h.vault.get('gmail-client').clientSecret,'original-secret');assert.equal(h.store.read().settings.gmailClientId,id);
});

test('successful authorization with a failed first sync stays connected and returns a retryable sync warning',async t=>{
  const h=harness(t,{bundled:{clientId:id,clientSecret:''}});h.gmail.sync=async()=>{throw new Error('synthetic offline');};
  const result=await h.actions['gmail.connect']({});
  assert.equal(result.connection.email,'self@example.test');assert.equal(result.connection.syncError,'synthetic offline');
  assert.equal(result.accounts[0].connected,true);assert.equal(result.gmailAuth.phase,'idle');
});

test('busy authorization blocks replacement config and duplicate login until cancellation has settled',async t=>{
  const h=harness(t,{bundled:{clientId:id,clientSecret:''}});let reject;
  h.gmail.connect=()=>new Promise((_resolve,no)=>{reject=no;});
  h.gmail.cancelConnect=()=>reject(Object.assign(new Error('cancelled'),{code:'AUTH_CANCELLED'}));
  const pending=h.actions['gmail.connect']({});const rejected=assert.rejects(pending,e=>e.code==='AUTH_CANCELLED');
  await assert.rejects(h.actions['gmail.connect']({}),e=>e.code==='AUTH_BUSY');
  assert.throws(()=>h.actions['gmail.clearConfig']({}),e=>e.code==='AUTH_BUSY');
  h.actions['gmail.cancel']({});await rejected;assert.equal(h.publicState().gmailAuth.phase,'idle');
});

test('resetting credentials cancels ongoing cloud work while a local task continues',async t=>{
  const h=harness(t),entered=[];let cloudRequest,localRequest,finishCloud,finishLocal;
  const started=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});entered.push({promise,resolve});return resolve;};
  const cloudStarted=started(),localStarted=started();
  h.core.models.register('llm',{run:request=>new Promise(resolve=>{cloudRequest=request;finishCloud=resolve;cloudStarted();})},{source:'cloud'});
  h.core.models.register('llm',{run:request=>new Promise(resolve=>{localRequest=request;finishLocal=resolve;localStarted();})});
  h.vault.set('cloud-api',{key:'synthetic-test-key'});
  h.core.saveTranslation({input:'Synthetic local translation.'});
  const chat=h.core.sendChat('Synthetic cloud question.','cloud'),translation=h.core.runTranslation('local');
  await Promise.all(entered.map(item=>item.promise));
  h.actions['secrets.reset']({});
  assert.equal(cloudRequest.signal.aborted,true);assert.equal(localRequest.signal.aborted,false);assert.equal(h.vault.get('cloud-api'),null);
  finishCloud({text:'Late cloud result.'});finishLocal({text:'Local result.'});
  await Promise.all([chat,translation]);
  assert.equal(h.core.snapshot().chat.status,'cancelled');assert.equal(h.core.snapshot().chat.messages.length,0);
  assert.equal(h.core.snapshot().translation.output,'Local result.');
});

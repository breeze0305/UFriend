'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('portable tray restart schedules the original EXE after its media installer has stopped',async()=>{
  const cleanup=deferred(),launcher=path.resolve('UFriend-Portable.exe');
  const h=harness({env:{PORTABLE_EXECUTABLE_FILE:launcher},mediaSetupCleanup:cleanup.promise});
  const restarting=h.requestQuit({restart:true});await new Promise(resolve=>setImmediate(resolve));
  assert(h.calls.includes('media.shutdown'));assert(!h.calls.includes('relaunch'));
  cleanup.resolve();await restarting;
  assert.deepEqual(h.shellState.relaunchOptions,{execPath:launcher,args:[]});assert.equal(h.calls.at(-1),'quit');
});
test('failed media installer shutdown prevents quit and preserves a retry',async()=>{
  const cleanup=deferred(),h=harness({mediaSetupCleanup:cleanup.promise});const quitting=h.requestQuit();
  cleanup.reject(Object.assign(new Error('Synthetic owned installer still running'),{code:'MEDIA_SETUP_SHUTDOWN'}));await quitting;
  assert(!h.calls.includes('quit'));assert.equal(h.lifecycle.schedulerRunning,true);assert(h.calls.includes('error:尚未關閉 UFriend'));
});
function harness({save=Promise.resolve(),cleanup=Promise.resolve(),cloudCleanup,videoExportCleanup,mediaSetupCleanup,relaunchError,env={},uiLanguage='zh-TW'}={}){
  const calls=[],file=path.resolve(__dirname,'../app/main.cjs'),moduleRequire=createRequire(file),module={exports:{}};
  const state={settings:{uiLanguage}},shellState={titles:[],tooltips:[],menu:null},lifecycle={schedulerRunning:true};
  const app={setName(){},getPath(){return path.resolve(__dirname,'../.test-data/inert-restart');},whenReady(){return new Promise(()=>{});},on(){},requestSingleInstanceLock(){return true;},relaunch(options){shellState.relaunchOptions=options;calls.push('relaunch');if(relaunchError)throw relaunchError;},quit(){calls.push('quit');}};
  const electron={app,protocol:{registerSchemesAsPrivileged(){}},dialog:{showErrorBox(title){calls.push('error:'+title);}},Menu:{buildFromTemplate:template=>({items:template})}};
  const source=fs.readFileSync(file,'utf8')+'\nmodule.exports={requestQuit,trayMenuTemplate,updateShellLanguage,tr,setContext(v){win=v.win;tray=v.tray;store=v.store;core=v.core;ocrApi=v.ocrApi;whisperApi=v.whisperApi;videoExports=v.videoExports;mediaRuntime=v.mediaRuntime;diagnostics=v.diagnostics;}};';
  vm.runInNewContext(source,{require:name=>name==='electron'?electron:moduleRequire(name),module,__dirname:path.dirname(file),__filename:file,process:{argv:['test'],env},Buffer,URL,console,setTimeout,clearTimeout,setInterval,clearInterval});
  const core={active:new Map([['recording:sample',{}]]),pauseRecording(id){calls.push('pause:'+id);},
    stopRecordingScheduler(){lifecycle.schedulerRunning=false;calls.push('scheduler.stop');},
    startRecordingScheduler(){lifecycle.schedulerRunning=true;calls.push('scheduler.start');}};
  for(const name of ['cancelMailAnalysis','cancelPolish','cancelChat','cancelTranslation','cancelOcr'])core[name]=()=>calls.push(name);
  if(cloudCleanup)core.models={get(kind,source){assert.equal(source,'cloud');return{cancelAll(){calls.push('cloudCleanup:'+kind);return cloudCleanup;}};}};
  module.exports.setContext({core,mediaRuntime:mediaSetupCleanup===undefined?undefined:{shutdown(){calls.push('media.shutdown');return mediaSetupCleanup;}},videoExports:videoExportCleanup===undefined?undefined:{setClosing(value){calls.push(value?'video.block':'video.resume');},shutdown(){calls.push('video.shutdown');return videoExportCleanup;}},store:{read:()=>state},tray:{setToolTip(value){shellState.tooltips.push(value);},setContextMenu(menu){shellState.menu=menu;}},win:{setTitle(value){shellState.titles.push(value);},isDestroyed:()=>false,isMinimized:()=>true,restore(){calls.push('restore');},show(){calls.push('show');},focus(){calls.push('focus');},webContents:{isDestroyed:()=>false,executeJavaScript(){calls.push('save');return save;}}},ocrApi:{cancelAll(){calls.push('ocrCleanup');return cleanup;}},whisperApi:{cancelAll(){calls.push('whisperCleanup');return Promise.resolve();}},diagnostics:{async write(entry){calls.push(entry.event);},async flush(){calls.push('logFlush');}}});
  return{...module.exports,calls,state,shellState,lifecycle};
}
test('tray restart saves edits, cancels work and waits for cleanup before scheduling exactly one relaunch',async()=>{
  const save=deferred(),cleanup=deferred(),h=harness({save:save.promise,cleanup:cleanup.promise});
  const menu=h.trayMenuTemplate();assert.deepEqual(Array.from(menu.filter(item=>item.label),item=>item.label),['開啟 UFriend','重新啟動 UFriend','結束 UFriend']);
  const restarting=menu.find(item=>item.label==='重新啟動 UFriend').click();await h.requestQuit({restart:true});assert.deepEqual(h.calls,['scheduler.stop','save']);assert.equal(h.lifecycle.schedulerRunning,false);
  save.resolve();await new Promise(resolve=>setImmediate(resolve));assert(h.calls.includes('cancelTranslation'));assert(h.calls.includes('pause:sample'));assert(!h.calls.includes('relaunch'));
  cleanup.resolve();await restarting;assert.deepEqual(h.calls.slice(-4),['app.restarting','logFlush','relaunch','quit']);assert.equal(h.calls.filter(call=>call==='relaunch').length,1);assert.equal(h.lifecycle.schedulerRunning,false);assert(!h.calls.includes('scheduler.start'));
});
test('failed edit saving preserves the app and allows a later restart retry',async()=>{
  const save=deferred(),h=harness({save:save.promise});const first=h.requestQuit({restart:true});save.reject(new Error('Synthetic save failure'));await first;
  assert.deepEqual(h.calls,['scheduler.stop','save','scheduler.start','show','error:尚未重新啟動 UFriend']);assert(!h.calls.includes('relaunch'));assert(!h.calls.includes('quit'));assert.equal(h.lifecycle.schedulerRunning,true);
  await h.requestQuit({restart:true});assert.equal(h.calls.filter(call=>call==='save').length,2);assert.equal(h.calls.filter(call=>call==='scheduler.stop').length,2);assert.equal(h.calls.filter(call=>call==='scheduler.start').length,2);
});
test('normal exit never relaunches, and a native relaunch error keeps the app open',async()=>{
  const normal=harness();await normal.trayMenuTemplate().find(item=>item.label==='結束 UFriend').click();assert(normal.calls.includes('app.stopped'));assert(normal.calls.includes('quit'));assert(!normal.calls.includes('relaunch'));assert.deepEqual(normal.calls.slice(0,2),['scheduler.stop','save']);assert.equal(normal.lifecycle.schedulerRunning,false);
  const failure=harness({relaunchError:new Error('Synthetic restart failure')});await failure.requestQuit({restart:true});assert(failure.calls.includes('error:尚未重新啟動 UFriend'));assert(!failure.calls.includes('quit'));assert.deepEqual(failure.calls.slice(-4),['relaunch','scheduler.start','show','error:尚未重新啟動 UFriend']);assert.equal(failure.lifecycle.schedulerRunning,true);
});

test('shell language changes immediately refresh title, tooltip and tray menu without cancelling work',()=>{
  const h=harness(),chinese=['開啟 UFriend','重新啟動 UFriend','結束 UFriend'],english=['Open UFriend','Restart UFriend','Quit UFriend'];
  let previousMenu;
  for(const [locale,title,labels]of [
    ['zh-TW','UFriend | 你的本地助手',chinese],
    ['en','UFriend | Your local assistant',english],
    ['zh-TW','UFriend | 你的本地助手',chinese]
  ]){
    h.state.settings.uiLanguage=locale;h.updateShellLanguage();
    assert.equal(h.shellState.titles.at(-1),title);assert.equal(h.shellState.tooltips.at(-1),title);
    assert.deepEqual(Array.from(h.shellState.menu.items.filter(item=>item.label),item=>item.label),labels);
    assert.notEqual(h.shellState.menu,previousMenu);previousMenu=h.shellState.menu;
    assert.deepEqual(h.calls,[],'refreshing shell text must not save, cancel models or invoke app lifecycle actions');
  }
  assert.deepEqual(h.shellState.titles,['UFriend | 你的本地助手','UFriend | Your local assistant','UFriend | 你的本地助手']);
  assert.deepEqual(h.shellState.tooltips,h.shellState.titles);
});

test('shell reads the current locale on each translation and falls back to Traditional Chinese for unknown values',()=>{
  const h=harness();
  for(const locale of [undefined,null,'unknown','en-US','EN',false,{},['en']]){
    h.state.settings.uiLanguage='en';assert.equal(h.tr('開啟 UFriend'),'Open UFriend');
    h.state.settings.uiLanguage=locale;assert.equal(h.tr('開啟 UFriend'),'開啟 UFriend');
    h.updateShellLanguage();
    assert.equal(h.shellState.titles.at(-1),'UFriend | 你的本地助手');
    assert.equal(h.shellState.tooltips.at(-1),'UFriend | 你的本地助手');
    assert.deepEqual(Array.from(h.shellState.menu.items.filter(item=>item.label),item=>item.label),['開啟 UFriend','重新啟動 UFriend','結束 UFriend']);
  }
  assert.deepEqual(h.calls,[]);
});

for(const restart of [true,false])test('English tray '+(restart?'restart':'quit')+' retains save, cancellation and lifecycle behavior',async()=>{
  const h=harness({uiLanguage:'en'});h.updateShellLanguage();
  h.shellState.menu.items.find(item=>item.label==='Open UFriend').click();
  assert.deepEqual(h.calls,['restore','show','focus']);h.calls.length=0;
  await h.shellState.menu.items.find(item=>item.label===(restart?'Restart UFriend':'Quit UFriend')).click();
  assert.deepEqual(h.calls,[
    'scheduler.stop','save','cancelMailAnalysis','cancelPolish','cancelChat','cancelTranslation','cancelOcr','pause:sample',
    'ocrCleanup','whisperCleanup',restart?'app.restarting':'app.stopped','logFlush',...(restart?['relaunch']:[]),'quit'
  ]);
});

test('an English restart save failure keeps the app open and shows the translated error title',async()=>{
  const save=deferred(),h=harness({uiLanguage:'en',save:save.promise});h.updateShellLanguage();
  const pending=h.shellState.menu.items.find(item=>item.label==='Restart UFriend').click();
  save.reject(new Error('Synthetic save failure'));await pending;
  assert.deepEqual(h.calls,['scheduler.stop','save','scheduler.start','show','error:UFriend has not restarted']);assert.equal(h.lifecycle.schedulerRunning,true);
});

test('restart blocks new video exports before saving and waits for encoder cleanup before relaunch',async()=>{
  const saved=deferred(),exported=deferred(),h=harness({save:saved.promise,videoExportCleanup:exported.promise});
  const restarting=h.requestQuit({restart:true});assert.deepEqual(h.calls,['scheduler.stop','video.block','save']);
  saved.resolve();await new Promise(resolve=>setImmediate(resolve));assert(h.calls.includes('video.shutdown'));assert(!h.calls.includes('relaunch'));assert(!h.calls.includes('quit'));
  exported.resolve();await restarting;assert(h.calls.indexOf('video.shutdown')<h.calls.indexOf('relaunch'));assert.equal(h.calls.at(-1),'quit');assert(!h.calls.includes('video.resume'));
});

test('failed edit saving resumes video export admission without cancelling the encoder',async()=>{
  const saved=deferred(),h=harness({save:saved.promise,videoExportCleanup:Promise.resolve()});
  const quitting=h.requestQuit();saved.reject(new Error('Synthetic save failure'));await quitting;
  assert.deepEqual(h.calls,['scheduler.stop','video.block','save','video.resume','scheduler.start','show','error:尚未關閉 UFriend']);
});

test('exit waits for cloud uploads and temporary audio cleanup to settle',async()=>{
  const cleanup=deferred(),h=harness({cloudCleanup:cleanup.promise});
  const quitting=h.requestQuit();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call=>call.startsWith('cloudCleanup:')),['cloudCleanup:llm','cloudCleanup:ocr','cloudCleanup:whisper']);
  assert(!h.calls.includes('quit'));
  cleanup.resolve();await quitting;assert.equal(h.calls.at(-1),'quit');
});

test('a cloud audio cleanup failure keeps the app open and records a safe diagnostic',async()=>{
  const cleanup=deferred(),h=harness({cloudCleanup:cleanup.promise});
  const quitting=h.requestQuit();await new Promise(resolve=>setImmediate(resolve));
  cleanup.reject(Object.assign(new Error('Synthetic audio cleanup failure'),{code:'MODEL_TEMP_CLEANUP_FAILED'}));
  await quitting;
  assert(!h.calls.includes('quit'));assert(h.calls.includes('cloud.temp_cleanup_failed'));
  assert(h.calls.includes('error:尚未關閉 UFriend'));assert.equal(h.lifecycle.schedulerRunning,true);
});

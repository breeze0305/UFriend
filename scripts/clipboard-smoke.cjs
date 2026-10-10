'use strict';

// Opt-in Windows/Electron integration test. Original clipboard payloads stay in
// memory, never enter the renderer/model/store, and are restored only while the
// clipboard still contains this run's last verified synthetic write.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {clipboard,ClipboardItem,nativeImage}=require('electron');
const {emptyState}=require('../app/services/store.cjs');
const {DEFAULT_SETTINGS}=require('../app/services/core.cjs');

const projectDir=path.resolve(__dirname,'..');
const endpoint='http://127.0.0.1:8767';
const BOOKMARK='electron application/bookmark';
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new Error(message);};

async function run({app,win,core,actions,dataDir,getClipboardProcess}){
  const testRoot=path.join(projectDir,'.test-data','clipboard-smoke');
  const workspace=path.join(testRoot,'workspace');
  assert(process.argv.includes('--clipboard-smoke-test'),'Clipboard smoke requires its explicit test flag.');
  assert.equal(process.platform,'win32','Clipboard smoke requires Windows.');
  assert.equal(path.resolve(app.getPath('userData')),testRoot,'Refusing a normal Electron profile.');
  assert.equal(path.resolve(dataDir),workspace,'Refusing a normal application workspace.');
  assert.equal(path.resolve(core.store.dataDir),workspace,'The store must use the isolated workspace.');
  const realProject=await fs.realpath(projectDir);
  for(const directory of [testRoot,dataDir,core.store.dataDir]){
    assert.equal(await fs.realpath(directory),path.join(realProject,path.relative(projectDir,directory)),
      'The profile, workspace and store must not redirect through filesystem links.');
  }
  assert.equal(typeof getClipboardProcess,'function','An owned helper accessor is required.');
  assert(!getClipboardProcess(),'A clipboard listener must not start before the synthetic-input guard.');
  assert.equal(core.snapshot().accounts.length,0,'The isolated workspace must have no accounts.');
  assert.equal(core.snapshot().messages.length,0,'The isolated workspace must have no mail.');
  assert.equal(core.active.size,0,'The isolated application must have no active jobs.');
  for(const method of ['read','readText','write','writeText','clear'])assert.equal(typeof clipboard[method],'function');
  assert.equal(typeof ClipboardItem,'function');

  // Check existing ancestors before mkdir, then check the resulting directory.
  const guardedDirectory=async directory=>{
    const relative=path.relative(projectDir,directory);
    assert(relative&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Output must remain inside the project.');
    let current=projectDir;
    for(const part of relative.split(path.sep)){
      current=path.join(current,part);
      try{
        const resolved=await fs.realpath(current);
        assert.equal(resolved,path.join(realProject,path.relative(projectDir,current)),'Output ancestors must not redirect through filesystem links.');
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    await fs.mkdir(directory,{recursive:true});
    assert.equal(await fs.realpath(directory),path.join(realProject,relative));
  };
  const started=Date.now(),runId=new Date(started).toISOString().replace(/[:.]/g,'-');
  const fixtureDir=path.join(testRoot,'fixtures',runId);
  const resultsDir=path.join(projectDir,'.test-results','clipboard',runId);
  await guardedDirectory(fixtureDir);await guardedDirectory(resultsDir);
  const reportFile=path.join(resultsDir,'clipboard-smoke-report.json');
  const report={runId,startedAt:new Date(started).toISOString(),electron:process.versions.electron,
    status:'running',scope:'Actual Windows clipboard, native notifications and local OCR; synthetic input only.',
    dataDir,fixtureDir,endpoint,checks:[],ocr:{},screenshots:[],cleanup:{},syntheticReads:0};
  const checkpoint=()=>fs.writeFile(reportFile,JSON.stringify({...report,elapsedMs:Date.now()-started},null,2)+'\n');
  const originalRead=clipboard.read,read=originalRead.bind(clipboard);
  const write=clipboard.write.bind(clipboard),readText=clipboard.readText.bind(clipboard);
  const clear=clipboard.clear.bind(clipboard);
  let originalSnapshot,restoreItems,lastOwnedFingerprint,activeExpected;
  let wroteClipboard=false,interference=false,ownedHelper,primaryError,guardInstalled=false;

  // Never put a raw Electron clipboard error in a report: it may contain a
  // platform format or data supplied by another application.
  const snapshot=async()=>{
    try{
      const source=await read();
      if(!Array.isArray(source)||source.length>16)fail('Unsupported clipboard entry count.');
      const entries=[];let bytes=0,formats=0;
      for(const item of source){
        if(!Array.isArray(item.types))fail('Unsupported clipboard types.');
        const entriesByType=new Map();
        for(const type of item.types){
          if(typeof type!=='string'||!type||type.length>4096||++formats>512)fail('Unsupported clipboard format.');
          const value=await item.getType(type);
          if(type===BOOKMARK){
            if(!value||typeof value.title!=='string'||typeof value.url!=='string')fail('Unsupported clipboard bookmark.');
            const bookmark={title:value.title,url:value.url};
            const payload=Buffer.from(JSON.stringify(bookmark));bytes+=payload.length;
            entriesByType.set(type,{type,bookmark,bytes:payload});
          }else{
            if(!value||typeof value.arrayBuffer!=='function'||!Number.isSafeInteger(value.size)||value.size<0)fail('Unsupported clipboard payload.');
            if(bytes+value.size>128*1024*1024)fail('Clipboard snapshot exceeds the memory limit.');
            const payload=Buffer.from(await value.arrayBuffer());
            if(payload.length!==value.size)fail('Clipboard payload changed while reading.');
            bytes+=payload.length;entriesByType.set(type,{type,bytes:payload});
          }
          if(bytes>128*1024*1024)fail('Clipboard snapshot exceeds the memory limit.');
        }
        if(entriesByType.size)entries.push([...entriesByType.values()].sort((a,b)=>a.type.localeCompare(b.type)));
      }
      const fingerprint=hash(Buffer.from(JSON.stringify(entries.map(entry=>entry.map(value=>[value.type,hash(value.bytes)])))));
      return{entries,fingerprint};
    }catch{throw new Error('Cannot safely snapshot every clipboard payload in memory; no payload details are recorded.');}
  };
  const prepareRestore=value=>{
    try{
      return value.entries.map(entry=>{
        const payloads=Object.create(null);
        for(const payload of entry)payloads[payload.type]=payload.bookmark?
          {...payload.bookmark}:new Blob([payload.bytes],{type:payload.type});
        return new ClipboardItem(payloads);
      });
    }catch{throw new Error('Cannot prepare every original clipboard format for restoration; the clipboard will not be changed.');}
  };
  const payloadFor=(value,type)=>value.entries.flat().find(payload=>payload.type===type);
  const bitmapFingerprint=png=>{
    const image=nativeImage.createFromBuffer(png);
    if(image.isEmpty())return null;
    const size=image.getSize();
    return `${size.width}x${size.height}:`+hash(image.toBitmap());
  };
  const matchesExpected=(value,expected)=>{
    if(!expected)return false;
    const text=payloadFor(value,'text/plain');
    if(!text||text.bytes.toString('utf8')!==expected.text)return false;
    const image=payloadFor(value,'image/png');
    if(!expected.png)return !image&&!payloadFor(value,'image/jpeg');
    return!!image&&bitmapFingerprint(image.bytes)===expected.bitmap;
  };
  const changed=()=>{interference=true;throw new Error('The clipboard changed outside this test; further writes are stopped.');};
  const assertOwned=async()=>{
    if(interference)changed();
    const current=await snapshot();
    if(current.fingerprint!==(lastOwnedFingerprint||originalSnapshot.fingerprint))changed();
    return current;
  };
  // Main receives only detached, verified synthetic bytes. Returning a newly
  // constructed item also prevents a lazy platform getType from reading a later
  // user copy after this guard has checked the current clipboard.
  const guardedRead=async()=>{
    let current;
    try{current=await snapshot();}catch{interference=true;return[];}
    if(!matchesExpected(current,activeExpected)){interference=true;return[];}
    report.syntheticReads++;
    if(activeExpected.png){
      const png=payloadFor(current,'image/png').bytes;
      return[new ClipboardItem({'image/png':new Blob([png],{type:'image/png'})})];
    }
    return[new ClipboardItem({'text/plain':activeExpected.text})];
  };
  const evaluate=async(fn,...args)=>{
    const result=await win.webContents.executeJavaScript(
      `(async()=>{try{return{ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})};}catch(error){return{ok:false,message:error.message};}})()`,true);
    if(!result.ok)throw new Error(result.message);return result.value;
  };
  const ipcCall=(name,args={})=>evaluate(async(name,args)=>{
    const response=await window.ufriend.request(name,args);
    if(!response.ok)throw new Error(response.error?.message||'The requested application action failed.');
    return response.value;
  },name,args);
  const waitFor=async(description,predicate,timeout=15000)=>{
    const deadline=Date.now()+timeout;
    do{if(interference)changed();if(await predicate())return;await pause(100);}while(Date.now()<deadline);
    throw new Error('Timed out: '+description);
  };
  const limited=async(promise,description,timeout=180000)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+description)),timeout);})]);}
    finally{clearTimeout(timer);}
  };
  const check=async(name,callback)=>{
    report.currentCheck=name;await checkpoint();const checkStarted=Date.now();
    try{await callback();report.checks.push({name,status:'passed',durationMs:Date.now()-checkStarted});}
    catch(error){report.checks.push({name,status:'failed',durationMs:Date.now()-checkStarted,error:error.message});throw error;}
    console.log('CLIPBOARD SMOKE PASS '+name);await checkpoint();
  };
  const writeSynthetic=async expected=>{
    await assertOwned();activeExpected=expected;wroteClipboard=true;
    let writeFailed=false;
    try{
      if(expected.png)await write([new ClipboardItem({'image/png':new Blob([expected.png],{type:'image/png'}),'text/plain':expected.text})]);
      else await ipcCall('clipboard.write',{text:expected.text});
    }catch{writeFailed=true;}
    const current=await snapshot();
    if(!matchesExpected(current,expected))changed();
    lastOwnedFingerprint=current.fingerprint;
    if(writeFailed)throw new Error('A synthetic clipboard write failed after changing the clipboard.');
  };
  const stopHelper=async()=>{
    const child=getClipboardProcess()||ownedHelper;
    await actions['settings.save']({ocrAuto:false});
    assert(!getClipboardProcess(),'The application must detach its clipboard helper before restoration.');
    if(child){
      await limited(new Promise(resolve=>{
        if(child.exitCode!==null||child.signalCode!==null)return resolve();
        child.once('exit',resolve);
      }),'owned clipboard helper exit',6000);
      assert(child.exitCode!==null||child.signalCode!==null,'The owned clipboard helper has not exited.');
    }
    report.cleanup.helperStopped=true;
  };
  const makeImage=async(label,lines)=>{
    const dataUrl=await evaluate(async lines=>{
      await document.fonts.ready;
      const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=680;
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle='#171c24';context.textBaseline='top';
      lines.forEach((line,index)=>{context.font=(index===0?'bold 48':'38')+'px "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif';context.fillText(line,54,44+index*110);});
      return canvas.toDataURL('image/png');
    },lines);
    assert(dataUrl.startsWith('data:image/png;base64,'));
    const png=Buffer.from(dataUrl.slice('data:image/png;base64,'.length),'base64');
    const file=path.join(fixtureDir,label+'.png');
    await fs.writeFile(file,png);await fs.writeFile(path.join(fixtureDir,label+'-expected.txt'),lines.join('\n')+'\n');
    return{png,bitmap:bitmapFingerprint(png),text:'UFriend synthetic clipboard '+runId+' '+label+' '+randomUUID(),lines,file};
  };
  const recordOcr=async(label,expected,inferenceStarted)=>{
    const result=structuredClone(core.snapshot().ocr);
    assert.equal(result.status,'done','Real OCR must produce nonempty text.');
    assert.equal(result.progress,100);assert(Array.isArray(result.regions));
    assert(result.meta?.model&&result.meta?.backend,'Actual model metadata is required.');
    const rawFile=path.join(resultsDir,label+'-raw-result.json');
    const observation={durationMs:Date.now()-inferenceStarted,inputFile:expected.file,rawFile,
      model:result.meta,regionCount:result.regions.length,characters:result.text.length,
      exactTokens:Object.fromEntries(['15:00','12,500','18:30','3,600'].filter(token=>expected.lines.join('\n').includes(token)).map(token=>[token,result.text.includes(token)])),
      qualityVerdict:'Raw output retained for review; content accuracy is not inferred from integration success.'};
    await fs.writeFile(rawFile,JSON.stringify({expected:{lines:expected.lines,text:expected.lines.join('\n')},actual:result,observation},null,2)+'\n');
    await fs.writeFile(path.join(resultsDir,label+'-actual.txt'),result.text);
    report.ocr[label]=observation;
    await waitFor('OCR text reaches the renderer',()=>evaluate(text=>document.querySelector('#ocr-text')?.value===text&&!document.querySelector('#ocr-text').readOnly,result.text));
  };

  try{
    clipboard.read=guardedRead;guardInstalled=clipboard.read===guardedRead;
    assert(guardInstalled,'The synthetic-only input guard must be installed before any clipboard test.');
    await actions['settings.save']({ocrAuto:false});
    core.store.update(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,emptyState());});
    core.initialize();
    await actions['settings.save']({...DEFAULT_SETTINGS,localBackend:'pc-api',theme:'light',keepBackground:false,ocrAuto:false,devOcr:{endpoint}});
    win.webContents.setBackgroundThrottling(false);win.setSize(1200,980);
    await win.loadFile(path.join(projectDir,'app','index.html'));
    await waitFor('Initial renderer',()=>evaluate(()=>!!document.querySelector('[data-nav="ocr"]')));
    await evaluate(()=>document.querySelector('[data-nav="ocr"]').click());
    await waitFor('OCR view',()=>evaluate(()=>!!document.querySelector('#ocr-text')));

    await check('isolated profile and actual OCR service are ready before clipboard writes',async()=>{
      const health=await ipcCall('models.health',{kind:'ocr',endpoint});
      assert.equal(health.ready,true);assert.equal(health.apiVersion,'1');
      assert(health.model&&health.backend,'The health response must identify the real OCR model.');
      report.model=health;assert.equal(core.snapshot().settings.ocrAuto,false);
      originalSnapshot=await snapshot();restoreItems=prepareRestore(originalSnapshot);
      const again=await snapshot();
      if(again.fingerprint!==originalSnapshot.fingerprint)changed();
      report.cleanup.originalPreparedInMemory=true;
    });
    const manual=await makeImage('manual',[
      'UFriend 剪貼簿手動辨識測試',
      '繁體中文：臺灣團隊，請準時參加會議。',
      'Meeting reminder: please bring the project report.',
      '時間：15:00',
      '金額：12,500元',
    ]);
    const automatic=await makeImage('automatic',[
      'UFriend 剪貼簿自動辨識測試',
      '繁體中文：活動已確認，請攜帶報名資料。',
      'Event confirmation: please bring your registration.',
      '時間：18:30',
      '金額：3,600元',
    ]);

    await check('text copy awaits the actual write and text-only capture is harmless',async()=>{
      const expected={text:'UFriend synthetic text-only '+runId+' '+randomUUID()};
      await writeSynthetic(expected);
      let actual;try{actual=await readText();}catch{throw new Error('Cannot verify the synthetic text write.');}
      assert(actual===expected.text,'The text write must be complete before clipboard.write IPC resolves.');
      const assetCount=core.snapshot().assets.length;
      await assert.rejects(()=>ipcCall('ocr.capture'),error=>error.message.includes('剪貼簿目前沒有圖片'));
      assert.equal(core.snapshot().assets.length,assetCount);
      assert.equal(core.snapshot().ocr.imageId,null);assert.equal(core.active.size,0);
    });
    await check('actual PNG clipboard data completes manual capture and real OCR',async()=>{
      await writeSynthetic(manual);
      await limited(ipcCall('ocr.capture'),'manual PNG capture',15000);
      assert.equal(core.snapshot().ocr.status,'waiting-model');
      assert(core.snapshot().ocr.imageId,'Manual capture must create an isolated image asset.');
      const inferenceStarted=Date.now();
      await limited(ipcCall('ocr.start'),'real manual OCR');
      await recordOcr('manual',manual,inferenceStarted);
    });
    await check('Windows native image notification starts automatic real OCR',async()=>{
      const beforeImage=core.snapshot().ocr.imageId,beforeReads=report.syntheticReads;
      await ipcCall('settings.save',{ocrAuto:true});ownedHelper=getClipboardProcess();
      assert(ownedHelper&&Number.isInteger(ownedHelper.pid),'The application must own an actual native helper.');
      await waitFor('Native helper registers Windows notifications',()=>actions.bootstrap().clipboard.status==='listening');
      const inferenceStarted=Date.now();await writeSynthetic(automatic);
      await waitFor('Native event completes real OCR',()=>{
        const state=core.snapshot().ocr;
        if(state.imageId!==beforeImage&&['error','cancelled'].includes(state.status))fail('Automatic real OCR did not complete successfully.');
        return state.imageId!==beforeImage&&state.status==='done'&&!core.active.has('ocr');
      },180000);
      assert(report.syntheticReads>beforeReads,'The native event must reach the guarded Electron clipboard reader.');
      await recordOcr('automatic',automatic,inferenceStarted);
    });
    await check('disabling automatic capture waits for the owned helper to exit',async()=>{
      await stopHelper();
      assert.equal(core.snapshot().settings.ocrAuto,false);
      assert.equal(actions.bootstrap().clipboard.status,'disabled');
      const beforeImage=core.snapshot().ocr.imageId,beforeRevision=core.snapshot().ocr.revision,beforeReads=report.syntheticReads;
      await writeSynthetic({...manual,text:'UFriend synthetic disabled-listener '+runId+' '+randomUUID()});
      await pause(750);
      assert.equal(core.snapshot().ocr.imageId,beforeImage);assert.equal(core.snapshot().ocr.revision,beforeRevision);
      assert.equal(report.syntheticReads,beforeReads,'A stopped helper must not read the later test image.');
      assert.equal(core.active.size,0);
    });
    await check('the final OCR result remains visible in the account-free test profile',async()=>{
      assert.equal(core.snapshot().accounts.length,0);assert.equal(core.snapshot().messages.length,0);
      await evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      win.webContents.invalidate();await pause(150);
      const shot=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      assert(!shot.isEmpty());const file=path.join(resultsDir,'automatic-ocr-result.png');
      await fs.writeFile(file,shot.toPNG());report.screenshots.push({file,...shot.getSize()});
    });
    report.status='integration-passed';
  }catch(error){
    primaryError=error;report.status='failed';report.error={message:error.message};
  }finally{
    // Disable notifications and await the exact owned process before exposing any
    // original clipboard content again. Cancel only this fixture application's job.
    try{await stopHelper();}catch{report.cleanup.helperStopped=false;report.cleanup.helperError='The owned clipboard helper did not stop cleanly.';}
    try{
      if(core.active.has('ocr'))core.cancelOcr();
      await core.models.adapters.get('ocr')?.cancelAll?.();
    }catch{report.cleanup.ocrCancellationError='The isolated OCR request did not cancel cleanly.';}
    if(wroteClipboard&&originalSnapshot){
      if(!report.cleanup.helperStopped)report.cleanup.restore='skipped-helper-not-stopped';
      else{
        try{
          const current=await snapshot();
          // A write can commit and then reject, or its immediate verification
          // read can fail. The unique synthetic text marker plus exact bitmap
          // still prove ownership without accepting arbitrary clipboard data.
          const stillOwned=(lastOwnedFingerprint&&current.fingerprint===lastOwnedFingerprint)||matchesExpected(current,activeExpected);
          if(interference||!stillOwned){
            report.cleanup.restore='skipped-current-clipboard-changed';
          }else{
            if(restoreItems.length)await write(restoreItems);else clear();
            report.cleanup.restore='restored';
          }
        }catch{report.cleanup.restore='failed';report.cleanup.restoreError='The original clipboard could not be restored; no original payload details were recorded.';}
      }
    }else report.cleanup.restore='not-needed-no-test-write';
    // If a helper cannot be stopped, keep denying unverified input until the
    // enclosing smoke runner exits the process.
    if(report.cleanup.helperStopped&&guardInstalled&&clipboard.read===guardedRead)clipboard.read=originalRead;
    originalSnapshot=null;restoreItems=null;activeExpected=null;lastOwnedFingerprint=null;
    if(!report.cleanup.helperStopped||report.cleanup.restore==='failed'||report.cleanup.ocrCancellationError){
      report.status='failed';primaryError??=new Error('Clipboard smoke cleanup did not complete; inspect the synthetic-only report.');
    }
    report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-started;
    await checkpoint();
  }
  if(primaryError)throw primaryError;
  console.log('CLIPBOARD SMOKE COMPLETE: integration passed; '+report.cleanup.restore+'.');
  return report;
}

module.exports=run;
module.exports.run=run;

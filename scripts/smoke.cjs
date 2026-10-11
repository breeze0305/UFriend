'use strict';

// Runs inside the application's hidden Electron window, against isolated fixtures.
// No account, network, file dialog, OS clipboard, or model inference is exercised.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {emptyState} = require('../app/services/store.cjs');
const {DEFAULT_SETTINGS} = require('../app/services/core.cjs');
const {resolveVideoFfmpegPath} = require('../app/services/video-runtime.cjs');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const projectDir = path.resolve(__dirname, '..');
const fixtureFfmpeg=process.env.UFRIEND_TEST_FFMPEG||resolveVideoFfmpegPath({projectRoot:projectDir});

function silentWav(seconds = 3) {
  const rate = 8000, bytes = rate * seconds * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  return wav;
}

function fixtureMail({subject, body, attachment = false}) {
  const headers = [
    'From: UFriend Test <sender@example.invalid>',
    'To: Local Test <recipient@example.invalid>',
    'Date: ' + new Date().toUTCString(),
    'Subject: ' + subject,
    'Message-ID: <' + (attachment ? 'attachment' : 'followup') + '@ufriend.invalid>',
    'MIME-Version: 1.0'
  ];
  const text = ['Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')];
  if (!attachment) return [...headers, ...text].join('\r\n') + '\r\n';
  return [...headers, 'Content-Type: multipart/mixed; boundary="ufriend-smoke"', '',
    '--ufriend-smoke', ...text, '--ufriend-smoke',
    'Content-Type: text/plain; charset=UTF-8; name="smoke-note.txt"',
    'Content-Disposition: attachment; filename="smoke-note.txt"',
    'Content-Transfer-Encoding: base64', '',
    Buffer.from('自製測試附件。\nUFriend smoke fixture.').toString('base64'),
    '--ufriend-smoke--', ''].join('\r\n');
}

function fixtureHtmlMail({subject,body,html,logo,inlineImages=[]}) {
  const encoded=value=>Buffer.from(value).toString('base64');
  return [
    'From: Synthetic Air <sender@example.invalid>','To: Local Test <recipient@example.invalid>',
    'Date: '+new Date().toUTCString(),'Subject: '+subject,'Message-ID: <'+encoded(subject)+'@ufriend.invalid>',
    'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="html-smoke-mixed"','',
    '--html-smoke-mixed','Content-Type: multipart/related; boundary="html-smoke-related"','',
    '--html-smoke-related','Content-Type: multipart/alternative; boundary="html-smoke-alternative"','',
    '--html-smoke-alternative','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',encoded(body),
    '--html-smoke-alternative','Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',encoded(html),
    '--html-smoke-alternative--','',
    '--html-smoke-related','Content-Type: image/png; name="smoke-logo.png"','Content-Disposition: inline; filename="smoke-logo.png"',
    'Content-ID: <smoke-logo@ufriend.invalid>','Content-Transfer-Encoding: base64','',encoded(logo),
    ...inlineImages.flatMap((image,index)=>['--html-smoke-related','Content-Type: image/png; name="smoke-inline-'+index+'.png"',
      'Content-Disposition: inline; filename="smoke-inline-'+index+'.png"','Content-ID: <'+image.id+'>','Content-Transfer-Encoding: base64','',encoded(image.content)]),
    '--html-smoke-related--','',
    '--html-smoke-mixed','Content-Type: text/plain; charset=UTF-8; name="html-note.txt"',
    'Content-Disposition: attachment; filename="html-note.txt"','Content-Transfer-Encoding: base64','',encoded('Synthetic HTML mail attachment.'),
    '--html-smoke-mixed--',''
  ].join('\r\n');
}

async function run({app, win, core, actions, dataDir, diagnostics, videoExports, mediaRuntime}) {
  const filter=process.argv.find(value=>value.startsWith('--smoke-filter='))?.slice('--smoke-filter='.length)||'';
  const testRoot = path.join(projectDir, '.test-data', 'smoke');
  assert(process.argv.includes('--smoke-test'), 'Smoke requires --smoke-test.');
  assert.equal(path.resolve(app.getPath('userData')), testRoot,
    'Smoke may only use the dedicated .test-data/smoke directory.');
  assert.equal(path.resolve(dataDir), path.join(testRoot, 'workspace'));
  assert.equal(core.snapshot().accounts.length, 0,
    'Refusing to reset a test workspace containing account records.');
  const resultsDir = path.join(projectDir, '.test-results');
  const fixtureDir = path.join(testRoot, 'fixtures');
  await fs.mkdir(resultsDir, {recursive: true});
  await fs.mkdir(fixtureDir, {recursive: true});

  const report = {startedAt: new Date().toISOString(), electron: process.versions.electron,
    dataDir, status: 'running', checks: [], screenshots: [], rendererErrors: []};
  win.webContents.setBackgroundThrottling(false);
  const evaluate = async (fn, ...args) => {
    const result=await win.webContents.executeJavaScript(
      `(async()=>{try{return{ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})};}catch(error){return{ok:false,message:error.message,stack:error.stack};}})()`,true);
    if(!result.ok)throw new Error(result.message+'\n'+result.stack);
    return result.value;
  };
  const ipcCall = (name, args = {}) => evaluate(async (name, args) => {
    const response = await window.ufriend.request(name, args);
    if (!response.ok) {
      const error = new Error(response.error?.message || 'IPC request failed.');
      error.code = response.error?.code || 'ACTION_FAILED';
      throw error;
    }
    return response.value;
  }, name, args);
  const waitFor = async (description, predicate, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    do {
      if (await predicate()) return;
      await pause(40);
    } while (Date.now() < deadline);
    const ui = await evaluate(() => ({title: document.querySelector('#mf-top')?.innerText,
      page: document.querySelector('#mf-page')?.innerText.slice(0, 3000),
      modal: document.querySelector('#mf-overlay')?.innerText.slice(0, 1500),
      toast: document.querySelector('#mf-toast')?.innerText}));
    throw new Error(`Timed out: ${description}\n${JSON.stringify(ui, null, 2)}`);
  };
  const uiWait = (description, fn, ...args) => waitFor(description, () => evaluate(fn, ...args));
  const click = selector => evaluate(selector => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('Missing control: ' + selector);
    if (el.disabled) throw new Error('Disabled control: ' + selector);
    if ((el.closest('[data-settings-panel]') || el.matches('[data-settings-tab]')) && !el.checkVisibility()) throw new Error('Hidden settings control: ' + selector);
    el.scrollIntoView({block: 'nearest'}); el.focus(); el.click();
  }, selector);
  const setValue = (selector, value, event = 'input') => evaluate((selector, value, event) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('Missing input: ' + selector);
    if (el.closest('[data-settings-panel]') && !el.checkVisibility()) throw new Error('Hidden settings input: ' + selector);
    el.focus(); el.value = value; el.dispatchEvent(new Event(event, {bubbles: true}));
  }, selector, value, event);
  const nav = async view => {
    await click(`[data-nav="${view}"]`);
    await uiWait('Navigate to ' + view, view =>
      !!document.querySelector(`[data-nav="${view}"][aria-current="page"]`) &&
      document.querySelector('#mf-overlay').hidden, view);
  };
  const settingsKeys=['general','profile','mail','models','prompts','diagnostics'];
  const settingsCategory=async key=>{
    assert(settingsKeys.includes(key),'Unknown settings category: '+key);
    if(!await evaluate(()=>document.querySelector('#mf-page')?.dataset.view==='settings'))await nav('settings');
    await uiWait('Settings category control is visible: '+key,key=>document.querySelector('[data-settings-tab="'+key+'"]')?.checkVisibility(),key);
    await click('[data-settings-tab="'+key+'"]');
    await uiWait('Settings category is selected and visible: '+key,key=>{
      const tab=document.querySelector('[data-settings-tab="'+key+'"]'),panel=document.querySelector('[data-settings-panel="'+key+'"]');
      return tab?.getAttribute('role')==='tab'&&tab.getAttribute('aria-selected')==='true'&&panel?.getAttribute('role')==='tabpanel'&&!panel.hidden&&panel.checkVisibility()&&tab.getAttribute('aria-controls')===panel.id;
    },key);
  };
  const closeModal = async () => {
    await click('#mf-overlay [data-action="modal-close"]');
    await uiWait('Close dialog', () => document.querySelector('#mf-overlay').hidden);
  };
  const screenshot = async name => {
    win.webContents.invalidate();
    await evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await pause(150);
    const shot = await win.webContents.capturePage(undefined, {stayHidden: true, stayAwake: true});
    assert(!shot.isEmpty(), 'Screenshot should contain the rendered app.');
    const file = path.join(resultsDir, 'smoke-' + name + '.png');
    await fs.writeFile(file, shot.toPNG());
    report.screenshots.push({name, file, ...shot.getSize()});
  };
  const check = async (name, callback) => {
    if(filter&&!name.includes(filter))return;
    const started = Date.now();
    report.currentCheck=name;
    await callback();
    report.checks.push({name, passed: true, durationMs: Date.now() - started});
    console.log('SMOKE PASS ' + name);
  };
  const rendererConsole = (_event, details) => {
    if (details && typeof details === 'object' && details.level === 'error') {
      report.rendererErrors.push({message: details.message, source: details.sourceId, line: details.lineNumber});
    }
  };
  win.webContents.on('console-message', rendererConsole);
  win.webContents.on('render-process-gone', (_event, details) => report.rendererErrors.push(details));
  let recordingId, draftId, importedMail;

  try {
    // Reset only this guarded fixture database. Existing generated files are retained.
    core.store.update(draft => {
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, emptyState());
    });
    core.initialize();
    core.startRecordingScheduler();
    // This guarded fixture profile can outlive the Windows encryption context.
    // Preserve an unreadable fake vault and reset it before exercising isolated UI.
    if(actions.bootstrap().secrets.error)await actions['secrets.reset']({});
    await actions['settings.save']({...DEFAULT_SETTINGS, localBackend: 'ugen300', theme: 'light', keepBackground: false});
    await win.loadFile(path.join(projectDir, 'app', 'index.html'));
    await uiWait('Initial renderer bootstrap', () => document.querySelector('#mf-top h1')?.textContent === '首頁');
    await evaluate(() => {
      window.__smokeErrors = [];
      window.addEventListener('error', event => window.__smokeErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason?.message || event.reason)));
    });

    await check('empty initial workspace', async () => {
      assert.equal(await evaluate(() => document.querySelector('.mf-count')?.textContent), '0');
      assert.equal(await evaluate(() => document.querySelectorAll('[data-action="open-mail"]').length), 0);
      assert(['llm','ocr','whisper'].every(kind => core.snapshot().models.sources.local[kind].configured === false));
      await screenshot('01-empty-home');
      await nav('inbox');
      await uiWait('Empty inbox', () => document.querySelector('#mf-page').innerText.includes('目前沒有符合條件的郵件'));
    });

    await check('media runtime settings show installation progress and retain localized failure and completion feedback', async()=>{
      const originalSnapshot=mediaRuntime.snapshot,originalInstall=actions['mediaRuntime.install'];
      const state={available:true,installed:false,installing:false,error:''};
      let finish,attempts=0;
      mediaRuntime.snapshot=()=>({...state});
      actions['mediaRuntime.install']=async args=>{
        assert.equal(args.mode,'download');attempts++;state.installing=true;state.error='';mediaRuntime.onChange();
        await new Promise(resolve=>{finish=resolve;});state.installing=false;
        if(attempts===1){state.error='找不到 7-Zip。請先安裝 7-Zip，或選擇已解壓的官方 FFmpeg 套件。';mediaRuntime.onChange();throw new Error(state.error);}
        state.installed=true;mediaRuntime.onChange();return{installed:true};
      };
      try{
        mediaRuntime.onChange();await nav('settings');await settingsCategory('general');
        await uiWait('Media installer buttons available',()=>document.querySelector('[data-action="media-runtime-download"]')?.disabled===false);
        await click('[data-action="media-runtime-download"]');
        await uiWait('Media install progress',()=>document.querySelector('#media-runtime-status')?.textContent.includes('正在下載')&&document.querySelector('[data-action="media-runtime-folder"]').disabled);
        assert.equal(attempts,1);finish();
        await uiWait('Missing extractor guidance',()=>document.querySelector('#media-runtime-settings [role="alert"]')?.textContent.includes('7-Zip')&&!document.querySelector('[data-action="media-runtime-download"]').disabled);
        await click('[data-action="media-runtime-download"]');
        await uiWait('Second media install progress',()=>document.querySelector('#media-runtime-status')?.textContent.includes('正在下載'));
        finish();await uiWait('Media runtime ready',()=>document.querySelector('#media-runtime-status')?.textContent==='影音元件已就緒。'&&document.querySelector('[data-action="media-runtime-download"]').disabled);
        await actions['settings.save']({uiLanguage:'en'});
        await uiWait('English media runtime controls',()=>document.querySelector('#media-runtime-status')?.textContent==='The media runtime is ready.'&&document.querySelector('[data-action="media-runtime-help"]')?.textContent.includes('Media runtime instructions'));
        state.bundled=true;mediaRuntime.onChange();
        await uiWait('Bundled runtime needs no installation controls',()=>document.querySelector('#media-runtime-status')?.textContent==='The media runtime is included. No separate installation is needed.'&&!document.querySelector('[data-action="media-runtime-download"]')&&!document.querySelector('[data-action="media-runtime-folder"]')&&!document.querySelector('#media-runtime-settings')?.textContent.includes('7-Zip'));
        await actions['settings.save']({uiLanguage:'zh-TW'});
        await uiWait('Bundled runtime Chinese status',()=>document.querySelector('#media-runtime-status')?.textContent==='影音元件已內建，無需另外安裝。');
      }finally{
        finish?.();mediaRuntime.snapshot=originalSnapshot;actions['mediaRuntime.install']=originalInstall;
        await actions['settings.save']({uiLanguage:'zh-TW'});mediaRuntime.onChange();
      }
    });

    await check('event model sources remain independent across configuration, requests and meeting queues',async()=>{
      await require('./source-smoke.cjs')({core,actions,win,projectDir,fixtureDir,silentWav,nav,click,setValue,evaluate,waitFor,uiWait,screenshot,settingsCategory,closeModal});
    });

    await check('settings data cleanup confirms each scope and safely clears isolated files, chats and logs', async () => {
      const saved=structuredClone(core.store.read()),size=win.getSize(),originalClear=actions['data.clear'],originalRun=core.models.run;
      const originalIngest=core.ingestAsset,originalDiagnosticClear=diagnostics.clear,requests=[],work=[],clearCalls=[];
      const filesDir=path.join(dataDir,'files'),sourceFiles=[0,1,2,3].map(index=>path.join(fixtureDir,'cleanup-synthetic-'+index+'.wav'));
      const videoSource=path.join(fixtureDir,'cleanup-preserved-video.mp4'),mailSource=path.join(fixtureDir,'cleanup-preserved-mail.eml');
      const diagnosticSentinel=path.join(diagnostics.directory,'cleanup-preserved-note.txt');let releaseImport;
      const track=promise=>{work.push(promise);return promise;};
      const assertIsolated=async()=>{
        assert.equal(path.resolve(dataDir),path.join(testRoot,'workspace'));assert.equal(core.store.read().accounts.length,0);
        assert.equal(path.resolve(diagnostics.directory),path.join(dataDir,'diagnostics'));
        const realProject=await fs.realpath(projectDir);
        for(const directory of [path.join(projectDir,'.test-data'),testRoot,dataDir,fixtureDir,filesDir,diagnostics.directory]){
          const expected=path.join(realProject,path.relative(projectDir,directory));
          const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
          if(!stat)await fs.mkdir(directory);
          const actual=stat||await fs.lstat(directory);
          assert(actual.isDirectory()&&!actual.isSymbolicLink(),'Cleanup fixtures require ordinary directories: '+directory);
          assert.equal((await fs.realpath(directory)).toLowerCase(),expected.toLowerCase(),'Cleanup may not follow redirected fixture directories.');
        }
        for(const directory of [filesDir,diagnostics.directory])for(const name of await fs.readdir(directory)){
          const file=path.join(directory,name),stat=await fs.lstat(file);
          assert(stat.isFile()&&!stat.isSymbolicLink(),'Cleanup fixtures may not contain redirected or non-file entries.');
          assert.equal((await fs.realpath(file)).toLowerCase(),path.join(await fs.realpath(directory),name).toLowerCase());
        }
      };
      const diskState=async()=>Promise.all([core.store.file,core.store.backup].map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));
      const openCleanup=async target=>{
        await settingsCategory('general');
        await uiWait('Cleanup becomes available after pending work: '+target,target=>{const button=document.querySelector('[data-action="clear-data"][data-target="'+target+'"]');return button&&!button.disabled;},target);
        await click('[data-action="clear-data"][data-target="'+target+'"]');
        await uiWait('Cleanup confirmation opens for '+target,()=>!!document.querySelector('[data-action="confirm-clear-data"]')&&!document.querySelector('#mf-overlay').hidden);
        assert(await evaluate(()=>/無法(?:從程式)?復原|不可復原/.test(document.querySelector('#mf-overlay').textContent)),'Destructive confirmation must explain that deletion cannot be undone.');
        assert.equal(await evaluate(()=>document.activeElement?.dataset.action),'cancel-clear-data','Confirmation initially focuses its cancel control.');
      };
      const confirmed=async()=>{
        await click('[data-action="confirm-clear-data"]');
        await uiWait('Successful cleanup closes its confirmation',()=>document.querySelector('#mf-overlay').hidden);
      };
      try{
        assert.equal(typeof originalClear,'function');assert.equal(typeof originalDiagnosticClear,'function');
        assert.equal(saved.recordings.length,0);assert.equal(saved.assets.length,0,'Cleanup runs before other scenarios own managed files.');
        await assertIsolated();
        actions['data.clear']=async args=>{
          assert(['media','chat','logs'].includes(args?.target),'Cleanup may only use one explicitly named fixture scope.');
          await assertIsolated();clearCalls.push(structuredClone(args));return originalClear(args);
        };
        core.models.run=(kind,request)=>{
          assert((kind==='llm'&&request.task==='chat')||(kind==='whisper'&&request.task==='transcribe'),'Only synthetic chat/transcription work is permitted.');
          return new Promise((resolve,reject)=>requests.push({kind,...request,resolve,reject}));
        };
        for(let index=0;index<sourceFiles.length;index++)await fs.writeFile(sourceFiles[index],silentWav(index+3));
        await fs.writeFile(videoSource,Buffer.from('Synthetic video retention sentinel; never decoded or played.'));
        await fs.writeFile(mailSource,fixtureMail({subject:'Synthetic cleanup preserved mail',body:'Synthetic mail survives each cleanup.',attachment:true}));
        const imported=await core.importMedia([...sourceFiles.slice(0,3),videoSource],'en');assert.deepEqual(imported.errors,[]);
        const [runningId,completedId,orphanId,videoId]=imported.imported;
        core.saveTranscript(completedId,{format:'txt',text:'SYNTHETIC_AUDIO_TRANSCRIPT_TO_DELETE'});
        core.removeRecording(orphanId);
        await core.importMails([mailSource]);
        const ocrAsset=await core.ingestBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVn8AAAAASUVORK5CYII=','base64'),{name:'cleanup-preserved-ocr.png'});
        await core.setOcrImage(ocrAsset);core.saveOcrText('Synthetic OCR text survives cleanup.');
        const completedChat=track(core.sendChat('SYNTHETIC_CHAT_SAVED_QUESTION'));
        await waitFor('Synthetic saved chat request',()=>requests.some(request=>request.kind==='llm'));
        requests.find(request=>request.kind==='llm').resolve({text:'SYNTHETIC_CHAT_SAVED_ANSWER'});await completedChat;core.newChat();
        const pendingChat=track(core.sendChat('SYNTHETIC_CHAT_PENDING_QUESTION'));
        const pendingRecording=track(core.runRecording(runningId));
        await waitFor('Synthetic running chat and audio work',()=>requests.filter(request=>request.kind==='llm').length===2&&requests.some(request=>request.kind==='whisper'));
        const chatRequest=requests.filter(request=>request.kind==='llm')[1],recordingRequest=requests.find(request=>request.kind==='whisper');
        chatRequest.onDelta('SYNTHETIC_CHAT_PARTIAL');await waitFor('Synthetic chat has an unfinished stream',()=>core.snapshot().chat.partialText==='SYNTHETIC_CHAT_PARTIAL');
        core.store.appendLog('SYNTHETIC_SYSTEM_LOG_TO_DELETE');
        await diagnostics.write({event:'smoke.cleanup.before'});
        await fs.writeFile(diagnostics.fileAt(9),JSON.stringify({event:'smoke.cleanup.old.rotation'})+'\n');
        await fs.writeFile(diagnosticSentinel,'Synthetic diagnostic sibling must survive.');
        const retainedState=structuredClone(core.store.read()),retainedFiles=new Map();
        for(const asset of retainedState.assets.filter(asset=>asset.category!=='recording'||asset.id===retainedState.recordings.find(recording=>recording.id===videoId).assetId)){
          const file=core.asset(asset.id).path;retainedFiles.set(file,await fs.readFile(file));
        }
        const originalBytes=new Map();for(const file of [...sourceFiles,videoSource,mailSource])originalBytes.set(file,await fs.readFile(file));
        win.webContents.send('ufriend:change',actions.bootstrap());await settingsCategory('general');
        await uiWait('All three cleanup counts are shown',()=>['media','chat','logs'].every(target=>document.querySelector('#data-cleanup-count-'+target)?.checkVisibility()&&document.querySelector('#data-cleanup-count-'+target).textContent.trim()));
        const info=await ipcCall('data.cleanupInfo');
        assert(!info.busy);assert.equal(info.media.includeVideo,false);
        assert.deepEqual({records:info.media.records,files:info.media.files,running:info.media.running,importing:info.media.importing},{records:2,files:3,running:1,importing:false});
        assert.deepEqual({conversations:info.chat.conversations,messages:info.chat.messages,running:info.chat.running},{conversations:2,messages:2,running:true});
        assert.equal(info.logs.entries,core.store.read().logs.length);assert(info.logs.files>=2);
        assert.equal(await evaluate(()=>document.querySelectorAll('[data-action="clear-data"]').length),3);
        assert.equal(await evaluate(()=>document.querySelector('#data-cleanup-count-media').textContent),'2 個音檔項目 · 3 份檔案副本');
        assert.equal(await evaluate(()=>document.querySelector('#data-cleanup-count-chat').textContent),'2 個對話 · 2 則訊息');
        await setValue('#preferred-language','ja','change');
        for(const theme of ['light','dark'])for(const [width,height]of [[1080,820],[640,480]]){
          win.setSize(width,height);await actions['settings.save']({theme});await settingsCategory('general');
          await uiWait('Cleanup visual theme updates',theme=>document.querySelector('#ufriend-app').style.colorScheme===theme,theme);
          assert(await evaluate(()=>['#ufriend-app','#mf-page','#settings-content'].every(selector=>{const el=document.querySelector(selector);return el.scrollWidth<=el.clientWidth+1;})),'Cleanup cards must not cause horizontal overflow.');
          for(const target of ['media','chat','logs'])assert(await evaluate(target=>{
            const button=document.querySelector('[data-action="clear-data"][data-target="'+target+'"]');button.scrollIntoView({block:'nearest'});
            const r=button.getBoundingClientRect(),content=document.querySelector('#settings-content').getBoundingClientRect();
            return r.left>=content.left-1&&r.right<=content.right+1&&r.top>=content.top-1&&r.bottom<=content.bottom+1;
          },target),'Every cleanup control is reachable at the current window size.');
          await evaluate(()=>document.querySelector('#data-cleanup-settings').scrollIntoView({block:'start'}));
          await screenshot('42-data-cleanup-cards-'+width+'x'+height+'-'+theme);
          await openCleanup('logs');
          assert(await evaluate(()=>['.mf-dialog','.mf-dialogbody','.mf-dialogfoot'].every(selector=>{const el=document.querySelector(selector);return el.scrollWidth<=el.clientWidth+1;})),'Cleanup dialogs must not overflow horizontally.');
          await screenshot('42-data-cleanup-dialog-'+width+'x'+height+'-'+theme);
          await click('[data-action="cancel-clear-data"]');await uiWait('Visual-only cleanup confirmation is cancelled',()=>document.querySelector('#mf-overlay').hidden);
        }
        win.setSize(...size);await actions['settings.save']({theme:'light'});
        for(const target of ['media','chat','logs']){
          const before=core.store.read(),calls=clearCalls.length;await diagnostics.flush();
          const diagnosticBefore=await fs.readFile(diagnostics.file);
          await openCleanup(target);await click('[data-action="cancel-clear-data"]');
          await uiWait('Cancelling '+target+' cleanup closes only its confirmation',()=>document.querySelector('#mf-overlay').hidden);
          assert.equal(clearCalls.length,calls,'Cancel must never invoke destructive IPC.');assert.deepEqual(core.store.read(),before);
          assert.deepEqual(await fs.readFile(diagnostics.file),diagnosticBefore);
        }
        for(const target of ['media','chat','logs']){
          const before=core.store.read();
          await assert.rejects(ipcCall('data.clear',{target}),error=>/確認/.test(error.message),'Direct IPC must require explicit confirmation.');
          assert.deepEqual(core.store.read(),before);
        }
        // Hold the real import before its managed copy is created. The backend
        // must refuse deletion while this operation can still add an audio file.
        core.ingestAsset=async function(source,options){
          assert.equal(source,sourceFiles[3]);await new Promise(resolve=>{releaseImport=resolve;});
          return originalIngest.call(this,source,options);
        };
        const pendingImport=track(core.importMedia([sourceFiles[3]],'en'));
        await waitFor('Synthetic audio import is pending',()=>!!releaseImport&&core.mediaImports>0);
        const beforeBusy=core.store.read(),busyResponse=await evaluate(()=>window.ufriend.request('data.clear',{target:'media',confirmed:true}));
        assert.equal(busyResponse.ok,false);assert.equal(busyResponse.error.code,'MEDIA_BUSY');
        assert.deepEqual(core.store.read(),beforeBusy);assert.equal(chatRequest.signal.aborted,false);assert.equal(recordingRequest.signal.aborted,false);
        releaseImport();releaseImport=null;const lateImport=await pendingImport;core.ingestAsset=originalIngest;assert.equal(lateImport.imported.length,1);
        const audioAssets=core.store.read().assets.filter(asset=>asset.category==='recording'&&asset.file.endsWith('.wav'));
        const audioFiles=audioAssets.map(asset=>core.asset(asset.id).path),chatBeforeMedia=structuredClone({chat:core.store.read().chat,chatHistory:core.store.read().chatHistory});
        await openCleanup('media');await screenshot('43-data-cleanup-audio-confirm');await confirmed();
        assert.equal(recordingRequest.signal.aborted,true);assert.equal(chatRequest.signal.aborted,false);
        recordingRequest.onProgress?.(90,{processedSeconds:2,durationSeconds:3});
        recordingRequest.resolve({segments:[{start:0,end:1,text:'LATE_TRANSCRIPT_MUST_NOT_RETURN'}],language:'en',duration:3});await pendingRecording;
        assert.deepEqual(core.store.read().recordings.map(recording=>recording.id),[videoId]);
        for(const file of audioFiles)await assert.rejects(fs.stat(file),error=>error.code==='ENOENT');
        assert.deepEqual({chat:core.store.read().chat,chatHistory:core.store.read().chatHistory},chatBeforeMedia);
        assert(core.store.read().logs.some(entry=>entry.text==='SYNTHETIC_SYSTEM_LOG_TO_DELETE'));
        for(const state of await diskState()){
          assert.deepEqual(state.recordings.map(recording=>recording.id),[videoId]);
          assert(!JSON.stringify(state.recordings).includes('SYNTHETIC_AUDIO_TRANSCRIPT_TO_DELETE'));
          assert(!state.assets.some(asset=>audioAssets.some(deleted=>deleted.id===asset.id)));
        }
        await actions['settings.save']({theme:'dark'});win.setSize(640,480);
        await openCleanup('chat');await screenshot('44-data-cleanup-chat-compact-dark');
        assert(await evaluate(()=>['.mf-dialog','.mf-dialogbody','.mf-dialogfoot'].every(selector=>{const el=document.querySelector(selector);return el.scrollWidth<=el.clientWidth+1;})),'Cleanup confirmation fits the minimum window.');
        const oldConversationIds=core.store.read().chatHistory.conversations.map(entry=>entry.id);await confirmed();
        assert.equal(chatRequest.signal.aborted,true);chatRequest.onDelta('LATE_CHAT_DELTA_MUST_NOT_RETURN');chatRequest.resolve({text:'LATE_CHAT_ANSWER_MUST_NOT_RETURN'});await pendingChat;
        const emptyChat=state=>state.chatHistory.conversations.length===1&&!oldConversationIds.includes(state.chatHistory.activeId)&&state.chat.messages.length===0&&state.chat.draft===''&&state.chat.pendingText===''&&state.chat.status==='idle';
        assert(emptyChat(core.store.read()));assert.equal(core.snapshot().chat.partialText,'');
        for(const state of await diskState()){assert(emptyChat(state));assert(!JSON.stringify({chat:state.chat,history:state.chatHistory}).includes('SYNTHETIC_CHAT_'));}
        assert.deepEqual(core.store.read().recordings.map(recording=>recording.id),[videoId]);
        assert(core.store.read().logs.some(entry=>entry.text==='SYNTHETIC_SYSTEM_LOG_TO_DELETE'));
        await actions['settings.save']({theme:'light'});win.setSize(...size);
        await openCleanup('logs');
        diagnostics.clear=async()=>{throw Object.assign(new Error('合成診斷清理失敗，請重試。'),{code:'SMOKE_CLEANUP_FAILURE'});};
        await click('[data-action="confirm-clear-data"]');
        await uiWait('A failed cleanup stays open with an actionable inline error',()=>!document.querySelector('#mf-overlay').hidden&&document.querySelector('#data-cleanup-error')?.textContent.includes('合成診斷清理失敗')&&document.querySelector('[data-action="confirm-clear-data"]')?.disabled===false);
        await screenshot('45-data-cleanup-error');diagnostics.clear=originalDiagnosticClear;
        // The same confirmation can retry after failure, and diagnostics remain
        // writable after their previously retained files have been removed.
        await diagnostics.write({event:'smoke.cleanup.before.retry'});await confirmed();await diagnostics.flush();
        assert.deepEqual(core.store.read().logs,[]);for(const state of await diskState())assert.deepEqual(state.logs,[]);
        for(let index=0;index<10;index++)await assert.rejects(fs.stat(diagnostics.fileAt(index)),error=>error.code==='ENOENT');
        assert.equal(await fs.readFile(diagnosticSentinel,'utf8'),'Synthetic diagnostic sibling must survive.');
        await diagnostics.write({event:'smoke.cleanup.after'});assert.deepEqual((await diagnostics.export()).entries.map(entry=>entry.event),['smoke.cleanup.after']);
        for(const [file,bytes]of [...retainedFiles,...originalBytes])assert.deepEqual(await fs.readFile(file),bytes,'Cleanup must preserve other targets and source files.');
        assert.deepEqual(core.store.read().messages,retainedState.messages);assert.deepEqual(core.store.read().ocr,retainedState.ocr);assert(emptyChat(core.store.read()));
        assert.equal(await evaluate(()=>document.querySelector('#preferred-language').value),'ja','Cleanup refresh must preserve an unsaved settings field.');
        await nav('chat');await uiWait('Cleared chat renders one fresh empty conversation',()=>document.querySelector('#chat-input')?.value===''&&document.querySelectorAll('.mf-chat-message').length===0&&document.querySelector('[data-action="chat-new"]')?.disabled===true);
        win.webContents.reload();await uiWait('Renderer reloads after cleanup',()=>document.querySelector('#mf-page')?.dataset.view==='home');
        await nav('chat');assert(emptyChat(core.store.read()));assert.equal(await evaluate(()=>document.querySelectorAll('.mf-chat-message').length),0);
        report.dataCleanup={targets:['media','chat','logs'],deletedAudioFiles:audioFiles.length,preservedVideoRecords:1,confirmations:clearCalls.filter(call=>call.confirmed===true).length,cancelledDialogs:3,lateWorkIgnored:true,backupVerified:true};
      }finally{
        if(releaseImport){releaseImport();releaseImport=null;}
        core.ingestAsset=originalIngest;diagnostics.clear=originalDiagnosticClear;actions['data.clear']=originalClear;
        core.cancelChat();for(const [key,controller]of core.active)if(key.startsWith('recording:')){controller.abort();core.active.delete(key);}
        for(const request of requests)request.resolve(request.kind==='llm'?{text:'Synthetic cleanup completion'}:{segments:[],language:'en',duration:3});
        await Promise.allSettled(work);await diagnostics.flush();core.models.run=originalRun;win.setSize(...size);
        await nav('home').catch(()=>{});
        core.store.purge(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,saved);});
        win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('unconfigured Gmail opens setup guidance without starting OAuth', async () => {
      assert.equal(actions.bootstrap().gmailAuth.configured, false,
        'The smoke source build must use its empty bundled Gmail configuration.');
      const originalConnect = actions['gmail.connect'];
      const originalSize = win.getSize();
      let connectCalls = 0;
      actions['gmail.connect'] = () => {
        connectCalls++;
        throw Object.assign(new Error('Real Google OAuth is forbidden in smoke tests.'), {code: 'SMOKE_EXTERNAL_AUTH_BLOCKED'});
      };
      try {
        await nav('home');
        assert.equal(await evaluate(() => {
          const button=document.querySelector('#mf-page [data-action="mail-settings"]');
          return button?.textContent==='連接信箱'&&button.classList.contains('mf-primary')&&
            !document.querySelector('#mf-page .mf-google-button');
        }), true, 'The empty home uses a themed mailbox-settings button rather than a Google sign-in button.');
        await click('#mf-page [data-action="mail-settings"]');
        await uiWait('Home mailbox button opens settings', () =>
          document.querySelector('#mf-top h1')?.textContent==='設定'&&document.querySelector('#mf-overlay').hidden&&document.querySelector('[data-settings-tab="mail"]')?.getAttribute('aria-selected')==='true'&&document.querySelector('[data-settings-panel="mail"]')?.checkVisibility());
        assert.equal(connectCalls,0,'Opening mailbox settings must not start authorization.');
        await click('#gmail-settings [data-action="connect-gmail"]');
        await uiWait('First-time Gmail help opens', () => document.querySelector('#dialog-title')?.textContent === '啟用 Gmail 連接');
        assert.equal(connectCalls, 0, 'An unconfigured Google button must not call Gmail authorization.');
        assert.equal(await evaluate(() => document.querySelectorAll('#mf-overlay input').length), 0,
          'First-time guidance must not present raw credential fields.');
        assert.equal(await evaluate(() => document.querySelectorAll('#mf-overlay .mf-setup-steps li').length), 4);
        assert.equal(await evaluate(() => document.querySelector('#mf-overlay').innerText.includes('Client ID')), false);
        win.setSize(640, 480);
        await uiWait('Setup dialog uses the minimum viewport', () => window.innerWidth <= 640 && window.innerHeight <= 480);
        assert.equal(await evaluate(() => ['.mf-dialog', '.mf-dialogbody', '.mf-dialogfoot'].every(selector => {
          const el = document.querySelector(selector);
          return el.scrollWidth <= el.clientWidth + 1;
        })), true, 'Gmail setup guidance must not overflow horizontally at minimum window size.');
        await screenshot('15-setup-help');
        await closeModal();
        await settingsCategory('mail');
        assert.equal(await evaluate(() => document.querySelector('#gmail-advanced').open), false);
        assert.equal(await evaluate(() => document.querySelector('#gmail-client-id').checkVisibility()), false);
        assert.equal(await evaluate(() => ['#gmail-days', '#gmail-interval'].every(selector => {
          const el = document.querySelector(selector);
          return !!el.closest('.mf-gmail-sync') && !el.closest('#gmail-advanced');
        })), true, 'Sync preferences must be independent from developer credentials.');
        await nav('inbox');
      } finally {
        actions['gmail.connect'] = originalConnect;
        win.setSize(...originalSize);
      }
    });

    await check('themed home actions and runtime sync loading recover after completion and errors', async () => {
      const originalBootstrap=actions.bootstrap,originalSync=actions['gmail.sync'];
      const snapshot=structuredClone(originalBootstrap()),syncCalls=[];
      const fakeId='gmail:sync-smoke@example.invalid';
      snapshot.settings.theme='dark';
      snapshot.messages=[];
      snapshot.accounts=[{id:fakeId,provider:'gmail',source:'Gmail',email:'sync-smoke@example.invalid',connected:true,
        syncStatus:'syncing',lastSyncAt:null,error:null}];
      snapshot.syncing=false;
      let pendingSync,attachedDebugger=false;
      const publish=()=>win.webContents.send('ufriend:change',structuredClone(snapshot));
      actions.bootstrap=()=>structuredClone(snapshot);
      actions['gmail.sync']=args=>{
        assert(!pendingSync,'Disabled controls must not create duplicate sync calls.');
        syncCalls.push(structuredClone(args));snapshot.syncing=true;publish();
        return new Promise((resolve,reject)=>{pendingSync={resolve,reject};});
      };
      const finishSync=({error='',reject=false}={})=>{
        assert(pendingSync,'A fake sync must be pending.');
        const pending=pendingSync;pendingSync=null;snapshot.syncing=false;
        snapshot.accounts[0].error=error;
        if(!error)snapshot.accounts[0].lastSyncAt=new Date().toISOString();
        // Leave a stale persisted value intentionally: only the runtime flag drives loading.
        snapshot.accounts[0].syncStatus='syncing';publish();
        if(reject)pending.reject(new Error(error));
        else pending.resolve([{id:fakeId,...(error?{error}:{added:0})}]);
      };
      const expectBusy=()=>uiWait('All visible sync controls show runtime loading',()=>{
        const buttons=[...document.querySelectorAll('.mf-sync-button')];
        return buttons.length>0&&buttons.every(button=>button.disabled&&button.getAttribute('aria-busy')==='true'&&
          button.querySelector('.mf-sync-label')?.textContent==='同步中…'&&
          getComputedStyle(button.querySelector('.mf-sync-indicator')).animationName==='mf-sync-spin');
      });
      const expectIdle=()=>uiWait('Sync controls recover despite stale saved syncStatus',()=>{
        const buttons=[...document.querySelectorAll('.mf-sync-button')];
        return buttons.length>0&&buttons.every(button=>!button.disabled&&button.getAttribute('aria-busy')==='false'&&
          !button.textContent.includes('同步中')&&getComputedStyle(button.querySelector('.mf-sync-indicator')).animationName==='none');
      });
      try {
        if(!win.webContents.debugger.isAttached()){win.webContents.debugger.attach('1.3');attachedDebugger=true;}
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        publish();await nav('home');
        await uiWait('Connected home offers a themed sync action',()=>{
          const button=document.querySelector('#mf-page [data-action="sync"]');
          return button?.textContent==='同步郵件'&&button.classList.contains('mf-primary')&&
            !document.querySelector('#mf-page .mf-google-button, #mf-page [data-action="mail-settings"]');
        });
        assert.equal(await evaluate(()=>getComputedStyle(document.querySelector('#mf-page [data-action="sync"]')).backgroundColor==='rgb(255, 255, 255)'),false);
        await expectIdle();await screenshot('16-connected-home-dark');
        await click('#mf-page [data-action="sync"]');await expectBusy();
        assert.equal(syncCalls.length,1);assert.deepEqual(syncCalls[0],{});
        await evaluate(()=>document.querySelector('.mf-sync-button').click());
        assert.equal(syncCalls.length,1,'A disabled loading button cannot launch another sync.');

        await nav('inbox');await expectBusy();
        await evaluate(()=>{document.querySelector('#mail-query').focus();window.__smokeSyncIndicator=document.querySelector('.mf-sync-indicator');});
        publish();
        await uiWait('Sync updates preserve an active search field',()=>document.activeElement?.id==='mail-query'&&
          document.querySelector('.mf-sync-indicator')===window.__smokeSyncIndicator&&
          document.querySelector('.mf-sync-button').getAttribute('aria-busy')==='true');
        await settingsCategory('mail');await expectBusy();
        await evaluate(()=>{window.__smokeSyncIndicator=document.querySelector('.mf-sync-indicator');});
        publish();
        await uiWait('Settings status updates do not restart the spinner element',()=>
          document.querySelector('.mf-sync-indicator')===window.__smokeSyncIndicator);
        assert.equal(await evaluate(()=>{
          const button=document.querySelector('#gmail-settings .mf-google-button');
          return !!button?.querySelector('.mf-google-mark')&&getComputedStyle(button).backgroundColor==='rgb(255, 255, 255)';
        }),true,'The Google-branded authentication control remains in settings.');
        await screenshot('17-sync-loading-settings-dark');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        await uiWait('Reduced motion keeps loading text without spinning',()=>
          document.querySelector('.mf-sync-button')?.textContent==='同步中…'&&
          getComputedStyle(document.querySelector('.mf-sync-indicator')).animationName==='none');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});

        await settingsCategory('profile');
        finishSync({error:'模擬同步失敗'});await expectIdle();
        await uiWait('A completed sync refresh preserves the selected category and tab focus',()=>document.activeElement?.id==='settings-tab-profile'&&document.querySelector('[data-settings-tab="profile"]').getAttribute('aria-selected')==='true'&&document.querySelector('[data-settings-panel="profile"]').checkVisibility());
        await settingsCategory('mail');
        await uiWait('Partial sync failure is visible',()=>document.querySelector('.mf-accountname .mf-sub')?.textContent.includes('模擬同步失敗'));
        await click(`[data-action="sync-account"][data-id="${fakeId}"]`);await expectBusy();
        assert.equal(syncCalls[1].id,fakeId);
        finishSync({error:'模擬連線中斷',reject:true});await expectIdle();
        await uiWait('Rejected sync is reported and remains retryable',()=>document.querySelector('#mf-toast')?.textContent==='模擬連線中斷');
        await click(`[data-action="sync-account"][data-id="${fakeId}"]`);await expectBusy();
        finishSync();await expectIdle();
        await uiWait('Successful retry refreshes the account status',()=>document.querySelector('.mf-accountname .mf-sub')?.textContent.includes('上次同步')&&
          !document.querySelector('.mf-accountname .mf-sub').textContent.includes('模擬'));
        assert.equal(syncCalls.length,3);

        snapshot.accounts[0].connected=false;publish();await nav('home');
        await uiWait('Disconnected home returns to themed mailbox settings',()=>{
          const button=document.querySelector('#mf-page [data-action="mail-settings"]');
          return button?.textContent==='連接信箱'&&button.classList.contains('mf-primary')&&
            !document.querySelector('#mf-page .mf-google-button, #mf-page [data-action="sync"]');
        });
        await screenshot('18-disconnected-home-dark');
      } finally {
        if(pendingSync)finishSync();
        actions.bootstrap=originalBootstrap;actions['gmail.sync']=originalSync;
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}).catch(()=>{});
        if(attachedDebugger)win.webContents.debugger.detach();
        win.webContents.send('ufriend:change',originalBootstrap());
        await nav('inbox');
      }
      assert.equal(core.snapshot().accounts.length,0,'Fake UI accounts never enter the local database.');
    });

    await check('settings categories support accessible keyboard navigation and remember the selected category', async () => {
      await win.loadFile(path.join(projectDir,'app','index.html'));
      await uiWait('Fresh renderer starts at home',()=>document.querySelector('#mf-page')?.dataset.view==='home');
      await nav('settings');
      assert.equal(await evaluate(()=>document.querySelector('[data-settings-tab][aria-selected="true"]')?.dataset.settingsTab),'general');
      assert.deepEqual(await evaluate(()=>Array.from(document.querySelectorAll('[data-settings-tab]'),tab=>tab.dataset.settingsTab)),settingsKeys);
      await evaluate(()=>{window.__smokeSettingsContent=document.querySelector('#settings-content');window.__smokeProfileName=document.querySelector('#profile-name');});
      for(const key of settingsKeys){
        await settingsCategory(key);
        assert(await evaluate(key=>{
          const tabs=[...document.querySelectorAll('[data-settings-tab]')],panels=[...document.querySelectorAll('[data-settings-panel]')];
          return tabs.filter(tab=>tab.tabIndex===0).length===1&&tabs.find(tab=>tab.tabIndex===0)?.dataset.settingsTab===key&&
            panels.filter(panel=>!panel.hidden).length===1&&panels.every(panel=>panel.getAttribute('aria-labelledby')==='settings-tab-'+panel.dataset.settingsPanel)&&
            panels.filter(panel=>panel.hidden).every(panel=>[...panel.querySelectorAll('input,select,textarea,button,a[href]')].every(el=>!el.checkVisibility()))&&
            document.querySelector('#settings-content')===window.__smokeSettingsContent&&document.querySelector('#profile-name')===window.__smokeProfileName;
        },key),'Category switches must select one linked panel without rebuilding form controls.');
      }
      await settingsCategory('general');
      const keyboard=async(key,expected)=>{
        await evaluate(key=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})),key);
        await uiWait('Settings keyboard '+key+' selects '+expected,expected=>document.activeElement?.dataset.settingsTab===expected&&document.activeElement.getAttribute('aria-selected')==='true',expected);
      };
      for(const [key,expected]of [['ArrowRight','profile'],['ArrowDown','mail'],['ArrowLeft','profile'],['ArrowUp','general'],['End','diagnostics'],['ArrowDown','general'],['ArrowUp','diagnostics'],['Home','general']])await keyboard(key,expected);
      const attachedDebugger=!win.webContents.debugger.isAttached();if(attachedDebugger)win.webContents.debugger.attach('1.3');
      const nativeKey=async(key,code,keyCode)=>{for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode,...(type==='keyDown'&&code!=='Tab'?{text:code==='Enter'?'\r':' ',unmodifiedText:code==='Enter'?'\r':' '}:{})});};
      try{
        await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
        await evaluate(()=>document.querySelector('[data-settings-tab="profile"]').focus());await nativeKey('Enter','Enter',13);
        await uiWait('Enter activates the focused settings tab',()=>document.querySelector('[data-settings-tab="profile"]')?.getAttribute('aria-selected')==='true');
        await evaluate(()=>document.querySelector('[data-settings-tab="general"]').focus());await nativeKey(' ','Space',32);
        await uiWait('Space activates the focused settings tab',()=>document.querySelector('[data-settings-tab="general"]')?.getAttribute('aria-selected')==='true');
        await nativeKey('Tab','Tab',9);
        await uiWait('Tab enters only the active settings panel',()=>document.activeElement?.id==='settings-panel-general');
      }finally{await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});if(attachedDebugger)win.webContents.debugger.detach();}
      await settingsCategory('profile');await setValue('#profile-name','Synthetic keyboard draft');
      assert.equal(await evaluate(()=>{const event=new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true,isComposing:true});document.querySelector('#profile-name').dispatchEvent(event);return event.defaultPrevented;}),false,'Typing and IME navigation inside an input must not select another category.');
      await settingsCategory('diagnostics');await nav('home');await nav('settings');
      await uiWait('Settings remembers its category across main navigation',()=>document.querySelector('[data-settings-tab="diagnostics"]')?.getAttribute('aria-selected')==='true');
      await win.loadFile(path.join(projectDir,'app','index.html'));
      await uiWait('Keyboard fixture drafts are discarded on renderer reload',()=>document.querySelector('#mf-page')?.dataset.view==='home');
    });

    await check('settings categories preserve independent drafts through switches and another category save', async () => {
      const saved=structuredClone(core.snapshot().settings);
      try{
        await settingsCategory('profile');await setValue('#profile-name','Synthetic category draft');
        await settingsCategory('general');await setValue('#preferred-language','ja','change');
        await settingsCategory('mail');await click('.mf-gmail-sync > summary');await setValue('#gmail-days','17');await setValue('#gmail-interval','11');
        await settingsCategory('models');await click('[data-action="model-config-tab"][data-model-config="local"]');await setValue('#local-backend','pc-api','change');
        await uiWait('PC fields are visible for draft fixture',()=>document.querySelector('#dev-api-endpoint')?.checkVisibility());
        await setValue('#dev-api-endpoint','http://127.0.0.1:8791');await setValue('#dev-ocr-endpoint','http://127.0.0.1:8891');await setValue('#dev-whisper-endpoint','http://127.0.0.1:8991');
        for(const key of settingsKeys)await settingsCategory(key);
        const expected={'profile-name':'Synthetic category draft','preferred-language':'ja','gmail-days':'17','gmail-interval':'11','dev-api-endpoint':'http://127.0.0.1:8791','dev-ocr-endpoint':'http://127.0.0.1:8891','dev-whisper-endpoint':'http://127.0.0.1:8991'};
        const drafts=()=>evaluate(ids=>Object.fromEntries(ids.map(id=>[id,document.getElementById(id)?.value])),Object.keys(expected));
        assert.deepEqual(await drafts(),expected);
        assert.deepEqual(core.snapshot().settings,saved,'Category switches and typing must not save unrelated form values.');
        await settingsCategory('general');await click('[data-action="theme"][data-theme="dark"]');
        await waitFor('Other-category theme save completes',()=>core.snapshot().settings.theme==='dark');
        await uiWait('Theme refresh leaves the general category selected',()=>document.querySelector('[data-settings-tab="general"]')?.getAttribute('aria-selected')==='true'&&document.querySelector('#ufriend-app').style.colorScheme==='dark');
        assert.deepEqual(await drafts(),expected,'A completed settings refresh must retain drafts from every category.');
        await settingsCategory('mail');assert.equal(await evaluate(()=>document.querySelector('.mf-gmail-sync').open),true,'Expanded fields remain reachable after another category saves.');
        await click('[data-action="save-gmail-sync"]');await waitFor('Mail category save completes',()=>core.snapshot().settings.initialDays===17&&core.snapshot().settings.syncMinutes===11);
        await uiWait('Mail save keeps the mail category selected',()=>document.querySelector('[data-settings-tab="mail"]')?.getAttribute('aria-selected')==='true'&&!document.querySelector('[data-action="save-gmail-sync"]').disabled);
        assert.deepEqual(await drafts(),expected,'Saving mail preferences must not erase other category drafts.');
        assert.equal(core.snapshot().settings.preferredLanguage,saved.preferredLanguage);assert.deepEqual(core.snapshot().settings.personalProfile,saved.personalProfile);assert.deepEqual(core.snapshot().settings.devLlm,saved.devLlm);
      }finally{await actions['settings.save'](saved);await win.loadFile(path.join(projectDir,'app','index.html'));await uiWait('Draft fixtures reset on renderer reload',()=>document.querySelector('#mf-page')?.dataset.view==='home');}
    });

    await check('settings categories remain reachable with independent scrolling at four window sizes in both themes', async () => {
      const size=win.getSize(),savedTheme=core.snapshot().settings.theme;
      try{
        for(const theme of ['light','dark'])for(const [width,height,shotCategory]of [[1280,900,'profile'],[1080,820,'general'],[640,480,'models'],[1080,480,'diagnostics']]){
          win.setSize(width,height);await settingsCategory('general');await click('[data-action="theme"][data-theme="'+theme+'"]');
          await uiWait('Settings size and theme applied',theme=>document.querySelector('#ufriend-app').style.colorScheme===theme,theme);
          for(const key of settingsKeys){
            await settingsCategory(key);
            const layout=await evaluate(()=>{
              const page=document.querySelector('#mf-page'),content=document.querySelector('#settings-content'),menu=document.querySelector('.mf-settings-menu');
              const rects=[...document.querySelectorAll('[data-settings-tab]')].map(tab=>{const r=tab.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),right:r.right,bottom:r.bottom,visible:tab.checkVisibility()};});
              const active=document.querySelector('[data-settings-panel]:not([hidden])');
              return{width:window.innerWidth,height:window.innerHeight,orientation:document.querySelector('[role="tablist"]').getAttribute('aria-orientation'),rects,
                overflow:[document.querySelector('#ufriend-app'),page,content,active].some(el=>el.scrollWidth>el.clientWidth+1),outerOverflow:page.scrollHeight>page.clientHeight+1,
                scrollable:getComputedStyle(content).overflowY==='auto',menuY:menu.getBoundingClientRect().y,menuBottom:menu.getBoundingClientRect().bottom};
            });
            assert.equal(layout.overflow,false,'Settings must not overflow horizontally: '+[width,height,theme,key]);assert.equal(layout.outerOverflow,false,'The outer settings page must not become a second vertical scroller.');assert.equal(layout.scrollable,true);
            assert(layout.rects.every(r=>r.visible&&r.x>=0&&r.y>=0&&r.right<=layout.width+1&&r.bottom<=layout.height+1),'All six categories must remain in view.');
            const compact=layout.width<=900||layout.height<=620;
            assert.equal(layout.orientation,compact?'horizontal':'vertical');
            assert.equal(new Set(layout.rects.map(r=>r.x)).size,compact?3:1);assert.equal(new Set(layout.rects.map(r=>r.y)).size,compact?2:6);
            await evaluate(()=>{const content=document.querySelector('#settings-content');content.scrollTop=content.scrollHeight;});
            const after=await evaluate(()=>({page:document.querySelector('#mf-page').scrollTop,menuY:document.querySelector('.mf-settings-menu').getBoundingClientRect().y}));
            assert.equal(after.page,0);assert.equal(after.menuY,layout.menuY,'Scrolling settings content must not displace the category menu.');
          }
          await settingsCategory('general');
          await evaluate(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true})));
          assert(await evaluate(()=>{const tab=document.activeElement,r=tab.getBoundingClientRect();return tab.id==='settings-tab-diagnostics'&&tab.getAttribute('aria-selected')==='true'&&r.x>=0&&r.y>=0&&r.right<=window.innerWidth+1&&r.bottom<=window.innerHeight+1;}),'End must focus a fully visible final category even in a short wide window.');
          await settingsCategory(shotCategory);await screenshot('39-settings-categories-'+width+'x'+height+'-'+theme);
        }
      }finally{win.setSize(...size);await actions['settings.save']({theme:savedTheme});await nav('home');}
    });

    await check('settings preferred language saves only on request and persists across page reloads', async () => {
      const saved=structuredClone(core.snapshot().settings);
      try{
        await settingsCategory('general');assert.equal(await evaluate(()=>document.querySelector('#preferred-language').value),saved.preferredLanguage);
        await setValue('#preferred-language','en','change');await pause(150);assert.equal(core.snapshot().settings.preferredLanguage,saved.preferredLanguage);
        await click('[data-action="save-preferred-language"]');await waitFor('Preferred language saved',()=>core.snapshot().settings.preferredLanguage==='en');
        assert.deepEqual({...core.snapshot().settings,preferredLanguage:saved.preferredLanguage},saved);
        win.webContents.reload();await uiWait('Renderer reloads after language save',()=>document.querySelector('#mf-page')?.dataset.view==='home');
        await settingsCategory('general');assert.equal(await evaluate(()=>document.querySelector('#preferred-language').value),'en');await evaluate(()=>document.querySelector('#language-settings').scrollIntoView({block:'start'}));await screenshot('36-preferred-language');
      }finally{await actions['settings.save']({preferredLanguage:saved.preferredLanguage});await nav('home');}
    });

    await check('English UI language stays independent and preserves original content', async () => {
      const saved=structuredClone(core.store.read()),size=win.getSize(),originalRun=core.models.run,originalPrompts=actions['llm.prompts.get'];
      const originalHealth=actions['models.health'],requests=[],healthCalls=[],errorsBefore=report.rendererErrors.length;
      const originalText='設定\n保存\n新對話\n<img src="invalid" onerror="window.__uiLanguageInjected=true"> & literal';
      const endpointDraft='http://127.0.0.1:18765',profileDraft='設定 保存 新對話 <literal>',mailPath=path.join(fixtureDir,'ui-language-original.eml');
      const variables={chat:['text'],polish:['text','use','tone'],mail:['referenceTime','date','recipient','sender','to','cc','lines'],translate:['text','sourceLanguage','targetLanguage']};
      const catalog={apiVersion:'1',limits:{system:12000,user:16000},tasks:Object.fromEntries(Object.entries(variables).map(([task,values])=>[task,{system:originalText,user:task==='mail'?'{{lines}}':'{{text}}',variables:values,requiredVariables:[task==='mail'?'lines':'text']}]))};
      core.models.run=(kind,request)=>{assert.equal(kind,'llm');assert.equal(request.task,'chat');return new Promise((resolve,reject)=>requests.push({...request,resolve,reject}));};
      actions['llm.prompts.get']=()=>structuredClone(catalog);
      actions['models.health']=args=>{healthCalls.push(args);throw new Error('Unexpected health request in an isolated UI language test.');};
      try{
        assert.equal(core.snapshot().accounts.length,0);
        await actions['settings.save']({uiLanguage:'zh-TW',preferredLanguage:'ja',localBackend:'pc-api',ocrAuto:false});
        core.saveChatDraft('Synthetic language fixture');core.newChat();
        const logo=await fs.readFile(path.join(projectDir,'app','assets','ufriend.png'));
        const html='<html><body><h2 id="original-title">設定</h2><p id="original-copy">保存</p><p id="original-conversation">新對話</p><p id="original-literal">&lt;img src="invalid"&gt; &amp; literal</p></body></html>';
        await fs.writeFile(mailPath,fixtureHtmlMail({subject:'設定',body:originalText,html,logo}));
        const imported=await core.importMails([mailPath]);assert.equal(imported.added,1);assert.deepEqual(imported.errors,[]);
        const mailId=core.snapshot().messages.find(message=>message.subject==='設定'&&message.body.includes('onerror')).id;
        core.store.update(state=>{
          state.messages=state.messages.filter(message=>message.id===mailId);
          const mail=state.messages[0];mail.read=true;mail.analysis={summary:originalText,reason:'保存',evidence:['新對話'],priority:1,analyzedAt:new Date().toISOString()};
          state.ocr={...state.ocr,text:originalText,status:'manual',error:''};
          state.polish={...state.polish,input:'設定',output:originalText,status:'manual',error:''};
          state.translation={...state.translation,input:'保存',output:originalText,status:'done',error:''};
          state.recordings=[{id:'ui-language-recording',name:'保存',size:1,type:'audio',state:'done',lang:'zh-TW',transcriptSource:'manual',textOnly:originalText}];
          state.logs.unshift({id:'ui-language-log',date:new Date().toISOString(),text:'設定',detail:originalText,status:'success'});
        });
        await win.loadFile(path.join(projectDir,'app','index.html'));
        await uiWait('Language fixture renderer is ready',()=>document.querySelector('#mf-page')?.dataset.view==='home');
        await nav('chat');await setValue('#chat-input','設定');await click('[data-action="chat-send"]');
        await waitFor('Synthetic chat is running before switching interface language',()=>requests.length===1&&core.snapshot().chat.status==='running');
        requests[0].onDelta(originalText);
        await uiWait('Synthetic original stream text is visible',text=>document.querySelector('#chat-stream-text')?.textContent===text,originalText);
        await settingsCategory('profile');await setValue('#profile-name',profileDraft);
        await settingsCategory('models');await setValue('#dev-api-endpoint',endpointDraft);
        await settingsCategory('general');await setValue('#preferred-language','en','change');
        await setValue('#ui-language','en','change');await pause(100);
        assert.equal(core.snapshot().settings.uiLanguage,'zh-TW','Selecting an interface language must wait for its save button.');
        assert.equal(core.snapshot().settings.preferredLanguage,'ja');
        await click('[data-action="save-ui-language"]');
        await uiWait('English app language is applied',()=>document.documentElement.lang==='en'&&document.querySelector('[data-nav="settings"] .mf-navtext')?.textContent==='Settings');
        assert.equal(await evaluate(()=>document.querySelector('[data-nav="chat"] .mf-navtext').textContent),'LLM chat');
        assert.equal(core.snapshot().settings.uiLanguage,'en');assert.equal(core.snapshot().settings.preferredLanguage,'ja');
        assert.equal(requests[0].signal.aborted,false,'Changing the interface language must keep the active chat request running.');
        assert.equal(core.snapshot().chat.partialText,originalText);
        const languageControls=await evaluate(()=>({
          ui:document.querySelector('#ui-language').value,llm:document.querySelector('#preferred-language').value,
          options:Array.from(document.querySelector('#ui-language').options,option=>option.value),
          text:document.querySelector('#settings-panel-general').textContent,
          orientation:document.querySelector('[role="tablist"]').getAttribute('aria-orientation')
        }));
        assert.deepEqual(languageControls.options,['zh-TW','en']);assert.equal(languageControls.ui,'en');assert.equal(languageControls.llm,'en');
        assert.match(languageControls.text,/App language/);assert.match(languageControls.text,/LLM preferred language/);
        assert(languageControls.orientation,'Translated accessible labels must not break settings orientation.');
        await settingsCategory('profile');assert.equal(await evaluate(()=>document.querySelector('#profile-name').value),profileDraft);
        await settingsCategory('models');assert.equal(await evaluate(()=>document.querySelector('#dev-api-endpoint').value),endpointDraft);
        assert.notEqual(core.snapshot().settings.personalProfile.name,profileDraft);assert.notEqual(core.snapshot().settings.devLlm.endpoint,endpointDraft);
        await settingsCategory('general');assert.equal(await evaluate(()=>document.querySelector('#preferred-language').value),'en');
        await setValue('#preferred-language','ja','change');
        requests[0].resolve({text:originalText,meta:{model:'fixture',backend:'isolated-ui-language'}});
        await waitFor('Synthetic chat completes after language switch',()=>core.snapshot().chat.status==='done');
        core.renameChat(core.snapshot().chatHistory.activeId,'新對話');

        const titles={inbox:'Email inbox',meetings:'Meeting notes',ocr:'OCR text recognition',polish:'Writing polish',translation:'Text translation',chat:'LLM chat',logs:'System logs',settings:'Settings'};
        for(const [view,title]of Object.entries(titles)){
          await nav(view);assert.equal(await evaluate(()=>document.querySelector('#mf-top h1').textContent),title,'English title for '+view);
          if(view==='inbox'){
            assert(await evaluate(()=>Array.from(document.querySelectorAll('.mf-mail-preview-subject')).some(node=>node.textContent==='設定')));
            await click('[data-action="open-mail"][data-id="'+mailId+'"]');
            await uiWait('Original HTML email remains available',()=>document.querySelector('#mail-html-frame')?.dataset.ready==='true');
            assert.deepEqual(await evaluate(()=>{const doc=document.querySelector('#mail-html-frame').contentDocument;return['original-title','original-copy','original-conversation','original-literal'].map(id=>doc.getElementById(id).textContent);}),['設定','保存','新對話','<img src="invalid"> & literal']);
            assert.equal(await evaluate(()=>document.querySelector('.mf-analysis-summary').textContent),originalText);
            assert.equal(await evaluate(()=>document.querySelector('.mf-analysis-summary').children.length),0);
            await click('[data-action="mail-back"]');
          }
          if(view==='meetings')assert.equal(await evaluate(()=>document.querySelector('.mf-meeting h3').textContent),'保存');
          if(view==='ocr')assert.equal(await evaluate(()=>document.querySelector('#ocr-text').value),originalText);
          if(view==='polish')assert.deepEqual(await evaluate(()=>['polish-input','polish-output'].map(id=>document.getElementById(id).value)),['設定',originalText]);
          if(view==='translation')assert.deepEqual(await evaluate(()=>['translation-input','translation-output'].map(id=>document.getElementById(id).value)),['保存',originalText]);
          if(view==='chat'){
            await uiWait('The renamed original chat title reaches the renderer',()=>document.querySelector('#chat-current-title')?.textContent==='新對話');
            assert.equal(await evaluate(()=>document.querySelector('#chat-current-title').textContent),'新對話');
            assert.deepEqual(await evaluate(()=>Array.from(document.querySelectorAll('.mf-chat-text'),node=>node.textContent)),['設定',originalText]);
            assert.equal(await evaluate(()=>document.querySelector('.mf-chat-assistant .mf-chat-text').children.length),0);
          }
          if(view==='logs')assert(await evaluate(text=>Array.from(document.querySelectorAll('.mf-logrow')).some(node=>node.textContent.includes(text)),originalText));
          assert.equal(await evaluate(()=>!!window.__uiLanguageInjected),false);
        }
        await settingsCategory('prompts');await click('[data-action="prompt-debug-open"]');
        await uiWait('English Prompt editor loads its synthetic catalog',()=>document.querySelector('#prompt-system')?.disabled===false);
        assert.match(await evaluate(()=>document.querySelector('#mf-top h1').textContent),/^Prompt [A-Za-z ]+$/);
        assert.equal(await evaluate(()=>document.querySelector('#prompt-system').value),originalText);
        assert.equal(await evaluate(()=>document.querySelector('#prompt-user').value),'{{text}}');
        await click('[data-action="prompt-back"]');

        for(const [width,height]of [[1080,820],[640,480]])for(const theme of ['light','dark']){
          win.setSize(width,height);await settingsCategory('general');await click('[data-action="theme"][data-theme="'+theme+'"]');
          await uiWait('English settings theme is applied',theme=>document.querySelector('#ufriend-app').style.colorScheme===theme,theme);
          for(const view of Object.keys(titles)){
            await nav(view);
            const overflow=await evaluate(()=>['#ufriend-app','.mf-side','.mf-nav','#mf-top','#mf-page'].filter(selector=>{const node=document.querySelector(selector);return node.scrollWidth>node.clientWidth+1;}));
            if(overflow.length)await screenshot('40-ui-language-overflow-'+view+'-'+width+'x'+height+'-'+theme);
            assert.deepEqual(overflow,[],'English page horizontal overflow: '+[width,height,theme,view]);
          }
          for(const category of settingsKeys){
            await settingsCategory(category);
            const layout=await evaluate(()=>({
              overflow:['#ufriend-app','.mf-side','.mf-nav','#mf-page','#settings-content','[data-settings-panel]:not([hidden])'].some(selector=>{const node=document.querySelector(selector);return node.scrollWidth>node.clientWidth+1;}),
              tabs:Array.from(document.querySelectorAll('[data-settings-tab]'),node=>{const r=node.getBoundingClientRect();return node.checkVisibility()&&r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;}),
              orientation:document.querySelector('[role="tablist"]').getAttribute('aria-orientation'),compact:innerWidth<=900||innerHeight<=620
            }));
            assert.equal(layout.overflow,false,'English settings horizontal overflow: '+[width,height,theme,category]);
            assert(layout.tabs.every(Boolean),'Every English settings category stays inside the viewport.');
            assert.equal(layout.orientation,layout.compact?'horizontal':'vertical');
          }
          await settingsCategory('general');await evaluate(()=>document.querySelector('#ui-language').closest('section').scrollIntoView({block:'start'}));
          await screenshot('40-ui-language-'+width+'x'+height+'-'+theme);
        }
        await win.loadFile(path.join(projectDir,'app','index.html'));
        await uiWait('English language survives a full renderer reload',()=>document.documentElement.lang==='en'&&document.querySelector('#mf-top h1')?.textContent==='Home');
        await settingsCategory('general');
        assert.deepEqual(await evaluate(()=>['ui-language','preferred-language'].map(id=>document.getElementById(id).value)),['en','ja']);
        assert.equal(core.snapshot().settings.preferredLanguage,'ja');
        assert.equal(core.snapshot().messages.find(message=>message.id===mailId).body.trim(),originalText);
        assert.equal(core.snapshot().chat.messages[1].content,originalText);
        assert.equal(core.snapshot().recordings[0].textOnly,originalText);
        assert.equal(requests.length,1);assert.deepEqual(healthCalls,[]);assert.equal(core.snapshot().accounts.length,0);
        assert.deepEqual(report.rendererErrors.slice(errorsBefore),[]);
        report.uiLanguage={interfaceLanguage:'en',preferredLanguage:'ja',visitedViews:Object.keys(titles).concat('llm-debug'),preservedContent:['email HTML','email analysis','chat stream and response','conversation title','OCR','polish','translation','transcript','Prompt','logs','unsaved settings'],syntheticModelRequests:requests.length,healthRequests:healthCalls.length};
      }finally{
        core.cancelChat();for(const request of requests)request.resolve({text:'Synthetic fixture cleanup'});
        core.models.run=originalRun;actions['llm.prompts.get']=originalPrompts;actions['models.health']=originalHealth;win.setSize(...size);
        core.store.update(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,saved);});
        await actions['settings.save']({uiLanguage:saved.settings.uiLanguage,preferredLanguage:saved.settings.preferredLanguage,localBackend:saved.settings.localBackend,theme:saved.settings.theme,ocrAuto:saved.settings.ocrAuto});
        await win.loadFile(path.join(projectDir,'app','index.html'));
        await uiWait('Original fixture renderer is restored',()=>document.querySelector('#mf-page')?.dataset.view==='home');
      }
    });

    await check('settings personal profile saves validated fields, keeps unsaved edits and can disable model background', async () => {
      const saved=structuredClone(core.snapshot().settings),size=win.getSize();
      const profile={enabled:true,name:'Synthetic Person',phone:'TEST-555-0199',personalEmail:'synthetic@example.invalid',workEmail:'work@example.invalid',company:'Synthetic Workshop',jobTitle:'Synthetic Designer',notes:'Synthetic background\n第二行測試背景'};
      const ids={name:'name',phone:'phone',personalEmail:'personal-email',workEmail:'work-email',company:'company',jobTitle:'job-title',notes:'notes'};
      try{
        await settingsCategory('profile');for(const [key,id]of Object.entries(ids))await setValue('#profile-'+id,profile[key]);
        await pause(800);assert.deepEqual(core.snapshot().settings.personalProfile,saved.personalProfile,'Editing profile is not an automatic save.');
        const otherLanguage=saved.preferredLanguage==='en'?'ja':'en';
        await settingsCategory('general');await setValue('#preferred-language',otherLanguage,'change');await click('[data-action="save-preferred-language"]');await waitFor('Other category language save completes',()=>core.snapshot().settings.preferredLanguage===otherLanguage);await settingsCategory('profile');await uiWait('Saving another category preserves profile edits',()=>document.querySelector('#profile-name')?.value==='Synthetic Person');
        await setValue('#profile-personal-email','INVALID_PRIVATE');await click('[data-action="save-personal-profile"]');await pause(120);assert.deepEqual(core.snapshot().settings.personalProfile,saved.personalProfile);
        await setValue('#profile-personal-email',profile.personalEmail);await click('[data-action="save-personal-profile"]');await waitFor('Profile saved',()=>core.snapshot().settings.personalProfile.name===profile.name);assert.deepEqual(core.snapshot().settings.personalProfile,profile);
        await evaluate(()=>document.querySelector('#personal-profile-settings').scrollIntoView({block:'start'}));await screenshot('37-personal-profile');
        win.webContents.reload();await uiWait('Renderer reloads after profile save',()=>document.querySelector('#mf-page')?.dataset.view==='home');await settingsCategory('profile');
        assert.deepEqual(await evaluate(ids=>Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,document.querySelector('#profile-'+id).value])),ids),Object.fromEntries(Object.entries(profile).filter(([key])=>key!=='enabled')));
        await evaluate(()=>{const el=document.querySelector('#profile-enabled');el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});await click('[data-action="save-personal-profile"]');await waitFor('Background disabled without clearing data',()=>core.snapshot().settings.personalProfile.enabled===false);assert.deepEqual(core.snapshot().settings.personalProfile,{...profile,enabled:false});
        win.setSize(640,480);await pause(100);await evaluate(()=>document.querySelector('#personal-profile-settings').scrollIntoView({block:'start'}));
        assert(await evaluate(()=>['#personal-profile-settings',...Array.from(document.querySelectorAll('#personal-profile-settings input, #personal-profile-settings textarea')).map(el=>'#'+el.id)].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth+1;})));await screenshot('38-personal-profile-minimum');
      }finally{win.setSize(...size);await actions['settings.save']({personalProfile:saved.personalProfile,preferredLanguage:saved.preferredLanguage});await nav('home');}
    });

    await check('PC API settings test the typed endpoint independently and recover from unavailable services', async () => {
      const originalHealth=actions['models.health'],savedSettings=structuredClone(core.snapshot().settings),healthCalls=[];
      let pendingHealth;
      actions['models.health']=args=>{healthCalls.push(structuredClone(args));return new Promise((resolve,reject)=>{pendingHealth={resolve,reject};});};
      const finishHealth=result=>{const current=pendingHealth;pendingHealth=null;current.resolve(result);};
      try {
        await settingsCategory('models');await click('[data-action="model-config-tab"][data-model-config="local"]');await setValue('#local-backend','pc-api','change');
        await click('[data-action="save-dev-api"]');await waitFor('PC backend is saved explicitly',()=>core.snapshot().settings.localBackend==='pc-api');
        await uiWait('PC API mode has its own endpoint',()=>document.querySelector('#dev-api-endpoint')?.value==='http://127.0.0.1:8765');
        assert.equal(await evaluate(()=>Array.from(document.querySelectorAll('#api-key, #pool-live')).some(el=>el.getClientRects().length>0)),false);
        await setValue('#dev-api-endpoint','http://127.0.0.1:8766');await click('[data-action="test-dev-api"]');
        await waitFor('Health IPC receives the unsaved endpoint',()=>healthCalls.length===1);
        assert.deepEqual(healthCalls[0],{source:'local',kind:'llm',endpoint:'http://127.0.0.1:8766'});
        assert.equal(core.snapshot().settings.devLlm.endpoint,'http://127.0.0.1:8765');
        assert.equal(await evaluate(()=>document.querySelector('[data-action="test-dev-api"]').disabled),true);
        await settingsCategory('general');
        pendingHealth.reject(new Error('PC 測試服务尚未啟動。'));pendingHealth=null;
        await uiWait('Unavailable API retains the typed endpoint and allows retry',()=>
          document.querySelector('#dev-api-status')?.textContent.includes('尚未啟動')&&
          document.querySelector('#dev-api-endpoint')?.value==='http://127.0.0.1:8766'&&
          !document.querySelector('[data-action="test-dev-api"]').disabled);
        assert(await evaluate(()=>document.querySelector('[data-settings-tab="general"]').getAttribute('aria-selected')==='true'&&document.activeElement?.id==='settings-tab-general'),'A pending model health response must preserve the active category and tab focus.');
        await settingsCategory('models');
        await click('[data-action="test-dev-api"]');await waitFor('Second health call',()=>healthCalls.length===2);
        finishHealth({ok:true,ready:false,apiVersion:'1',backend:'pc-llama.cpp',model:'Qwen2.5-1.5B-Instruct'});
        await uiWait('Configured service is not mislabeled ready',()=>document.querySelector('#dev-api-status')?.textContent.includes('模型尚未就緒'));
        await click('[data-action="test-dev-api"]');await waitFor('Third health call',()=>healthCalls.length===3);
        finishHealth({ok:true,ready:true,apiVersion:'1',backend:'pc-llama.cpp',model:'Qwen2.5-1.5B-Instruct',quantization:'Q4_K_M',contextTokens:2048});
        await uiWait('Ready model identity is shown',()=>document.querySelector('#dev-api-status')?.textContent.includes('模型已就緒')&&document.querySelector('#dev-api-status').textContent.includes('Q4_K_M'));
        await nav('home');await settingsCategory('models');
        await uiWait('Returning to the saved endpoint clears another endpoints health status',()=>
          document.querySelector('#dev-api-endpoint')?.value==='http://127.0.0.1:8765'&&document.querySelector('#dev-api-status')?.textContent.includes('尚未測試連線'));
        await setValue('#dev-api-endpoint','http://127.0.0.1:8766');await click('[data-action="test-dev-api"]');await waitFor('Retest selected endpoint',()=>healthCalls.length===4);
        finishHealth({ok:true,ready:true,apiVersion:'1',backend:'pc-llama.cpp',model:'Qwen2.5-1.5B-Instruct',quantization:'Q4_K_M',contextTokens:2048});
        await uiWait('Selected endpoint is ready',()=>document.querySelector('#dev-api-status')?.textContent.includes('模型已就緒'));
        await click('[data-action="save-dev-api"]');await waitFor('Endpoint is saved separately',()=>core.snapshot().settings.devLlm.endpoint==='http://127.0.0.1:8766');
        assert.deepEqual(core.snapshot().settings.api,savedSettings.api,'PC settings must not modify the cloud API fields.');
        await screenshot('19-pc-api-settings');
        await setValue('#dev-api-endpoint','https://external.example.invalid');await click('[data-action="save-dev-api"]');
        await uiWait('Invalid remote endpoint is rejected without erasing input',()=>document.querySelector('#mf-toast')?.textContent.includes('只允許本機')&&document.querySelector('#dev-api-endpoint')?.value==='https://external.example.invalid');
        assert.equal(core.snapshot().settings.devLlm.endpoint,'http://127.0.0.1:8766');
      } finally {
        if(pendingHealth)finishHealth({ok:true,ready:false});
        actions['models.health']=originalHealth;await actions['settings.save'](savedSettings);await nav('home');
      }
    });

    await check('mail analysis progress, summary updates, manual priority and cancellation use isolated model fixtures', async () => {
      const saved=structuredClone(core.store.read()),originalRun=core.models.run,requests=[];
      const fixtureIds=['model-manual','model-failure','model-skipped','model-cancel'];
      const quote='請於明天十點前回覆 <確認> & 完成。';
      core.models.run=(kind,request)=>{assert.equal(kind,'llm');if(request.task==='mail-classify'){assert.deepEqual(request.input,{summary:'測試摘要：明天回覆確認。'});return Promise.resolve({category:'work'});}assert.equal(request.task,'mail');return new Promise((resolve,reject)=>requests.push({...request,resolve,reject}));};
      const result=request=>({analyses:[{id:request.input.messages[0].id,summary:'測試摘要：明天回覆確認。',priority:0,reason:'原文載明明天十點前需回覆。',evidence:[quote]}],meta:{model:'Synthetic UI fixture',backend:'isolated-smoke'}});
      try {
        core.store.update(state=>{state.messages=fixtureIds.map((id,index)=>({id,accountId:'local',source:'本機',sender:'模型 UI 測試',email:'fixture@example.invalid',subject:'Synthetic model fixture '+index,body:quote,date:new Date().toISOString(),folder:'inbox',read:true,done:false,level:index===0?2:null,prioritySource:index===0?'manual':null,attachments:[]}));});
        win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');await click('[data-action="analyze"]');
        await waitFor('First fake mail request',()=>requests.length===1);
        await uiWait('Analysis spinner and cancellation are visible',()=>document.querySelector('[data-action="analyze"]')?.disabled&&
          document.querySelector('[data-action="analyze"]').getAttribute('aria-busy')==='true'&&
          !!document.querySelector('#mail-analysis-actions .mf-progress-indicator')&&
          !!document.querySelector('[data-action="cancel-analysis"]')&&document.querySelector('#mail-analysis-progress')?.textContent.includes('0 / 4'));
        await evaluate(()=>document.querySelector('[data-action="analyze"]').click());assert.equal(requests.length,1);
        await click('[data-action="open-mail"][data-id="model-manual"]');
        await evaluate(()=>{document.querySelector('#mail-level').focus();window.__smokePriority=document.querySelector('#mail-level');});
        requests[0].resolve(result(requests[0]));await waitFor('Next fake mail request',()=>requests.length===2);
        await uiWait('The summary updates without replacing the focused manual priority selector',()=>
          document.querySelector('#mail-level')===window.__smokePriority&&document.activeElement?.id==='mail-level'&&
          document.querySelector('#mail-level').value==='2'&&
          document.querySelector('.mf-analysis-summary')?.textContent==='測試摘要：明天回覆確認。');
        assert.equal(core.snapshot().messages[0].level,2);assert.equal(core.snapshot().messages[0].analysis.priority,0);
        assert.deepEqual(core.snapshot().messages[0].analysis.evidence,[quote],'Evidence remains available in stored analysis.');
        assert(await evaluate(()=>!document.querySelector('#mail-analysis-result .mf-analysis-evidence,#mail-analysis-result .mf-analysis-facts,#mail-analysis-result .mf-analysis-quality,#mail-analysis-result .mf-analysis-source,#mail-analysis-result .mf-mail-analysis-notice')),'A live result does not restore removed summary details.');
        await screenshot('20-mail-analysis-summary');
        core.store.update(state=>{state.messages=state.messages.filter(mail=>mail.id!=='model-skipped');});
        requests[1].reject(Object.assign(new Error('測試長郵件超過上下文上限。'),{code:'MODEL_API_CONTEXT_LIMIT'}));
        await waitFor('Failed and skipped entries advance to the last mail',()=>requests.length===3&&core.snapshot().mailAnalysis.processed===3);
        await click('[data-action="mail-back"]');
        await uiWait('Partial counts are visible while analyzing',()=>document.querySelector('#mail-analysis-progress')?.textContent.includes('3 / 4')&&
          document.querySelector('#mail-analysis-progress').textContent.includes('失敗 1 封 · 略過 1 封'));
        await screenshot('21-mail-analysis-running');
        await click('[data-action="cancel-analysis"]');
        await uiWait('Cancelled analysis retains counts and re-enables start',()=>document.querySelector('#mail-analysis-progress')?.textContent.includes('已取消整理 · 3 / 4')&&!document.querySelector('[data-action="analyze"]').disabled&&!document.querySelector('[data-action="cancel-analysis"]'));
        assert(requests[2].signal.aborted);requests[2].resolve(result(requests[2]));await pause(80);
        assert.equal(core.snapshot().messages.find(mail=>mail.id==='model-cancel').analysis,undefined,'Late cancelled results must not appear.');
        core.store.update(state=>{for(const mail of state.messages)if(mail.id!=='model-cancel')mail.folder='archive';});
        win.webContents.send('ufriend:change',actions.bootstrap());await click('[data-action="analyze"]');await waitFor('Retry starts',()=>requests.length===4);
        requests[3].resolve(result(requests[3]));await uiWait('Completed retry shows final counts and recovers the button',()=>document.querySelector('#mail-analysis-progress')?.textContent.includes('整理完成 · 1 / 1')&&!document.querySelector('[data-action="analyze"]').disabled);
      } finally {
        core.cancelMailAnalysis();for(const request of requests)request.resolve(result(request));core.models.run=originalRun;
        core.store.update(state=>{for(const key of ['messages','mailAnalysis'])state[key]=saved[key];});
        win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('mail summary card keeps only the full summary and category while preserving original content and priority', async () => {
      report.mailQuality=await require('./mail-quality-smoke.cjs')({win,core,actions,nav,click,setValue,evaluate,uiWait,waitFor,screenshot});
    });

    await check('polish loading and cancellation preserve focused input and ignore stale model results', async () => {
      const saved=structuredClone(core.store.read().polish),originalRun=core.models.run,requests=[];
      core.models.run=(kind,request)=>{assert.equal(kind,'llm');assert.equal(request.task,'polish');return new Promise((resolve,reject)=>requests.push({...request,resolve,reject}));};
      try {
        await nav('polish');await setValue('#polish-input','請提醒大家明天上午十點開會。');
        await pause(900);assert.equal(requests.length,0,'Typing and its debounce must only save the draft.');
        await setValue('#polish-use','document','change');await setValue('#polish-tone','formal','change');await pause(200);assert.equal(requests.length,0,'Changing options must not invoke the model.');
        await click('[data-action="polish-start"]');await evaluate(()=>document.querySelector('#polish-input').focus());
        await waitFor('First fake polish starts',()=>requests.length===1);
        await uiWait('Focused input still receives running controls',()=>document.activeElement?.id==='polish-input'&&
          document.querySelector('#polish-output')?.readOnly&&document.querySelector('[data-action="polish-start"]').disabled&&
          !!document.querySelector('[data-action="polish-cancel"]'));
        requests[0].reject(Object.assign(new Error('PC 測試服務尚未啟動，請先啟動獨立 API。'),{code:'MODEL_API_UNAVAILABLE'}));
        await uiWait('Unavailable polish keeps input and no output',()=>document.querySelector('#polish-status')?.textContent.includes('尚未啟動')&&
          document.querySelector('#polish-input')?.value==='請提醒大家明天上午十點開會。'&&
          document.querySelector('#polish-output')?.value===''&&!document.querySelector('[data-action="polish-start"]').disabled);
        await click('[data-action="polish-start"]');await waitFor('Polish retry starts',()=>requests.length===2);
        await uiWait('Cancel is available for manual retry',()=>!!document.querySelector('[data-action="polish-cancel"]'));
        await screenshot('22-polish-running');await click('[data-action="polish-cancel"]');
        await uiWait('Cancellation clears loading while retaining text',()=>document.querySelector('#polish-status')?.textContent==='已取消'&&
          !document.querySelector('[data-action="polish-cancel"]')&&!document.querySelector('[data-action="polish-start"]').disabled);
        assert(requests[1].signal.aborted);requests[1].resolve({text:'禁止套用的已取消結果'});await pause(80);
        assert.equal(await evaluate(()=>document.querySelector('#polish-output').value),'');
        await setValue('#polish-input','第一版內容。');await click('[data-action="polish-start"]');await waitFor('Older revision starts',()=>requests.length===3);
        await setValue('#polish-input','暫時改寫。');await setValue('#polish-input','第一版內容。');requests[2].resolve({text:'禁止顯示的過期結果'});
        await pause(900);assert.equal(requests.length,3,'Returning to the original draft must still cancel the old generation without starting a replacement.');
        assert.equal(await evaluate(()=>document.querySelector('#polish-input').value),'第一版內容。');
        assert.equal(await evaluate(()=>document.querySelector('#polish-output').value),'','An older result must not flash while the next edit is debouncing.');
        await setValue('#polish-input','保留這一版新的內容。');await pause(900);assert.equal(requests.length,3);await click('[data-action="polish-start"]');
        await waitFor('Newer revision starts',()=>requests.length===4);
        await nav('home');assert.equal(requests[3].signal.aborted,false,'Navigation saving unchanged input must not cancel ongoing polish.');
        await nav('polish');await uiWait('Running polish remains cancellable after navigation',()=>!!document.querySelector('[data-action="polish-cancel"]'));
        requests[3].resolve({text:'這是依照最新內容完成的測試潤句。',meta:{model:'Synthetic UI fixture',backend:'isolated-smoke'}});
        await uiWait('Latest result is shown and copy becomes available',()=>document.querySelector('#polish-output')?.value==='這是依照最新內容完成的測試潤句。'&&
          document.querySelector('#polish-status')?.textContent==='已完成 · 結果來源：本地'&&!document.querySelector('[data-action="polish-copy"]').disabled);
        await screenshot('23-polish-complete');
      } finally {
        core.cancelPolish();for(const request of requests)request.resolve({text:'Synthetic fixture cleanup'});core.models.run=originalRun;
        core.store.update(state=>{state.polish=saved;});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('OCR and Whisper settings keep independent endpoints and health indicators', async () => {
      const savedSettings=structuredClone(core.snapshot().settings),originalHealth=actions['models.health'],calls=[];
      actions['models.health']=async args=>{calls.push(args);return{ok:true,ready:true,apiVersion:'1',model:args.kind==='ocr'?'PP-OCRv5 mobile fixture':'Whisper small fixture',backend:'isolated-smoke'};};
      try{
        await settingsCategory('models');await click('[data-action="model-config-tab"][data-model-config="local"]');await setValue('#local-backend','pc-api','change');
        await uiWait('Media API controls render after mode change',()=>!!document.querySelector('#dev-ocr-endpoint')&&!!document.querySelector('#dev-whisper-endpoint'));
        await setValue('#dev-ocr-endpoint','http://127.0.0.1:8867');await click('[data-action="test-media-api"][data-kind="ocr"]');
        await uiWait('OCR health is independent',()=>document.querySelector('#dev-ocr-status')?.textContent.includes('PP-OCRv5')&&document.querySelector('#dev-whisper-status')?.textContent.includes('尚未測試'));
        await setValue('#dev-whisper-endpoint','http://127.0.0.1:8868');await click('[data-action="test-media-api"][data-kind="whisper"]');
        await uiWait('Whisper health is independent',()=>document.querySelector('#dev-whisper-status')?.textContent.includes('Whisper small'));
        assert.deepEqual(calls,[{source:'local',kind:'ocr',endpoint:'http://127.0.0.1:8867'},{source:'local',kind:'whisper',endpoint:'http://127.0.0.1:8868'}]);
        await click('[data-action="save-dev-api"]');await waitFor('Both media endpoints saved',()=>core.snapshot().settings.devOcr.endpoint.endsWith(':8867')&&core.snapshot().settings.devWhisper.endpoint.endsWith(':8868'));
        await screenshot('24-media-api-settings');
      }finally{actions['models.health']=originalHealth;await actions['settings.save'](savedSettings);await nav('home');}
    });

    await check('translation language selection, navigation, cancellation and escaped output use isolated input',async()=>{
      const saved=structuredClone(core.store.read().translation),originalRun=core.models.run,requests=[];
      core.models.run=(kind,request)=>{assert.equal(kind,'llm');assert.equal(request.task,'translate');return new Promise(resolve=>requests.push({...request,resolve}));};
      try{
        await nav('translation');await setValue('#translation-source','en','change');await setValue('#translation-target','ja','change');
        await setValue('#translation-input','Please attend the meeting at 15:00.');await pause(550);assert.equal(requests.length,0,'Typing must not automatically invoke translation.');
        await click('[data-action="translation-start"]');await waitFor('Translation request',()=>requests.length===1);
        assert.deepEqual(requests[0].input,{text:'Please attend the meeting at 15:00.',sourceLanguage:'en',targetLanguage:'ja'});
        await nav('home');await nav('translation');assert.equal(requests[0].signal.aborted,false);
        requests[0].resolve({text:'15:00に会議へ参加してください。<literal>',meta:{model:'fixture',backend:'isolated-smoke'}});
        await uiWait('Translation result arrives in the correct view',()=>document.querySelector('#translation-output')?.value==='15:00に会議へ参加してください。<literal>');
        await screenshot('29-translation');
        await setValue('#translation-target','zh-TW','change');await click('[data-action="translation-start"]');await waitFor('Translation retry',()=>requests.length===2);
        await uiWait('Translation cancel button',()=>!!document.querySelector('[data-action="translation-cancel"]'));
        await click('[data-action="translation-cancel"]');await waitFor('Translation is cancelled',()=>core.snapshot().translation.status==='cancelled');
        requests[1].resolve({text:'晚到結果不能覆蓋'});await pause(80);assert.equal(core.snapshot().translation.output,'');assert.equal(core.snapshot().translation.input,'Please attend the meeting at 15:00.');
      }finally{core.cancelTranslation();for(const request of requests)request.resolve({text:'fixture cleanup'});core.models.run=originalRun;core.store.update(state=>{state.translation=saved;});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');}
    });

    await check('chat supports follow-up, escaped output, stop, draft recovery, deletion and compact layout', async () => {
      const saved=structuredClone({chat:core.store.read().chat,chatHistory:core.store.read().chatHistory}),originalRun=core.models.run,requests=[];
      core.models.run=(kind,request)=>{assert.equal(kind,'llm');assert.equal(request.task,'chat');return new Promise((resolve,reject)=>requests.push({...request,resolve,reject}));};
      const bounds=win.getBounds();
      try{
        await nav('chat');await screenshot('25-chat-empty');
        assert.equal(await evaluate(()=>!!document.querySelector('[data-action="chat-clear"]')),false);
        assert.equal(await evaluate(()=>document.querySelector('[data-action="chat-new"]')?.disabled),true);
        await setValue('#chat-input','二加三是多少？');
        await uiWait('Typing enables a new conversation without leaving chat',()=>document.querySelector('[data-action="chat-new"]')?.disabled===false);
        await evaluate(()=>document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
        assert.equal(requests.length,0,'IME confirmation must not submit a question.');
        await click('[data-action="chat-send"]');await waitFor('Chat first request',()=>requests.length===1);
        await uiWait('Chat pending state is visible',()=>document.querySelector('#chat-input')?.readOnly&&document.querySelector('#chat-log')?.textContent.includes('二加三')&&!!document.querySelector('[data-action="chat-cancel"]'));
        assert.equal(await evaluate(()=>document.querySelector('[data-action="chat-new"]')?.disabled),false,'A running conversation may start a new conversation.');
        await nav('home');await nav('chat');assert.equal(requests[0].signal.aborted,false);
        requests[0].resolve({text:'答案是五。<literal> & 保留文字',meta:{model:'fixture',backend:'isolated-smoke'}});
        await uiWait('Chat answer is rendered as plain text',()=>document.querySelector('.mf-chat-assistant .mf-chat-text')?.textContent==='答案是五。<literal> & 保留文字'&&!document.querySelector('#chat-input').readOnly);
        assert.equal(await evaluate(()=>document.querySelector('.mf-chat-assistant .mf-chat-text').children.length),0);
        assert.equal(await evaluate(()=>document.querySelector('[data-action="chat-new"]')?.disabled),false,'Completed messages keep new conversation available with an empty composer.');
        await setValue('#chat-input','再減一呢？');await click('[data-action="chat-send"]');await waitFor('Chat follow-up request',()=>requests.length===2);
        assert.equal(requests[1].input.messages[1].content,'答案是五。<literal> & 保留文字');
        requests[1].resolve({text:'答案是四。',meta:{model:'fixture',backend:'isolated-smoke'}});
        await uiWait('Both assistant answers remain in history',()=>document.querySelectorAll('.mf-chat-assistant').length===2&&!document.querySelector('#chat-input').readOnly);
        await screenshot('26-chat-follow-up');
        await setValue('#chat-input','停止後保留這個問題');await click('[data-action="chat-send"]');await waitFor('Third chat request',()=>requests.length===3);
        await uiWait('Third chat cancellation control is ready',()=>!!document.querySelector('[data-action="chat-cancel"]'));
        await click('[data-action="chat-cancel"]');
        await uiWait('Cancelled draft returns to the composer',()=>document.querySelector('#chat-input')?.value==='停止後保留這個問題'&&!document.querySelector('#chat-input').readOnly);
        requests[2].resolve({text:'不能出現的晚到答案'});await pause(80);assert.equal(core.snapshot().chat.messages.length,4);
        await nav('home');await nav('chat');assert.equal(await evaluate(()=>document.querySelector('#chat-input').value),'停止後保留這個問題');
        win.setBounds({...bounds,width:640,height:480});await uiWait('Compact chat viewport',()=>window.innerWidth<=640);
        await uiWait('Composer remains in viewport',()=>{const input=document.querySelector('#chat-input').getBoundingClientRect(),button=document.querySelector('[data-action="chat-send"]').getBoundingClientRect();return input.top>=0&&button.bottom<=window.innerHeight&&document.documentElement.scrollWidth<=window.innerWidth;});
        await screenshot('27-chat-compact');
        const deletedId=core.snapshot().chatHistory.activeId;assert.equal(core.snapshot().chatHistory.conversations.length,1);
        if(await evaluate(()=>document.querySelector('[data-action="chat-history-toggle"]')?.getAttribute('aria-expanded')!=='true'))await click('[data-action="chat-history-toggle"]');
        await uiWait('History is visible before deleting the last conversation',()=>{const panel=document.querySelector('#chat-history-panel');return panel&&!panel.hidden&&panel.getBoundingClientRect().height>0;});
        await click('[data-action="chat-delete"][data-id="'+deletedId+'"]');await uiWait('Delete conversation confirmation appears',()=>!!document.querySelector('[data-action="confirm-chat-delete"]'));
        await click('[data-action="confirm-chat-delete"]');
        await waitFor('Last conversation is replaced by one empty conversation',()=>{const {chat,chatHistory}=core.snapshot();return chatHistory.conversations.length===1&&chatHistory.activeId!==deletedId&&chat.messages.length===0&&!chat.draft.trim()&&!chat.pendingText.trim()&&chat.status!=='running';});
        await uiWait('Deleting the last conversation leaves new disabled and no clear control',()=>document.querySelector('#mf-overlay').hidden&&document.querySelectorAll('.mf-chat-message').length===0&&document.querySelector('#chat-input')?.value===''&&document.querySelector('[data-action="chat-new"]')?.disabled===true&&!document.querySelector('[data-action="chat-clear"]'));
      }finally{
        core.cancelChat();for(const request of requests)request.resolve({text:'fixture cleanup'});core.models.run=originalRun;win.setBounds(bounds);
        core.store.update(state=>{state.chat=saved.chat;state.chatHistory=saved.chatHistory;});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('chat history creates, renames, switches and deletes conversations without mixing drafts',async()=>{
      const saved=structuredClone({chat:core.store.read().chat,chatHistory:core.store.read().chatHistory}),bounds=win.getBounds();
      try{
        await nav('chat');const first=core.snapshot().chatHistory.activeId;
        const initialCount=core.snapshot().chatHistory.conversations.length;
        assert.equal(await evaluate(()=>document.querySelector('[data-action="chat-new"]')?.disabled),true);
        assert.equal(await evaluate(()=>!!document.querySelector('[data-action="chat-clear"]')),false);
        await setValue('#chat-input',' \n\t ');
        await uiWait('Whitespace-only draft keeps new conversation disabled',()=>document.querySelector('[data-action="chat-new"]')?.disabled===true);
        await evaluate(()=>document.querySelector('[data-action="chat-new"]').click());
        assert.equal(core.snapshot().chatHistory.activeId,first);assert.equal(core.snapshot().chatHistory.conversations.length,initialCount);
        await setValue('#chat-input','第一段還沒送出的草稿');
        await uiWait('Nonempty draft enables new conversation',()=>document.querySelector('[data-action="chat-new"]')?.disabled===false);
        await click('[data-action="chat-new"]');
        await waitFor('New conversation selected',()=>core.snapshot().chatHistory.activeId!==first);const second=core.snapshot().chatHistory.activeId;
        await uiWait('New conversation immediately has an empty composer and disables new',()=>document.querySelector('#chat-input')?.value===''&&document.querySelector('[data-action="chat-new"]')?.disabled===true);
        assert.equal(core.snapshot().chatHistory.conversations.length,initialCount+1);
        await setValue('#chat-input','第二段保留草稿');
        const showHistory=async()=>{if(await evaluate(()=>document.querySelector('[data-action="chat-history-toggle"]')?.getAttribute('aria-expanded')!=='true'))await click('[data-action="chat-history-toggle"]');await uiWait('History panel is visible',()=>{const panel=document.querySelector('#chat-history-panel');return panel&&!panel.hidden&&panel.getBoundingClientRect().height>0;});};
        await showHistory();await click('[data-action="chat-rename"][data-id="'+second+'"]');await uiWait('Rename dialog opened after saving the draft',()=>!!document.querySelector('#chat-rename-title'));await setValue('#chat-rename-title','Python 學習筆記');await click('[data-action="confirm-chat-rename"]');
        await waitFor('Conversation renamed',()=>core.snapshot().chatHistory.conversations.some(entry=>entry.id===second&&entry.title==='Python 學習筆記'));
        await uiWait('Rename dialog closed',()=>document.querySelector('#mf-overlay').hidden);await showHistory();await click('[data-action="chat-select"][data-id="'+first+'"]');
        await uiWait('Original draft restored',()=>document.querySelector('#chat-input')?.value==='第一段還沒送出的草稿');
        const stale=await ipcCall('chat.save',{id:second,text:'不得覆蓋目前對話'});assert.equal(stale.skipped,true);assert.equal(core.snapshot().chat.draft,'第一段還沒送出的草稿');
        await showHistory();await screenshot('30-chat-history');
        win.setBounds({...bounds,width:640,height:480});await uiWait('Compact history viewport',()=>window.innerWidth<=640);await pause(250);await showHistory();
        await pause(350);await uiWait('History stays above a visible composer',()=>{const button=document.querySelector('[data-action="chat-send"]').getBoundingClientRect();return !document.querySelector('#chat-history-panel').hidden&&button.bottom<=window.innerHeight&&document.documentElement.scrollWidth<=window.innerWidth;});await screenshot('31-chat-history-compact');
        await click('[data-action="chat-delete"][data-id="'+second+'"]');await uiWait('Delete confirmation opened after saving the draft',()=>!!document.querySelector('[data-action="confirm-chat-delete"]'));await click('[data-action="confirm-chat-delete"]');
        await waitFor('Only chosen conversation deleted',()=>!core.snapshot().chatHistory.conversations.some(entry=>entry.id===second));assert.equal(core.snapshot().chat.draft,'第一段還沒送出的草稿');
      }finally{core.cancelChat();win.setBounds(bounds);core.store.update(state=>{state.chat=saved.chat;state.chatHistory=saved.chatHistory;});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');}
    });

    await check('prompt debug saves one task, preserves tab drafts, restores defaults and reports service errors',async()=>{
      const saved=structuredClone(core.store.read().settings.llmPrompts),originalGet=actions['llm.prompts.get'];
      const variables={chat:['text'],polish:['text','use','tone'],mail:['referenceTime','date','recipient','sender','to','cc','lines'],translate:['text','sourceLanguage','targetLanguage']};
      const catalog={apiVersion:'1',limits:{system:12000,user:16000},tasks:Object.fromEntries(Object.entries(variables).map(([task,values])=>[task,{system:'Synthetic '+task+' default',user:task==='mail'?'{{lines}}':'{{text}}',variables:values,requiredVariables:[task==='mail'?'lines':'text']}]))};
      actions['llm.prompts.get']=()=>structuredClone(catalog);
      try{
        await settingsCategory('prompts');await click('[data-action="prompt-debug-open"]');await uiWait('Prompt editor loaded',()=>!!document.querySelector('#prompt-task')&&document.querySelector('#prompt-system')?.disabled===false);
        await setValue('#prompt-task','chat','change');await setValue('#prompt-system','Synthetic chat experiment');
        await setValue('#prompt-task','translate','change');await setValue('#prompt-system','Synthetic translation experiment');
        await setValue('#prompt-task','chat','change');assert.equal(await evaluate(()=>document.querySelector('#prompt-system').value),'Synthetic chat experiment');
        await click('[data-action="prompt-save"]');await waitFor('Only chat override saved',()=>core.snapshot().settings.llmPrompts.chat?.system==='Synthetic chat experiment');assert.equal(core.snapshot().settings.llmPrompts.translate,undefined);
        await setValue('#prompt-task','translate','change');assert.equal(await evaluate(()=>document.querySelector('#prompt-system').value),'Synthetic translation experiment');await click('[data-action="prompt-save"]');
        await waitFor('Translation override saved',()=>core.snapshot().settings.llmPrompts.translate?.system==='Synthetic translation experiment');
        await setValue('#prompt-task','chat','change');await click('[data-action="prompt-reset"]');await waitFor('Reset affects only the selected task',()=>!core.snapshot().settings.llmPrompts.chat&&core.snapshot().settings.llmPrompts.translate?.system==='Synthetic translation experiment');
        await uiWait('Default system prompt shown',()=>document.querySelector('#prompt-system')?.value==='Synthetic chat default');await screenshot('32-prompt-debug');
        actions['llm.prompts.get']=()=>{throw new Error('合成服務暫時無法連接');};await click('[data-action="prompt-refresh"]');
        await uiWait('Prompt service error is visible',()=>document.querySelector('#prompt-status')?.textContent.includes('合成服務暫時無法連接'));
        await click('[data-action="prompt-back"]');await uiWait('Prompt return selects the Prompt settings category',()=>document.querySelector('[data-settings-tab="prompts"]')?.getAttribute('aria-selected')==='true'&&document.querySelector('[data-settings-panel="prompts"]')?.checkVisibility());
      }finally{actions['llm.prompts.get']=originalGet;core.settings({llmPrompts:saved});await nav('home');}
    });

    await check('chat streaming updates one unfinished bubble and rejects stale or incomplete answers',async()=>{
      const saved=structuredClone(core.store.read()),originalRun=core.models.run,requests=[];
      core.models.run=(kind,request)=>new Promise((resolve,reject)=>requests.push({kind,...request,resolve,reject}));
      try{
        await nav('chat');const previousId=core.snapshot().chatHistory.activeId;
        await setValue('#chat-input','隔離串流測試前置草稿');
        await uiWait('Fixture draft permits a fresh conversation',()=>document.querySelector('[data-action="chat-new"]')?.disabled===false);
        await click('[data-action="chat-new"]');
        await waitFor('Fresh fixture conversation created',()=>core.snapshot().chatHistory.activeId!==previousId);
        await uiWait('Fresh fixture conversation rendered',id=>document.querySelector('#chat-history-list [data-action="chat-select"][aria-current="true"]')?.dataset.id===id&&!document.querySelector('#chat-input').readOnly,core.snapshot().chatHistory.activeId);
        await setValue('#chat-input','合成串流問題');await click('[data-action="chat-send"]');
        await waitFor('Streaming request starts',()=>requests.length===1&&core.snapshot().chat.status==='running');
        await uiWait('Unfinished assistant bubble exists',()=>!!document.querySelector('#chat-stream-message'));
        await evaluate(()=>{window.smokeChatInput=document.querySelector('#chat-input');window.smokeChatInput.focus();});
        requests[0].onDelta('第一段測試回覆');
        await uiWait('First delta is visible before completion',()=>document.querySelector('#chat-stream-text')?.textContent==='第一段測試回覆');
        assert.equal(core.snapshot().chat.messages.length,0);assert(await evaluate(()=>document.querySelector('#chat-input')===window.smokeChatInput&&document.activeElement===window.smokeChatInput));
        const stream=core.snapshot().chat,activeId=core.snapshot().chatHistory.activeId;
        win.webContents.send('ufriend:chat-stream',{conversationId:activeId,streamId:'stale-stream',partialText:'過期內容'});await pause(100);
        assert.equal(await evaluate(()=>document.querySelector('#chat-stream-text').textContent),'第一段測試回覆');
        await nav('home');requests[0].onDelta('，第二段。');await pause(100);await nav('chat');
        await uiWait('Stream survives navigation',()=>document.querySelector('#chat-stream-text')?.textContent==='第一段測試回覆，第二段。');await screenshot('33-chat-streaming');
        requests[0].resolve({text:'第一段測試回覆，第二段。',meta:{model:'fixture',backend:'isolated-smoke'}});
        await waitFor('Complete answer saved',()=>core.snapshot().chat.status==='done');await uiWait('Unfinished bubble removed',()=>!document.querySelector('#chat-stream-message'));assert.equal(core.snapshot().chat.messages.length,2);
        await setValue('#chat-input','第二個合成問題');await click('[data-action="chat-send"]');await waitFor('Next stream starts',()=>requests.length===2);
        requests[1].onDelta('尚未完成的回答');await uiWait('Second partial visible',()=>document.querySelector('#chat-stream-text')?.textContent==='尚未完成的回答');
        const requestId='05a5d764-104b-4e81-b5cc-30c849bfcbf5';requests[1].reject(Object.assign(new Error('fixture truncated'),{code:'MODEL_OUTPUT_LIMIT',requestId}));
        await waitFor('Output limit is reported',()=>core.snapshot().chat.status==='error');
        await uiWait('Error code and request ID are visible',()=>document.querySelector('#chat-error-details')?.textContent.includes('MODEL_OUTPUT_LIMIT')&&document.querySelector('#chat-error-details')?.textContent.includes('05a5d764'));
        assert.equal(core.snapshot().chat.messages.length,2);assert.equal(core.snapshot().chat.draft,'第二個合成問題');assert(!await evaluate(()=>!!document.querySelector('#chat-stream-message')));await screenshot('34-chat-stream-error');
        win.webContents.send('ufriend:chat-stream',{conversationId:activeId,streamId:stream.streamId,partialText:'舊完成後回覆'});await pause(100);assert(!await evaluate(()=>document.querySelector('#chat-log').textContent.includes('舊完成後回覆')));
      }finally{core.cancelChat();core.models.run=originalRun;core.store.update(state=>{state.chat=saved.chat;state.chatHistory=saved.chatHistory;});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');}
    });

    await check('diagnostic controls open and export safely and record content-free errors',async()=>{
      const open=actions['diagnostics.open'],exportLogs=actions['diagnostics.export'];let opens=0,exports=0;
      actions['diagnostics.open']=()=>{opens++;return{opened:true};};actions['diagnostics.export']=()=>{exports++;return{cancelled:true};};
      try{
        await settingsCategory('diagnostics');await uiWait('Diagnostic location is visible',()=>document.querySelector('#diagnostics-directory')?.checkVisibility()&&document.querySelector('#diagnostics-directory').textContent.includes('diagnostics'));
        await click('[data-action="diagnostics-open"]');await waitFor('Open diagnostic folder action',()=>opens===1);
        await click('[data-action="diagnostics-export"]');await waitFor('Export diagnostic action',()=>exports===1);
        await nav('logs');await uiWait('System log has diagnostic controls',()=>!!document.querySelector('[data-action="diagnostics-export"]'));await screenshot('35-diagnostics');
        const before=(await diagnostics.export()).entries.length;
        await evaluate(()=>{const expected='PRIVATE_SMOKE_ERROR_BODY',index=window.__smokeErrors?.length||0;window.dispatchEvent(new ErrorEvent('error',{message:expected,error:Object.assign(new Error(expected),{code:'MODEL_INVALID_OUTPUT'}),lineno:7,colno:9}));if(window.__smokeErrors?.[index]===expected)window.__smokeErrors.splice(index,1);});
        await waitFor('Renderer error report reaches diagnostics',async()=>{await diagnostics.flush();return(await diagnostics.export()).entries.slice(before).some(entry=>entry.event==='renderer.error');});
        const rejected=await evaluate(()=>window.ufriend.request('llm.prompts.save',{task:'chat',system:'PRIVATE_SMOKE_PROMPT_BODY',user:'missing-variable'}));assert.equal(rejected.ok,false);
        const exported=await diagnostics.export(),raw=JSON.stringify(exported);assert(!raw.includes('PRIVATE_SMOKE_ERROR_BODY'));assert(!raw.includes('PRIVATE_SMOKE_PROMPT_BODY'));assert(exported.entries.some(entry=>entry.event==='ipc.failed'&&entry.action==='llm.prompts.save'));
        actions['diagnostics.open']=()=>{throw new Error('合成資料夾開啟失敗');};await click('[data-action="diagnostics-open"]');await uiWait('Opening error is visible',()=>document.querySelector('#mf-toast')?.textContent.includes('合成資料夾開啟失敗'));
      }finally{actions['diagnostics.open']=open;actions['diagnostics.export']=exportLogs;await nav('home');}
    });

    await check('OCR and recording progress survive navigation and update focused result dialogs', async () => {
      const saved=structuredClone(core.store.read()),originalRun=core.models.run,requests=[];
      core.models.run=(kind,request)=>new Promise((resolve,reject)=>requests.push({kind,...request,resolve,reject}));
      try{
        await actions['ocr.import']({paths:[path.join(projectDir,'app','assets','ufriend.png')]});await nav('ocr');
        await uiWait('Imported OCR image enables recognition',()=>document.querySelector('[data-action="ocr-start"]')?.disabled===false);
        await click('[data-action="ocr-start"]');
        await waitFor('OCR fixture starts',()=>requests.length===1);await nav('home');assert.equal(requests[0].signal.aborted,false);
        await nav('ocr');await evaluate(()=>document.querySelector('#ocr-text').focus());
        requests[0].resolve({text:'公告：明天 15:00 前回覆。',regions:[],meta:{model:'fixture',backend:'isolated-smoke'}});
        await uiWait('Focused OCR result updates',()=>document.querySelector('#ocr-text')?.value==='公告：明天 15:00 前回覆。'&&!document.querySelector('#ocr-text').readOnly);
        await screenshot('28-ocr-result');
        const wav=path.join(fixtureDir,'progress-meeting.wav');await fs.writeFile(wav,silentWav());
        const imported=await actions['media.import']({paths:[wav],language:'zh-TW'}),id=imported.imported[0];
        await nav('meetings');await uiWait('Imported recording appears',id=>!!document.querySelector('[data-action="media-start"][data-id="'+id+'"]'),id);
        await click('[data-action="media-start"][data-id="'+id+'"]');await waitFor('ASR fixture starts',()=>requests.length===2);
        requests[1].onProgress(50,{processedSeconds:1.5,durationSeconds:3});await nav('home');await nav('meetings');
        await uiWait('Recording progress persists across navigation',()=>document.querySelector('.mf-meeting-fill')?.style.width==='50%');
        await click('[data-action="media-open"][data-id="'+id+'"]');
        assert.equal(await evaluate(()=>document.querySelector('#recording-language').disabled),true);
        requests[1].resolve({segments:[{start:0,end:1,text:'明天下午三點開會。'},{start:1.1,end:2.5,text:'請帶展示資料。'}],language:'zh',duration:3,meta:{model:'fixture',backend:'isolated-smoke'}});
        await uiWait('Open media dialog receives completed timed transcript',()=>document.querySelectorAll('#recording-transcript [data-action="seek-media"]').length===2&&!document.querySelector('[data-action="export-srt"]').disabled);
        await screenshot('29-recording-complete');await closeModal();
        const silent=await actions['media.import']({paths:[wav],language:'en'}),silentId=silent.imported[0];
        await uiWait('Silent recording fixture appears',id=>!!document.querySelector('[data-action="media-start"][data-id="'+id+'"]'),silentId);
        await click('[data-action="media-start"][data-id="'+silentId+'"]');await waitFor('Silent fixture starts',()=>requests.length===3);
        requests[2].resolve({segments:[],language:'en',duration:3,meta:{model:'fixture',backend:'isolated-smoke'}});
        await waitFor('Silent fixture completes honestly',()=>core.snapshot().recordings.find(r=>r.id===silentId)?.state==='no-speech');
        await uiWait('Silent recording can retry on its card',id=>!!document.querySelector('[data-action="media-start"][data-id="'+id+'"]'),silentId);
        await click('[data-action="media-open"][data-id="'+silentId+'"]');
        await uiWait('Silent recording can retry in its dialog',()=>!!document.querySelector('#mf-overlay [data-action="media-start"]'));
        await closeModal();
      }finally{
        core.cancelOcr();for(const key of [...core.active.keys()])if(key.startsWith('recording:'))core.pauseRecording(key.slice(10));
        for(const request of requests)request.resolve(request.kind==='ocr'?{text:'fixture cleanup'}:{segments:[]});core.models.run=originalRun;
        core.store.update(state=>{for(const key of ['ocr','recordings','assets'])state[key]=saved[key];});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('native meeting file drops stage language selection and preserve active dialogs', async () => {
      const saved=structuredClone(core.store.read()),size=win.getSize(),originalImport=actions['media.import'],originalChoose=actions['media.choose'],originalRun=core.models.run;
      const calls=[],results=[],files=Array.from({length:5},(_,i)=>path.join(fixtureDir,'拖入 合成會議 '+(i+1)+'.wav'));
      const unsupported=path.join(fixtureDir,'unsupported-drop.txt'),empty=path.join(fixtureDir,'empty-drop.wav');
      for(let i=0;i<files.length;i++)await fs.writeFile(files[i],silentWav(i+3));
      await fs.writeFile(unsupported,'Synthetic unsupported media.');await fs.writeFile(empty,Buffer.alloc(0));
      let releaseImport,holdNextImport=false,modelCalls=0;
      const allowedFiles=new Set([...files,unsupported,empty].map(file=>path.resolve(file))),inFlightImports=new Set();
      actions['media.import']=args=>{
        assert(Array.isArray(args?.paths)&&args.paths.length>0,'A native drop must supply paths instead of opening a real file dialog.');
        assert(args.paths.every(file=>typeof file==='string'&&allowedFiles.has(path.resolve(file))),'Drop imports may read only the synthetic files created by this scenario.');
        const pending=(async()=>{calls.push(structuredClone(args));if(holdNextImport){holdNextImport=false;await new Promise(resolve=>{releaseImport=resolve;});}const result=await originalImport(args);results.push(structuredClone(result));return result;})();
        inFlightImports.add(pending);pending.then(()=>inFlightImports.delete(pending),()=>inFlightImports.delete(pending));return pending;
      };
      core.models.run=async()=>{modelCalls++;throw new Error('A file drop must not start model inference.');};
      const attachedDebugger=!win.webContents.debugger.isAttached();
      const beginDrag=async(paths,selector='#mf-page',items=[])=>{
        const point=await evaluate(selector=>{const el=document.querySelector(selector);el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};},selector);
        const drag={...point,data:{items,files:paths,dragOperationsMask:1}};
        for(const type of ['dragEnter','dragOver'])await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,...drag});return drag;
      };
      const endDrag=async(drag,type='drop')=>{
        // CDP dragCancel alone emits no DOM leave event. Moving outside the
        // viewport first exercises the same dragleave path as leaving a window.
        if(type==='dragCancel')await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type:'dragOver',...drag,x:-10,y:-10});
        return win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,...drag});
      };
      const nativeDrop=async(paths,selector)=>endDrag(await beginDrag(paths,selector));
      const hiddenFeedback=()=>uiWait('File drag feedback resets',()=>!document.querySelector('#media-drag-feedback')?.checkVisibility());
      const imported=async(count)=>{await waitFor('Native drop import settles',()=>results.length===count);await uiWait('Media import returns to idle',()=>![...document.querySelectorAll('[data-media-import-status]')].some(el=>el.checkVisibility()&&el.textContent.trim()));};
      const staged=async(paths,count,language='zh-TW')=>{
        await uiWait('Dropped files wait for language and scheduling confirmation',(names,language)=>{
          const overlay=document.querySelector('#mf-overlay');return !overlay.hidden&&document.querySelector('#upload-language')?.value===language&&document.querySelector('#upload-transcription')?.value==='manual'&&names.every(name=>overlay.textContent.includes(name))&&document.querySelector('[data-action="confirm-media-import"]')?.disabled===false;
        },paths.map(file=>path.basename(file)),language);
        assert.equal(calls.length,count,'Staging a drop must not copy files or invoke media.import before confirmation.');
        assert.equal(modelCalls,0,'Staging a drop must not start transcription.');
      };
      const visuals=async state=>{
        for(const theme of ['light','dark'])for(const [width,height]of [[1080,820],[640,480]]){
          win.setSize(width,height);await actions['settings.save']({theme});await uiWait('Drop visual theme updates',theme=>document.querySelector('#ufriend-app').style.colorScheme===theme,theme);
          assert(await evaluate(()=>document.querySelector('#meeting-drop-zone')?.checkVisibility()&&['#ufriend-app','#mf-page'].every(selector=>{const el=document.querySelector(selector);return el.scrollWidth<=el.clientWidth+1;})),'The meeting drop invitation remains visible without horizontal overflow.');
          const captureDrag=(width===640&&theme==='light')||(width===1080&&theme==='dark');
          if(!captureDrag)await screenshot('41-meeting-drop-'+state+'-'+width+'x'+height+'-'+theme+'-idle');
          const drag=await beginDrag([files[0]],'#mf-top');
          await uiWait('A file dragged outside the banner shows the full-window invitation',()=>{const feedback=document.querySelector('#media-drag-feedback');return feedback?.checkVisibility()&&feedback.textContent.includes('放開即可匯入影音檔案')&&getComputedStyle(feedback).pointerEvents==='none';});
          if(captureDrag)await screenshot('41-meeting-drop-'+state+'-'+width+'x'+height+'-'+theme+'-drag');
          await endDrag(drag,'dragCancel');await hiddenFeedback();
        }
        win.setSize(...size);await actions['settings.save']({theme:saved.settings.theme});
      };
      try{
        if(attachedDebugger)win.webContents.debugger.attach('1.3');
        core.store.update(state=>{state.recordings=[];});win.webContents.send('ufriend:change',actions.bootstrap());await nav('meetings');
        await visuals('empty');assert.equal(calls.length,0,'Cancelling file drags must not import anything.');
        const navigationDrag=await beginDrag([files[0]]);await nav('home');await hiddenFeedback();await endDrag(navigationDrag,'dragCancel');await nav('meetings');
        await nativeDrop([files[0]],'#mf-page');await staged([files[0]],0);await hiddenFeedback();
        await setValue('#upload-language','ja','change');await closeModal();
        assert.equal(calls.length,0,'Cancelling a staged page drop must leave the media library untouched.');assert.equal(core.snapshot().recordings.length,0);
        await nativeDrop([files[0]],'#mf-page');await staged([files[0]],0);await setValue('#upload-language','en','change');
        await screenshot('46-meeting-drop-confirm-language');await click('[data-action="confirm-media-import"]');await imported(1);
        assert.deepEqual(calls[0].paths,[files[0]],'Native File objects must reach the original local paths through preload.');assert.equal(calls[0].language,'en');
        assert.equal(results[0].imported.length,1);assert.deepEqual(results[0].errors,[]);
        const firstId=results[0].imported[0],first=core.snapshot().recordings.find(recording=>recording.id===firstId);
        assert.equal(first.name,path.basename(files[0]));assert.equal(first.state,'waiting-model');assert.equal(first.lang,'en');assert.deepEqual(first.segments,[]);
        assert.deepEqual(await fs.readFile(core.asset(first.assetId).path),await fs.readFile(files[0]),'A real drop must copy the original synthetic file bytes.');
        await uiWait('A native drop creates its visible meeting card',id=>!!document.querySelector('[data-action="media-open"][data-id="'+id+'"]'),firstId);
        await visuals('nonempty');
        await nativeDrop([files[1],unsupported,files[2]],'#mf-top');await staged([files[1],unsupported,files[2]],1);await click('[data-action="confirm-media-import"]');await imported(2);
        assert.deepEqual(calls[1].paths,[files[1],unsupported,files[2]]);assert.equal(calls[1].language,'zh-TW');assert.equal(results[1].imported.length,2);assert.equal(results[1].errors.length,1);assert.equal(core.snapshot().recordings.length,3);
        await uiWait('Batch feedback reports both successful and unsupported files',()=>{const text=document.querySelector('#mf-toast').textContent;return text.includes('2')&&text.includes('已匯入')&&text.includes('1')&&text.includes('未匯入')&&text.includes('unsupported-drop.txt');});
        await click('#meeting-drop-zone');await uiWait('Drop invitation also opens the file chooser dialog',()=>!!document.querySelector('#media-drop'));
        await setValue('#upload-language','en','change');
        await nativeDrop([unsupported,empty],'#media-drop');await staged([unsupported,empty],2,'en');await click('[data-action="confirm-media-import"]');await imported(3);
        assert.equal(results[2].imported.length,0);assert.equal(results[2].errors.length,2);
        assert(await evaluate(()=>document.querySelector('#upload-language')?.value==='en'&&!document.querySelector('#mf-overlay').hidden),'A fully rejected batch preserves the upload dialog and chosen language.');
        await closeModal();await click('#meeting-drop-zone');await setValue('#upload-language','en','change');
        await nativeDrop([files[3]],'#media-drop');await staged([files[3]],3,'en');await click('[data-action="confirm-media-import"]');await imported(4);
        assert.deepEqual(calls[3].paths,[files[3]]);assert.equal(calls[3].language,'en');assert.equal(core.snapshot().recordings.find(recording=>recording.id===results[3].imported[0]).lang,'en');
        await uiWait('A successful upload drop closes its own dialog',()=>document.querySelector('#mf-overlay').hidden);
        const beforeUnsupportedDrop=calls.length;
        await evaluate(()=>{const data=new DataTransfer();data.items.add(new File(['Synthetic browser-only bytes'],'browser-only.wav',{type:'audio/wav'}));document.querySelector('#mf-page').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});
        await uiWait('A browser-created File reports its missing local path',()=>{const text=document.querySelector('#mf-toast').textContent;return text.includes('無法讀取拖入的檔案')&&text.includes('檔案總管');});assert.equal(calls.length,beforeUnsupportedDrop);
        await evaluate(()=>{window.__smokeTextDrop=null;window.__smokeTextDropListener=event=>{window.__smokeTextDrop={prevented:event.defaultPrevented,types:[...event.dataTransfer.types]};};window.addEventListener('dragover',window.__smokeTextDropListener);});
        const textDrag=await beginDrag([],'#mf-page',[{mimeType:'text/plain',data:'Synthetic text drag'}]);await hiddenFeedback();await endDrag(textDrag);
        await uiWait('A plain text drag reaches the renderer without being captured',()=>window.__smokeTextDrop?.types.includes('text/plain'));
        assert.equal(await evaluate(()=>window.__smokeTextDrop.prevented),false);assert.equal(calls.length,beforeUnsupportedDrop);
        await click('[data-action="media-open"][data-id="'+firstId+'"]');await click('[data-action="transcript-edit"]');await setValue('#transcript-text','Synthetic unsaved transcript draft.');
        await evaluate(()=>{window.__smokeDropEditor=document.querySelector('#transcript-text');});
        const blocked=await beginDrag([files[4]],'#transcript-text');await hiddenFeedback();await endDrag(blocked);await pause(120);
        assert.equal(calls.length,beforeUnsupportedDrop);assert(await evaluate(()=>document.querySelector('#transcript-text')===window.__smokeDropEditor&&document.querySelector('#transcript-text').value==='Synthetic unsaved transcript draft.'),'Dropping files on a transcript editor must not import, close, or replace its unsaved draft.');await closeModal();
        holdNextImport=true;await nativeDrop([files[4]],'#mf-top');await staged([files[4]],4);await click('[data-action="confirm-media-import"]');await waitFor('A native drop reaches the controlled pending import',()=>!!releaseImport);
        const pendingCallCount=calls.length;await nativeDrop([files[0]],'#mf-top');await pause(120);assert.equal(calls.length,pendingCallCount,'Concurrent drops must not start duplicate imports.');
        await closeModal();await click('.mf-meeting-open[data-id="'+firstId+'"]');await evaluate(()=>{window.__smokeDropLaterPlayer=document.querySelector('#mf-overlay audio');});
        const release=releaseImport;releaseImport=null;release();await imported(5);
        assert(await evaluate(()=>!document.querySelector('#mf-overlay').hidden&&document.querySelector('#mf-overlay audio')===window.__smokeDropLaterPlayer),'Finishing a page drop must preserve a player opened after that import began.');await closeModal();
        holdNextImport=true;await nativeDrop([files[0],files[1]],'#mf-top');await staged([files[0],files[1]],5);await click('[data-action="confirm-media-import"]');await waitFor('A second background import is pending',()=>!!releaseImport);
        await nav('translation');await setValue('#translation-input','Synthetic translation draft during file import.');await evaluate(()=>{window.__smokeDropTranslation=document.querySelector('#translation-input');});
        const releaseBackground=releaseImport;releaseImport=null;releaseBackground();await imported(6);
        await uiWait('Background batch completion is reported',()=>document.querySelector('#mf-toast').textContent==='2 個檔案已匯入');
        assert(await evaluate(()=>document.querySelector('#translation-input')===window.__smokeDropTranslation&&document.querySelector('#translation-input').value==='Synthetic translation draft during file import.'),'Completing a background import must not rebuild or erase another page draft.');
        assert.equal(modelCalls,0,'Importing dropped files must not start Whisper or another model.');assert.equal(core.snapshot().recordings.length,7);
        await nav('meetings');await click('#meeting-drop-zone');await setValue('#upload-language','ja','change');
        let pickerCalls=0;actions['media.choose']=async()=>{pickerCalls++;return[files[4]];};
        await click('[data-action="choose-media"]');await staged([files[4]],6,'ja');assert.equal(pickerCalls,1,'The ordinary picker must use the same staged language confirmation.');
        await closeModal();assert.equal(calls.length,6,'Cancelling picker selection must not import files.');
        report.mediaFileDrop={nativeImports:calls.length,imported:results.map(result=>result.imported.length),errors:results.map(result=>result.errors.length),modelCalls};
      }finally{
        if(releaseImport){releaseImport();releaseImport=null;}
        await Promise.allSettled([...inFlightImports]);
        actions['media.import']=originalImport;actions['media.choose']=originalChoose;core.models.run=originalRun;
        await evaluate(()=>{if(window.__smokeTextDropListener)window.removeEventListener('dragover',window.__smokeTextDropListener);}).catch(()=>{});
        if(attachedDebugger&&win.webContents.debugger.isAttached())win.webContents.debugger.detach();
        win.setSize(...size);await actions['settings.save']({theme:saved.settings.theme});
        await nav('home');core.store.update(state=>{for(const key of ['recordings','assets','translation'])state[key]=saved[key];});win.webContents.send('ufriend:change',actions.bootstrap());
      }
    });

    await check('meeting transcription queues one job at a time and saves optional start times', async () => {
      const saved=structuredClone(core.store.read()),originalRun=core.models.run,originalChoose=actions['media.choose'],originalImport=actions['media.import'],originalRetryAt=core.recordingSchedulerRetryAt;
      const files=Array.from({length:4},(_,i)=>path.join(fixtureDir,'scheduled-meeting-'+(i+1)+'.wav')),requests=[],imports=[];
      for(const file of files)await fs.writeFile(file,silentWav());
      core.models.run=(kind,request)=>new Promise((resolve,reject)=>{assert.equal(kind,'whisper');assert.equal(request.task,'transcribe');requests.push({...request,resolve,reject});});
      actions['media.import']=async args=>{assert(args.paths.every(file=>files.includes(file)));const result=await originalImport(args);imports.push({args:structuredClone(args),result:structuredClone(result)});return result;};
      const record=id=>core.snapshot().recordings.find(recording=>recording.id===id);
      const complete=request=>request.resolve({segments:[{start:0,end:2,text:'Synthetic scheduled meeting transcript.'}],language:'en',duration:3});
      const choose=async paths=>{actions['media.choose']=async()=>paths;await click('#meeting-drop-zone');await click('[data-action="choose-media"]');await uiWait('Picker stages the requested files',names=>names.every(name=>document.querySelector('#mf-overlay').textContent.includes(name)),paths.map(file=>path.basename(file)));};
      const localDate=value=>{const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
      try{
        core.stopRecordingScheduler();core.store.update(state=>{state.recordings=[];});core.startRecordingScheduler();win.webContents.send('ufriend:change',actions.bootstrap());await nav('meetings');
        await choose(files.slice(0,3));await setValue('#upload-language','en','change');await setValue('#upload-transcription','queue','change');
        assert.equal(imports.length,0);assert.equal(requests.length,0);await click('[data-action="confirm-media-import"]');
        await waitFor('An imported batch starts only its first transcription',()=>imports.length===1&&requests.length===1);await uiWait('Queued import closes its staging dialog',()=>document.querySelector('#mf-overlay').hidden);
        const [first,second,third]=imports[0].result.imported;assert.equal(imports[0].args.transcription,'queue');assert.equal(record(first).state,'running');assert.equal(record(second).state,'queued');assert.equal(record(third).state,'queued');
        assert.equal(requests[0].input.filePath,core.asset(record(first).assetId).path);assert.equal(requests[0].input.language,'en');assert(record(second).queueOrder<record(third).queueOrder);
        assert(await evaluate(id=>document.querySelector('.mf-meeting-open[data-id="'+id+'"]')?.tagName==='BUTTON',second),'The meeting card content must expose a keyboard-accessible button.');
        await click('.mf-meeting-open[data-id="'+second+'"]');await uiWait('Clicking meeting card content opens its result',()=>!!document.querySelector('#recording-transcript'));
        await closeModal();const secondBefore=record(second),secondBytes=await fs.readFile(core.asset(secondBefore.assetId).path);
        await click('[data-action="media-pause"][data-id="'+second+'"]');await waitFor('A queued recording cancels without starting',()=>record(second).state==='paused');
        assert.equal(requests.length,1);assert.equal(record(second).assetId,secondBefore.assetId);assert.deepEqual(await fs.readFile(core.asset(record(second).assetId).path),secondBytes);
        assert.deepEqual(record(second).segments,[]);assert(!record(second).scheduledAt&&!record(second).queuedAt,'Cancelling must clear persisted queue intent.');
        assert(await evaluate(()=>document.querySelector('#mf-overlay').hidden),'A card action must not also open the recording dialog.');
        await click('[data-action="media-start"][data-id="'+second+'"]');await waitFor('A cancelled job can rejoin the back of the queue',()=>record(second).state==='queued'&&record(second).queueOrder>record(third).queueOrder);
        await screenshot('47-meeting-transcription-queue');complete(requests[0]);
        await waitFor('Finishing the first job advances FIFO to the third imported file',()=>requests.length===2);assert.equal(record(first).state,'done');assert.equal(requests[1].input.filePath,core.asset(record(third).assetId).path);assert.equal(record(second).state,'queued');
        complete(requests[1]);await waitFor('FIFO then advances to the requeued second file',()=>requests.length===3);assert.equal(requests[2].input.filePath,core.asset(record(second).assetId).path);
        complete(requests[2]);await waitFor('All queued recordings finish',()=>[first,second,third].every(id=>record(id).state==='done')&&!core.recordingSchedulerBusy&&!core.recordingModelWork?.size);
        await choose([files[3]]);await setValue('#upload-transcription','schedule','change');await setValue('#upload-scheduled-at',localDate(Date.now()-3600000),'change');
        await click('[data-action="confirm-media-import"]');await pause(100);assert.equal(imports.length,1,'A past start time must be rejected before copying media.');assert.equal(requests.length,3);assert(await evaluate(()=>document.querySelector('#upload-scheduled-at')?.checkVisibility()));
        const future=localDate(Date.now()+3600000);await setValue('#upload-scheduled-at',future,'change');await click('[data-action="confirm-media-import"]');await waitFor('An upload saves its future transcription time',()=>imports.length===2);
        const scheduled=imports[1].result.imported[0],futureIso=new Date(future).toISOString();await uiWait('Scheduled upload closes its dialog',()=>document.querySelector('#mf-overlay').hidden);
        assert.equal(record(scheduled).state,'scheduled');assert.equal(record(scheduled).scheduledAt,futureIso);assert.equal(imports[1].args.transcription,'schedule');assert.equal(requests.length,3,'A future upload must not start early.');
        const persisted=JSON.parse(await fs.readFile(core.store.file,'utf8')).recordings.find(recording=>recording.id===scheduled);assert.equal(persisted.state,'scheduled');assert.equal(persisted.scheduledAt,futureIso);
        await nav('home');await nav('meetings');await click('[data-action="media-schedule"][data-id="'+scheduled+'"]');await uiWait('Saved scheduling controls reopen',()=>!!document.querySelector('#recording-scheduled-at'));
        assert.equal(await evaluate(()=>document.querySelector('#recording-scheduled-at').value),future);const beforeCancel=structuredClone(record(scheduled));
        await setValue('#recording-scheduled-at',localDate(Date.now()+7200000),'change');await click('[data-action="cancel-media-schedule"]');await uiWait('Cancelling schedule edits closes the dialog',()=>document.querySelector('#mf-overlay').hidden);assert.deepEqual(record(scheduled),beforeCancel,'Dismissing an edited schedule must retain the saved start time.');
        await click('[data-action="media-pause"][data-id="'+scheduled+'"]');await waitFor('Cancelling a future schedule retains the recording',()=>record(scheduled).state==='paused');assert.equal(record(scheduled).assetId,beforeCancel.assetId);assert(!record(scheduled).scheduledAt);assert.equal(requests.length,3);
        await click('[data-action="media-schedule"][data-id="'+scheduled+'"]');await setValue('#schedule-mode','schedule','change');await setValue('#recording-scheduled-at',localDate(Date.now()-3600000),'change');await click('[data-action="confirm-media-schedule"]');await pause(100);assert.equal(record(scheduled).state,'paused');assert.equal(requests.length,3);
        await setValue('#schedule-mode','queue','change');await click('[data-action="confirm-media-schedule"]');await waitFor('The schedule dialog can queue a recording immediately',()=>requests.length===4);assert.equal(requests[3].input.filePath,core.asset(record(scheduled).assetId).path);
        complete(requests[3]);await waitFor('The formerly scheduled recording completes',()=>record(scheduled).state==='done'&&!core.recordingSchedulerBusy&&!core.recordingModelWork?.size);
        let retryClock=Date.now();core.startRecordingScheduler({now:()=>retryClock});core.saveTranscript(scheduled,{format:'txt',text:''});
        await uiWait('A cleared synthetic transcript can be queued again',id=>!!document.querySelector('[data-action="media-start"][data-id="'+id+'"]'),scheduled);
        await click('[data-action="media-start"][data-id="'+scheduled+'"]');await waitFor('The busy-service fixture starts',()=>requests.length===5);
        requests[4].reject(Object.assign(new Error('Synthetic service occupied by another request.'),{code:'MODEL_API_BUSY'}));
        await waitFor('A busy service preserves retry intent in the queue',()=>record(scheduled).state==='queued'&&!!record(scheduled).queueRetryAt&&!core.recordingSchedulerBusy&&!core.recordingModelWork?.size);
        const retryAt=record(scheduled).queueRetryAt;assert(Date.parse(retryAt)>retryClock);
        await uiWait('The queued card explains that the busy service will retry automatically',id=>document.querySelector('.mf-meeting-open[data-id="'+id+'"]')?.textContent.includes('自動重試'),scheduled);
        await actions['settings.save']({uiLanguage:'en'});await uiWait('The busy retry notice follows the English interface language',id=>{const text=document.querySelector('.mf-meeting-open[data-id="'+id+'"]')?.textContent||'';return /busy/i.test(text)&&/retry/i.test(text)&&!text.includes('語音服務忙碌中');},scheduled);
        await actions['settings.save']({uiLanguage:saved.settings.uiLanguage});await uiWait('The busy notice returns to the original interface language',id=>document.querySelector('.mf-meeting-open[data-id="'+id+'"]')?.textContent.includes('自動重試'),scheduled);
        await click('[data-action="media-pause"][data-id="'+scheduled+'"]');await waitFor('Cancelling a busy retry clears its saved error and timer intent',()=>record(scheduled).state==='paused'&&record(scheduled).error===''&&!record(scheduled).queueRetryAt);
        await uiWait('A cancelled card no longer claims that it will retry',id=>{const card=document.querySelector('.mf-meeting-open[data-id="'+id+'"]');return card?.textContent.includes('已暫停')&&!card.textContent.includes('自動重試');},scheduled);
        retryClock=Date.parse(retryAt)+1;core.wakeRecordingScheduler();await pause(100);assert.equal(requests.length,5,'Advancing past a cancelled retry must not submit another model request.');
        core.stopRecordingScheduler();const rankingNow=Date.now();
        core.store.update(state=>{for(const [id,queueOrder,scheduledAt]of [[first,1,new Date(rankingNow-60000).toISOString()],[second,2,null],[third,0,new Date(rankingNow+3600000).toISOString()]])Object.assign(state.recordings.find(recording=>recording.id===id),{state:scheduledAt?'scheduled':'queued',queueOrder,scheduledAt,queuedAt:new Date(rankingNow-120000).toISOString(),segments:[],textOnly:null,transcriptSource:null,error:''});});
        win.webContents.send('ufriend:change',actions.bootstrap());await uiWait('Expired scheduled work participates in queue ranking while future work remains scheduled',(first,second,third)=>{const label=id=>document.querySelector('.mf-meeting-open[data-id="'+id+'"]')?.textContent||'';return label(first).includes('排隊第 1 個')&&label(second).includes('排隊第 2 個')&&label(third).includes('已排程')&&!label(third).includes('排隊第');},first,second,third);
        assert.equal(requests.length,5);report.meetingScheduling={transcriptions:requests.length,fifo:[first,third,second],futureSaved:futureIso,cancelPreservedMedia:true,invalidTimeDidNotImport:true,busyRetryCancellation:true,busyNoticeEnglish:true,expiredScheduleRanking:true};
      }finally{
        core.stopRecordingScheduler();for(const key of [...core.active.keys()])if(key.startsWith('recording:'))core.pauseRecording(key.slice(10));for(const request of requests)complete(request);
        await waitFor('Synthetic transcription work settles before restoring fixtures',()=>!core.recordingSchedulerBusy&&!core.recordingModelWork?.size);
        core.models.run=originalRun;actions['media.choose']=originalChoose;actions['media.import']=originalImport;
        await actions['settings.save']({uiLanguage:saved.settings.uiLanguage});
        await nav('home');core.store.update(state=>{for(const key of ['recordings','assets'])state[key]=saved[key];});if(originalRetryAt===undefined)delete core.recordingSchedulerRetryAt;else core.recordingSchedulerRetryAt=originalRetryAt;core.startRecordingScheduler();win.webContents.send('ufriend:change',actions.bootstrap());
      }
    });

    await check('long MP3 player seeks in both directions and follows completed transcript timestamps', async () => {
      const saved=structuredClone(core.store.read()),originalRun=core.models.run;
      const mp3=path.join(fixtureDir,'seeking-11m47.mp3'),duration=707,requests=[];
      const generated=spawnSync(fixtureFfmpeg,[
        '-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=24000:cl=mono',
        '-t',String(duration),'-codec:a','libmp3lame','-b:a','32k','-y',mp3
      ],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
      if(generated.error?.code==='ENOENT')throw Object.assign(new Error('MP3 seeking verification requires the prepared project FFmpeg runtime or UFRIEND_TEST_FFMPEG; no audio was downloaded and this scenario could not be verified.'),{code:'SMOKE_UNSUPPORTED'});
      assert.equal(generated.error,undefined,'Synthetic MP3 generation must finish: '+generated.error?.message);
      assert.equal(generated.status,0,'Synthetic MP3 generation failed: '+generated.stderr);
      report.mediaSeeking={format:'mp3',duration,steps:[]};
      core.models.run=(kind,request)=>new Promise((resolve,reject)=>requests.push({kind,...request,resolve,reject}));
      const attachedDebugger=!win.webContents.debugger.isAttached();
      const sample=()=>evaluate(()=>{const media=document.querySelector('#mf-overlay audio'),ranges=value=>Array.from({length:value.length},(_,i)=>[value.start(i),value.end(i)]);return{duration:media.duration,currentTime:media.currentTime,readyState:media.readyState,seeking:media.seeking,paused:media.paused,error:media.error?.code||null,seekable:ranges(media.seekable),buffered:ranges(media.buffered),events:window.__smokeMediaSeek.events};});
      const observeSeeks=()=>evaluate(()=>{
        const media=document.querySelector('#mf-overlay audio');media.muted=true;
        const observation={element:media,events:[]};window.__smokeMediaSeek=observation;
        for(const type of ['seeking','seeked'])media.addEventListener(type,()=>{observation.events.push({type,time:media.currentTime});});
      });
      const resetSeek=()=>evaluate(()=>{const media=document.querySelector('#mf-overlay audio');media.pause();window.__smokeMediaSeek.events=[];});
      const expectSeek=async(label,min,max)=>{
        try{await uiWait(label,(min,max)=>{const media=document.querySelector('#mf-overlay audio');return window.__smokeMediaSeek.events.some(event=>event.type==='seeked')&&!media.seeking&&media.readyState>=2&&media.currentTime>=min&&media.currentTime<=max;},min,max);}
        catch(error){report.mediaSeeking.steps.push({label,failed:true,...await sample()});throw error;}
        const settled=await sample();assert.equal(settled.error,null);assert.equal(settled.paused,true);
        assert(settled.events.some(event=>event.type==='seeking'),'A real seek operation must occur.');
        report.mediaSeeking.steps.push({label,...settled});
      };
      try{
        if(attachedDebugger)win.webContents.debugger.attach('1.3');
        const imported=await actions['media.import']({paths:[mp3],language:'en'});assert.deepEqual(imported.errors,[]);assert.equal(imported.imported.length,1);
        const id=imported.imported[0];await nav('meetings');
        await uiWait('Long MP3 appears in the isolated recording list',id=>!!document.querySelector('[data-action="media-start"][data-id="'+id+'"]'),id);
        await click('[data-action="media-start"][data-id="'+id+'"]');await waitFor('Synthetic long recording transcription starts',()=>requests.length===1);
        assert.equal(requests[0].kind,'whisper');requests[0].onProgress(50,{processedSeconds:353.5,durationSeconds:duration});
        await click('[data-action="media-open"][data-id="'+id+'"]');
        await uiWait('Long MP3 metadata loads',duration=>{const media=document.querySelector('#mf-overlay audio');return media?.readyState>=1&&Math.abs(media.duration-duration)<0.1;},duration);
        await observeSeeks();
        await uiWait('A long MP3 exposes its entire seekable range',duration=>{const media=document.querySelector('#mf-overlay audio');return media.seekable.length>0&&media.seekable.start(0)<=0.1&&media.seekable.end(media.seekable.length-1)>=duration-0.1;},duration);
        report.mediaSeeking.initial=await sample();
        for(const target of [530,120]){
          await resetSeek();await evaluate(target=>{document.querySelector('#mf-overlay audio').currentTime=target;},target);
          await expectSeek('Long MP3 currentTime settles at '+target+' seconds',target-0.2,target+0.2);
        }
        requests[0].resolve({segments:[{start:120,end:125,text:'合成測試：較早的時間點。'},{start:530,end:535,text:'合成測試：較晚的時間點。'}],language:'en',duration,meta:{model:'synthetic-fixture',backend:'isolated-smoke'}});
        await uiWait('Long MP3 receives a completed transcript',()=>document.querySelectorAll('#recording-transcript [data-action="seek-media"]').length===2&&document.querySelector('#recording-status').textContent==='已完成 · 結果來源：本地');
        assert(await evaluate(()=>document.querySelector('#mf-overlay audio')===window.__smokeMediaSeek.element),'Completing transcription must preserve the existing player.');
        await evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
        await pause(200);
        // Chromium owns the native controls. Inspect its timeline node to click
        // the real slider, so assigning currentTime cannot mask a broken UI.
        const tree=await win.webContents.debugger.sendCommand('DOM.getDocument',{depth:-1,pierce:true});let timeline;
        const visit=node=>{const attrs=node.attributes||[];for(let i=0;i<attrs.length;i+=2)if(attrs[i]==='pseudo'&&attrs[i+1]==='-webkit-media-controls-timeline')timeline=node;for(const child of [...(node.children||[]),...(node.shadowRoots||[])])visit(child);};visit(tree.root);
        assert(timeline,'The visible native audio timeline must be available for pointer interaction.');
        const {model}=await win.webContents.debugger.sendCommand('DOM.getBoxModel',{nodeId:timeline.nodeId}),box=model.content;
        const left=Math.min(box[0],box[2],box[4],box[6]),right=Math.max(box[0],box[2],box[4],box[6]),y=(Math.min(box[1],box[3],box[5],box[7])+Math.max(box[1],box[3],box[5],box[7]))/2;
        for(const fraction of [.75,.2]){
          await resetSeek();const x=left+(right-left)*fraction;
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
          await expectSeek('Native MP3 timeline reaches '+Math.round(fraction*100)+' percent',duration*(fraction-.05),duration*(fraction+.05));
        }
        await resetSeek();
        const dragStart=left+(right-left)*.2,dragEnd=left+(right-left)*.6;
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:dragStart,y,button:'left',buttons:1,clickCount:1});
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragEnd,y,button:'left',buttons:1});
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragEnd,y,button:'left',buttons:0,clickCount:1});
        await expectSeek('Native MP3 timeline drags from 20 to 60 percent',duration*.55,duration*.65);
        for(const target of [530,120]){
          await resetSeek();await click('[data-action="seek-media"][data-time="'+target+'"]');
          await expectSeek('Completed transcript jumps to '+target+' seconds',target-0.2,target+0.2);
        }
        await screenshot('40-long-mp3-seeking');await closeModal();
        await click('[data-action="media-open"][data-id="'+id+'"]');
        await uiWait('Reopened MP3 starts with fresh playback state',duration=>{const media=document.querySelector('#mf-overlay audio');return media?.readyState>=1&&Math.abs(media.duration-duration)<0.1&&media.currentTime<0.1&&media.seekable.length>0&&media.seekable.end(media.seekable.length-1)>=duration-0.1;},duration);
        assert(await evaluate(()=>document.querySelector('#mf-overlay audio')!==window.__smokeMediaSeek.element),'Reopening must create a fresh player without an earlier seek state.');
        await observeSeeks();await click('[data-action="seek-media"][data-time="530"]');
        await expectSeek('Reopened transcript player still jumps to 530 seconds',529.8,530.2);
        await closeModal();
        assert.deepEqual(report.rendererErrors,[],'Closing and reopening a player must not emit renderer errors.');
      }finally{
        for(const key of [...core.active.keys()])if(key.startsWith('recording:'))core.pauseRecording(key.slice(10));
        for(const request of requests)request.resolve({segments:[]});core.models.run=originalRun;
        await evaluate(()=>document.querySelector('#mf-overlay audio')?.pause()).catch(()=>{});
        if(attachedDebugger&&win.webContents.debugger.isAttached())win.webContents.debugger.detach();
        core.store.update(state=>{for(const key of ['recordings','assets'])state[key]=saved[key];});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('meeting videos use side by side transcripts and native CC captions while preserving playback', async () => {
      const saved=structuredClone(core.store.read()),size=win.getSize(),originalRun=core.models.run,videoFile=path.join(fixtureDir,'synthetic-caption-player.webm');
      const generated=spawnSync(fixtureFfmpeg,[
        '-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-f','lavfi','-i','anullsrc=r=24000:cl=mono',
        '-t','12','-c:v','libvpx','-b:v','180k','-c:a','libvorbis','-shortest','-y',videoFile
      ],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
      if(generated.error?.code==='ENOENT')throw Object.assign(new Error('Video captions verification requires the prepared project FFmpeg runtime or UFRIEND_TEST_FFMPEG; the scenario uses only a generated test pattern.'),{code:'SMOKE_UNSUPPORTED'});
      assert.equal(generated.error,undefined,'Synthetic WebM generation must finish: '+generated.error?.message);assert.equal(generated.status,0,'Synthetic WebM generation failed: '+generated.stderr);
      let modelCalls=0;core.models.run=async()=>{modelCalls++;throw new Error('Video playback smoke must not invoke a real model.');};
      const literal='Synthetic caption <b>literal</b> & <img src=x onerror=alert(1)> must remain plain text.';
      const caption=index=>index===0?literal:'Synthetic caption '+(index+1)+': the video stays visible beside its transcript while this longer sentence wraps into readable lines.';
      const srt=Array.from({length:12},(_,i)=>`${i+1}\n00:00:${String(i).padStart(2,'0')},100 --> 00:00:${String(i).padStart(2,'0')},750\n${caption(i)}\n`).join('\n');
      const sample=()=>evaluate(()=>{const media=document.querySelector('#recording-player'),track=[...media.textTracks].find(track=>track.kind==='captions');return{time:media.currentTime,paused:media.paused,seeking:media.seeking,mode:track?.mode,cues:[...(track?.cues||[])].map(cue=>({start:cue.startTime,end:cue.endTime,text:cue.getCueAsHTML().textContent})),active:[...(track?.activeCues||[])].map(cue=>cue.getCueAsHTML().textContent),error:media.error?.code||null};});
      const seek=async time=>{await evaluate(time=>{const media=document.querySelector('#recording-player');media.pause();media.currentTime=time;},time);await uiWait('Native video settles at '+time+' seconds',time=>{const media=document.querySelector('#recording-player');return !media.seeking&&media.readyState>=2&&Math.abs(media.currentTime-time)<.05;},time);};
      try{
        core.store.update(state=>{state.recordings=[];});win.webContents.send('ufriend:change',actions.bootstrap());const imported=await actions['media.import']({paths:[videoFile],language:'en'}),id=imported.imported[0];assert.deepEqual(imported.errors,[]);await nav('meetings');
        await uiWait('The directly imported synthetic video reaches its meeting card',id=>!!document.querySelector('.mf-meeting-open[data-id="'+id+'"]'),id);
        await click('.mf-meeting-open[data-id="'+id+'"]');await uiWait('A card opens a real playable video',()=>{const media=document.querySelector('#recording-player');return media?.tagName==='VIDEO'&&media.readyState>=2&&media.duration>=11.9;});
        await evaluate(()=>{const media=document.querySelector('#recording-player');media.muted=true;window.__smokeCaptionPlayer=media;window.__smokeCaptionEvents={timeupdate:0,cuechange:0};media.addEventListener('timeupdate',()=>window.__smokeCaptionEvents.timeupdate++);});
        assert.equal(await evaluate(()=>document.querySelector('[data-action="media-captions"]').disabled),true,'CC remains unavailable until there are timed subtitles.');
        await core.saveTranscript(id,{format:'srt',text:srt});await uiWait('Completing a transcript populates a native TextTrack',()=>{const media=document.querySelector('#recording-player'),track=[...media.textTracks].find(track=>track.kind==='captions');return media===window.__smokeCaptionPlayer&&track?.cues?.length===12&&track.mode==='showing'&&document.querySelector('[data-action="media-captions"]')?.getAttribute('aria-pressed')==='true';});
        await evaluate(()=>{document.querySelector('#recording-player').textTracks[0].addEventListener('cuechange',()=>window.__smokeCaptionEvents.cuechange++);});
        assert.equal((await sample()).cues[0].text,literal,'Native captions must display literal transcript markup rather than interpreting it.');
        assert(await evaluate(()=>!document.querySelector('#recording-transcript img')&&document.querySelector('#recording-transcript').textContent.includes('<img src=x onerror=alert(1)>')),'Transcript markup must remain text.');
        await seek(.4);await uiWait('A paused video shows the matching native subtitle',text=>document.querySelector('#recording-player').textTracks[0].activeCues?.[0]?.getCueAsHTML().textContent===text,literal);
        const layouts=[];
        for(const theme of ['light','dark'])for(const [width,height]of [[1480,980],[640,620]]){
          win.setSize(width,height);await actions['settings.save']({theme});await uiWait('Video dialog applies the selected theme',theme=>document.querySelector('#ufriend-app').style.colorScheme===theme,theme);
          const layout=await evaluate(()=>{
            const dialog=document.querySelector('.mf-recording-dialog.mf-recording-video'),playback=dialog.querySelector('.mf-recording-playback'),timeline=dialog.querySelector('.mf-recording-timeline'),bounds=el=>{const box=el.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom};};
            return{dialog:bounds(dialog),playback:bounds(playback),timeline:bounds(timeline),viewport:innerWidth,overflow:dialog.scrollWidth>dialog.clientWidth+1,playerPreserved:document.querySelector('#recording-player')===window.__smokeCaptionPlayer};
          });
          assert.equal(layout.overflow,false,'The recording dialog must not overflow horizontally.');assert.equal(layout.playerPreserved,true,'Theme changes must preserve the video player.');
          if(width>800){assert(layout.playback.right<=layout.timeline.x+2,'On a wide window the video sits left of the transcript.');assert(Math.abs(layout.playback.y-layout.timeline.y)<2,'Wide video and transcript start on the same row.');}
          else{assert(layout.timeline.y>=layout.playback.bottom-2,'A narrow window stacks the transcript beneath the video.');assert(layout.dialog.width<=layout.viewport,'The narrow dialog remains inside the viewport.');}
          layouts.push({theme,width,height,...layout});await screenshot('48-video-captions-'+theme+'-'+width+'x'+height);
        }
        win.setSize(1480,980);await click('[data-action="media-captions"]');assert.equal((await sample()).mode,'disabled');assert.equal(await evaluate(()=>document.querySelector('[data-action="media-captions"]').getAttribute('aria-pressed')),'false');
        await click('[data-action="media-captions"]');await uiWait('CC toggles back to visible at the paused playback position',()=>document.querySelector('#recording-player').textTracks[0].mode==='showing'&&document.querySelector('#recording-player').textTracks[0].activeCues?.length===1);
        await seek(1);await uiWait('The subtitle clears in a gap between cues',()=>document.querySelector('#recording-player').textTracks[0].activeCues?.length===0);
        await click('[data-action="seek-media"][data-time="3.1"]');await uiWait('A transcript timestamp preserves the paused state',()=>{const media=document.querySelector('#recording-player');return media.paused&&!media.seeking&&Math.abs(media.currentTime-3.1)<.05&&media.textTracks[0].activeCues?.[0]?.startTime===3.1;});
        await evaluate(async()=>{await document.querySelector('#recording-player').play();});await uiWait('Synthetic video starts playing',()=>!document.querySelector('#recording-player').paused);
        await click('[data-action="seek-media"][data-time="6.1"]');await uiWait('A transcript timestamp preserves active playback',()=>{const media=document.querySelector('#recording-player');return !media.paused&&!media.seeking&&media.currentTime>=6.1&&media.currentTime<7.1;});
        await uiWait('Native subtitles advance with actual playback',()=>{const media=document.querySelector('#recording-player');return !media.paused&&media.currentTime>7.1&&media.textTracks[0].activeCues?.[0]?.startTime===7.1;});
        await evaluate(()=>document.querySelector('#recording-player').pause());const beforeBroadcast=await sample();
        core.store.update(state=>{state.recordings.find(recording=>recording.id===id).name='Synthetic renamed video';});win.webContents.send('ufriend:change',actions.bootstrap());await pause(100);
        assert(await evaluate(()=>document.querySelector('#recording-player')===window.__smokeCaptionPlayer),'A recording state broadcast must preserve the existing native player.');assert.equal((await sample()).time,beforeBroadcast.time);assert.equal((await sample()).paused,true);
        assert.equal(modelCalls,0);assert.equal((await sample()).error,null);report.meetingVideo={format:'synthetic WebM',nativeCues:12,literalMarkup:true,layouts,events:await evaluate(()=>window.__smokeCaptionEvents),pausedSeekPreserved:true,playingSeekPreserved:true};
        await closeModal();await click('.mf-meeting-open[data-id="'+id+'"]');await uiWait('Reopening installs a fresh native subtitle track',()=>{const media=document.querySelector('#recording-player');return media!==window.__smokeCaptionPlayer&&media?.textTracks[0]?.cues?.length===12&&media.currentTime<.1;});await closeModal();
      }finally{
        await evaluate(()=>document.querySelector('#recording-player')?.pause()).catch(()=>{});core.models.run=originalRun;win.setSize(...size);await actions['settings.save']({theme:saved.settings.theme});await nav('home');
        core.store.update(state=>{for(const key of ['recordings','assets'])state[key]=saved[key];});win.webContents.send('ufriend:change',actions.bootstrap());
      }
    });

    await check('meeting video subtitle export preserves playback, cancels safely and produces a new local MP4', async () => {
      assert(videoExports&&!videoExports.job,'Video export smoke needs an idle manager.');
      const saved=structuredClone(core.store.read()),size=win.getSize(),originalRun=core.models.run;
      const original={chooseOutput:videoExports.chooseOutput,exporter:videoExports.exporter,resolveFfmpeg:videoExports.resolveFfmpeg,state:videoExports.snapshot(),output:videoExports.output,closing:videoExports.closing};
      const {shell}=require('electron'),originalReveal=shell.showItemInFolder,revealed=[],requests=[],choices=[];
      const ffmpegPath=path.join(projectDir,'local','runtimes','ffmpeg','win32-x64','ffmpeg.exe');
      assert((await fs.stat(ffmpegPath)).isFile(),'Video export smoke uses only the verified local FFmpeg bundle.');
      const generatedDir=await fs.mkdtemp(path.join(fixtureDir,'video-export-')),videoFile=path.join(generatedDir,'synthetic-export.webm'),audioFile=path.join(generatedDir,'synthetic-audio.wav'),outputFile=path.join(generatedDir,'繁中與English字幕.mp4');
      const generated=spawnSync(ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','3','-c:v','libvpx','-b:v','180k','-c:a','libvorbis','-shortest','-n',videoFile],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
      assert.equal(generated.error,undefined,'Synthetic export video generation must finish.');assert.equal(generated.status,0,'Synthetic export video generation failed: '+generated.stderr);await fs.writeFile(audioFile,silentWav());
      const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex'),sourceHash=await hash(videoFile);
      const srt='1\n00:00:00,100 --> 00:00:01,350\n繁體中文字幕：會議重點與後續安排。\n\n2\n00:00:01,500 --> 00:00:02,850\nEnglish subtitles: next steps stay visible.\n';
      let modelCalls=0;core.models.run=async()=>{modelCalls++;throw new Error('Video export smoke must never invoke a real model.');};
      videoExports.setClosing(false);videoExports.resolveFfmpeg=()=>ffmpegPath;
      videoExports.chooseOutput=({name})=>{choices.push(name);return{canceled:true};};
      videoExports.exporter=input=>new Promise((resolve,reject)=>requests.push({...input,resolve,reject}));
      shell.showItemInFolder=file=>{revealed.push(file);};
      const aborted=()=>Object.assign(new Error('Synthetic export cancelled after cleanup.'),{name:'AbortError',code:'ABORT_ERR'});
      const waitStatus=status=>waitFor('Video export reaches '+status,()=>videoExports.snapshot().status===status,30000);
      const openRecord=async id=>{
        await uiWait('The exported-video fixture has a visible meeting card',id=>!!document.querySelector('.mf-meeting-open[data-id="'+id+'"]'),id);
        await click('.mf-meeting-open[data-id="'+id+'"]');
        await uiWait('The requested recording dialog is open',id=>!document.querySelector('#mf-overlay').hidden&&document.querySelector('#recording-player')?.dataset.recording===id,id);
      };
      try{
        core.store.update(state=>{state.recordings=[];});win.webContents.send('ufriend:change',actions.bootstrap());
        await actions['settings.save']({theme:'light',uiLanguage:'zh-TW'});win.setSize(1480,980);
        const imported=await actions['media.import']({paths:[videoFile,audioFile],language:'zh-TW'});assert.deepEqual(imported.errors,[]);
        const records=core.store.read().recordings,id=records.find(recording=>recording.type==='video').id,audioId=records.find(recording=>recording.type==='audio').id;
        const managedSource=core.asset(records.find(recording=>recording.id===id).assetId).path,managedSourceHash=await hash(managedSource);
        await nav('meetings');await openRecord(id);
        await uiWait('The export fixture is a playable video',()=>document.querySelector('#recording-player')?.readyState>=2);
        assert.equal(await evaluate(()=>document.querySelector('[data-action="export-video"]')?.disabled),true,'A video without timed captions cannot export.');
        await core.saveTranscript(id,{format:'txt',text:'A plain transcript has no subtitle timestamps.'});
        await uiWait('TXT keeps video export disabled',()=>document.querySelector('[data-action="export-video"]')?.disabled===true&&document.querySelector('#recording-transcript')?.textContent.includes('A plain transcript has no subtitle timestamps.'));
        await closeModal();await openRecord(audioId);
        assert.equal(await evaluate(()=>!!document.querySelector('#recording-video-export')),false,'An audio recording never offers video export.');await closeModal();
        await core.saveTranscript(id,{format:'srt',text:srt});await openRecord(id);
        await uiWait('Timed SRT enables video export',()=>document.querySelector('[data-action="export-video"]')?.disabled===false);
        await click('[data-action="export-video"]');await waitStatus('cancelled');assert.equal(requests.length,0);assert.equal(choices.length,1);
        await uiWait('Closing the chooser restores the export action',()=>!document.querySelector('[data-action="export-video"]')?.disabled&&document.querySelector('.mf-video-export-status')?.textContent.includes('已取消'));

        videoExports.chooseOutput=({name})=>{choices.push(name);return{canceled:false,filePath:path.join(generatedDir,'cancelled-output.mp4')};};
        await click('[data-action="export-video"]');await waitFor('The synthetic exporter receives its first request',()=>requests.length===1);
        await evaluate(()=>{const media=document.querySelector('#recording-player');media.pause();media.muted=true;media.currentTime=.7;window.__smokeExportPlayer=media;});
        await uiWait('The export preview is paused at its chosen position',()=>{const media=document.querySelector('#recording-player');return media.readyState>=2&&!media.seeking&&media.paused&&Math.abs(media.currentTime-.7)<.05;});
        requests[0].onProgress({stage:'processing',seconds:1,progress:.32});
        await uiWait('Real export UI exposes percent and cancellation',()=>document.querySelector('.mf-video-export-status')?.textContent.includes('32%')&&document.querySelector('.mf-video-export-progress')?.value===.32&&!document.querySelector('[data-action="cancel-video-export"]')?.disabled);
        assert(await evaluate(()=>{const media=document.querySelector('#recording-player');return media===window.__smokeExportPlayer&&media.paused&&Math.abs(media.currentTime-.7)<.05;}),'Progress updates must preserve the same native video and paused seek.');
        await screenshot('49-video-export-light-wide');
        await closeModal();await uiWait('A closed video keeps export progress on its meeting card',id=>document.querySelector('.mf-meeting-open[data-id="'+id+'"] .mf-video-export-card')?.textContent.includes('32%'),id);
        await nav('home');requests[0].onProgress({stage:'processing',seconds:2,progress:.64});await nav('meetings');
        await uiWait('Export progress survives navigation',id=>document.querySelector('.mf-meeting-open[data-id="'+id+'"] .mf-video-export-card')?.textContent.includes('64%'),id);
        await openRecord(id);await uiWait('Reopening exposes the same running export',()=>document.querySelector('.mf-video-export-status')?.textContent.includes('64%'));
        win.setSize(640,720);await actions['settings.save']({theme:'dark'});await uiWait('Small export dialog uses dark theme',()=>document.querySelector('#ufriend-app').style.colorScheme==='dark');
        assert(await evaluate(()=>{const dialog=document.querySelector('.mf-recording-dialog'),panel=document.querySelector('#recording-video-export');return dialog.scrollWidth<=dialog.clientWidth+1&&panel.getBoundingClientRect().right<=innerWidth;}),'The narrow export panel must fit inside the viewport.');
        await screenshot('49-video-export-dark-small');await click('[data-action="cancel-video-export"]');await waitStatus('cancelling');
        assert.equal(requests[0].signal.aborted,true);await pause(100);assert.equal(videoExports.snapshot().status,'cancelling','Cancellation must wait for the exporter to release its files.');
        await uiWait('Cancellation stays visible while cleanup runs',()=>document.querySelector('[data-action="cancel-video-export"]')?.disabled&&document.querySelector('.mf-video-export-status')?.textContent.includes('正在取消'));
        requests[0].reject(aborted());await waitStatus('cancelled');await uiWait('Cleanup restores export availability',()=>document.querySelector('[data-action="export-video"]')?.disabled===false&&!document.querySelector('.mf-video-export-progress'));
        assert.equal(await fs.stat(path.join(generatedDir,'cancelled-output.mp4')).catch(()=>null),null);

        await click('[data-action="export-video"]');await waitFor('The synthetic exporter starts a retry',()=>requests.length===2);
        requests[1].reject(Object.assign(new Error('/private/test-detail-must-not-appear'),{code:'VIDEO_OUTPUT_EXISTS'}));await waitStatus('error');
        await uiWait('A failed export explains how to choose another filename',()=>document.querySelector('.mf-video-export-status')?.textContent.includes('新的檔名'));
        await actions['settings.save']({uiLanguage:'en'});await uiWait('Export action and error are translated into English',()=>{
          const label=document.querySelector('[data-action="export-video"]')?.textContent,status=document.querySelector('.mf-video-export-status')?.textContent;
          return label?.includes('Export video with subtitles')&&status?.toLowerCase().includes('already exists')&&!/[\u3400-\u9fff]/.test(status);
        });
        assert.equal(await evaluate(()=>document.querySelector('#recording-video-export').textContent.includes('private/test-detail')),false);

        videoExports.exporter=original.exporter;videoExports.chooseOutput=({name})=>{choices.push(name);return{canceled:false,filePath:outputFile};};
        win.setSize(1480,980);await actions['settings.save']({theme:'light'});await click('[data-action="export-video"]');await waitStatus('done');
        await uiWait('A real completed MP4 exposes its output location',()=>!!document.querySelector('[data-action="reveal-video-export"]')&&document.querySelector('.mf-video-export-status')?.textContent.includes('Video with subtitles exported:'));
        assert((await fs.stat(outputFile)).size>1000);assert.equal(path.resolve(videoExports.getOutput(id)),path.resolve(outputFile));assert.equal(videoExports.getOutput(audioId),null);
        assert.equal(await hash(videoFile),sourceHash);assert.equal(await hash(managedSource),managedSourceHash);assert.equal(modelCalls,0);
        await click('[data-action="reveal-video-export"]');await waitFor('Reveal is intercepted without opening Explorer',()=>revealed.length===1);assert.deepEqual(revealed,[path.resolve(outputFile)]);
        await assert.rejects(actions['video.reveal']({id:audioId}));assert.equal(revealed.length,1,'Another recording cannot reveal this output.');
        await screenshot('49-video-export-complete-english');
        const outputHash=await hash(outputFile),frame=path.join(resultsDir,'smoke-49-video-export-burned-frame.png');
        const extracted=spawnSync(ffmpegPath,['-hide_banner','-loglevel','error','-ss','0.6','-i',outputFile,'-frames:v','1','-y',frame],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
        assert.equal(extracted.error,undefined);assert.equal(extracted.status,0,'The exported H.264 video must decode into a subtitle QA frame.');
        await click('[data-action="export-video"]');await waitStatus('error');assert.equal(videoExports.snapshot().code,'VIDEO_OUTPUT_EXISTS');
        assert.equal(await hash(outputFile),outputHash,'A second export cannot overwrite its completed output.');assert.equal(await hash(videoFile),sourceHash);assert.equal(await hash(managedSource),managedSourceHash);
        assert.equal(JSON.stringify(videoExports.snapshot()).includes(generatedDir),false,'Public export status must never include private absolute output paths.');
        report.meetingVideoExport={sourceFormat:'synthetic WebM',outputFormat:'H.264/AAC MP4',sourceUnchanged:true,existingOutputPreserved:true,pausedSeekPreserved:true,cancelWaitedForCleanup:true,englishErrors:true,revealIntercepted:true,outputFile,subtitleFrame:frame};
        await closeModal();assert.deepEqual(report.rendererErrors,[],'The video export workflow must not emit renderer errors.');
      }finally{
        for(const request of requests)request.reject(aborted());await videoExports.cancel();
        Object.assign(videoExports,original);shell.showItemInFolder=originalReveal;core.models.run=originalRun;
        await evaluate(()=>document.querySelector('#recording-player')?.pause()).catch(()=>{});win.setSize(...size);
        await actions['settings.save']({theme:saved.settings.theme,uiLanguage:saved.settings.uiLanguage});
        core.store.update(state=>{for(const key of ['recordings','assets'])state[key]=saved[key];});win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('EML import, search, reading and attachment UI', async () => {
      await nav('inbox');
      const first = path.join(fixtureDir, 'attachment.eml'), second = path.join(fixtureDir, 'followup.eml');
      await fs.writeFile(first, fixtureMail({subject: 'UFriend smoke: attachment',
        body: '這是本機匯入郵件。\n保留中文與 <literal> & 符號。', attachment: true}));
      await fs.writeFile(second, fixtureMail({subject: 'UFriend smoke: follow-up', body: '第二封自製測試郵件。'}));
      const result = await core.importMails([first, second]);
      assert.equal(result.added, 2); assert.deepEqual(result.errors, []);
      await uiWait('Imported messages render', () => document.querySelectorAll('.mf-mailrow [data-action="open-mail"]').length === 2);
      await setValue('#mail-query', 'follow-up');
      await uiWait('Search narrows message list', () => document.querySelectorAll('.mf-mailrow [data-action="open-mail"]').length === 1);
      await setValue('#mail-query', '');
      importedMail = core.snapshot().messages.find(message => message.subject === 'UFriend smoke: attachment');
      await click(`[data-action="open-mail"][data-id="${importedMail.id}"]`);
      await uiWait('Mail text and attachment display', () =>
        document.querySelector('.mf-bodytext')?.textContent.includes('<literal> &') &&
        document.querySelector('[data-action="mail-attachment"]')?.textContent.includes('smoke-note.txt'));
      await waitFor('Read state persisted', () => core.snapshot().messages.find(message => message.id === importedMail.id).read);
      await setValue('#mail-level', '1', 'change');
      await waitFor('Manual priority persisted', () => core.snapshot().messages.find(message => message.id === importedMail.id).level === 1);
      await screenshot('02-local-mail');
    });

    await check('HTML mail preserves tables, inline links and images inside an inert frame', async () => {
      const {BrowserWindow,nativeImage}=require('electron'),saved=structuredClone(core.store.read()),size=win.getSize();
      const originalImage=actions['mail.image'],originalContent=actions['mail.content'],originalLink=actions['mail.openLink'];
      const remoteImage='https://images.example.test/logo.png',linkHref='https://travel.example.test/manage?booking=SYNTHETIC-001';
      const logo=await fs.readFile(path.join(projectDir,'app','assets','ufriend.png')),imageResult={dataUrl:'data:image/png;base64,'+logo.toString('base64'),mimeType:'image/png',bytes:logo.length};
      const lateImageUrl='https://images.example.test/late-tall.png',lateImageBytes=nativeImage.createFromBuffer(logo).resize({width:24,height:120}).toPNG();
      const lateImageResult={dataUrl:'data:image/png;base64,'+lateImageBytes.toString('base64'),mimeType:'image/png',bytes:lateImageBytes.length};
      const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVn8AAAAASUVORK5CYII=','base64');
      const inlineImages=Array.from({length:9},(_,index)=>({id:'smoke-inline-'+(index+1)+'@ufriend.invalid',content:pixel}));
      const cidSources=new Set(['cid:smoke-logo@ufriend.invalid',...inlineImages.map(image=>'cid:'+image.id)]);
      const imageCalls=[],contentCalls=[],linkCalls=[],networkAttempts=[],networkWork=new Set(),actionWork=new Set(),pendingContents=[],pendingImages=[],fixtureIds=new Set(),contentModes=new Map();
      const beforeUrl=win.webContents.getURL(),beforeWindows=BrowserWindow.getAllWindows().map(window=>window.id).sort(),attachedDebugger=!win.webContents.debugger.isAttached();
      let remoteMode='invalid-image',holdCid=false,holdLongImage=false,fetchEnabled=false;
      const trackAction=pending=>{actionWork.add(pending);pending.then(()=>actionWork.delete(pending),()=>actionWork.delete(pending));return pending;};
      const canary='UFRIEND_SYNTHETIC_MAIL_SCRIPT_EXECUTED';
      const html=[
        '<!doctype html><html><head><style>.notice{color:#174d33}#mf-top{display:none!important}</style>',
        '<base href="https://blocked.example.test/"><meta http-equiv="refresh" content="0;url=https://blocked.example.test/redirect">',
        '<script>parent.postMessage("'+canary+'","*")</script></head><body style="margin:0;padding:20px;font-family:Arial,sans-serif;color:#233129;background:#fff">',
        '<div style="padding:18px;background:#edf5ed;border-bottom:4px solid #2a6141"><img src="cid:smoke-logo@ufriend.invalid" alt="合成航空標誌" width="48" height="48" style="vertical-align:middle" onerror="parent.postMessage(&quot;'+canary+'&quot;,&quot;*&quot;)"><strong style="margin-left:12px;font-size:24px;color:#174d33">SYNTHETIC AIR</strong></div>',
        '<h2 style="font-size:22px;color:#174d33">合成行程確認</h2><p>旅客：測試使用者（合成資料）</p>',
        '<table aria-label="合成行程資訊" style="width:100%;max-width:640px;border-collapse:collapse;border:1px solid #b8cabe">',
        '<tr><th style="padding:12px;background:#edf5ed;text-align:left;border:1px solid #b8cabe">出發</th><th style="padding:12px;background:#edf5ed;text-align:left;border:1px solid #b8cabe">抵達</th></tr>',
        '<tr><td style="padding:12px;border:1px solid #b8cabe">TPE 台北</td><td style="padding:12px;border:1px solid #b8cabe">KHH 高雄</td></tr>',
        '<tr><td style="padding:12px;border:1px solid #b8cabe">出發時間 12:30</td><td style="padding:12px;border:1px solid #b8cabe">票價 NT$1,250</td></tr></table>',
        '<p class="notice">請使用 <a href="'+linkHref+'" style="color:#17663d;text-decoration:underline">管理行程</a> 查看合成資訊。</p>',
        '<p id="alpha-note" style="color:rgba(0,0,0,.65);background:rgba(255,255,255,.85)">合成半透明文字與背景。</p>',
        '<div style="display:none">'+inlineImages.map(image=>'<img src="cid:'+image.id+'" alt="" width="1" height="1">').join('')+'</div>',
        '<div style="height:52px;background-image:url('+remoteImage+');background-repeat:no-repeat;background-size:40px 40px"><span style="margin-left:52px">合成背景圖片</span></div>',
        '<p><img src="'+remoteImage+'" width="36" height="36" alt="合成遠端圖片"> 本信僅供隔離測試。</p>',
        '<a href="javascript:parent.postMessage(&quot;'+canary+'&quot;,&quot;*&quot;)">不應執行的連結</a>',
        '<form action="https://blocked.example.test/form"><input name="fixture" value="synthetic"><button type="submit">不應送出</button></form>',
        '<iframe src="https://blocked.example.test/frame"></iframe><object data="https://blocked.example.test/object"></object>',
        '</body></html>'
      ].join('');
      const simpleHtml=label=>'<html><body style="background:#111;color:white"><h2>'+label+'</h2><table><tr><td>合成 B 內容</td><td>保持原信</td></tr></table></body></html>';
      const longHtml='<html style="height:100% !important;min-height:100vh !important"><body style="margin:0;padding:20px;background:#fff;color:#000;font:14px/20px Arial,sans-serif;min-height:100vh !important">'+
        '<div class="gmail_default" style="background:white;color:black"><h2 id="long-title">合成長信：主題與捲動測試</h2><p>這是測試資料，沒有真實郵件內容。</p>'+
        '<div style="min-height:5vh">合成視窗高度樣式。</div>'+
        '<img id="long-late-image" src="'+lateImageUrl+'" alt="延遲載入的合成圖片" style="display:block;width:96px;height:auto">'+
        '<blockquote class="gmail_quote" style="margin:12px 0 0 8px;padding-left:12px;border-left:1px solid #ccc;background:#ffffff;color:#000000">'+
        '<div class="gmail_attr" style="color:#222;background:#fff">測試寄件者的第一層引文</div>'+
        '<blockquote class="gmail_quote" style="margin:12px 0 0 8px;padding-left:12px;border-left:1px solid #ccc;background:white;color:black">'+
        Array.from({length:560},(_,index)=>'<p id="long-paragraph-'+index+'" class="long-paragraph" style="margin:0 0 8px;line-height:20px">第 '+(index+1)+' 段合成信件。<br>保留段落、換行和引文。<br>上下捲動應連續順暢。</p>').join('')+
        '<p id="long-end">合成長信結尾。</p></blockquote></blockquote></div></body></html>';
      const specs=[
        {name:'html-layout.eml',subject:'UFriend smoke: HTML layout',body:'合成行程純文字備援：TPE → KHH，12:30，NT$1,250。',html,inlineImages},
        {name:'html-other.eml',subject:'UFriend smoke: HTML other',body:'合成 B 純文字。',html:simpleHtml('合成另一封郵件')},
        {name:'html-retry.eml',subject:'UFriend smoke: HTML retry',body:'HTML 載入失敗時保留這段合成純文字。',html:simpleHtml('重試後的合成 HTML')},
        {name:'html-late.eml',subject:'UFriend smoke: HTML late',body:'合成延遲內文。',html:simpleHtml('晚到的 A 內容不應出現在 B')},
        {name:'html-long.eml',subject:'UFriend smoke: HTML long theme and scroll',body:'合成長信純文字備援。',html:longHtml},
      ];
      const onDebuggerMessage=(_event,method,params,sessionId)=>{
        if(method!=='Fetch.requestPaused')return;
        networkAttempts.push({url:params.request.url,resourceType:params.resourceType});
        const pending=win.webContents.debugger.sendCommand('Fetch.failRequest',{requestId:params.requestId,errorReason:'BlockedByClient'},sessionId);
        networkWork.add(pending);pending.then(()=>networkWork.delete(pending),()=>networkWork.delete(pending));
      };
      const openMail=async id=>{
        await nav('inbox');await setValue('#mail-query','');await setValue('#mail-folder','inbox','change');
        await uiWait('The synthetic mail appears in the inbox',id=>!!document.querySelector('[data-action="open-mail"][data-id="'+id+'"]'),id);
        await click('[data-action="open-mail"][data-id="'+id+'"]');
        await uiWait('HTML mail body container opens',()=>!!document.querySelector('#mail-body-view'));
      };
      const frameReady=async text=>uiWait('Sanitized HTML frame renders '+text,text=>{
        const frame=document.querySelector('#mail-html-frame');
        return frame?.dataset.ready==='true'&&frame.contentDocument?.body?.textContent.includes(text);
      },text);
      const themeSamples=[],scrollSamples=[];
      const watchFrame=()=>evaluate(()=>{
        window.__smokeMailProbe?.observer.disconnect();
        const frame=document.querySelector('#mail-html-frame'),probe={frame,doc:frame.contentDocument,loads:0,styleMutations:0,heightMutations:0,lastHeight:frame.style.height};
        frame.addEventListener('load',()=>probe.loads++);
        probe.observer=new MutationObserver(records=>{probe.styleMutations+=records.length;if(frame.style.height!==probe.lastHeight){probe.heightMutations++;probe.lastHeight=frame.style.height;}});
        probe.observer.observe(frame,{attributes:true,attributeFilter:['style']});window.__smokeMailProbe=probe;
      });
      const frameMetrics=()=>evaluate(()=>{
        const frame=document.querySelector('#mail-html-frame'),doc=frame.contentDocument,page=document.querySelector('#mf-page'),style=getComputedStyle(frame),probe=window.__smokeMailProbe;
        return{frameHeight:frame.getBoundingClientRect().height,contentHeight:doc.body.scrollHeight,innerScrollTop:doc.scrollingElement.scrollTop,
          innerOverflow:doc.scrollingElement.scrollHeight-doc.scrollingElement.clientHeight,outerScrollTop:page.scrollTop,outerScrollable:page.scrollHeight>page.clientHeight,
          border:style.borderTopWidth,boxSizing:style.boxSizing,minHeight:style.minHeight,
          horizontalOverflow:[document.querySelector('#ufriend-app'),page,document.querySelector('#mail-body-view'),doc.documentElement].some(element=>element.scrollWidth>element.clientWidth+2),
          sameFrame:probe?.frame===frame,sameDocument:probe?.doc===doc,loads:probe?.loads||0,styleMutations:probe?.styleMutations||0,heightMutations:probe?.heightMutations||0};
      });
      const assertFrameTheme=async(theme,kind)=>{
        await uiWait('HTML body follows the application '+theme+' theme',theme=>{
          const frame=document.querySelector('#mail-html-frame'),doc=frame?.contentDocument,app=document.querySelector('#ufriend-app');
          return doc?.body&&frame.style.colorScheme===theme&&frame.contentWindow.getComputedStyle(doc.body).backgroundColor===getComputedStyle(app).backgroundColor;
        },theme);
        const sample=await evaluate(kind=>{
          const frame=document.querySelector('#mail-html-frame'),doc=frame.contentDocument,view=frame.contentWindow;
          const rgba=value=>(value.match(/[\d.]+/g)||[]).map(Number),blend=(foreground,background)=>foreground.slice(0,3).map((channel,index)=>channel*(foreground[3]??1)+background[index]*(1-(foreground[3]??1)));
          const luminance=value=>value.map(channel=>{channel/=255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
          const background=element=>{const colors=[];for(let current=element;current;current=current.parentElement)colors.unshift(rgba(view.getComputedStyle(current).backgroundColor));return colors.reduce((bg,color)=>blend(color,bg),rgba(getComputedStyle(document.querySelector('#ufriend-app')).backgroundColor).slice(0,3));};
          const selectors=kind==='long'?['body','.gmail_default','.gmail_attr','.gmail_quote','.gmail_quote .gmail_quote','#long-paragraph-0','#long-paragraph-280']:kind==='author-dark'?['body','h2','td']:['body','h2','th','td','.notice','.notice a','strong','#alpha-note'];
          return{kind,bodyBackground:view.getComputedStyle(doc.body).backgroundColor,appBackground:getComputedStyle(document.querySelector('#ufriend-app')).backgroundColor,
            colors:selectors.map(selector=>{const element=doc.querySelector(selector),style=view.getComputedStyle(element),bg=background(element),a=luminance(blend(rgba(style.color),bg)),b=luminance(bg);return{selector,color:style.color,background:'rgb('+bg.map(Math.round).join(', ')+')',contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};}),
            coloredBackground:kind==='table'?view.getComputedStyle(doc.querySelector('th')).backgroundColor:null,
            imageSources:[...doc.images].map(image=>image.getAttribute('src')),
            imageFilters:[...doc.images].flatMap(image=>{const filters=[];for(let element=image;element;element=element.parentElement)filters.push(view.getComputedStyle(element).filter);for(let element=frame;element;element=element.parentElement)filters.push(getComputedStyle(element).filter);return filters;})};
        },kind);
        assert.equal(sample.bodyBackground,sample.appBackground,'Neutral mail surfaces must match the application surface.');
        assert.equal(sample.appBackground,theme==='dark'?'rgb(32, 35, 33)':'rgb(251, 251, 250)');
        for(const color of sample.colors)assert(color.contrast>=4.5,'Readable '+theme+' '+kind+' text contrast: '+JSON.stringify(color));
        assert(sample.imageFilters.every(filter=>filter==='none'),'Mail images and their ancestors must not use color filters.');
        if(kind==='long')for(const color of sample.colors)assert.equal(color.background,sample.appBackground,'Gmail-style neutral wrappers and nested quotes should use the application background.');
        if(kind==='table'){
          const [r,g,b]=sample.coloredBackground.match(/\d+/g).map(Number);
          assert(g>r&&g>=b,'The original green table background must retain its hue.');
        }
        themeSamples.push({theme,...sample,imageSources:undefined,imageFilters:undefined});return sample;
      };
      const assertStableFrame=async label=>{
        await evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await pause(100);
        const before=await frameMetrics(),started=Date.now();await pause(360);const after=await frameMetrics();
        assert(Math.abs(after.frameHeight-before.frameHeight)<=1,'The mail frame must not grow through its own resize feedback: '+label);
        assert.equal(after.styleMutations,before.styleMutations,'An idle mail frame should not keep rewriting its style: '+label);
        assert.equal(after.innerScrollTop,0);assert(after.innerOverflow<=2,'There should be no second vertical scroll range inside the mail frame: '+JSON.stringify(after));
        assert.equal(after.border,'0px');assert.equal(after.boxSizing,'content-box');assert.equal(after.minHeight,'120px');assert(!after.horizontalOverflow);
        assert(after.sameFrame&&after.sameDocument&&after.loads===0,'Theme and resize changes must preserve the loaded document.');
        scrollSamples.push({label,observationMs:Date.now()-started,...after,idleStyleMutations:after.styleMutations-before.styleMutations});return after;
      };
      const assertNoExternalEffects=async()=>{
        await Promise.allSettled([...networkWork]);
        assert.deepEqual(networkAttempts,[],'A direct renderer network attempt was stopped by the smoke safety net; product isolation did not pass.');
        assert.deepEqual(await evaluate(()=>window.__smokeHtmlCanaries||[]),[],'Mail HTML must never execute its script or event-handler canary.');
        assert.equal(win.webContents.getURL(),beforeUrl);assert.deepEqual(BrowserWindow.getAllWindows().map(window=>window.id).sort(),beforeWindows);
      };
      try{
        assert.equal(core.store.read().accounts.length,0);assert.equal(typeof originalImage,'function');assert.equal(typeof originalContent,'function');assert.equal(typeof originalLink,'function');
        if(attachedDebugger)win.webContents.debugger.attach('1.3');
        win.webContents.debugger.on('message',onDebuggerMessage);
        await win.webContents.debugger.sendCommand('Fetch.enable',{patterns:[{urlPattern:'http://*'},{urlPattern:'https://*'}]});fetchEnabled=true;
        await evaluate(canary=>{window.__smokeHtmlCanaries=[];window.__smokeHtmlListener=event=>{if(event.data===canary)window.__smokeHtmlCanaries.push(event.data);};window.addEventListener('message',window.__smokeHtmlListener);},canary);
        const files=[];for(const spec of specs){const file=path.join(fixtureDir,spec.name);await fs.writeFile(file,fixtureHtmlMail({...spec,logo}));files.push(file);}
        const plainFile=path.join(fixtureDir,'html-plain.eml');await fs.writeFile(plainFile,fixtureMail({subject:'UFriend smoke: HTML plain fallback',body:'純文字仍保留 <literal> & 換行。\n第二行。'}));files.push(plainFile);
        const imported=await core.importMails(files);assert.equal(imported.added,6);assert.deepEqual(imported.errors,[]);
        const messages=specs.map(spec=>core.store.read().messages.find(message=>message.subject===spec.subject)),[layout,other,retry,late,long]=messages;
        const plain=core.store.read().messages.find(message=>message.subject==='UFriend smoke: HTML plain fallback');
        for(const message of [...messages,plain])fixtureIds.add(message.id);
        assert.equal(layout.htmlVersion,1);assert(layout.html.includes('<table'));assert.equal(plain.html,null);
        const cidAttachment=layout.attachments.find(attachment=>attachment.contentId?.includes('smoke-logo@ufriend.invalid'));assert(cidAttachment?.assetId,'Local EML import must retain its CID-to-asset association.');
        assert.deepEqual(await fs.readFile(core.asset(cidAttachment.assetId).path),logo);
        const storedContent=new Map(messages.map(message=>[message.id,{id:message.id,html:message.html,htmlVersion:message.htmlVersion,body:message.body,attachments:message.attachments}]));
        actions['mail.image']=args=>trackAction((async()=>{
          assert(fixtureIds.has(args?.id),'Mail images may only read the synthetic messages in this scenario.');imageCalls.push(structuredClone(args));
          if(cidSources.has(args.source)){
            const result=await originalImage(args);
            if(holdCid)await new Promise(resolve=>pendingImages.push({id:args.id,resolve}));return result;
          }
          if(args.source===lateImageUrl){if(holdLongImage)await new Promise(resolve=>pendingImages.push({id:args.id,longImage:true,resolve}));return lateImageResult;}
          assert.equal(args.source,remoteImage,'Unknown image destinations are never delegated to a real network request.');
          if(remoteMode==='invalid-image')return{dataUrl:'data:image/jpeg;base64,/9j/4A==',mimeType:'image/jpeg',bytes:4};
          return imageResult;
        })());
        actions['mail.content']=args=>trackAction((async()=>{
          assert(fixtureIds.has(args?.id),'Mail content may only read the synthetic messages in this scenario.');contentCalls.push(args.id);
          const mode=contentModes.get(args.id);
          if(mode==='fail')throw new Error('合成 HTML 內文載入失敗。');
          if(mode==='hold')await new Promise(resolve=>pendingContents.push({id:args.id,resolve}));
          return mode?structuredClone(storedContent.get(args.id)):originalContent(args);
        })());
        actions['mail.openLink']=async args=>{linkCalls.push(structuredClone(args));assert.equal(args.id,layout.id);assert.equal(args.href,linkHref);return{opened:true};};
        await openMail(plain.id);await uiWait('Plain text keeps its original escaped presentation',()=>document.querySelector('.mf-bodytext')?.textContent.includes('<literal> &')&&!document.querySelector('#mail-html-frame'));
        assert(!contentCalls.includes(plain.id),'Known plain text mail must not request a missing HTML body.');
        await openMail(layout.id);await frameReady('合成行程確認');
        await uiWait('An undecodable image leaves readable mail and an explicit retry',()=>document.querySelector('#mail-image-status')?.checkVisibility()&&document.querySelector('#mail-image-status').textContent.trim()&&document.querySelector('[data-action="mail-images-retry"]')?.checkVisibility());
        await evaluate(()=>document.querySelector('#mail-image-status').scrollIntoView({block:'center'}));
        await screenshot('46-html-mail-image-error');remoteMode='allow';await click('[data-action="mail-images-retry"]');
        await uiWait('CID and controlled remote images decode successfully',()=>{
          const doc=document.querySelector('#mail-html-frame')?.contentDocument,images=doc?[...doc.images]:[];
          return images.length===11&&images.every(image=>image.complete&&image.naturalWidth>0&&image.src.startsWith('data:image/png'));
        });
        assert(imageCalls.some(call=>call.source==='cid:smoke-logo@ufriend.invalid'));assert(imageCalls.some(call=>call.source===remoteImage));
        assert(imageCalls.some(call=>call.source===remoteImage&&call.refresh===true),'Retry must bypass the cached undecodable image.');
        const rendered=await evaluate(()=>{
          const frame=document.querySelector('#mail-html-frame'),doc=frame.contentDocument,table=doc.querySelector('table'),cells=[...table.rows[1].cells],rects=cells.map(cell=>cell.getBoundingClientRect());
          return{sandbox:[...frame.sandbox],csp:doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content||'',text:doc.body.textContent,
            tableRows:table.rows.length,aligned:Math.abs(rects[0].top-rects[1].top)<1&&rects[0].right<=rects[1].left+1,
            cellDisplay:frame.contentWindow.getComputedStyle(cells[0]).display,border:frame.contentWindow.getComputedStyle(cells[0]).borderTopWidth,
            unsafeTags:[...doc.querySelectorAll('script,iframe,object,embed,form,input,button,base,meta[http-equiv="refresh"]')].map(element=>element.tagName),
            handlers:[...doc.querySelectorAll('*')].flatMap(element=>[...element.attributes].filter(attribute=>/^on/i.test(attribute.name)).map(attribute=>attribute.name)),
            unsafeLinks:[...doc.querySelectorAll('[href]')].map(element=>element.getAttribute('href')).filter(href=>/^\s*(?:javascript|data|file):/i.test(href)),
            background:frame.contentWindow.getComputedStyle([...doc.querySelectorAll('div')].find(element=>element.textContent.trim()==='合成背景圖片')).backgroundImage,
            require:typeof frame.contentWindow.require,process:typeof frame.contentWindow.process,bridge:typeof frame.contentWindow.ufriend,
            parentHeaderVisible:document.querySelector('#mf-top').checkVisibility()&&getComputedStyle(document.querySelector('#mf-top')).display!=='none'};
        });
        assert.deepEqual(rendered.sandbox,['allow-same-origin']);assert(rendered.csp.includes("default-src 'none'"));assert(rendered.csp.includes('data:'));
        assert.equal(rendered.tableRows,3);assert(rendered.aligned);assert.equal(rendered.cellDisplay,'table-cell');assert.notEqual(rendered.border,'0px');
        assert(rendered.text.includes('12:30')&&rendered.text.includes('NT$1,250'));assert.deepEqual(rendered.unsafeTags,[]);assert.deepEqual(rendered.handlers,[]);assert.deepEqual(rendered.unsafeLinks,[]);
        assert.equal(rendered.require,'undefined');assert.equal(rendered.process,'undefined');assert.equal(rendered.bridge,'undefined');assert(rendered.parentHeaderVisible);
        assert.equal(new Set(imageCalls.map(call=>call.source)).size,11,'Exercise eleven distinct resources so token 1 cannot replace the prefix of token 10.');
        assert.equal(rendered.background,'url("'+imageResult.dataUrl+'")','The eleventh resource must remain the exact expected CSS background, with no earlier image data or placeholder suffix.');
        const attachmentIndex=layout.attachments.findIndex(attachment=>attachment.name==='html-note.txt');
        assert(await evaluate(index=>document.querySelector('[data-action="mail-attachment"][data-index="'+index+'"]')?.textContent.includes('html-note.txt'),attachmentIndex),'Normal attachment controls must retain their original attachment index.');
        const linkPoint=await evaluate(()=>{
          const frame=document.querySelector('#mail-html-frame');frame.scrollIntoView({block:'start'});
          const link=[...frame.contentDocument.querySelectorAll('a')].find(element=>element.textContent==='管理行程');if(!link)throw new Error('Missing inline HTML link.');
          link.scrollIntoView({block:'center'});const outer=frame.getBoundingClientRect(),inner=link.getBoundingClientRect();
          return{x:outer.left+frame.clientLeft+inner.left+inner.width/2,y:outer.top+frame.clientTop+inner.top+inner.height/2,text:link.textContent,href:link.getAttribute('href')};
        });
        assert.equal(linkPoint.text,'管理行程');assert.equal(linkPoint.href,linkHref);
        for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:linkPoint.x,y:linkPoint.y,button:'left',clickCount:1});
        await waitFor('A real inline-link click reaches only the controlled opener',()=>linkCalls.length===1);assert.deepEqual(linkCalls,[{id:layout.id,href:linkHref}]);
        const originalImageSources=await evaluate(()=>[...document.querySelector('#mail-html-frame').contentDocument.images].map(image=>image.getAttribute('src')));
        await watchFrame();
        for(const theme of ['light','dark'])for(const [width,height]of [[1080,820],[640,480]]){
          win.setSize(width,height);await actions['settings.save']({theme});
          await uiWait('HTML mail visual theme updates',theme=>document.querySelector('#ufriend-app').style.colorScheme===theme,theme);
          await frameReady('合成行程確認');
          const colors=await assertFrameTheme(theme,'table');assert.deepEqual(colors.imageSources,originalImageSources,'Theme changes must preserve exact original image sources.');
          await evaluate(()=>document.querySelector('#mail-body-view').scrollIntoView({block:'start'}));
          assert(await evaluate(()=>['#ufriend-app','#mf-page','#mail-body-view'].every(selector=>{const element=document.querySelector(selector);return element.scrollWidth<=element.clientWidth+1;})),'HTML mail must stay within the application width.');
          await assertStableFrame('table-'+width+'x'+height+'-'+theme);
          await screenshot('47-html-mail-'+width+'x'+height+'-'+theme);
        }
        win.setSize(1080,820);await actions['settings.save']({theme:'light'});holdLongImage=true;
        await openMail(long.id);await frameReady('合成長信：主題與捲動測試');await watchFrame();
        await waitFor('The long mail is readable while its late image is held',()=>pendingImages.some(request=>request.longImage));
        await uiWait('The mail frame can grow beyond the old 30000 px limit',()=>document.querySelector('#mail-html-frame').getBoundingClientRect().height>30000);
        const beforeLateImage=await frameMetrics();
        for(const request of pendingImages.filter(request=>request.longImage))request.resolve();
        holdLongImage=false;
        await uiWait('The late image decodes and expands the outer mail height',()=>{
          const frame=document.querySelector('#mail-html-frame'),image=frame.contentDocument.getElementById('long-late-image');
          return image?.complete&&image.naturalHeight===120&&frame.getBoundingClientRect().height>30000;
        });
        await uiWait('Late image size reaches the frame without clipping',before=>document.querySelector('#mail-html-frame').getBoundingClientRect().height>before+200,beforeLateImage.frameHeight);
        const afterLateImage=await assertStableFrame('long-late-image-resized');
        assert(afterLateImage.frameHeight>30000);assert(afterLateImage.outerScrollable);
        const longImageSources=[lateImageResult.dataUrl];
        assert.deepEqual((await assertFrameTheme('light','long')).imageSources,longImageSources);
        await evaluate(()=>document.querySelector('#mail-body-view').scrollIntoView({block:'start'}));await screenshot('49-html-simple-long-light');
        const callsBeforeTheme={images:imageCalls.length,content:contentCalls.length};
        await actions['settings.save']({theme:'dark'});assert.deepEqual((await assertFrameTheme('dark','long')).imageSources,longImageSources);
        await assertStableFrame('long-dark');await screenshot('49-html-simple-long-dark');
        await evaluate(()=>{const page=document.querySelector('#mf-page');page.scrollTop=Math.min(18000,page.scrollHeight-page.clientHeight-1500);});
        const wheel=async(deltaY,label)=>{
          const point=await evaluate(()=>{
            const frame=document.querySelector('#mail-html-frame'),page=document.querySelector('#mf-page'),outer=frame.getBoundingClientRect(),viewport=page.getBoundingClientRect();
            const x=Math.max(outer.left+24,viewport.left+24),y=Math.max(outer.top,viewport.top)+Math.min(180,viewport.height/2);
            return{x,y,insideFrame:x>outer.left&&x<outer.right&&y>outer.top&&y<outer.bottom,scrollTop:page.scrollTop};
          });
          assert(point.insideFrame,'Native wheel input must target the visible iframe content.');const started=Date.now();
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY});
          await uiWait('Native wheel '+label+' moves the outer mail scroller',(before,direction)=>{
            const frame=document.querySelector('#mail-html-frame');return(direction>0?document.querySelector('#mf-page').scrollTop>before+100:document.querySelector('#mf-page').scrollTop<before-100)&&frame.contentDocument.scrollingElement.scrollTop===0;
          },point.scrollTop,deltaY);
          const metrics=await frameMetrics();scrollSamples.push({label,nativeWheelDeltaY:deltaY,beforeScrollTop:point.scrollTop,observedAfterMs:Date.now()-started,...metrics});
        };
        await wheel(600,'long-native-wheel-down');await wheel(-480,'long-native-wheel-up');await assertStableFrame('long-after-native-wheel');
        await screenshot('49-html-simple-long-midread-dark');
        const middlePosition=await frameMetrics();
        await actions['settings.save']({theme:'light'});await assertFrameTheme('light','long');
        const lightPosition=await assertStableFrame('long-midread-light');assert(Math.abs(lightPosition.outerScrollTop-middlePosition.outerScrollTop)<=2,'Changing theme must preserve the current reading position.');
        await actions['settings.save']({theme:'system'});
        for(const theme of ['dark','light']){
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
          assert.deepEqual((await assertFrameTheme(theme,'long')).imageSources,longImageSources);
          const metrics=await assertStableFrame('long-system-'+theme);assert(Math.abs(metrics.outerScrollTop-middlePosition.outerScrollTop)<=2,'System theme changes must preserve reading position.');
        }
        assert.equal(imageCalls.length,callsBeforeTheme.images,'Theme changes must not reload mail images.');assert.equal(contentCalls.length,callsBeforeTheme.content,'Theme changes must not refetch mail content.');
        win.setSize(640,480);await assertStableFrame('long-small-window');
        await evaluate(()=>document.querySelector('#mail-body-view').scrollIntoView({block:'start'}));await screenshot('49-html-simple-long-small-light');
        for(const message of [layout,long])assert.equal(core.store.read().messages.find(value=>value.id===message.id).html,storedContent.get(message.id).html,'Display themes must not rewrite the stored original HTML.');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
        win.setSize(...size);await actions['settings.save']({theme:saved.settings.theme});await assertNoExternalEffects();
        // Legacy-message content fetches are isolated from the already cached
        // layout fixture, so failure and late completion cannot pass via a cache.
        core.store.update(state=>{for(const message of state.messages)if([retry.id,late.id].includes(message.id)){delete message.html;delete message.htmlVersion;message.source='Gmail';message.read=true;}});
        win.webContents.send('ufriend:change',actions.bootstrap());
        contentModes.set(retry.id,'fail');await openMail(retry.id);
        await uiWait('HTML load failure keeps the plain body and a retry control',()=>document.querySelector('#mail-content-status')?.textContent.includes('合成 HTML')&&document.querySelector('.mf-bodytext')?.textContent.includes('保留這段合成純文字')&&document.querySelector('[data-action="mail-content-retry"]')?.checkVisibility());
        await screenshot('48-html-mail-content-error');contentModes.set(retry.id,'cached');await click('[data-action="mail-content-retry"]');await frameReady('重試後的合成 HTML');
        contentModes.set(late.id,'hold');await openMail(late.id);await waitFor('A synthetic legacy content request is pending',()=>pendingContents.some(request=>request.id===late.id));
        await openMail(other.id);await frameReady('合成另一封郵件');
        await assertFrameTheme(await evaluate(()=>document.querySelector('#ufriend-app').style.colorScheme),'author-dark');
        for(const request of pendingContents.splice(0))request.resolve();await Promise.allSettled([...actionWork]);await pause(120);
        assert(await evaluate(()=>{const text=document.querySelector('#mail-html-frame')?.contentDocument?.body?.textContent||'';return text.includes('合成另一封郵件')&&!text.includes('晚到的 A');}),'Late content from another mail must not replace the selected body.');
        // An unfinished CID result cannot reopen a mail after leaving, including
        // a result returned by the main process image cache.
        holdCid=true;await openMail(layout.id);await waitFor('A synthetic CID result is held after the real main action',()=>pendingImages.length>0);
        await nav('inbox');for(const request of pendingImages.splice(0))request.resolve();holdCid=false;await Promise.allSettled([...actionWork]);await pause(120);
        assert(await evaluate(()=>!!document.querySelector('#mail-query')&&!document.querySelector('#mail-html-frame')),'Finishing an old image must not rebuild a mail after returning to the inbox.');
        await assertNoExternalEffects();report.htmlMail={cidDecoded:true,remoteImageStubbed:true,invalidImageRetryRefresh:true,distinctImageResources:11,eleventhBackgroundVerified:true,tableLayout:true,inlineLinkCalls:linkCalls.length,directNetworkRequests:networkAttempts.length,activeContentRemoved:true,lateContentIgnored:true,lateImageIgnored:true,
          themes:themeSamples,scroll:scrollSamples,longMailHeight:afterLateImage.frameHeight,lateImageHeightGrowth:afterLateImage.frameHeight-beforeLateImage.frameHeight,nativeWheelDirections:['down','up'],themePreservesDocument:true,themePreservesReadingPosition:true,themePreservesStoredHtml:true,themePreservesOriginalImages:true,performanceScope:'Bounded native wheel, late image resize and idle mutation observations; no FPS or device-wide smoothness claim.'};
      }finally{
        holdCid=false;holdLongImage=false;
        for(const [id,mode]of contentModes)if(mode==='hold')contentModes.set(id,'cached');
        for(const request of [...pendingContents.splice(0),...pendingImages.splice(0)])request.resolve();
        await nav('home').catch(()=>{});await Promise.allSettled([...actionWork,...networkWork]);
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}).catch(()=>{});
        if(fetchEnabled)await win.webContents.debugger.sendCommand('Fetch.disable').catch(()=>{});
        win.webContents.debugger.removeListener('message',onDebuggerMessage);
        if(attachedDebugger&&win.webContents.debugger.isAttached())win.webContents.debugger.detach();
        actions['mail.image']=originalImage;actions['mail.content']=originalContent;actions['mail.openLink']=originalLink;
        await evaluate(()=>{if(window.__smokeHtmlListener)window.removeEventListener('message',window.__smokeHtmlListener);window.__smokeMailProbe?.observer.disconnect();delete window.__smokeMailProbe;}).catch(()=>{});
        win.setSize(...size);core.store.update(state=>{for(const key of ['messages','assets','settings'])state[key]=saved[key];});
        win.webContents.send('ufriend:change',actions.bootstrap());await nav('home');
      }
    });

    await check('local draft close, save and reopen', async () => {
      await nav('inbox');
      await click('[data-action="compose"]');
      await uiWait('Compose opens', () => !!document.querySelector('#compose-body'));
      await setValue('#compose-to', 'draft@example.invalid');
      await setValue('#compose-subject', 'Smoke local draft');
      await setValue('#compose-body', '僅保存在本機的草稿。\n第二行 <draft> & 測試。');
      await closeModal();
      await waitFor('One local draft saved', () => core.snapshot().drafts.length === 1);
      let draft = core.snapshot().drafts[0];
      assert.equal(draft.accountId, 'local'); assert.equal(draft.status, 'local');
      draftId = draft.id;
      await evaluate(() => {
        window.__smokeDraftUpdate = new Promise(resolve => {
          const unsubscribe = window.ufriend.onChange(next => {
            if (next.drafts.some(draft => draft.attachments?.length)) { unsubscribe(); resolve(); }
          });
        });
      });
      await actions['draft.save']({...draft, localOnly: true, attachments: importedMail.attachments});
      await evaluate(() => window.__smokeDraftUpdate);
      await setValue('#mail-folder', 'drafts', 'change');
      await uiWait('Saved draft listed', id => !!document.querySelector(`[data-action="edit-draft"][data-id="${id}"]`), draftId);
      await click(`[data-action="edit-draft"][data-id="${draftId}"]`);
      await uiWait('Saved draft reopens', () => document.querySelector('#compose-body')?.value.includes('<draft> &'));
      assert.equal(await evaluate(() => document.querySelector('#compose-to').value), 'draft@example.invalid');
      assert.equal(await evaluate(() => document.querySelector('#compose-account').value), 'local');
      await uiWait('Draft attachment renders', () => document.querySelector('.mf-attachment')?.textContent.includes('smoke-note.txt'));
      await evaluate(() => document.querySelector('.mf-attachment').scrollIntoView({block: 'end'}));
      await screenshot('03-local-draft');
      await closeModal();
      assert.equal(core.snapshot().drafts.length, 1, 'Closing a saved draft must not duplicate it.');
    });

    await check('WAV import, player and unavailable Whisper status', async () => {
      const wav = path.join(fixtureDir, 'smoke-meeting.wav');
      await fs.writeFile(wav, silentWav());
      const result = await actions['media.import']({paths: [wav], language: 'zh-TW'});
      assert.equal(result.imported.length, 1); assert.deepEqual(result.errors, []);
      recordingId = result.imported[0];
      await nav('meetings');
      await uiWait('Recording listed', () => !!document.querySelector('[data-action="media-start"]'));
      await click(`[data-action="media-start"][data-id="${recordingId}"]`);
      await waitFor('Missing Whisper is recorded', () => core.snapshot().recordings[0].error.includes('尚未接入'));
      assert.equal(core.snapshot().recordings[0].state, 'waiting-model');
      assert.deepEqual(core.snapshot().recordings[0].segments, []);
      await uiWait('Whisper status renders', () => document.querySelector('#mf-page').innerText.includes('Whisper 語音模型尚未接入'));
      await screenshot('04-meeting-model-status');
      await click(`[data-action="media-open"][data-id="${recordingId}"]`);
      await uiWait('Local WAV metadata loads', () => {
        const audio = document.querySelector('#mf-overlay audio');
        return audio?.readyState >= 1 && Math.abs(audio.duration - 3) < 0.1;
      });
      assert.equal(await evaluate(() => document.querySelector('[data-action="export-srt"]').disabled), true);
    });

    await check('manual SRT and TXT editor round trip', async () => {
      await click('[data-action="transcript-edit"]');
      await setValue('#transcript-format', 'srt', 'change');
      await setValue('#transcript-text', '1\n00:00:00,000 --> 00:00:01,000\n第一段人工逐字稿。\n\n2\n00:00:01,100 --> 00:00:02,500\n第二段 <時間點> & 測試。\n');
      await click('[data-action="transcript-save"]');
      await uiWait('SRT segments display', () => document.querySelectorAll('[data-action="seek-media"]').length === 2);
      assert.equal(await evaluate(() => document.querySelector('[data-action="export-srt"]').disabled), false);
      assert.equal(core.snapshot().recordings[0].transcriptSource, 'manual');
      await screenshot('05-manual-srt');
      await click('[data-action="transcript-edit"]');
      assert((await evaluate(() => document.querySelector('#transcript-text').value)).includes('00:00:01,100 --> 00:00:02,500'));
      await setValue('#transcript-format', 'txt', 'change');
      await setValue('#transcript-text', '純文字人工逐字稿。\n保留第二行，沒有自動生成時間點。');
      await click('[data-action="transcript-save"]');
      await uiWait('TXT displays without fabricated timestamps', () =>
        document.querySelector('.mf-transcript')?.innerText.includes('純文字人工逐字稿') &&
        document.querySelectorAll('[data-action="seek-media"]').length === 0);
      assert.equal(await evaluate(() => document.querySelector('[data-action="export-srt"]').disabled), true);
      assert.equal(await evaluate(() => document.querySelector('[data-action="export-txt"]').disabled), false);
      await closeModal();
    });

    await check('OCR image protocol, unavailable model and manual text', async () => {
      await nav('ocr');
      await actions['ocr.import']({paths: [path.join(projectDir, 'app', 'assets', 'ufriend.png')]});
      await uiWait('OCR managed image loads', () => {
        const image = document.querySelector('.mf-imagebox img');
        return image?.complete && image.naturalWidth === 256;
      });
      await click('[data-action="ocr-start"]');
      await waitFor('Missing OCR is recorded', () => core.snapshot().ocr.error.includes('尚未接入'));
      assert.equal(core.snapshot().ocr.status, 'waiting-model');
      assert.equal(core.snapshot().ocr.text, '');
      await uiWait('Missing OCR UI explains the state', () => document.querySelector('.mf-toolstatus')?.textContent.includes('OCR 辨識模型尚未接入'));
      await screenshot('06-ocr-model-status');
      await setValue('#ocr-text', '人工校對文字，不是模型辨識結果。');
      await waitFor('Manual OCR text saved', () => core.snapshot().ocr.status === 'manual');
      await nav('home'); await nav('ocr');
      assert.equal(await evaluate(() => document.querySelector('#ocr-text').value), '人工校對文字，不是模型辨識結果。');
    });

    await check('polish debounce keeps input and produces no fake output', async () => {
      await nav('polish');
      await setValue('#polish-input', '提醒大家明天上午十點開會。');
      await pause(900);assert.equal(core.snapshot().polish.input,'提醒大家明天上午十點開會。');assert(!core.snapshot().polish.error,'A draft save does not attempt unavailable inference.');
      await click('[data-action="polish-start"]');
      await waitFor('Unavailable LLM preserves saved input', () => core.snapshot().polish.error?.includes('尚未接入'));
      await uiWait('Polish input survives model attempt', () =>
        document.querySelector('#polish-input')?.value === '提醒大家明天上午十點開會。' &&
        document.querySelector('.mf-toolstatus')?.textContent.includes('LLM 文字模型尚未接入'));
      assert.equal(await evaluate(() => document.querySelector('#polish-output').value), '');
      assert.equal(await evaluate(() => document.querySelector('[data-action="polish-copy"]').disabled), true);
      await setValue('#polish-tone', 'formal', 'change');
      await waitFor('Tone is persisted', () => core.snapshot().polish.tone === 'formal');
      await screenshot('07-polish-model-status');
    });

    await check('theme controls persist and update the rendered surface', async () => {
      await settingsCategory('general');
      await click('[data-action="theme"][data-theme="dark"]');
      await uiWait('Dark theme applied', () => document.querySelector('#ufriend-app').style.colorScheme === 'dark' &&
        document.querySelector('[data-theme="dark"]').getAttribute('aria-pressed') === 'true');
      assert.equal(core.snapshot().settings.theme, 'dark');
      await screenshot('08-settings-dark');
      await click('[data-action="theme"][data-theme="light"]');
      await uiWait('Light theme applied', () => document.querySelector('#ufriend-app').style.colorScheme === 'light');
    });

    await check('device pool UI queues, cancels and finishes a simulated job', async () => {
      await settingsCategory('models');await click('[data-model-config="local"]');await setValue('#local-backend','ugen300','change');
      await evaluate(()=>{document.querySelector('#ugen-preview').open=true;});
      await click('[data-action="pool-add"]');
      await uiWait('Simulated device appears', () => document.querySelectorAll('.mf-device-row').length === 1);
      await evaluate(() => { document.querySelector('.mf-pool-test').open = true; });
      await click('[data-action="pool-test"][data-model="llm"]');
      await uiWait('First simulated job appears', () =>
        document.querySelector('.mf-pool-job')?.textContent.includes('LLM') &&
        !document.querySelector('[data-action="pool-test"][data-model="llm"]').disabled);
      await evaluate(() => { document.querySelector('.mf-pool-test').open = true; });
      await click('[data-action="pool-test"][data-model="ocr"]');
      await waitFor('Second model waits for the device', () => actions.bootstrap().pool.jobs.some(job => job.model === 'ocr' && job.state === 'queued'));
      await uiWait('Running and waiting work are visible', () => document.querySelectorAll('.mf-pool-job').length === 2);
      await evaluate(() => document.querySelector('#pool-jobs').scrollIntoView({block: 'center'}));
      await screenshot('09-pool-queue');
      const queued = actions.bootstrap().pool.jobs.find(job => job.model === 'ocr');
      await click(`[data-action="pool-cancel"][data-id="${queued.id}"]`);
      await waitFor('Queued work cancelled', () => actions.bootstrap().pool.jobs.find(job => job.id === queued.id).state === 'cancelled');
      await waitFor('Five-second simulated work completes', () => actions.bootstrap().pool.jobs.some(job => job.model === 'llm' && job.state === 'completed'));
      await uiWait('Resident model remains available', () => document.querySelector('.mf-device-state')?.textContent.includes('閒置'));
      assert.equal(actions.bootstrap().pool.devices[0].model, 'llm');
      assert.equal(core.snapshot().polish.output, '', 'Scheduler must not manufacture model output.');
    });

    await check('preferred and offload policy fields control the pool', async () => {
      await settingsCategory('models');
      await click('input[name="policy-mode"][value="preferred"]');
      await setValue('#pool-preferred', 'ocr', 'change');
      await setValue('#pool-idle', '1');
      await setValue('#pool-unit', 'seconds', 'change');
      await click('[data-action="save-policy"]');
      await waitFor('Preferred policy saved', () => core.snapshot().settings.policy.mode === 'preferred');
      await waitFor('Idle device returns to preferred OCR', () => {
        const device = actions.bootstrap().pool.devices[0];
        return device.state === 'ready' && device.model === 'ocr';
      });
      await click('input[name="policy-mode"][value="offload"]');
      await click('[data-action="save-policy"]');
      await waitFor('Idle device unloads its model', () => actions.bootstrap().pool.devices[0].state === 'empty');
      assert.equal(core.snapshot().settings.policy.mode, 'offload');
      assert.equal(core.snapshot().settings.policy.idleMs, 1000);
      await setValue('#pool-idle','60');await setValue('#pool-unit','seconds','change');await click('[data-action="save-policy"]');
      await waitFor('A sixty-second policy saves exactly one minute',()=>core.snapshot().settings.policy.idleMs===60000);
      await uiWait('Formatted policy controls preserve the saved duration',()=>Number(document.querySelector('#pool-idle').value)*(document.querySelector('#pool-unit').value==='minutes'?60000:1000)===60000&&!document.querySelector('[data-action="save-policy"]').disabled);
      await click('input[name="policy-mode"][value="resident"]');
      await click('[data-action="save-policy"]');
      await waitFor('Resident policy restored', () => core.snapshot().settings.policy.mode === 'resident');
    });

    await check('renderer reload retains local work and isolated state', async () => {
      report.rendererErrors.push(...await evaluate(() => window.__smokeErrors || []));
      await win.loadFile(path.join(projectDir, 'app', 'index.html'));
      await uiWait('Reload bootstrap', () => document.querySelector('#mf-top h1')?.textContent === '首頁');
      await nav('inbox');
      await setValue('#mail-folder', 'drafts', 'change');
      await click(`[data-action="edit-draft"][data-id="${draftId}"]`);
      assert.equal(await evaluate(() => document.querySelector('#compose-subject').value), 'Smoke local draft');
      await closeModal();
      await nav('meetings');
      await click(`[data-action="media-open"][data-id="${recordingId}"]`);
      await uiWait('Manual transcript survives reload', () => document.querySelector('.mf-transcript')?.textContent.includes('純文字人工逐字稿'));
      await closeModal();
      const state = actions.bootstrap();
      assert.equal(state.accounts.length, 0); assert.equal(state.settings.ocrAuto, false);
      assert.equal(state.settings.theme, 'light'); assert.equal(state.polish.output, '');
      assert.equal(state.ocr.text, '人工校對文字，不是模型辨識結果。');
      assert.equal(state.drafts.length, 1);
      await nav('home');
      await screenshot('10-persisted-home');
      assert.deepEqual(report.rendererErrors, [], 'Renderer emitted errors.');
    });

    await check('minimum window settings and compose stay within viewport', async () => {
      const originalSize = win.getSize();
      try {
        win.setSize(640, 480);
        await settingsCategory('general');
        await uiWait('Minimum window layout updates', () => window.innerWidth <= 640 && window.innerHeight <= 480);
        assert.equal(await evaluate(() => ['#ufriend-app', '#mf-page'].every(selector => {
          const el = document.querySelector(selector);
          return el.scrollWidth <= el.clientWidth + 1;
        })), true, 'Settings must not overflow horizontally at minimum window size.');
        await screenshot('11-minimum-settings');
        await nav('inbox');
        await setValue('#mail-folder', 'drafts', 'change');
        await click(`[data-action="edit-draft"][data-id="${draftId}"]`);
        await uiWait('Draft opens in minimum window', () => !!document.querySelector('#compose-body'));
        assert.equal(await evaluate(() => ['.mf-dialog', '.mf-dialogbody', '.mf-dialogfoot'].every(selector => {
          const el = document.querySelector(selector);
          return el.scrollWidth <= el.clientWidth + 1;
        })), true, 'Compose must not overflow horizontally at minimum window size.');
        await screenshot('12-minimum-compose');
        await closeModal();
      } finally {
        win.setSize(...originalSize);
      }
    });

    await check('native credential encryption and renderer isolation', async () => {
      const {safeStorage} = require('electron');
      const {Vault} = require('../app/services/vault.cjs');
      const fakeKey = 'ufriend-smoke-key';
      const preferences = win.webContents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      assert.deepEqual(await evaluate(() => ({require: typeof window.require, process: typeof window.process})),
        {require: 'undefined', process: 'undefined'});
      if (!safeStorage.isEncryptionAvailable()) {
        const error = new Error('Unsupported: native safeStorage encryption is unavailable; credential smoke was not passed.');
        error.code = 'SMOKE_UNSUPPORTED';
        throw error;
      }
      assert.equal(actions.bootstrap().secrets.cloudKeySet, false,
        'The dedicated smoke workspace must not already contain an API key.');
      try {
        const saved = await ipcCall('secrets.save', {kind: 'cloud-api', value: fakeKey});
        assert.equal(saved.secrets.cloudKeySet, true);
        assert.equal(JSON.stringify(saved).includes(fakeKey), false, 'Save response must not expose the key.');
        const snapshot = await ipcCall('bootstrap');
        assert.equal(snapshot.secrets.cloudKeySet, true);
        assert.equal(JSON.stringify(snapshot).includes(fakeKey), false, 'Renderer snapshot must not expose the key.');
        const encrypted = await fs.readFile(path.join(dataDir, 'credentials.bin'));
        assert(encrypted.length > 0, 'Encrypted credential file must exist.');
        assert.equal(encrypted.includes(Buffer.from(fakeKey, 'utf8')), false);
        assert.equal(encrypted.includes(Buffer.from(fakeKey, 'utf16le')), false);
        const reloadedVault = new Vault({dataDir, safeStorage});
        assert.deepEqual(reloadedVault.get('cloud-api'), {key: fakeKey},
          'A fresh vault must decrypt the saved credential from the isolated test file.');
        await win.loadFile(path.join(projectDir, 'app', 'index.html'));
        await waitFor('Credential status after renderer reload', async () =>
          (await ipcCall('bootstrap')).secrets.cloudKeySet === true);
        assert.equal(JSON.stringify(await ipcCall('bootstrap')).includes(fakeKey), false);
      } finally {
        await actions['secrets.save']({kind: 'cloud-api', clear: true});
      }
      assert.equal(actions.bootstrap().secrets.cloudKeySet, false, 'Fake key must be cleared after the test.');
      assert.equal(new Vault({dataDir, safeStorage}).get('cloud-api'), null);
    });

    await check('Gmail configuration, independent sync preferences and safe auth feedback', async () => {
      const {safeStorage} = require('electron');
      const {Vault} = require('../app/services/vault.cjs');
      const baseline = actions.bootstrap();
      assert.equal(baseline.gmailAuth.configured, false);
      assert.equal(baseline.gmailAuth.hasOverride, false);
      assert.equal(baseline.secrets.gmailSecretSet, false);
      const fakeClientId = 'fake-client.apps.googleusercontent.com';
      const fakeSecret = 'ufriend-smoke-google-secret';
      const originalConnect = actions['gmail.connect'];
      const originalSize = win.getSize();
      let rejectAuthorization, connectCalls = 0;
      // This replacement is the only authorization path used below. It never
      // creates an OAuth listener, opens a browser, or invokes a Gmail service.
      actions['gmail.connect'] = () => {
        connectCalls++;
        return new Promise((_resolve, reject) => {
          rejectAuthorization = reject;
          const current = actions.bootstrap();
          win.webContents.send('ufriend:change', {...current,
            gmailAuth: {...current.gmailAuth, phase: 'waiting'}});
        });
      };
      try {
        const configured = await ipcCall('gmail.configure', {clientId: fakeClientId, clientSecret: fakeSecret});
        assert.equal(configured.gmailAuth.configured, true);
        assert.equal(configured.gmailAuth.source, 'manual');
        assert.equal(configured.secrets.gmailSecretSet, true);
        assert.equal(JSON.stringify(configured).includes(fakeSecret), false);
        await win.loadFile(path.join(projectDir, 'app', 'index.html'));
        await uiWait('Configured app reloads', () => document.querySelector('#mf-top h1')?.textContent === '首頁');
        await settingsCategory('mail');
        await uiWait('Google sign-in readiness is visible', () =>
          document.querySelector('.mf-gmail-connect')?.innerText.includes('Google 連接已就緒'));
        assert.equal(await evaluate(() => document.querySelector('#gmail-advanced').open), false);
        assert.equal(await evaluate(() => document.querySelector('#gmail-client-id').checkVisibility()), false);

        win.setSize(640, 480);
        await uiWait('Configured settings use the minimum viewport', () => window.innerWidth <= 640 && window.innerHeight <= 480);
        assert.equal(await evaluate(() => ['#ufriend-app', '#mf-page', '#gmail-settings', '.mf-gmail-connect'].every(selector => {
          const el = document.querySelector(selector);
          return el.scrollWidth <= el.clientWidth + 1;
        })), true, 'Gmail connection settings must not overflow horizontally at minimum window size.');
        await evaluate(() => document.querySelector('.mf-gmail-connect').scrollIntoView({block: 'center'}));
        await screenshot('14-settings-gmail');
        win.setSize(...originalSize);

        await click('.mf-gmail-sync > summary');
        await setValue('#gmail-days', '14');
        await setValue('#gmail-interval', '9');
        await click('[data-action="save-gmail-sync"]');
        await waitFor('Sync preferences save separately', () =>
          core.snapshot().settings.initialDays === 14 && core.snapshot().settings.syncMinutes === 9);
        assert.equal(core.snapshot().settings.gmailClientId, fakeClientId);
        assert.equal(new Vault({dataDir, safeStorage}).get('gmail-client')?.clientSecret, fakeSecret);
        await uiWait('Advanced credentials remain collapsed', () => !document.querySelector('#gmail-advanced').open);

        // The simulated phase exists only in its injected snapshot. Let the
        // preceding settings refresh/broadcast finish before publishing it.
        await uiWait('Sync settings action has settled before simulated authorization',()=>!document.querySelector('[data-action="save-gmail-sync"]').disabled&&document.querySelector('#mf-toast')?.textContent==='同步偏好已保存。');
        await pause(120);

        // Configured buttons are clicked only while the guarded replacement is installed.
        await click('#gmail-settings [data-action="connect-gmail"]');
        await waitFor('Only the simulated authorization was invoked', () => connectCalls === 1);
        await uiWait('Authorization wait state is explained', () =>
          document.querySelector('#gmail-auth-status')?.textContent.includes('請在 Google 頁面選擇帳號'));
        rejectAuthorization(Object.assign(new Error('Simulated Google authorization refusal.'), {code: 'AUTH_DENIED'}));
        rejectAuthorization = null;
        await uiWait('Denied authorization offers a useful retry', () =>
          document.querySelector('#dialog-title')?.textContent === '尚未完成授權' &&
          !!document.querySelector('#mf-overlay [data-action="connect-gmail"]'));
        assert.equal(actions.bootstrap().accounts.length, 0, 'A simulated refusal must not create an account.');
        await closeModal();

        await click('#gmail-settings [data-action="connect-gmail"]');
        await waitFor('Retry invokes only simulated authorization', () => connectCalls === 2);
        await uiWait('Simulated retry reaches the wait state', () =>
          document.querySelector('#gmail-auth-status')?.textContent.includes('請在 Google 頁面選擇帳號'));
        rejectAuthorization(Object.assign(new Error('Simulated Google authorization cancellation.'), {code: 'AUTH_CANCELLED'}));
        rejectAuthorization = null;
        await uiWait('Cancelled authorization closes without an error dialog', () =>
          document.querySelector('#mf-overlay').hidden &&
          document.querySelector('#mf-toast')?.textContent === '已取消 Gmail 連接。');
        assert.equal(actions.bootstrap().accounts.length, 0, 'A simulated cancellation must not create an account.');

        await click('#gmail-advanced > summary');
        await click('[data-action="gmail-clear-config"]');
        await uiWait('Cleared settings show first-time setup again', () =>
          document.querySelector('.mf-gmail-connect')?.innerText.includes('尚未完成首次設定'));
        const cleared = actions.bootstrap();
        assert.equal(cleared.gmailAuth.configured, false);
        assert.equal(cleared.gmailAuth.hasOverride, false);
        assert.equal(cleared.settings.gmailClientId, '');
        assert.equal(cleared.secrets.gmailSecretSet, false);
        assert.equal(new Vault({dataDir, safeStorage}).get('gmail-client'), null);
      } finally {
        if (rejectAuthorization) rejectAuthorization(Object.assign(new Error('Smoke cleanup cancelled simulated authorization.'), {code: 'AUTH_CANCELLED'}));
        actions['gmail.connect'] = originalConnect;
        await actions['gmail.clearConfig']({});
        await actions['settings.save']({initialDays: baseline.settings.initialDays, syncMinutes: baseline.settings.syncMinutes});
        win.setSize(...originalSize);
      }
      assert.equal(actions.bootstrap().accounts.length, 0);
      assert.equal(actions.bootstrap().secrets.gmailSecretSet, false);
    });
    assert(report.checks.length,'The smoke filter must match at least one scenario.');
    if(filter)report.filter=filter;
    report.status = 'passed';
    console.log(`SMOKE COMPLETE ${report.checks.length} scenarios, ${report.screenshots.length} screenshots`);
  } catch (error) {
    report.status = error.code === 'SMOKE_UNSUPPORTED' ? 'unsupported' : 'failed';
    report.error = {code: error.code, message: error.message, stack: error.stack};
    try { await screenshot('failure'); } catch (captureError) { report.captureError = captureError.message; }
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(resultsDir, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
    if(filter==='English UI language')await fs.writeFile(path.join(resultsDir,'ui-language-target-v'+app.getVersion()+'.json'),JSON.stringify(report,null,2)+'\n');
    win.webContents.removeListener('console-message', rendererConsole);
  }
}

module.exports = run;
module.exports.run = run;

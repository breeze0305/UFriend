'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

// Exercises the UI, IPC and real source registry with synthetic adapters only.
module.exports=async({core,actions,win,projectDir,fixtureDir,silentWav,nav,click,setValue,evaluate,waitFor,uiWait,screenshot,settingsCategory,closeModal})=>{
  const saved=structuredClone(core.store.read()),bounds=win.getBounds(),calls=[];
  const originalChoose=actions['media.choose'],originalHealth=actions['models.health'],originalSaveSecret=actions['secrets.save'];
  let resolveHealth;
  const originals=Object.fromEntries(['local','cloud'].map(source=>[source,new Map(core.models.sourceAdapters[source])]));
  const answer='Synthetic source selection result.';
  for(const source of ['local','cloud'])for(const kind of ['llm','ocr','whisper'])core.models.register(kind,{isConfigured:()=>true,async run(request){
    calls.push({source,kind,task:request.task,input:structuredClone(request.input)});
    assert.equal(request.source,source);
    const meta={model:'synthetic-'+source,backend:'smoke'};
    if(request.task==='mail')return{analyses:request.input.messages.map(mail=>({id:mail.id,summary:answer,priority:1,reason:'Synthetic request',evidence:[mail.body]})),meta};
    if(request.task==='mail-classify'){assert.deepEqual(request.input,{summary:answer});return{category:'work',meta};}
    if(kind==='whisper')return{segments:[{start:0,end:2,text:answer}],duration:3,language:'en',meta};
    if(request.task==='chat')request.onDelta?.(answer);
    return{text:answer,regions:[],meta};
  }},{source});
  const refresh=()=>win.webContents.send('ufriend:change',actions.bootstrap());
  const chooseSource=async(kind,source)=>{
    await setValue('#ai-source-'+kind,source,'change');
    await uiWait(kind+' source selection settles',(kind,source)=>{const field=document.querySelector('#ai-source-'+kind);return field?.value===source&&!field.disabled&&field.getAttribute('aria-busy')!=='true';},kind,source);
    if(kind!=='mail')assert.equal(await evaluate(()=>document.activeElement.id),'ai-source-'+kind,'Saving the selection must retain keyboard focus.');
  };
  try{
    core.stopRecordingScheduler();
    core.store.update(state=>{
      state.messages=[{id:'source-smoke-mail',accountId:'local',source:'本機',subject:'Synthetic source test',body:'Please review this synthetic message.',sender:'sender@example.invalid',to:'recipient@example.invalid',date:new Date().toISOString(),folder:'inbox',done:false,level:null,attachments:[]}];
      state.recordings=[];
    });
    core.startRecordingScheduler();refresh();
    const settingsBefore=structuredClone(core.snapshot().settings);
    await settingsCategory('models');
    await click('[data-model-config="cloud"]');
    await uiWait('Cloud has separate model parameters',()=>['api-endpoint','api-model','api-ocr-model','api-transcription-model','api-temperature'].every(id=>document.getElementById(id)?.checkVisibility()));
    assert(!Object.hasOwn(core.snapshot().settings,'compute'));
    await screenshot('50-source-cloud-settings');
    await click('[data-model-config="local"]');
    assert.deepEqual(core.snapshot().settings,settingsBefore,'Browsing connection configuration must not change task selection or settings.');

    await nav('home');await chooseSource('mail','cloud');
    assert.equal(core.snapshot().ocr.source,'local');assert.equal(core.snapshot().translation.source,'local');
    await click('[data-action="analyze"]');
    await waitFor('Mail completes with its selected source',()=>core.snapshot().messages[0].analysis?.meta?.source==='cloud'&&core.snapshot().messages[0].analysis?.categoryStatus==='done');
    assert.equal(core.snapshot().messages[0].analysis.category,'work');

    const logo=await fs.readFile(path.join(projectDir,'app/assets/ufriend.png'));
    await core.setOcrImage(await core.ingestBuffer(logo,{name:'source-smoke.png'}));
    refresh();await nav('ocr');await chooseSource('ocr','cloud');await click('[data-action="ocr-start"]');
    await waitFor('OCR completes with its selected source',()=>core.snapshot().ocr.meta?.source==='cloud');

    core.savePolish({input:'Synthetic text to polish.',use:'message',tone:'polite'});
    refresh();await nav('polish');await chooseSource('polish','cloud');await click('[data-action="polish-start"]');
    await waitFor('Polish completes with its selected source',()=>core.snapshot().polish.meta?.source==='cloud');

    core.saveTranslation({input:'Synthetic text to translate.',sourceLanguage:'en',targetLanguage:'zh-TW'});
    refresh();await nav('translation');await chooseSource('translation','cloud');await click('[data-action="translation-start"]');
    await waitFor('Translation completes with its selected source',()=>core.snapshot().translation.meta?.source==='cloud');

    await nav('chat');await chooseSource('chat','cloud');
    assert((await evaluate(()=>document.querySelector('#mf-page').textContent)).includes('歷史'));
    await setValue('#chat-input','Synthetic cloud conversation.');await click('[data-action="chat-send"]');
    await waitFor('Chat completes with its selected source',()=>core.snapshot().chat.messages.at(-1)?.meta?.source==='cloud');
    await screenshot('50-source-cloud-chat');
    await chooseSource('chat','local');await setValue('#chat-input','Synthetic local follow-up.');await click('[data-action="chat-send"]');
    await waitFor('The next chat request can use local',()=>core.snapshot().chat.messages.at(-1)?.meta?.source==='local');
    assert.equal(core.snapshot().chat.messages.at(-3).meta.source,'cloud','Changing the next request must preserve the previous result source.');

    const media=path.join(fixtureDir,'source-selection.wav');await fs.writeFile(media,silentWav(3));
    actions['media.choose']=async()=>[media];
    await nav('meetings');await click('#meeting-drop-zone');await click('[data-action="choose-media"]');
    await setValue('#upload-source','cloud','change');await setValue('#upload-language','en','change');
    await screenshot('50-source-meeting-import');
    await click('[data-action="confirm-media-import"]');
    await waitFor('Imported meeting saves its source',()=>core.snapshot().recordings.length===1&&core.snapshot().recordings[0].source==='cloud');
    await uiWait('Import closes',()=>document.querySelector('#mf-overlay').hidden);
    const id=core.snapshot().recordings[0].id;
    assert(!calls.some(call=>call.kind==='whisper'),'Import alone must not transmit the recording.');
    await actions['media.schedule']({ids:[id],source:'cloud',scheduledAt:new Date(Date.now()+3600000).toISOString()});refresh();
    await uiWait('Scheduled source cannot be changed without pausing',id=>document.querySelector('[data-recording-source="'+id+'"]')?.disabled,id);
    core.initialize();core.startRecordingScheduler();refresh();
    assert.equal(core.snapshot().recordings[0].source,'cloud');assert.equal(core.snapshot().recordings[0].state,'scheduled');
    await actions['settings.save']({localBackend:'pc-api'});
    assert.equal(core.snapshot().recordings[0].source,'cloud','Changing local connection configuration cannot retarget a queued cloud meeting.');
    await actions['media.pause']({id});refresh();
    await click('[data-action="media-start"][data-id="'+id+'"]');
    await waitFor('Meeting queue executes the saved source',()=>core.snapshot().recordings[0].state==='done');
    assert.equal(core.snapshot().recordings[0].meta.source,'cloud');
    assert.deepEqual(calls.filter(call=>call.source==='cloud').map(call=>call.task),['mail','mail-classify','recognize','polish','translate','chat','transcribe']);
    assert.deepEqual(calls.filter(call=>call.source==='local').map(call=>call.task),['chat']);
    await screenshot('50-source-meeting-result');

    for(const [view,kind] of [['home','mail'],['ocr','ocr'],['polish','polish'],['translation','translation'],['chat','chat']]){
      await nav(view);await uiWait(kind+' returns to its local default',kind=>document.querySelector('#ai-source-'+kind)?.value==='local',kind);
      await chooseSource(kind,'cloud');await nav('settings');await nav(view);
      await uiWait(kind+' temporary cloud choice resets after returning',kind=>document.querySelector('#ai-source-'+kind)?.value==='local',kind);
    }
    await settingsCategory('models');await click('[data-model-config="cloud"]');
    for(const kind of ['llm','ocr','whisper']){
      await click('#model-default-cloud-'+kind);await waitFor(kind+' cloud default saved',()=>core.snapshot().settings.modelDefaults[kind]==='cloud');
      await uiWait(kind+' default switch is on',kind=>document.querySelector('#model-default-cloud-'+kind)?.checked,kind);
    }
    await nav('translation');await uiWait('LLM starts with cloud default',()=>document.querySelector('#ai-source-translation')?.value==='cloud');
    await chooseSource('translation','local');await nav('home');await nav('translation');await uiWait('LLM returns to cloud default',()=>document.querySelector('#ai-source-translation')?.value==='cloud');
    await nav('ocr');await uiWait('OCR starts with cloud default',()=>document.querySelector('#ai-source-ocr')?.value==='cloud');
    await nav('meetings');await click('#meeting-drop-zone');await uiWait('New import uses Whisper default',()=>document.querySelector('#upload-source')?.value==='cloud');await closeModal();
    await nav('home');await click('[data-action="analyze"]');await waitFor('Unchanged mail batch finishes',()=>core.snapshot().mailAnalysis.status==='done'&&core.snapshot().mailAnalysis.unchanged===1);
    assert.equal(calls.filter(call=>call.task==='mail').length,1,'Cached mail must not invoke the summary model again.');
    await nav('inbox');await uiWait('Inbox shows generated category and summary',()=>document.querySelector('.mf-mail-category[data-category="work"]')&&document.querySelector('#mf-page')?.textContent.includes('Synthetic source selection result.'));
    await setValue('#mail-category','finance','change');await uiWait('Category filter hides unrelated mail',()=>!document.querySelector('[data-action="open-mail"][data-id="source-smoke-mail"]'));
    await setValue('#mail-category','work','change');await click('[data-action="open-mail"][data-id="source-smoke-mail"]');
    const detailHasOnlyMailControls=()=>document.querySelector('#mail-analysis-result .mf-mail-category[data-category="work"]')&&
      !document.querySelector('#ai-source-mail,#mail-analysis-actions,#mail-analysis-progress,[data-action="analyze-mail"],[data-action="analyze"],[data-action="cancel-analysis"]');
    await uiWait('Detail retains its summary and category without organization controls or batch progress',detailHasOnlyMailControls);
    await screenshot('50-mail-summary-and-category');
    core.store.update(state=>{state.messages[0].body+=' Please review the revised synthetic request.';});refresh();
    await uiWait('Detail live updates do not restore organization controls or batch progress',detailHasOnlyMailControls);
    await click('[data-action="mail-back"]');
    await uiWait('Inbox retains global organization controls and completed batch progress',()=>document.querySelector('#ai-source-mail')?.value==='cloud'&&document.querySelector('[data-action="analyze"]')&&!document.querySelector('[data-action="cancel-analysis"]')&&document.querySelector('#mail-analysis-progress')?.textContent.includes('沒有新增或需要更新的信件'));
    await chooseSource('mail','local');await click('[data-action="analyze"]');
    await waitFor('Changed mail is regenerated from the inbox using its selected source',()=>calls.filter(call=>call.task==='mail').length===2&&core.snapshot().mailAnalysis.status==='done'&&core.snapshot().messages[0].analysis?.meta?.source==='local');
    await click('[data-action="open-mail"][data-id="source-smoke-mail"]');
    await uiWait('Updated detail keeps batch counts and organization controls out of the message',detailHasOnlyMailControls);
    await settingsCategory('mail');await click('#mail-schedule-enabled');await setValue('#mail-schedule-time','21:35','change');await click('[data-action="save-mail-schedule"]');
    await waitFor('Daily organization time persists',()=>core.snapshot().settings.mailSchedule.enabled&&core.snapshot().settings.mailSchedule.time==='21:35');
    await nav('home');await settingsCategory('mail');await uiWait('Saved daily time survives navigation',()=>document.querySelector('#mail-schedule-enabled')?.checked&&document.querySelector('#mail-schedule-time')?.value==='21:35');
    await evaluate(()=>document.querySelector('#mail-schedule-settings').scrollIntoView({block:'start'}));await screenshot('50-mail-daily-schedule');

    const cloudLlm=core.models.get('llm','cloud');let finishRunning;
    try{
      await actions['settings.save']({modelDefaults:{llm:'local'}});refresh();
      core.models.register('llm',{isConfigured:()=>true,run(request){assert.equal(request.task,'polish');assert.equal(request.source,'cloud');return new Promise(resolve=>{finishRunning=()=>resolve({text:'Synthetic cloud job finished after navigation.',meta:{model:'synthetic-cloud',backend:'smoke'}});});}},{source:'cloud'});
      await nav('polish');await chooseSource('polish','cloud');await setValue('#polish-input','Synthetic ongoing cloud job.');await click('[data-action="polish-start"]');
      await waitFor('Selected cloud task is running',()=>!!finishRunning&&core.snapshot().polish.status==='running');
      await nav('home');await nav('polish');
      await uiWait('Returning displays local default while the cloud task continues',()=>document.querySelector('#ai-source-polish')?.value==='local'&&document.querySelector('.mf-ai-source-running')?.textContent.includes('雲端'));
      assert.equal(core.snapshot().polish.status,'running');assert.equal(core.snapshot().polish.source,'cloud');
      await screenshot('50-default-with-running-cloud-task');finishRunning();
      await waitFor('Running result retains its actual cloud source',()=>core.snapshot().polish.status==='done'&&core.snapshot().polish.meta.source==='cloud');
    }finally{finishRunning?.();core.models.register('llm',cloudLlm,{source:'cloud'});}

    for(const [width,height,theme,language] of [[1080,820,'light','zh-TW'],[640,620,'dark','en']]){
      win.setSize(width,height);await actions['settings.save']({theme,uiLanguage:language});refresh();
      await settingsCategory('models');await click('[data-model-config="cloud"]');
      await uiWait('Source settings fit the viewport',()=>document.documentElement.scrollWidth<=window.innerWidth+1);
      await screenshot('50-source-settings-'+width+'-'+language);
      if(language==='en'){
        actions['models.health']=async args=>{assert.equal(args.source,'cloud');throw new Error('請先設定雲端 API 位址、金鑰及這項功能使用的模型。');};
        await click('[data-action="test-cloud-api"][data-kind="llm"]');
        await uiWait('Cloud configuration errors use the selected UI language',()=>document.querySelector('#cloud-llm-status')?.textContent.includes('Configure'));
        actions['models.health']=()=>new Promise(resolve=>{resolveHealth=resolve;});
        let savedKey=false;
        actions['secrets.save']=async args=>{assert.equal(args.kind,'cloud-api');assert.equal(args.value,'synthetic-rotated-key');savedKey=true;return actions.bootstrap();};
        await click('[data-action="test-cloud-api"][data-kind="llm"]');await waitFor('Old key health is pending',()=>!!resolveHealth);
        await setValue('#api-key','synthetic-rotated-key');await click('[data-action="save-api"]');
        await uiWait('Saving a key invalidates its prior health result',()=>document.querySelector('#cloud-llm-status')?.textContent.includes('not been tested'));
        assert(savedKey);resolveHealth({ready:true,model:'obsolete-key-result',backend:'synthetic'});resolveHealth=null;
        await new Promise(resolve=>setTimeout(resolve,100));
        assert((await evaluate(()=>document.querySelector('#cloud-llm-status').textContent)).includes('not been tested'),'A late result for an earlier key must not mark the saved key ready.');
      }
    }
  }finally{
    core.stopRecordingScheduler();
    for(const controller of core.active.values())controller.abort();core.active.clear();
    resolveHealth?.({ready:false,model:'cancelled-fixture'});
    actions['media.choose']=originalChoose;actions['models.health']=originalHealth;actions['secrets.save']=originalSaveSecret;
    for(const source of ['local','cloud']){core.models.sourceAdapters[source].clear();for(const [kind,adapter] of originals[source])core.models.sourceAdapters[source].set(kind,adapter);}
    core.store.update(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,saved);});core.initialize();core.startRecordingScheduler();
    win.setBounds(bounds);await actions['settings.save']({theme:saved.settings.theme,uiLanguage:saved.settings.uiLanguage});refresh();
    if(await evaluate(()=>!document.querySelector('#mf-overlay').hidden))await closeModal();
    await nav('home');
  }
};

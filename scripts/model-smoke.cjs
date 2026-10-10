'use strict';

// Hidden Electron integration run against the three already-running local model APIs.
// The audio, transcript, reports and screenshots remain in Git-ignored directories.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {emptyState}=require('../app/services/store.cjs');
const {DEFAULT_SETTINGS}=require('../app/services/core.cjs');
const {exportTxt,exportSrt,parseSrt,validateSegments}=require('../app/services/formats.cjs');

const projectDir=path.resolve(__dirname,'..');
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const ENDPOINTS={llm:'http://127.0.0.1:8765',ocr:'http://127.0.0.1:8767',whisper:'http://127.0.0.1:8768'};
const OCR_LINES=[
  'UFriend 本機模型整合測試',
  '繁體中文：臺灣團隊，請準時參加會議。',
  'Meeting reminder: please bring the project report.',
  '時間：15:00',
  '金額：12,500元',
];

function characterErrorRate(reference,hypothesis){
  const expected=Array.from(reference),actual=Array.from(hypothesis);
  let previous=Array.from({length:actual.length+1},(_,index)=>index);
  for(let row=1;row<=expected.length;row++){
    const current=[row];
    for(let column=1;column<=actual.length;column++)current[column]=Math.min(
      current[column-1]+1,previous[column]+1,previous[column-1]+(expected[row-1]===actual[column-1]?0:1));
    previous=current;
  }
  const distance=previous[actual.length];
  return{distance,referenceCharacters:expected.length,hypothesisCharacters:actual.length,cer:expected.length?distance/expected.length:null};
}

async function run({app,win,core,actions,dataDir}){
  const testRoot=path.join(projectDir,'.test-data','model-smoke');
  const workspace=path.join(testRoot,'workspace');
  assert(process.argv.includes('--model-smoke-test'),'This run requires --model-smoke-test.');
  assert.equal(path.resolve(app.getPath('userData')),testRoot,'Refusing to use a normal user profile.');
  assert.equal(path.resolve(dataDir),workspace,'Refusing to use a workspace outside the dedicated model smoke profile.');
  assert.equal(path.resolve(core.store.dataDir),workspace);
  const realProject=await fs.realpath(projectDir);
  assert.equal(await fs.realpath(dataDir),path.join(realProject,'.test-data','model-smoke','workspace'),
    'The isolated workspace must not redirect through a filesystem link.');
  assert.equal(core.snapshot().accounts.length,0,'Refusing to reset a workspace with accounts.');
  assert.equal(core.snapshot().messages.length,0,'Refusing to reset a workspace with mail.');
  assert.equal(core.active.size,0,'Another application job is already active.');

  const started=Date.now(),runId=new Date(started).toISOString().replace(/[:.]/g,'-');
  const fixtureDir=path.join(testRoot,'fixtures',runId);
  const resultsDir=path.join(projectDir,'.test-results','models');
  const privateDir=path.join(projectDir,'local','test-results','integration',runId);
  for(const directory of [fixtureDir,resultsDir,privateDir]){
    await fs.mkdir(directory,{recursive:true});
    assert.equal(await fs.realpath(directory),path.join(realProject,path.relative(projectDir,directory)),
      'Results must stay inside the designated ignored project directory.');
  }
  const reportFile=path.join(resultsDir,'model-smoke-report.json');
  const report={runId,startedAt:new Date(started).toISOString(),electron:process.versions.electron,
    status:'running',scope:'Real local API and desktop integration; content quality is recorded, not asserted.',
    dataDir,fixtureDir,privateDir,endpoints:ENDPOINTS,checks:[],screenshots:[],rendererErrors:[],metrics:{},models:{}};
  let recordingId,latestProgressLog=0;
  win.webContents.setBackgroundThrottling(false);
  win.setSize(1200,980);

  const evaluate=async(fn,...args)=>{
    const result=await win.webContents.executeJavaScript(
      `(async()=>{try{return{ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})};}catch(error){return{ok:false,message:error.message,stack:error.stack};}})()`,true);
    if(!result.ok)throw new Error(result.message+'\n'+result.stack);
    return result.value;
  };
  const ipcCall=(name,args={})=>evaluate(async(name,args)=>{
    const response=await window.ufriend.request(name,args);
    if(!response.ok)throw new Error((response.error?.code||'IPC_FAILED')+': '+(response.error?.message||name));
    return response.value;
  },name,args);
  const checkpoint=async()=>{
    report.elapsedMs=Date.now()-started;
    await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  };
  const waitFor=async(description,predicate,timeoutMs=12000,intervalMs=100)=>{
    const deadline=Date.now()+timeoutMs;
    do{if(await predicate())return;await pause(intervalMs);}while(Date.now()<deadline);
    throw new Error('Timed out: '+description);
  };
  const uiWait=(description,predicate,...args)=>waitFor(description,()=>evaluate(predicate,...args));
  const click=selector=>evaluate(selector=>{
    const element=document.querySelector(selector);
    if(!element)throw new Error('Missing control: '+selector);
    if(element.disabled)throw new Error('Disabled control: '+selector);
    element.scrollIntoView({block:'nearest'});element.focus();element.click();
  },selector);
  const setValue=(selector,value,event='input')=>evaluate((selector,value,event)=>{
    const element=document.querySelector(selector);
    if(!element)throw new Error('Missing input: '+selector);
    element.focus();element.value=value;element.dispatchEvent(new Event(event,{bubbles:true}));
  },selector,value,event);
  const nav=async view=>{
    await click('[data-nav="'+view+'"]');
    await uiWait('Navigate to '+view,view=>document.querySelector('#mf-page')?.dataset.view===view&&document.querySelector('#mf-overlay').hidden,view);
  };
  const closeModal=async()=>{
    await click('#mf-overlay [data-action="modal-close"]');
    await uiWait('Close dialog',()=>document.querySelector('#mf-overlay').hidden);
  };
  const screenshot=async name=>{
    win.webContents.invalidate();
    await evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    await pause(150);
    const image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    assert(!image.isEmpty(),'A screenshot must contain the rendered application.');
    const file=path.join(resultsDir,runId+'-'+name+'.png');
    await fs.writeFile(file,image.toPNG());report.screenshots.push({name,file,...image.getSize()});
  };
  const check=async(name,callback)=>{
    report.currentCheck=name;await checkpoint();
    const checkStarted=Date.now();
    try{await callback();report.checks.push({name,status:'passed',durationMs:Date.now()-checkStarted});}
    catch(error){report.checks.push({name,status:'failed',durationMs:Date.now()-checkStarted,error:error.message});throw error;}
    console.log('MODEL SMOKE INTEGRATION PASS '+name);await checkpoint();
  };
  const rendererConsole=(_event,details)=>{
    if(details&&typeof details==='object'&&details.level==='error')report.rendererErrors.push({message:details.message,source:details.sourceId,line:details.lineNumber});
  };
  const rendererGone=(_event,details)=>report.rendererErrors.push({type:'render-process-gone',...details});
  win.webContents.on('console-message',rendererConsole);win.webContents.on('render-process-gone',rendererGone);

  try{
    // Reset only the guarded, account-free fixture database. Keep generated files for review.
    core.store.update(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,emptyState());});
    core.initialize();
    await actions['settings.save']({...DEFAULT_SETTINGS,theme:'light',keepBackground:false,ocrAuto:false});
    await win.loadFile(path.join(projectDir,'app','index.html'));
    await uiWait('Initial renderer',()=>document.querySelector('#mf-page')?.dataset.view==='home');
    await evaluate(()=>{
      window.__modelSmokeErrors=[];
      window.addEventListener('error',event=>window.__modelSmokeErrors.push({type:'error',message:event.message}));
      window.addEventListener('unhandledrejection',event=>window.__modelSmokeErrors.push({type:'unhandledrejection',message:String(event.reason?.message||event.reason)}));
    });

    await check('three saved PC API endpoints report actual readiness',async()=>{
      await nav('settings');await click('[data-settings-tab="models"]');await click('[data-model-config="local"]');await setValue('#local-backend','pc-api','change');
      await uiWait('PC API settings',()=>!!document.querySelector('#dev-whisper-endpoint'));
      for(const [kind,selector] of [['llm','#dev-api-endpoint'],['ocr','#dev-ocr-endpoint'],['whisper','#dev-whisper-endpoint']])await setValue(selector,ENDPOINTS[kind]);
      await click('[data-action="save-dev-api"]');
      await waitFor('Save all three endpoints',()=>{
        const settings=core.snapshot().settings;
        return settings.localBackend==='pc-api'&&settings.devLlm.endpoint===ENDPOINTS.llm&&settings.devOcr.endpoint===ENDPOINTS.ocr&&settings.devWhisper.endpoint===ENDPOINTS.whisper;
      });
      await uiWait('Endpoint save finishes in the renderer',()=>document.querySelector('#mf-toast')?.textContent==='PC 測試 API 端點已保存。');
      for(const kind of ['llm','ocr','whisper']){
        const button=kind==='llm'?'[data-action="test-dev-api"]':'[data-action="test-media-api"][data-kind="'+kind+'"]';
        const status=kind==='llm'?'#dev-api-status':'#dev-'+kind+'-status';
        await click(button);
        await uiWait(kind+' health response',(button,status)=>{
          const text=document.querySelector(status)?.textContent||'';
          return !document.querySelector(button)?.disabled&&text&&!text.includes('正在測試')&&!text.includes('尚未測試');
        },button,status);
        const visible=await evaluate(selector=>document.querySelector(selector).textContent,status);
        assert(visible.includes('模型已就緒'),kind+' is not ready: '+visible);
        const health=await ipcCall('models.health',{kind,endpoint:ENDPOINTS[kind]});
        assert.equal(health.ready,true);assert.equal(health.apiVersion,'1');
        assert.equal(typeof health.model,'string');assert(health.model.trim());
        assert.equal(typeof health.backend,'string');assert(health.backend.trim());
        report.models[kind]=health;
      }
      await evaluate(()=>document.querySelector('.mf-dev-api').scrollIntoView({block:'start'}));
      await screenshot('01-settings-ready');
    });

    await check('synthetic screenshot passes through real OCR and reaches the editor',async()=>{
      const expected=OCR_LINES.join('\n');
      const png=await evaluate(async lines=>{
        await document.fonts.ready;
        const canvas=document.createElement('canvas');canvas.width=1500;canvas.height=640;
        const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
        context.fillStyle='#171c24';context.textBaseline='top';
        lines.forEach((line,index)=>{context.font=(index===0?'bold 48':'38')+'px "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif';context.fillText(line,55,45+index*108);});
        return canvas.toDataURL('image/png');
      },OCR_LINES);
      assert(png.startsWith('data:image/png;base64,'));
      const inputFile=path.join(fixtureDir,'繁體中文-英文-時間-金額.png');
      await fs.writeFile(inputFile,Buffer.from(png.slice('data:image/png;base64,'.length),'base64'));
      await fs.writeFile(path.join(fixtureDir,'ocr-expected.txt'),expected+'\n');
      await actions['ocr.import']({paths:[inputFile]});await nav('ocr');
      assert.equal(core.snapshot().ocr.status,'waiting-model');
      await uiWait('Imported OCR image enables recognition',()=>document.querySelector('[data-action="ocr-start"]')?.disabled===false);
      const inferenceStarted=Date.now();await click('[data-action="ocr-start"]');
      await waitFor('Real OCR finishes',()=>{
        const state=core.snapshot().ocr;
        if(['error','cancelled'].includes(state.status))throw new Error('OCR failed: '+(state.error||state.status));
        return ['done','no-text'].includes(state.status)&&!core.active.has('ocr');
      },200000,250);
      const result=structuredClone(core.snapshot().ocr);
      assert.equal(result.progress,100);assert(Array.isArray(result.regions));
      assert.equal(typeof result.meta?.model,'string');assert(result.meta.model);assert(result.meta.backend);
      await uiWait('OCR editor shows the unchanged model result',text=>document.querySelector('#ocr-text')?.value===text&&!document.querySelector('#ocr-text').readOnly,result.text);
      const normalize=text=>text.normalize('NFC').replace(/\s/gu,'');
      report.metrics.ocr={durationMs:Date.now()-inferenceStarted,state:result.status,inputFile,
        raw:characterErrorRate(expected,result.text),withoutWhitespace:characterErrorRate(normalize(expected),normalize(result.text)),
        normalization:'NFC and whitespace removal only; no punctuation, digit, script or spelling substitution.',
        exactTokens:Object.fromEntries(['15:00','12,500','12,500元'].map(token=>[token,result.text.includes(token)])),
        regionCount:result.regions.length,model:result.meta,qualityVerdict:'recorded-for-review'};
      const rawFile=path.join(privateDir,'ocr-raw-result.json');
      await fs.writeFile(rawFile,JSON.stringify({input:{file:inputFile,expected,lines:OCR_LINES},actual:result,metrics:report.metrics.ocr},null,2)+'\n');
      await fs.writeFile(path.join(privateDir,'ocr-actual.txt'),result.text);
      report.metrics.ocr.rawResultFile=rawFile;
      await screenshot('02-ocr-result');
    });

    await check('user audio completes through real Whisper after navigation and exports intact',async()=>{
      const source=path.join(projectDir,'local','test-data','audio','test_audio.mp3');
      const sourceStat=await fs.stat(source);assert(sourceStat.isFile()&&sourceStat.size>0,'The authorized local audio fixture is missing or empty.');
      const imported=await ipcCall('media.import',{paths:[source],language:'auto'});
      assert.deepEqual(imported.errors,[]);assert.equal(imported.imported.length,1);recordingId=imported.imported[0];
      const recording=()=>core.snapshot().recordings.find(item=>item.id===recordingId);
      const asset=core.asset(recording().assetId);
      assert(path.resolve(asset.path).startsWith(workspace+path.sep),'Imported audio must be managed by the isolated workspace.');
      assert.equal((await fs.stat(asset.path)).size,sourceStat.size);
      await nav('meetings');await uiWait('Imported meeting appears',id=>!!document.querySelector('[data-action="media-open"][data-id="'+id+'"]'),recordingId);
      await click('[data-action="media-open"][data-id="'+recordingId+'"]');
      await uiWait('Recording dialog appears',()=>!!document.querySelector('#recording-language'));
      await setValue('#recording-language','zh-TW','change');
      await waitFor('Save language from the actual UI',()=>recording().lang==='zh-TW');
      await closeModal();
      const cancelStarted=Date.now();
      await click('[data-action="media-start"][data-id="'+recordingId+'"]');
      await waitFor('Real Whisper processes audio before cancellation',()=>{
        if(recording().state==='error')throw new Error(recording().error);
        return recording().state==='running'&&recording().processedSeconds>0;
      },30000,200);
      const processedBeforeCancel=recording().processedSeconds;
      await uiWait('Real transcription exposes pause',id=>!!document.querySelector('[data-action="media-pause"][data-id="'+id+'"]'),recordingId);
      const cancellationRequested=Date.now();
      await click('[data-action="media-pause"][data-id="'+recordingId+'"]');
      await waitFor('Desktop cancellation settles',()=>recording().state==='paused'&&!core.active.has('recording:'+recordingId));
      await waitFor('Whisper releases the cancelled GPU job',async()=>{
        const response=await fetch(ENDPOINTS.whisper+'/health',{signal:AbortSignal.timeout(5000)});
        const health=await response.json();return health.ready===true&&health.busy===false;
      },30000,250);
      assert.equal(recording().segments.length,0);assert.equal(recording().transcriptSource,null);
      report.metrics.whisperCancellation={processedBeforeCancel,elapsedBeforeCancelMs:cancellationRequested-cancelStarted,
        releaseMs:Date.now()-cancellationRequested,state:recording().state,partialTranscriptPublished:false};
      await uiWait('Cancelled transcription exposes retry',id=>document.querySelector('[data-action="media-start"][data-id="'+id+'"]')?.disabled===false,recordingId);
      const inferenceStarted=Date.now(),samples=[];
      report.metrics.whisper={source,sourceBytes:sourceStat.size,recordingId,languageRequested:'zh-TW',progress:samples,qualityVerdict:'no-reference-transcript; accuracy-not-scored'};
      await click('[data-action="media-start"][data-id="'+recordingId+'"]');
      await waitFor('Whisper starts through UI',()=>{
        if(recording().state==='error')throw new Error(recording().error);
        return ['running','done','no-speech'].includes(recording().state);
      });
      assert(!['error','paused'].includes(recording().state),recording().error||'Whisper did not start.');
      report.metrics.whisper.stateBeforeNavigation=recording().state;
      await nav('home');await nav('meetings');
      await uiWait('Imported recording survives navigation',id=>!!document.querySelector('[data-action="media-open"][data-id="'+id+'"]'),recordingId);
      await uiWait('Recording card reflects inference state',id=>{
        const text=document.querySelector('[data-action="media-open"][data-id="'+id+'"]')?.closest('.mf-meeting')?.querySelector('.mf-filemeta')?.textContent||'';
        return text.includes('%')||text.includes('已完成')||text.includes('沒有辨識到語音');
      },recordingId);
      const card=await evaluate(id=>{
        const card=document.querySelector('[data-action="media-open"][data-id="'+id+'"]').closest('.mf-meeting');
        return{widthPercent:Number.parseFloat(card.querySelector('.mf-meeting-fill').style.width),text:card.querySelector('.mf-filemeta').textContent};
      },recordingId);
      assert(Number.isFinite(card.widthPercent)&&card.widthPercent>=0&&card.widthPercent<=100);
      if(recording().state==='running')assert(card.text.includes('%'),'The running recording card must display progress after navigation.');
      report.metrics.whisper.cardAfterNavigation=card;
      await screenshot('03-recording-after-navigation');
      await click('[data-action="media-open"][data-id="'+recordingId+'"]');
      if(recording().state==='running')await uiWait('Language is disabled during real transcription',()=>document.querySelector('#recording-language')?.disabled===true);
      await waitFor('The complete audio file finishes',async()=>{
        const current=recording();assert(current,'The imported recording disappeared.');
        if(['error','paused','waiting-model'].includes(current.state))throw new Error('Whisper failed: '+(current.error||current.state));
        const sample={elapsedMs:Date.now()-inferenceStarted,state:current.state,progress:current.progress,
          processedSeconds:current.processedSeconds??0,durationSeconds:current.duration};
        const previous=samples.at(-1);
        if(!previous||['state','progress','processedSeconds','durationSeconds'].some(key=>previous[key]!==sample[key])){
          if(previous)assert(sample.progress>=previous.progress,'Whisper progress must never go backwards.');
          if(sample.state==='running')assert(sample.progress<100,'A running job cannot claim full completion.');
          samples.push(sample);
        }
        if(Date.now()-latestProgressLog>15000){
          latestProgressLog=Date.now();console.log('MODEL SMOKE WHISPER '+Math.round(current.progress||0)+'% / '+Math.round(current.processedSeconds||0)+' seconds processed');await checkpoint();
        }
        return ['done','no-speech'].includes(current.state)&&!core.active.has('recording:'+recordingId);
      },2*60*60*1000+15000,750);
      const result=structuredClone(recording());
      assert.equal(result.progress,100);assert.equal(result.transcriptSource,'model');assert.equal(result.error,'');
      assert(Number.isFinite(result.duration)&&result.duration>=0,'The complete recording must carry the service duration.');
      assert.equal(result.processedSeconds,result.duration);
      assert.equal(typeof result.detectedLanguage,'string');assert(result.detectedLanguage);
      assert(result.meta?.model&&result.meta?.backend,'The transcription must identify the actual model and backend.');
      assert.deepEqual(validateSegments(result.segments),result.segments);
      for(const segment of result.segments)assert(segment.end<=result.duration+1,'A transcript segment exceeds the complete audio duration.');
      await uiWait('Open dialog receives all real segments',(count)=>document.querySelectorAll('#recording-transcript .mf-transcriptrow').length===count&&!document.querySelector('#recording-language').disabled,result.segments.length);
      const rendered=await evaluate(()=>Array.from(document.querySelectorAll('#recording-transcript .mf-transcriptrow p'),element=>element.textContent));
      assert.deepEqual(rendered,result.segments.map(segment=>segment.text));
      const txt=exportTxt(result),srt=exportSrt(result.segments),roundtrip=parseSrt(srt);
      assert.equal(roundtrip.length,result.segments.length);
      roundtrip.forEach((segment,index)=>{
        assert.equal(segment.text,result.segments[index].text);
        assert(Math.abs(segment.start-result.segments[index].start)<=0.000501);
        assert(Math.abs(segment.end-result.segments[index].end)<=0.000501);
      });
      const txtFile=path.join(privateDir,'test_audio.txt'),srtFile=path.join(privateDir,'test_audio.srt'),rawFile=path.join(privateDir,'whisper-raw-result.json');
      await fs.writeFile(txtFile,'\uFEFF'+txt);await fs.writeFile(srtFile,'\uFEFF'+srt);
      await fs.writeFile(rawFile,JSON.stringify(result,null,2)+'\n');
      assert.equal((await fs.readFile(txtFile,'utf8')).replace(/^\uFEFF/,''),txt);
      assert.equal((await fs.readFile(srtFile,'utf8')).replace(/^\uFEFF/,''),srt);
      assert.equal((await fs.stat(source)).size,sourceStat.size,'The original audio must remain intact.');
      Object.assign(report.metrics.whisper,{durationMs:Date.now()-inferenceStarted,state:result.state,fullCompleted:true,
        audioDurationSeconds:result.duration,processedSeconds:result.processedSeconds,segmentCount:result.segments.length,
        characterCount:Array.from(txt).length,firstSegmentStart:result.segments[0]?.start??null,lastSegmentStart:result.segments.at(-1)?.start??null,
        lastSegmentEnd:result.segments.at(-1)?.end??null,trailingSecondsAfterLastSegment:result.segments.length?result.duration-result.segments.at(-1).end:null,
        trailingSecondsInterpretation:'An untranscribed tail may be silence; this is an observation, not a completeness or accuracy score.',
        detectedLanguage:result.detectedLanguage,model:result.meta,exports:{txt:txtFile,srt:srtFile,raw:rawFile}});
      await screenshot('04-transcript-complete');
      if(result.segments.length){
        await evaluate(()=>document.querySelector('#recording-transcript .mf-transcriptrow:last-child').scrollIntoView({block:'end'}));
        await screenshot('05-transcript-last-segment');
      }
      await closeModal();
    });

    await check('two real LLM turns keep history and render replies as plain text',async()=>{
      await nav('chat');assert.equal(core.snapshot().chat.messages.length,0);
      const prompts=['2 + 3 等於多少？請用繁體中文簡短回答算式與答案。','把剛才的答案減去 1，是多少？請簡短回答，最後原樣附上這段純文字：<model-smoke>&'];
      const turns=[];
      for(let index=0;index<prompts.length;index++){
        const previous=structuredClone(core.snapshot().chat.messages),turnStarted=Date.now();
        await setValue('#chat-input',prompts[index]);
        await uiWait('Chat composer is ready to send',()=>document.querySelector('#chat-input')?.readOnly===false&&document.querySelector('[data-action="chat-send"]')?.disabled===false);
        await click('[data-action="chat-send"]');
        await waitFor('Real LLM turn '+(index+1)+' finishes',()=>{
          const chat=core.snapshot().chat;
          if(['error','waiting-model','cancelled'].includes(chat.status))throw new Error('LLM chat failed: '+(chat.error||chat.status));
          return chat.status==='done'&&chat.messages.length===(index+1)*2&&!core.active.has('chat');
        },200000,250);
        const chat=structuredClone(core.snapshot().chat);
        assert.deepEqual(chat.messages.slice(0,previous.length),previous,'The second turn must retain the actual first response.');
        assert.equal(chat.messages.at(-2).content,prompts[index]);assert(chat.messages.at(-1).content.trim());
        assert.equal(chat.pendingText,'');assert.equal(chat.error,'');
        await uiWait('The complete chat history renders',count=>document.querySelectorAll('#chat-log .mf-chat-text').length===count,chat.messages.length);
        const rendered=await evaluate(()=>Array.from(document.querySelectorAll('#chat-log .mf-chat-text'),element=>({text:element.textContent,childElements:element.children.length})));
        assert.deepEqual(rendered.map(item=>item.text),chat.messages.map(message=>message.content));
        assert(rendered.every(item=>item.childElements===0),'Chat text must never turn model markup into HTML elements.');
        turns.push({durationMs:Date.now()-turnStarted,user:prompts[index],assistant:chat.messages.at(-1).content,meta:chat.messages.at(-1).meta});
      }
      const chat=structuredClone(core.snapshot().chat);
      assert.deepEqual(chat.messages.map(message=>message.role),['user','assistant','user','assistant']);
      report.metrics.chat={turnCount:turns.length,messageCount:chat.messages.length,turns,
        arithmeticObservations:{firstMentionsFive:/(?:\b5\b|五)/u.test(turns[0].assistant),followupMentionsFour:/(?:\b4\b|四)/u.test(turns[1].assistant)},
        literalMarkerReturned:turns[1].assistant.includes('<model-smoke>&'),plainTextRendering:true,qualityVerdict:'observed-answers-require-review'};
      await fs.writeFile(path.join(privateDir,'chat-raw-result.json'),JSON.stringify(chat,null,2)+'\n');
      await screenshot('06-chat-two-turns');
    });

    await check('renderer stays error-free and the test workspace stays account-free',async()=>{
      report.rendererErrors.push(...await evaluate(()=>window.__modelSmokeErrors||[]));
      assert.deepEqual(report.rendererErrors,[]);
      assert.equal(core.snapshot().accounts.length,0);assert.equal(core.snapshot().messages.length,0);
      assert.equal(core.snapshot().settings.ocrAuto,false);assert.equal(core.active.size,0);
      report.summary={integrationPassed:true,qualityPassed:null,qualityAssessment:'OCR CER, exact numeric tokens, transcript timing and raw LLM answers are observations only.',
        modelNames:Object.fromEntries(Object.entries(report.models).map(([kind,value])=>[kind,value.model])),
        uiErrors:report.rendererErrors.length,completedChecks:report.checks.length+1};
    });
    report.status='integration-passed';
    console.log('MODEL SMOKE COMPLETE: local integration passed; model content quality remains recorded for review.');
    return report;
  }catch(error){
    report.status='failed';report.error={code:error.code,message:error.message,stack:error.stack};
    report.summary={integrationPassed:false,qualityPassed:null,failedCheck:report.currentCheck,uiErrors:report.rendererErrors.length};
    try{report.rendererErrors.push(...await evaluate(()=>window.__modelSmokeErrors||[]));await screenshot('failure');}catch(captureError){report.captureError=captureError.message;}
    throw error;
  }finally{
    // Cancel only this isolated desktop's work if a UI check failed mid-inference.
    if(core.active.has('ocr'))core.cancelOcr();
    if(core.active.has('chat'))core.cancelChat();
    if(recordingId&&core.active.has('recording:'+recordingId))core.pauseRecording(recordingId);
    await Promise.allSettled(['ocr','whisper'].map(kind=>core.models.adapters.get(kind)?.cancelAll?.()));
    report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-started;
    await checkpoint();
    await fs.writeFile(path.join(privateDir,'model-smoke-report.json'),JSON.stringify(report,null,2)+'\n');
    win.webContents.removeListener('console-message',rendererConsole);win.webContents.removeListener('render-process-gone',rendererGone);
  }
}

module.exports=run;
module.exports.run=run;

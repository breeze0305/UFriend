'use strict';

// Real local LLM requests through an isolated Electron profile. No user accounts,
// clipboard, mail, OCR or Whisper calls. Generated replies and reports are ignored.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {emptyState}=require('../app/services/store.cjs');
const projectDir=path.resolve(__dirname,'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

module.exports=async function run({app,win,core,actions,dataDir,diagnostics}){
  const testRoot=path.join(projectDir,'.test-data','llm-features-smoke');
  assert(process.argv.includes('--llm-features-smoke-test'));
  assert.equal(path.resolve(app.getPath('userData')),testRoot);
  assert.equal(path.resolve(dataDir),path.join(testRoot,'workspace'));
  assert.equal(await fs.realpath(dataDir),path.join(await fs.realpath(projectDir),'.test-data','llm-features-smoke','workspace'));
  assert.equal(core.snapshot().accounts.length,0);assert.equal(core.snapshot().messages.length,0);assert.equal(core.active.size,0);
  const outputDir=path.join(projectDir,'.test-results','llm-features');await fs.mkdir(outputDir,{recursive:true});
  assert.equal(await fs.realpath(outputDir),path.join(await fs.realpath(projectDir),'.test-results','llm-features'));
  const report={startedAt:new Date().toISOString(),status:'running',version:app.getVersion(),checks:[],metrics:{},screenshots:[]};
  const file=path.join(outputDir,'report.json');
  win.webContents.setBackgroundThrottling(false);win.setSize(1200,980);
  const evaluate=(fn,...args)=>win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`,true);
  const waitFor=async(label,predicate,timeout=180000)=>{const deadline=Date.now()+timeout;do{if(await predicate())return;await pause(30);}while(Date.now()<deadline);throw new Error('Timed out: '+label);};
  const call=(name,args={})=>evaluate(async(name,args)=>{const result=await window.ufriend.request(name,args);if(!result.ok)throw new Error(result.error.code+': '+result.error.message);return result.value;},name,args);
  const click=selector=>evaluate(selector=>{const element=document.querySelector(selector);if(!element||element.disabled)throw new Error('Unavailable control '+selector);element.click();},selector);
  const nav=async view=>{await click('[data-nav="'+view+'"]');await waitFor('navigate '+view,()=>evaluate(view=>!!document.querySelector('[data-nav="'+view+'"][aria-current="page"]'),view),10000);};
  const screenshot=async name=>{await evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});const image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});assert(!image.isEmpty());const target=path.join(outputDir,name+'.png');await fs.writeFile(target,image.toPNG());report.screenshots.push(target);};
  const check=async(name,work)=>{const start=Date.now();report.currentCheck=name;await work();report.checks.push({name,durationMs:Date.now()-start});await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');console.log('LLM FEATURES PASS '+name);};
  const originalStream=core.onChatStream;
  try{
    core.store.update(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,emptyState());});core.initialize();
    core.settings({localBackend:'pc-api',devLlm:{endpoint:'http://127.0.0.1:8765'},llmPrompts:{},ocrAuto:false,theme:'light'});
    win.webContents.send('ufriend:change',actions.bootstrap());
    await check('real LLM service and default prompts',async()=>{
      report.model=await call('models.health',{kind:'llm'});assert(report.model.ready);
      const catalog=await call('llm.prompts.get');assert.deepEqual(Object.keys(catalog.tasks).sort(),['chat','mail','polish','translate']);
    });
    let firstId;
    await check('Python question streams before completion and commits one complete answer',async()=>{
      await nav('chat');const started=Date.now();let count=0,earlySnapshot;
      firstId=core.snapshot().chatHistory.activeId;
      core.onChatStream=payload=>{if(payload.conversationId===firstId){count++;if(!earlySnapshot){earlySnapshot=core.snapshot();report.metrics.firstDeltaMs=Date.now()-started;}}originalStream?.(payload);};
      await evaluate(()=>{const input=document.querySelector('#chat-input');input.value='請你詳細描述一下python的用法';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await click('[data-action="chat-send"]');
      await waitFor('visible streamed response',()=>evaluate(()=>!!document.querySelector('#chat-stream-text')?.textContent.trim()));
      assert.equal(core.snapshot().chat.status,'running','The renderer must show text before completion.');
      await waitFor('Python completion',()=>core.snapshot().chat.status!=='running');
      const chat=core.snapshot().chat;assert.equal(chat.status,'done',chat.error);assert(count>0);assert.equal(earlySnapshot.chat.status,'running');assert.equal(earlySnapshot.chat.messages.length,0);assert(earlySnapshot.chat.partialText.length>0);
      assert.equal(chat.messages.length,2);assert(chat.messages[1].content.length>100);assert.match(chat.messages[1].content,/python/i);
      report.metrics.streamEvents=count;report.metrics.completeMs=Date.now()-started;report.pythonAnswer=chat.messages[1].content;
      await waitFor('completed answer rendered',()=>evaluate(()=>document.querySelector('#mf-page')?.innerText.includes('Python')));await screenshot('python-chat');
    });
    await check('chat history retains independent drafts and complete answers',async()=>{
      await call('chat.save',{id:firstId,text:'第一段尚未送出的追問'});await call('chat.rename',{id:firstId,title:'Python 用法'});
      await call('chat.new');const second=core.snapshot().chatHistory.activeId;assert.notEqual(firstId,second);
      await call('chat.save',{id:second,text:'第二段草稿'});await call('chat.select',{id:firstId});assert.equal(core.snapshot().chat.draft,'第一段尚未送出的追問');assert.equal(core.snapshot().chat.messages.length,2);
      await call('chat.select',{id:second});assert.equal(core.snapshot().chat.draft,'第二段草稿');assert.equal(core.snapshot().chat.messages.length,0);
      report.metrics.conversations=core.snapshot().chatHistory.conversations.length;
    });
    await check('selected English to Traditional Chinese translation',async()=>{
      await call('translation.save',{input:'Please confirm the meeting at 15:00 tomorrow. The total budget is 12,500 dollars.',sourceLanguage:'en',targetLanguage:'zh-TW'});
      await call('translation.start');const result=core.snapshot().translation;assert.equal(result.status,'done',result.error);assert.match(result.output,/15:00/);assert.match(result.output,/12,500/);assert.match(result.output,/[\u4e00-\u9fff]/);report.translation=result.output;
      await nav('translation');await waitFor('translation output rendered',()=>evaluate(()=>document.querySelector('#translation-output')?.value.includes('15:00')));await screenshot('translation');
    });
    await check('custom chat prompt reaches the model and resets independently',async()=>{
      const prompt={system:'You are a test responder. Reply with exactly UFRIEND_OK and nothing else.',user:'{{text}}'};
      await call('llm.prompts.save',{task:'chat',...prompt});await call('chat.new');await call('chat.send',{text:'Test custom instructions.'});
      const chat=core.snapshot().chat;assert.equal(chat.status,'done',chat.error);assert.match(chat.messages.at(-1).content,/UFRIEND_OK/);report.customPromptReply=chat.messages.at(-1).content;
      await call('llm.prompts.reset',{task:'chat'});assert.equal(core.snapshot().settings.llmPrompts.chat,undefined);
    });
    await check('article polishing waits for the Generate button before real inference',async()=>{
      await nav('polish');await evaluate(()=>{const input=document.querySelector('#polish-input');input.value='請確認明天 15:00 的會議，預算為 12,500 元。';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await pause(950);assert.equal(core.snapshot().polish.status,'waiting-model');assert.equal(core.snapshot().polish.output,'');assert(!core.active.has('polish'));
      await click('[data-action="polish-start"]');await waitFor('polish completion',()=>['done','error'].includes(core.snapshot().polish.status));const result=core.snapshot().polish;assert.equal(result.status,'done',result.error);assert.match(result.output,/15:00/);assert.match(result.output,/12,500/);report.polish=result.output;await screenshot('polish-manual');
    });
    await check('preferred English language applies to a Chinese question through desktop chat',async()=>{
      await nav('settings');await click('[data-settings-tab="general"]');await evaluate(()=>{const el=document.querySelector('#preferred-language');if(!el.checkVisibility())throw new Error('Language settings must be visible.');el.value='en';el.dispatchEvent(new Event('change',{bubbles:true}));});await click('[data-action="save-preferred-language"]');await waitFor('preferred English saved',()=>core.snapshot().settings.preferredLanguage==='en');
      await call('chat.new');await call('chat.send',{text:'請用一句話解釋 Python 的變數是什麼。'});const chat=core.snapshot().chat;assert.equal(chat.status,'done',chat.error);report.preferredLanguageReply=chat.messages.at(-1).content;assert.match(report.preferredLanguageReply,/[A-Za-z]{4,}/);assert(!/[\u4e00-\u9fff]/.test(report.preferredLanguageReply),'The tested English preference must produce an English reply.');
      await nav('chat');await screenshot('preferred-english');await call('settings.save',{preferredLanguage:'zh-TW'});
    });
    await check('personal background reaches chat and disabling removes it from a new conversation',async()=>{
      const profile={enabled:true,name:'Synthetic Private Person',phone:'TEST-555-0199',personalEmail:'synthetic-profile@example.invalid',workEmail:'synthetic-work@example.invalid',company:'Synthetic Workshop',jobTitle:'海棠測試架構師',notes:'這是自製的測試背景。'};
      await call('settings.save',{personalProfile:profile});await call('chat.new');await call('chat.send',{text:'根據我的個人背景，我的職稱是什麼？請簡短回答。'});let chat=core.snapshot().chat;assert.equal(chat.status,'done',chat.error);report.profileReply=chat.messages.at(-1).content;assert.match(report.profileReply,/海棠測試架構師/);
      await nav('chat');await screenshot('profile-chat');await call('settings.save',{personalProfile:{...profile,enabled:false}});await call('chat.new');await call('chat.send',{text:'我的職稱是什麼？不知道就說不知道。'});chat=core.snapshot().chat;assert.equal(chat.status,'done',chat.error);report.disabledProfileReply=chat.messages.at(-1).content;assert(!report.disabledProfileReply.includes('海棠測試架構師'));
    });
    await check('diagnostic request IDs correlate complete model requests without source text',async()=>{
      assert(diagnostics);await diagnostics.flush();const exported=await diagnostics.export();
      const entries=exported.entries.filter(entry=>entry.sessionId===diagnostics.sessionId),starts=entries.filter(entry=>entry.event==='llm.request.started'),done=entries.filter(entry=>entry.event==='llm.request.completed');
      assert(starts.length>=3);assert(done.length>=3);assert(done.every(entry=>starts.some(start=>start.requestId===entry.requestId)));
      const raw=JSON.stringify(exported);for(const source of ['請你詳細描述一下python的用法','Please confirm the meeting','You are a test responder','Synthetic Private Person','TEST-555-0199','synthetic-profile@example.invalid','synthetic-work@example.invalid','Synthetic Workshop','海棠測試架構師'])assert(!raw.includes(source));
      report.diagnostics={file:diagnostics.info().file,requestIds:done.map(entry=>entry.requestId),requestCount:starts.length};
    });
    report.status='passed';delete report.currentCheck;console.log('LLM FEATURES COMPLETE '+report.checks.length+' checks');
  }catch(error){report.status='failed';report.error={code:error.code||'',message:error.message};throw error;}
  finally{core.onChatStream=originalStream;core.cancelChat();core.cancelTranslation();core.settings({llmPrompts:{}});report.finishedAt=new Date().toISOString();await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');}
};

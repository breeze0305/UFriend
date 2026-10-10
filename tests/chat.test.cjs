'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {overlayChatStream}=require('../app/services/chat.cjs');

const testRoot=path.resolve(__dirname,'../.test-data/chat-tests');
async function fixture(t,run){
  await fs.mkdir(testRoot,{recursive:true});const dataDir=await fs.mkdtemp(path.join(testRoot,'case-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dataDir)),testRoot);await fs.rm(dataDir,{recursive:true,force:true});});
  const models=new ModelAdapters();if(run)models.register('llm',{run});
  const store=new Store({dataDir}),core=new AppService({store,dataDir,models});
  return{store,core,dataDir,models,view:()=>overlayChatStream(core.snapshot(),core.chatStream),reopen:()=>new AppService({store:new Store({dataDir}),dataDir,models})};
}
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function persistedChat(state){const {partialText,streamId,...chat}=state.chat;return chat;}

test('chat sends only successful conversation turns and current question, and persists across reopen',async t=>{
  const requests=[];const f=await fixture(t,async request=>{requests.push(request);return{text:requests.length===1?'答案是五。':'再減一是四。',meta:{model:'fixture',backend:'test',private:'discard'}};});
  f.store.update(state=>{state.messages.push({body:'private email'});state.chat.draft='五減一是多少？';});
  await f.core.sendChat('二加三是多少？');
  await f.core.sendChat('再減一呢？');
  assert.deepEqual(requests[0].input,{messages:[{role:'user',content:'二加三是多少？'}]});
  assert.deepEqual(requests[1].input.messages,[{role:'user',content:'二加三是多少？'},{role:'assistant',content:'答案是五。'},{role:'user',content:'再減一呢？'}]);
  const chat=f.reopen().snapshot().chat;assert.equal(chat.status,'done');assert.equal(chat.messages.length,4);assert.equal(chat.pendingText,'');
  assert.deepEqual(chat.messages[1].meta,{source:'local',model:'fixture',backend:'test'});
  assert(!JSON.stringify(f.store.read().logs).includes('二加三'));
});

test('unconfigured chat, API capacity errors and malformed output preserve the question without inserting a fake answer',async t=>{
  const unconfigured=await fixture(t);await unconfigured.core.sendChat('請問明天如何安排？');
  assert.equal(unconfigured.core.snapshot().chat.status,'waiting-model');assert.equal(unconfigured.core.snapshot().chat.draft,'請問明天如何安排？');
  for(const response of ['capacity','invalid']){
    const f=await fixture(t,()=>{if(response==='capacity')throw Object.assign(new Error('capacity'),{code:'MODEL_INPUT_TOO_LONG'});return{text:{bad:'output'}};});
    await f.core.sendChat('保留這個問題');const chat=f.core.snapshot().chat;
    assert.equal(chat.status,'error');assert.equal(chat.draft,'保留這個問題');assert.equal(chat.messages.length,0);assert.equal(chat.pendingText,'');
    if(response==='capacity')assert.match(chat.error,/上下文/);
  }
});

test('cancelling or deleting the last chat returns without waiting for an ignoring model and rejects its late response',async t=>{
  for(const action of ['cancel','delete']){
    const first=deferred();let calls=0;const f=await fixture(t,()=>++calls===1?first.promise:{text:'新問題的答案'});
    const originalId=f.core.snapshot().chatHistory.activeId;
    const pending=f.core.sendChat('舊問題');await Promise.resolve();
    if(action==='cancel')f.core.cancelChat();else f.core.deleteChat(originalId);
    await pending;assert.equal(f.core.snapshot().chat.messages.length,0);
    if(action==='cancel')assert.equal(f.core.snapshot().chat.draft,'舊問題');
    else assert.notEqual(f.core.snapshot().chatHistory.activeId,originalId);
    await f.core.sendChat('新問題');first.resolve({text:'過期答案'});await Promise.resolve();
    assert.deepEqual(f.core.snapshot().chat.messages.map(message=>message.content),['新問題','新問題的答案']);
  }
});

test('chat draft persists, pending question is recovered after interruption and changing the LLM endpoint cancels generation',async t=>{
  const waiting=deferred();const f=await fixture(t,()=>waiting.promise);
  f.core.saveChatDraft('已保存的草稿');assert.equal(f.reopen().snapshot().chat.draft,'已保存的草稿');
  const pending=f.core.sendChat('被中斷的問題');await Promise.resolve();
  const recovered=f.reopen().snapshot().chat;assert.equal(recovered.status,'cancelled');assert.equal(recovered.draft,'被中斷的問題');
  f.core.settings({devLlm:{endpoint:'http://127.0.0.1:8775'}});await pending;waiting.resolve({text:'不得保存'});await Promise.resolve();
  assert.equal(f.core.snapshot().chat.messages.length,0);assert.equal(f.core.snapshot().chat.status,'cancelled');
});

test('chat rejects simultaneous sends and overlong questions before changing the successful history',async t=>{
  const waiting=deferred();const f=await fixture(t,()=>waiting.promise);
  await assert.rejects(f.core.sendChat('a'.repeat(16001)),/16,000/);
  const pending=f.core.sendChat('第一個問題');await assert.rejects(f.core.sendChat('第二個問題'),/正在產生/);
  f.core.cancelChat();await pending;
  assert.equal(f.core.snapshot().chat.messages.length,0);assert.equal(f.core.snapshot().chat.draft,'第一個問題');
});

test('legacy chat messages and draft migrate without losing content and keep a stable conversation identity',async t=>{
  const f=await fixture(t);
  const messages=[
    {id:'legacy-user',role:'user',content:'  舊問題\n第二行  ',createdAt:'2026-09-09T01:00:00.000Z'},
    {id:'legacy-answer',role:'assistant',content:'原始回覆，繁體字。',createdAt:'2026-09-09T01:00:01.000Z',meta:{model:'old-model',backend:'old-api'}}
  ];
  const draft='  尚未送出\n保留空白與換行  ';
  f.store.update(state=>{delete state.chatHistory;state.chat={messages,draft,pendingText:'',status:'done',error:'',revision:7};});
  const reopened=f.reopen(),state=reopened.snapshot();
  assert.equal(state.chatHistory.version,1);assert.equal(state.chatHistory.conversations.length,1);
  assert.deepEqual(state.chat.messages,messages);assert.equal(state.chat.draft,draft);assert.equal(state.chat.revision,7);
  const entry=state.chatHistory.conversations[0];
  assert.equal(entry.id,state.chatHistory.activeId);assert.deepEqual(entry.chat,persistedChat(state));
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));assert.ok(Number.isFinite(Date.parse(entry.updatedAt)));
  const again=f.reopen().snapshot();
  assert.equal(again.chatHistory.activeId,entry.id);assert.equal(again.chatHistory.conversations.length,1);
  assert.deepEqual(again.chat.messages,messages);assert.equal(again.chat.draft,draft);
});

test('new conversation is a no-op for empty or whitespace-only drafts, including a renamed blank conversation',async t=>{
  const f=await fixture(t);
  for(const draft of ['', ' \n\t　 ']){
    f.core.saveChatDraft(draft);f.core.renameChat(f.core.snapshot().chatHistory.activeId,'尚未開始');
    const before=f.core.snapshot();assert.deepEqual(f.core.newChat(),before);assert.deepEqual(f.core.newChat(),before);assert.deepEqual(f.core.snapshot(),before);
  }
  assert.equal(f.reopen().snapshot().chatHistory.conversations.length,1);
});

test('a draft permits one new conversation, and deleting the last conversation restores the empty guard',async t=>{
  const f=await fixture(t),first=f.core.snapshot().chatHistory.activeId;
  f.core.saveChatDraft('尚未送出的問題');f.core.newChat();const created=f.core.snapshot(),second=created.chatHistory.activeId;
  assert.notEqual(second,first);assert.equal(created.chatHistory.conversations.length,2);assert.equal(created.chatHistory.conversations.find(entry=>entry.id===first).chat.draft,'尚未送出的問題');
  assert.deepEqual(f.core.newChat(),created);assert.equal(f.reopen().snapshot().chatHistory.conversations.length,2);
  f.core.deleteChat(first);f.core.deleteChat(second);const remaining=f.core.snapshot();assert.equal(remaining.chatHistory.conversations.length,1);assert.notEqual(remaining.chatHistory.activeId,second);assert.deepEqual(f.core.newChat(),remaining);
});

test('conversation CRUD persists names and drafts, deleting the active chat preserves other chats, and deleting the last chat leaves an empty one',async t=>{
  const f=await fixture(t,()=>({text:'第一段的完整答案'}));
  const first=f.core.snapshot().chatHistory.activeId;
  await f.core.sendChat('第一段問題');f.core.saveChatDraft('第一段草稿');
  f.core.newChat();const second=f.core.snapshot().chatHistory.activeId;
  assert.notEqual(first,second);assert.equal(f.core.snapshot().chat.messages.length,0);
  f.core.saveChatDraft('第二段草稿');f.core.renameChat(first,'  工作紀錄  ');f.core.renameChat(second,'私人筆記');
  f.core.selectChat(first);
  let state=f.reopen().snapshot();
  assert.equal(state.chatHistory.activeId,first);assert.equal(state.chat.draft,'第一段草稿');assert.equal(state.chat.messages.length,2);
  assert.equal(state.chatHistory.conversations.find(entry=>entry.id===first).title,'工作紀錄');
  const savedSecond=state.chatHistory.conversations.find(entry=>entry.id===second);
  assert.equal(savedSecond.title,'私人筆記');assert.equal(savedSecond.chat.draft,'第二段草稿');
  f.core.deleteChat(first);state=f.core.snapshot();
  assert.equal(state.chatHistory.conversations.some(entry=>entry.id===first),false);
  const remainingSecond=state.chatHistory.conversations.find(entry=>entry.id===second);
  assert.equal(remainingSecond.title,savedSecond.title);assert.deepEqual(remainingSecond.chat,savedSecond.chat);
  assert.equal(f.core.snapshot().chatHistory.activeId,second);assert.equal(f.core.snapshot().chat.draft,'第二段草稿');
  f.core.deleteChat(second);state=f.reopen().snapshot();
  assert.equal(state.chatHistory.conversations.length,1);assert.notEqual(state.chatHistory.activeId,second);
  assert.equal(state.chat.messages.length,0);assert.equal(state.chat.draft,'');assert.equal(state.chat.status,'idle');
});

test('each conversation sends only its own successful turns to the model',async t=>{
  const requests=[];const f=await fixture(t,request=>{requests.push(request.input.messages);return{text:'完整答案'+requests.length};});
  const first=f.core.snapshot().chatHistory.activeId;
  await f.core.sendChat('第一段的問題');
  assert.equal(f.core.snapshot().chatHistory.conversations[0].title,'第一段的問題');
  f.core.newChat();const second=f.core.snapshot().chatHistory.activeId;
  f.core.renameChat(second,'自己取的名稱');await f.core.sendChat('第二段的問題');
  assert.equal(f.core.snapshot().chatHistory.conversations.find(entry=>entry.id===second).title,'自己取的名稱');
  f.core.selectChat(first);await f.core.sendChat('延續第一段');
  assert.deepEqual(requests[1],[{role:'user',content:'第二段的問題'}]);
  assert.deepEqual(requests[2],[{role:'user',content:'第一段的問題'},{role:'assistant',content:'完整答案1'},{role:'user',content:'延續第一段'}]);
  f.core.selectChat(second);assert.deepEqual(f.core.snapshot().chat.messages.map(message=>message.content),['第二段的問題','完整答案2']);
});

test('invalid history actions and editing an inactive conversation do not cancel the running active conversation',async t=>{
  const waiting=deferred(),started=deferred();let signal;
  const f=await fixture(t,request=>{signal=request.signal;started.resolve();return waiting.promise;});
  const first=f.core.snapshot().chatHistory.activeId;f.core.saveChatDraft('建立測試對話的草稿');f.core.newChat();const second=f.core.snapshot().chatHistory.activeId;f.core.selectChat(first);
  const pending=f.core.sendChat('正在處理');await started.promise;
  for(const [method,args] of [['selectChat',['missing']],['deleteChat',['missing']],['renameChat',['missing','標題']],['renameChat',[first,'']],['renameChat',[first,'x'.repeat(81)]],['renameChat',[first,'兩行\n標題']]])assert.throws(()=>f.core[method](...args));
  f.core.renameChat(second,'改名的第二段');f.core.deleteChat(second);
  assert.equal(signal.aborted,false);assert.equal(f.core.snapshot().chatHistory.activeId,first);assert.equal(f.core.snapshot().chat.status,'running');
  waiting.resolve({text:'仍可正常完成'});await pending;
  assert.deepEqual(f.core.snapshot().chat.messages.map(message=>message.content),['正在處理','仍可正常完成']);
});

for(const action of ['new','select','delete']){
  test(action+' conversation cancels the previous job and rejects a model response that arrives after switching',async t=>{
    const waiting=deferred(),started=deferred();let calls=0,signal;
    const f=await fixture(t,request=>{if(++calls===1){signal=request.signal;started.resolve();return waiting.promise;}return{text:'新對話答案'};});
    const first=f.core.snapshot().chatHistory.activeId;f.core.saveChatDraft('建立測試對話的草稿');f.core.newChat();const second=f.core.snapshot().chatHistory.activeId;f.core.selectChat(first);
    const pending=f.core.sendChat('舊對話尚未完成');await started.promise;
    if(action==='select')f.core.saveChatDraft('另外編輯中的草稿');
    if(action==='new')f.core.newChat();
    if(action==='select')f.core.selectChat(second);
    if(action==='delete')f.core.deleteChat(first);
    await pending;assert.equal(signal.aborted,true);
    const old=f.core.snapshot().chatHistory.conversations.find(entry=>entry.id===first);
    if(action==='delete')assert.equal(old,undefined);
    else{assert.equal(old.chat.status,'cancelled');assert.equal(old.chat.messages.length,0);assert.equal(old.chat.draft,action==='select'?'另外編輯中的草稿':'舊對話尚未完成');}
    await f.core.sendChat('新的問題');waiting.resolve({text:'不得儲存的舊答案'});await Promise.resolve();
    const state=f.reopen().snapshot();
    assert.deepEqual(state.chat.messages.map(message=>message.content),['新的問題','新對話答案']);
    assert.ok(!JSON.stringify(state.chatHistory).includes('不得儲存的舊答案'));
  });
}

test('reopening recovers interrupted questions in active and archived conversations without losing an edited draft',async t=>{
  const f=await fixture(t);const first=f.core.snapshot().chatHistory.activeId;f.core.saveChatDraft('建立測試對話的草稿');f.core.newChat();const second=f.core.snapshot().chatHistory.activeId;
  f.store.update(state=>{
    const archived=state.chatHistory.conversations.find(entry=>entry.id===first).chat;
    Object.assign(archived,{status:'running',pendingText:'舊分頁的中斷問題',draft:''});
    Object.assign(state.chat,{status:'running',pendingText:'目前分頁的中斷問題',draft:'已編輯的新草稿'});
  });
  const state=f.reopen().snapshot();
  assert.equal(state.chatHistory.activeId,second);assert.equal(state.chat.status,'cancelled');assert.equal(state.chat.draft,'已編輯的新草稿');
  const old=state.chatHistory.conversations.find(entry=>entry.id===first).chat;
  assert.equal(old.status,'cancelled');assert.equal(old.draft,'舊分頁的中斷問題');assert.equal(old.pendingText,'');
  assert.deepEqual(state.chatHistory.conversations.find(entry=>entry.id===second).chat,persistedChat(state));
});

test('real delta bursts update only an ephemeral bubble and a throttled stream event until complete success',async t=>{
  const started=deferred(),finished=deferred(),events=[];
  const f=await fixture(t,request=>{started.resolve(request);return finished.promise;});
  let changes=0;f.core.onChange=()=>{changes++;};f.core.onChatStream=payload=>events.push(payload);
  const pending=f.core.sendChat('串流問題');const request=await started.promise;
  const startedView=f.view();
  assert.equal(startedView.chat.status,'running');assert.equal(startedView.chat.partialText,'');
  assert.match(startedView.chat.streamId,/^[a-f0-9-]{36}$/);
  const read=f.store.read.bind(f.store),update=f.store.update.bind(f.store);
  let reads=0,writes=0;
  f.store.read=()=>{reads++;return read();};f.store.update=mutator=>{writes++;return update(mutator);};
  const baselineChanges=changes,chunks=Array.from({length:80},(_,index)=>'即時片段'+index+' '),answer=chunks.join('');
  for(const chunk of chunks)request.onDelta(chunk);
  assert.equal(reads,0);assert.equal(writes,0);assert.equal(events.length,0);
  await delay(75);
  assert.equal(reads,0,'deltas and dedicated events must not clone the whole store');
  assert.equal(writes,0,'deltas must not trigger filesystem writes');
  assert.equal(changes,baselineChanges,'stream progress must use its dedicated event when available');
  assert.equal(events.length,1);
  assert.deepEqual(events[0],{conversationId:startedView.chatHistory.activeId,streamId:startedView.chat.streamId,partialText:answer});
  f.store.read=read;f.store.update=update;
  assert.equal(f.view().chat.partialText,answer);assert.equal(f.view().chat.messages.length,0);
  const before=JSON.parse(await fs.readFile(f.store.file,'utf8'));
  assert.equal(before.chat.partialText,undefined);assert.equal(before.chat.streamId,undefined);
  assert.equal(before.chatHistory.conversations[0].chat.partialText,undefined);
  assert.ok(!JSON.stringify(before).includes('即時片段'));
  finished.resolve({text:answer,meta:{model:'fixture',backend:'test'}});await pending;
  const state=f.view();assert.equal(state.chat.status,'done');assert.equal(state.chat.partialText,'');assert.equal(state.chat.streamId,'');
  assert.deepEqual(state.chat.messages.map(message=>message.content),['串流問題',answer.trim()]);
  assert.equal(f.core.chatStream,null);
  assert.deepEqual(f.reopen().snapshot().chat.messages,state.chat.messages);
});

test('stream snapshots are non-mutating and hide other conversations, old revisions and stopped jobs',()=>{
  const state={chat:{status:'running',revision:3,messages:[]},chatHistory:{activeId:'conversation'}};
  const stream={conversationId:'conversation',streamId:'stream',revision:3,partialText:'尚未完成'};
  assert.equal(overlayChatStream(state,stream).chat.partialText,'尚未完成');
  assert.equal(state.chat.partialText,undefined);assert.equal(state.chat.streamId,undefined);
  for(const hidden of [{...stream,conversationId:'other'},{...stream,revision:2},null]){
    const view=overlayChatStream(state,hidden);assert.equal(view.chat.partialText,'');assert.equal(view.chat.streamId,'');
  }
  assert.equal(overlayChatStream({...state,chat:{...state.chat,status:'done'}},stream).chat.partialText,'');
  const controller=new AbortController();controller.abort();
  assert.equal(overlayChatStream(state,{...stream,controller}).chat.partialText,'');
});

test('stream progress falls back to onChange when no dedicated listener is installed',async t=>{
  const started=deferred(),finished=deferred(),views=[];
  const f=await fixture(t,request=>{started.resolve(request);return finished.promise;});
  f.core.onChange=()=>views.push(f.view().chat.partialText);
  const pending=f.core.sendChat('問題');const request=await started.promise;
  request.onDelta('未完成回覆');await delay(75);
  assert.ok(views.includes('未完成回覆'));
  f.core.cancelChat();await pending;
  assert.equal(f.view().chat.partialText,'');assert.equal(f.view().chat.draft,'問題');
});

for(const action of ['cancel','delete-last','new','select','delete']){
  test(action+' discards pending stream events and stale deltas without contaminating a newer job',async t=>{
    const starts=[deferred(),deferred()],finishes=[deferred(),deferred()],events=[],requests=[];
    const f=await fixture(t,request=>{const index=requests.length;requests.push(request);starts[index].resolve(request);return finishes[index].promise;});
    const first=f.core.snapshot().chatHistory.activeId;f.core.saveChatDraft('建立測試對話的草稿');f.core.newChat();const second=f.core.snapshot().chatHistory.activeId;f.core.selectChat(first);
    if(action==='delete-last')f.core.deleteChat(second);
    f.core.onChatStream=payload=>events.push(payload);
    const previous=f.core.sendChat('舊問題');const oldRequest=await starts[0].promise;
    oldRequest.onDelta('不得保存的舊片段');const oldStreamId=f.view().chat.streamId;
    if(action==='cancel')f.core.cancelChat();
    if(action==='new')f.core.newChat();
    if(action==='select')f.core.selectChat(second);
    if(action==='delete'||action==='delete-last')f.core.deleteChat(first);
    await previous;
    oldRequest.onDelta('取消後的舊片段');
    assert.equal(f.view().chat.partialText,'');assert.equal(oldRequest.signal.aborted,true);
    const newer=f.core.sendChat('新問題');const newRequest=await starts[1].promise;
    newRequest.onDelta('新的完整答案');const newStreamId=f.view().chat.streamId;
    assert.notEqual(newStreamId,oldStreamId);
    oldRequest.onDelta('不可以污染新回覆');finishes[0].resolve({text:'不得保存的舊片段'});
    await delay(75);
    assert.equal(events.length,1);assert.equal(events[0].streamId,newStreamId);assert.equal(events[0].partialText,'新的完整答案');
    assert.equal(f.view().chat.partialText,'新的完整答案');
    assert.deepEqual(newRequest.input.messages,[{role:'user',content:'新問題'}]);
    finishes[1].resolve({text:'新的完整答案'});await newer;
    const state=f.reopen().snapshot();
    assert.deepEqual(state.chat.messages.map(message=>message.content),['新問題','新的完整答案']);
    assert.ok(!JSON.stringify(state.chatHistory).includes('不得保存的舊片段'));
    assert.ok(!JSON.stringify(state.chatHistory).includes('不可以污染新回覆'));
  });
}

test('a completed 16000-character answer remains valid context for a later question',async t=>{
  const answer='字'.repeat(16000),requests=[];
  const f=await fixture(t,request=>{requests.push(request);if(requests.length===1){request.onDelta(answer);return{text:answer};}return{text:'下一個答案'};});
  await f.core.sendChat('長回覆');assert.equal(f.core.snapshot().chat.status,'done');
  assert.equal(f.core.snapshot().chat.messages[1].content.length,16000);
  await f.core.sendChat('繼續');assert.equal(f.core.snapshot().chat.status,'done');
  assert.equal(requests[1].input.messages[1].content,answer);
});

test('invalid or oversized deltas abort an ignoring adapter promptly and cannot create a successful pair',async t=>{
  for(const delta of [{invalid:true},'字'.repeat(16001)]){
    let signal;const ignored=deferred();
    const f=await fixture(t,request=>{signal=request.signal;request.onDelta(delta);return ignored.promise;});
    await f.core.sendChat('保留問題');
    const state=f.view();assert.equal(signal.aborted,true);assert.equal(state.chat.status,'error');
    assert.equal(state.chat.errorCode,typeof delta==='string'?'MODEL_OUTPUT_LIMIT':'MODEL_INVALID_OUTPUT');
    assert.equal(state.chat.draft,'保留問題');assert.equal(state.chat.messages.length,0);assert.equal(state.chat.partialText,'');
    ignored.resolve({text:'遲到的假成功'});await Promise.resolve();
    assert.equal(f.core.snapshot().chat.messages.length,0);
  }
});

test('output limits and interrupted streams preserve drafts and safe diagnostic IDs without saving partial answers',async t=>{
  for(const code of ['MODEL_OUTPUT_LIMIT','MODEL_STREAM_INTERRUPTED']){
    const started=deferred(),finished=deferred(),errors=[];
    const f=await fixture(t,request=>{started.resolve(request);return finished.promise;});
    f.core.onChatError=payload=>errors.push(payload);
    const pending=f.core.sendChat('不能出現在診斷中的私人問題');const request=await started.promise;
    request.onDelta('不能出現在診斷中的半截答案');
    const streamId=f.view().chat.streamId,conversationId=f.core.snapshot().chatHistory.activeId;
    f.core.saveChatDraft('另外保存的新草稿');
    const requestId='00a00000-0000-4000-8000-000000000001';
    finished.reject(Object.assign(new Error(code),{code,requestId}));await pending;
    const state=f.view();assert.equal(state.chat.status,'error');assert.equal(state.chat.errorCode,code);assert.equal(state.chat.errorRequestId,requestId);
    assert.match(state.chat.error,code==='MODEL_OUTPUT_LIMIT'?/長度上限/:/傳輸中斷/);
    assert.equal(state.chat.draft,'另外保存的新草稿');assert.equal(state.chat.messages.length,0);assert.equal(state.chat.partialText,'');
    assert.deepEqual(errors,[{code,requestId,conversationId,streamId}]);
    const diagnostics=JSON.stringify({errors,logs:f.store.read().logs});
    assert.ok(!diagnostics.includes('私人問題'));assert.ok(!diagnostics.includes('半截答案'));
    assert.equal(f.reopen().snapshot().chat.errorRequestId,requestId);
    f.models.register('llm',{run:()=>({text:'重試後完整回覆'})});await f.core.sendChat('重試');
    assert.equal(f.core.snapshot().chat.status,'done');assert.equal(f.core.snapshot().chat.errorCode,'');assert.equal(f.core.snapshot().chat.errorRequestId,'');
    assert.deepEqual(f.core.snapshot().chat.messages.map(message=>message.content),['重試','重試後完整回覆']);
  }
});

test('explicit truncation and mismatched terminal output never become successful history',async t=>{
  for(const result of [{text:'片段',truncated:true},{text:'片段',complete:false},{text:'片段',finishReason:'length'},{text:'片段',meta:{finish_reason:'max_tokens'}},
    {text:'片段',meta:{truncated:true}},{text:'片段',meta:{complete:false}},{text:'片段',finishReason:'stop',meta:{finishReason:'length'}},
    {text:'片段',finishReason:'stop',finish_reason:'max_tokens'},{text:'不同於已接收的片段'}]){
    const f=await fixture(t,request=>{request.onDelta('片段');return result;});
    await f.core.sendChat('原問題');const state=f.view();
    assert.equal(state.chat.status,'error');assert.equal(state.chat.messages.length,0);assert.equal(state.chat.draft,'原問題');assert.equal(state.chat.partialText,'');
    assert.equal(state.chat.errorCode,result.text==='片段'?'MODEL_OUTPUT_LIMIT':'MODEL_INVALID_OUTPUT');
  }
});

test('explicit non-stop completion reasons cannot create a successful chat turn',async t=>{
  for(const reason of ['content_filter','tool_calls','function_call','missing',null]){
    const f=await fixture(t,request=>{request.onDelta('Partial answer');return{text:'Partial answer',finishReason:'stop',meta:{finish_reason:reason}};});
    await f.core.sendChat('Synthetic question');
    const state=f.view();assert.equal(state.chat.errorCode,'MODEL_INVALID_OUTPUT');assert.equal(state.chat.status,'error');
    assert.equal(state.chat.messages.length,0);assert.equal(state.chat.draft,'Synthetic question');assert.equal(state.chat.partialText,'');
  }
});

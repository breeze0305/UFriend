'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {AppService}=require('../app/services/core.cjs');
const {ModelAdapters}=require('../app/models/adapters.cjs');
const {Diagnostics}=require('../app/services/diagnostics.cjs');
const {clearAllChats,clearAllLogs}=require('../app/services/data-cleanup.cjs');
const root=path.resolve(__dirname,'../.test-data/data-cleanup-tests');
async function fixture(t,run){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));
  t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir}),models=new ModelAdapters();if(run)models.register('llm',{run});
  const core=new AppService({store,dataDir,models}),diagnostics=new Diagnostics({directory:path.join(dataDir,'diagnostics')});
  store.update(state=>{state.messages=[{id:'kept-mail',body:'mail content'}];state.recordings=[{id:'kept-recording',textOnly:'transcript'}];state.ocr.text='OCR text';state.polish.input='polish input';});
  return{dataDir,store,core,diagnostics};
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
function withoutChat(state){const{chat,chatHistory,models,...other}=state;return other;}

test('clear all chats removes every conversation and draft from both store copies, preserving other features',async t=>{
  const {core,store,dataDir}=await fixture(t,()=>({text:'private old answer'}));
  await core.sendChat('private old question');core.saveChatDraft('private archived draft');core.newChat();core.saveChatDraft('private active draft');core.renameChat(core.snapshot().chatHistory.activeId,'private title');
  const before=store.read(),ids=before.chatHistory.conversations.map(entry=>entry.id);let changes=0;core.onChange=()=>{changes++;};
  const deleted=clearAllChats(core),result=core.snapshot();assert.deepEqual(deleted,{deletedConversations:2,deletedMessages:2});
  assert.equal(changes,1);assert.equal(result.chatHistory.conversations.length,1);assert(!ids.includes(result.chatHistory.activeId));
  assert.equal(result.chat.status,'idle');assert.deepEqual(result.chat.messages,[]);assert.equal(result.chat.draft,'');assert.equal(result.chat.pendingText,'');
  assert.deepEqual(withoutChat(result),withoutChat(before));
  for(const file of [store.file,store.backup]){const persisted=await read(file);assert(!JSON.stringify(persisted).includes('private'));assert.deepEqual(persisted.chatHistory,store.read().chatHistory);}
  await fs.writeFile(store.file,'invalid primary');const recovered=new AppService({store:new Store({dataDir}),dataDir,models:core.models}).snapshot();
  assert.equal(recovered.chatHistory.activeId,result.chatHistory.activeId);assert(!JSON.stringify(recovered).includes('private'));
});

test('clearing chats aborts a running stream immediately and ignores late deltas or completion after a new chat starts',async t=>{
  const old=deferred(),started=deferred();let calls=0;
  const {core,store}=await fixture(t,request=>{if(++calls===1){started.resolve(request);return old.promise;}return{text:'new answer'};});
  core.saveChatDraft('private archived draft');core.newChat();const events=[];core.onChatStream=value=>events.push(value);
  const pending=core.sendChat('private pending question'),request=await started.promise;request.onDelta('private unfinished');assert(core.chatStream.timer);
  const oldIds=core.snapshot().chatHistory.conversations.map(entry=>entry.id);clearAllChats(core);
  assert.equal(request.signal.aborted,true);assert.equal(core.chatStream,null);assert.equal(core.active.has('chat'),false);await pending;
  const next=core.snapshot().chatHistory.activeId;assert(!oldIds.includes(next));await core.sendChat('new question');
  request.onDelta('private late delta');old.resolve({text:'private late answer'});await new Promise(resolve=>setTimeout(resolve,75));
  assert.deepEqual(events,[]);assert.equal(core.snapshot().chatHistory.activeId,next);assert.deepEqual(core.snapshot().chat.messages.map(message=>message.content),['new question','new answer']);
  for(const file of [store.file,store.backup])assert(!JSON.stringify(await read(file)).includes('private'));
});

test('chat cleanup counts exclude the empty initial conversation but include archived drafts',async t=>{
  const {core}=await fixture(t);assert.deepEqual(clearAllChats(core),{deletedConversations:0,deletedMessages:0});
  core.saveChatDraft('archived draft');core.newChat();assert.equal(core.snapshot().chatHistory.conversations.length,2);
  assert.deepEqual(clearAllChats(core),{deletedConversations:1,deletedMessages:0});assert.equal(core.snapshot().chatHistory.conversations.length,1);
});

test('clear all logs purges system and diagnostic history while new events remain usable',async t=>{
  const {store,diagnostics}=await fixture(t);store.appendLog('private old system event');await diagnostics.write({event:'old.event'});
  const before=store.read();let changes=0;
  const deleted=await clearAllLogs({store,diagnostics,onChange:()=>{changes++;}});assert.deepEqual(deleted,{deletedEntries:1,deletedFiles:1});
  assert.equal(changes,1);assert.deepEqual(store.read(),{...before,logs:[]});assert.deepEqual((await read(store.backup)).logs,[]);assert.deepEqual((await diagnostics.export()).entries,[]);
  let release;diagnostics.queue=new Promise(resolve=>{release=resolve;});
  const clearing=clearAllLogs({store,diagnostics});store.appendLog('new system event');const writing=diagnostics.write({event:'new.event'});release();await Promise.all([clearing,writing]);
  assert.deepEqual(store.read().logs.map(log=>log.text),['new system event']);assert.deepEqual((await diagnostics.export()).entries.map(entry=>entry.event),['new.event']);
  assert(!JSON.stringify(await read(store.backup)).includes('private old system event'));
});

test('cleanup callers reject failed persistence or diagnostic deletion without signaling success',async t=>{
  const {core,store,diagnostics}=await fixture(t);core.saveChatDraft('preserved on failure');let changes=0;core.onChange=()=>{changes++;};
  const original=store._atomicWrite.bind(store);store._atomicWrite=(target,value)=>{if(target===store.file)throw new Error('fixture disk failure');return original(target,value);};
  assert.throws(()=>clearAllChats(core),/fixture disk failure/);assert.equal(core.snapshot().chat.draft,'preserved on failure');assert.equal(changes,0);
  let attempted=0;await assert.rejects(clearAllLogs({store,diagnostics:{clear(){attempted++;}},onChange:()=>{changes++;}}),/fixture disk failure/);assert.equal(attempted,0);assert.equal(changes,0);
  store._atomicWrite=original;await diagnostics.write({event:'old.event'});await fs.mkdir(diagnostics.fileAt(1));
  await assert.rejects(clearAllLogs({store,diagnostics,onChange:()=>{changes++;}}));assert.equal(changes,0);assert.deepEqual(store.read().logs,[]);
  await fs.rmdir(diagnostics.fileAt(1));await clearAllLogs({store,diagnostics,onChange:()=>{changes++;}});assert.equal(changes,1);
});

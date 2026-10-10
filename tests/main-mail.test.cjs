'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {randomUUID} = require('node:crypto');
const {Store} = require('../app/services/store.cjs');
const {AppService} = require('../app/services/core.cjs');
const {ModelAdapters} = require('../app/models/adapters.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const mailError = (code, message = code) => Object.assign(new Error(message), {code});

// Test the real IPC controllers and disk persistence with no Electron window or Gmail account.
function controllerHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufriend-main-mail-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('ufriend-main-mail-'));
    fs.rmSync(dataDir, {recursive:true, force:true});
  });
  const store = new Store({dataDir});
  store.update(state => {
    state.drafts = [];
    state.assets = [];
    state.settings.initialDays = 30;
    state.accounts = [
      {id:'account-a', email:'self@example.test', connected:true},
      {id:'account-b', email:'other@example.test', connected:true}
    ];
  });
  const assets = new Map();
  const calls = {save:[], send:[], remove:[], download:[], sync:[], open:[]};
  const gmail = {
    listAccounts() { return store.read().accounts; },
    async saveDraft(accountId, payload) {
      calls.save.push({accountId, payload});
      return {id:'account-a:message-v'+calls.save.length, draftId:payload.draftId || 'remote-draft', remoteId:'message-v'+calls.save.length};
    },
    async send(accountId, payload) {
      calls.send.push({accountId, payload});
      return {id:accountId+':sent-message', remoteId:'sent-message'};
    },
    async deleteDraft(accountId, draftId, options) { calls.remove.push({accountId, draftId, options}); },
    async downloadAttachment(accountId, messageId, attachmentId) {
      calls.download.push({accountId, messageId, attachmentId});
      return Buffer.from('synthetic attachment');
    },
    async sync(accountId, options) { calls.sync.push({accountId, options}); return {}; }
  };
  const core = {
    snapshot() { return store.read(); },
    asset(id) { const asset=assets.get(id); if(!asset) throw new Error('Unknown synthetic asset'); return asset; },
    async ingestBuffer(buffer, options) {
      const id=randomUUID(), file=path.join(dataDir,id+'.bin');
      fs.writeFileSync(file,buffer);
      const asset={id,path:file,name:options.name,mimeType:options.mime || 'application/octet-stream',size:buffer.length};
      assets.set(id,asset);
      return asset;
    }
  };
  const mainFile = path.resolve(__dirname, '..', 'app', 'main.cjs');
  const moduleRequire = createRequire(mainFile);
  const electron = {
    app:{setName(){},setPath(){},getPath(){return dataDir;},getVersion(){return 'test';},whenReady(){return new Promise(() => {});},on(){},requestSingleInstanceLock(){return true;},quit(){}},
    protocol:{registerSchemesAsPrivileged(){}},
    shell:{async openExternal(url){calls.open.push(url);}}
  };
  const module = {exports:{}};
  const source = fs.readFileSync(mainFile,'utf8') + '\nmodule.exports={actions,draftPayload,makeMailScheduler(){mailScheduler=createMailScheduler();return mailScheduler;},setClosing(v){closing=v;},setTestContext(v){core=v.core;store=v.store;gmail=v.gmail;vault=v.vault;pool=v.pool;diagnostics={info:()=>({})};}};';
  vm.runInNewContext(source, {
    require:name => name === 'electron' ? electron : moduleRequire(name),module,
    __dirname:path.dirname(mainFile),__filename:mainFile,
    process:{argv:['node','test'],env:{},platform:'win32'},Buffer,URL,Response,console,
    setTimeout(){return {unref(){}};},clearTimeout(){},setInterval(){return {unref(){}};},clearInterval(){}
  }, {filename:mainFile});
  module.exports.setTestContext({store,core,gmail,vault:{available(){return true;},get(){return null;}},pool:{snapshot(){return {};}}});
  return {...module.exports,store,core,gmail,calls,dataDir};
}

function draft(overrides = {}) {
  return {id:randomUUID(),accountId:'account-a',to:'recipient@example.test',cc:'',bcc:'',subject:'Draft subject',body:'Draft body',attachments:[],...overrides};
}

function sourceMessage(overrides = {}) {
  return {id:'account-a:source-message',accountId:'account-a',source:'Gmail',remoteId:'source-message',threadId:'source-thread',messageId:'<source@example.test>',references:['<earlier@example.test>'],email:'author@example.test',sender:'Author',from:'Author <author@example.test>',to:'self@example.test',cc:'team@example.test',bcc:'',subject:'Source subject',body:'Original body',date:'2026-09-01T10:00:00Z',attachments:[],...overrides};
}

function organizationHarness(t){
  const h=controllerHarness(t),modelCalls=[],models=new ModelAdapters();
  for(const source of ['local','cloud'])models.register('llm',{run(request){
    modelCalls.push(request);
    return request.task==='mail'?{analyses:[{id:'organize',summary:'Synthetic summary.',priority:2,reason:'Notification only.',evidence:['Synthetic notification.']}]}:{category:'account'};
  }},{source});
  const core=new AppService({store:h.store,dataDir:h.dataDir,models});
  core.settings({modelDefaults:{llm:'cloud'},mailSchedule:{enabled:true,time:'00:00'}});
  h.store.update(d=>{d.messages=[{id:'organize',folder:'inbox',subject:'Synthetic notification.',body:'Synthetic notification.',done:true,read:true}];});
  h.setTestContext({store:h.store,core,gmail:h.gmail,vault:{available(){return true;},get(){return null;}},pool:{snapshot(){return {};}}});
  return{...h,core,modelCalls,scheduler:h.makeMailScheduler()};
}

test('daily mail controller syncs all accounts then summarizes and classifies with the captured default, blocking overlapping manual starts',async t=>{
  const h=organizationHarness(t);let release;
  h.gmail.sync=async id=>{h.calls.sync.push(id);if(id==='account-a')await new Promise(resolve=>{release=resolve;});return{};};
  const pending=h.scheduler.tick();assert.equal(h.store.read().mailScheduleState.status,'running');
  assert.throws(()=>h.actions['mail.analyze']({source:'local'}),{code:'MAIL_ANALYSIS_BUSY'});
  h.core.settings({modelDefaults:{llm:'local'}});release();await pending;
  assert.deepEqual(h.calls.sync,['account-a','account-b']);assert.deepEqual(h.modelCalls.map(c=>[c.source,c.task]),[['cloud','mail'],['cloud','mail-classify']]);
  assert.equal(h.store.read().messages[0].analysis.category,'account');assert.equal(h.store.read().mailScheduleState.status,'done');
  await h.actions['mail.analyze']({source:'cloud'});assert.equal(h.modelCalls.length,2,'Manual default mode also skips complete unchanged mail.');
  await h.actions['mail.analyze']({source:'cloud',onlyChanged:false,ids:['organize']});assert.equal(h.modelCalls.length,4);
});

test('daily mail controller retains available summaries but reports a partial account sync failure',async t=>{
  const h=organizationHarness(t);h.gmail.sync=async id=>{if(id==='account-b')throw new Error('Synthetic sync offline');return{};};
  await h.scheduler.tick();assert.equal(h.modelCalls.length,2);assert.equal(h.store.read().messages[0].analysis.category,'account');
  assert.equal(h.store.read().mailScheduleState.status,'error');assert.match(h.store.read().mailScheduleState.error,/1 個郵件帳戶同步失敗/);
});

test('daily mail reserves the text model slot throughout sync and inference, releasing it when finished',async t=>{
  const h=organizationHarness(t);let releaseSync,releaseSummary;
  h.store.update(d=>{d.accounts=d.accounts.slice(0,1);});
  h.gmail.sync=()=>new Promise(resolve=>{releaseSync=resolve;});
  h.core.models.register('llm',{run(request){
    h.modelCalls.push(request);
    if(request.task==='mail')return new Promise(resolve=>{releaseSummary=()=>resolve({analyses:[{id:'organize',summary:'Synthetic summary.',priority:2,reason:'Notification only.',evidence:['Synthetic notification.']}]});});
    return{category:'account'};
  }},{source:'cloud'});
  const otherCalls=[];
  h.core.sendChat=()=>otherCalls.push('chat');h.core.runTranslation=()=>otherCalls.push('translation');h.core.runPolish=()=>otherCalls.push('polish');
  const assertReserved=()=>{
    for(const action of ['chat.send','translation.start','polish.start'])assert.throws(()=>h.actions[action]({text:'Synthetic question.',source:'local'}),{code:'MAIL_ANALYSIS_BUSY'});
    assert.deepEqual(otherCalls,[]);
  };
  const pending=h.scheduler.tick();assertReserved();releaseSync({});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof releaseSummary,'function');assertReserved();
  releaseSummary();await pending;assert.equal(h.store.read().mailScheduleState.status,'done');
  for(const action of ['chat.send','translation.start','polish.start'])h.actions[action]({text:'Synthetic question.',source:'local'});
  assert.deepEqual(otherCalls,['chat','translation','polish']);
});

test('daily mail controller does not start inference when shutdown begins during account sync',async t=>{
  const h=organizationHarness(t);let release;h.gmail.sync=()=>new Promise(resolve=>{release=resolve;});
  h.store.update(d=>{d.accounts=d.accounts.slice(0,1);});const pending=h.scheduler.tick();h.setClosing(true);release({});await pending;
  assert.equal(h.modelCalls.length,0);assert.equal(h.store.read().mailScheduleState.status,'cancelled');assert.equal(h.core.active.size,0);
});

test('daily mail controller waits for an existing text model task before claiming the day',async t=>{
  const h=organizationHarness(t);h.core.active.set('chat',new AbortController());
  assert.equal(await h.scheduler.tick(),false);assert.equal(h.store.read().mailScheduleState.lastScheduledDate,'');assert.equal(h.modelCalls.length,0);
  h.core.active.delete('chat');await h.scheduler.tick();assert.equal(h.modelCalls.length,2);
});

test('repeated local saves preserve the compose ID and persist exactly one latest draft', async t => {
  const h=controllerHarness(t), input=draft({accountId:'local'});
  await h.actions['draft.save']({...input,localOnly:true});
  const result=await h.actions['draft.save']({...input,body:'Latest local body',localOnly:true});
  assert.equal(result.draft.id,input.id);
  assert.equal(result.draft.body,'Latest local body');
  assert.equal(h.store.read().drafts.length,1);
  assert.equal(new Store({dataDir:h.dataDir}).read().drafts[0].body,'Latest local body');
  assert.equal(h.calls.save.length,0);
});

test('remote saves preserve Gmail draft identity and check the last remote message version', async t => {
  const h=controllerHarness(t), input=draft();
  const first=await h.actions['draft.save']({...input,remoteDraftId:'untrusted-draft',remoteMessageId:'untrusted-version'});
  assert.equal(h.calls.save[0].payload.draftId,undefined);
  assert.equal(h.calls.save[0].payload.expectedMessageId,undefined);
  assert.equal(first.draft.remoteDraftId,'remote-draft');
  assert.equal(first.draft.remoteMessageId,'message-v1');
  const second=await h.actions['draft.save']({...input,body:'Second version'});
  assert.equal(h.calls.save[1].payload.draftId,'remote-draft');
  assert.equal(h.calls.save[1].payload.expectedMessageId,'message-v1');
  assert.equal(second.draft.remoteDraftId,'remote-draft');
  assert.equal(second.draft.remoteMessageId,'message-v2');
  assert.equal(second.draft.status,'synced');
  assert.equal(h.store.read().drafts.length,1);
});

test('switching the sender account clears remote draft, message version and Gmail thread identifiers', async t => {
  const h=controllerHarness(t), input=draft({remoteDraftId:'account-a-draft',remoteMessageId:'account-a-version',threadId:'account-a-thread',status:'synced'});
  h.store.update(state => {state.drafts.push(input);});
  const local=await h.actions['draft.save']({...input,accountId:'account-b',localOnly:true});
  assert.equal(local.draft.remoteDraftId,null);
  assert.equal(local.draft.remoteMessageId,null);
  assert.equal(local.draft.threadId,null);
  await h.actions['draft.save']({...local.draft,remoteDraftId:'account-a-draft',remoteMessageId:'account-a-version'});
  assert.equal(h.calls.save[0].accountId,'account-b');
  assert.equal(h.calls.save[0].payload.draftId,undefined);
  assert.equal(h.calls.save[0].payload.expectedMessageId,undefined);
  assert.equal(h.calls.save[0].payload.threadId,null);
});

test('reply and reply-all derive trusted headers and thread from the source, excluding the sender account', async t => {
  const h=controllerHarness(t), message=sourceMessage({replyTo:'Replies <replies@example.test>'});
  h.store.update(state => {state.messages.push(message);});
  const reply=await h.actions['draft.fromMail']({id:message.id,mode:'reply-all'});
  assert.match(reply.to,/replies@example\.test/);
  assert.doesNotMatch(reply.to+' '+reply.cc,/self@example\.test/);
  assert.match(reply.cc,/team@example\.test/);
  assert.equal(reply.subject,'Re: Source subject');
  assert.equal(reply.replyToId,message.id);
  assert.deepEqual(plain(reply.attachments),[]);
  await h.actions['draft.save']({...reply,inReplyTo:'<forged@example.test>',references:['<forged@example.test>'],threadId:'forged-thread'});
  const payload=h.calls.save[0].payload;
  assert.equal(payload.inReplyTo,message.messageId);
  assert.deepEqual(plain(payload.references),['<earlier@example.test>','<source@example.test>']);
  assert.equal(payload.threadId,'source-thread');
  await h.actions['draft.save']({...reply,accountId:'account-b'});
  assert.equal(h.calls.save[1].payload.inReplyTo,message.messageId);
  assert.equal(h.calls.save[1].payload.threadId,undefined);
});

test('forwarding materializes attachments but does not reuse reply headers or the Gmail thread', async t => {
  const h=controllerHarness(t), message=sourceMessage({attachments:[{name:'notes.txt',mimeType:'text/plain',size:20,attachmentId:'attachment-1'}]});
  h.store.update(state => {state.messages.push(message);});
  const forward=await h.actions['draft.fromMail']({id:message.id,mode:'forward'});
  assert.equal(forward.to,'');assert.equal(forward.cc,'');assert.equal(forward.bcc,'');
  assert.equal(forward.subject,'Fwd: Source subject');
  assert.equal(forward.replyToId,null);
  assert.equal(forward.attachments.length,1);
  assert.match(forward.body,/Original body/);
  await h.actions['draft.save']({...forward,to:'forward@example.test'});
  const payload=h.calls.save[0].payload;
  assert.equal(payload.inReplyTo,'');
  assert.deepEqual(plain(payload.references),[]);
  assert.equal(payload.threadId,null);
  assert.equal(payload.attachments[0].name,'notes.txt');
  assert.equal(payload.attachments[0].contentType,'text/plain');
  assert.equal(payload.attachments[0].content.toString(),'synthetic attachment');
  assert.deepEqual(h.calls.download,[{accountId:'account-a',messageId:'source-message',attachmentId:'attachment-1'}]);
});

test('opening a remote draft preserves headers, versions, recipients and attachment bytes across repeated opens and saves', async t => {
  const h=controllerHarness(t), message=sourceMessage({draftId:'existing-remote-draft',remoteId:'existing-draft-version',inReplyTo:'<parent@example.test>',cc:'copy@example.test',bcc:'blind@example.test',attachments:[{name:'draft.txt',mimeType:'text/plain',size:20,attachmentId:'draft-attachment'}]});
  h.store.update(state => {state.messages.push(message);});
  const opened=await h.actions['draft.openRemote']({id:message.id});
  const again=await h.actions['draft.openRemote']({id:message.id});
  assert.equal(again.id,opened.id);
  assert.equal(h.store.read().drafts.length,1);
  assert.equal(h.calls.download.length,1);
  assert.equal(opened.remoteDraftId,message.draftId);
  assert.equal(opened.remoteMessageId,message.remoteId);
  assert.equal(opened.cc,message.cc);assert.equal(opened.bcc,message.bcc);
  await h.actions['draft.save']({...opened,body:'Edited remote body'});
  const payload=h.calls.save[0].payload;
  assert.equal(payload.draftId,message.draftId);
  assert.equal(payload.expectedMessageId,message.remoteId);
  assert.equal(payload.inReplyTo,message.inReplyTo);
  assert.deepEqual(plain(payload.references),message.references);
  assert.equal(payload.threadId,message.threadId);
  assert.equal(payload.body,'Edited remote body');
  assert.equal(payload.attachments[0].content.toString(),'synthetic attachment');
});

test('a remote version conflict keeps the latest local edits and refuses deletion without losing the draft', async t => {
  const h=controllerHarness(t), input=draft({remoteDraftId:'changed-draft',remoteMessageId:'old-version'});
  h.store.update(state => {state.drafts.push(input);});
  h.gmail.saveDraft=async () => {throw mailError('DRAFT_CONFLICT','The draft changed in Gmail');};
  const result=await h.actions['draft.save']({...input,body:'Unsynced local edit'});
  assert.equal(result.draft.status,'conflict');
  assert.equal(result.draft.body,'Unsynced local edit');
  assert.equal(result.draft.remoteMessageId,'old-version');
  assert.match(result.warning,/本機草稿/);
  h.gmail.deleteDraft=async (accountId,draftId,options) => {
    assert.equal(accountId,'account-a');assert.equal(draftId,'changed-draft');assert.equal(options.expectedMessageId,'old-version');
    throw mailError('DRAFT_CONFLICT');
  };
  await assert.rejects(h.actions['draft.remove']({id:input.id}),{code:'DRAFT_CONFLICT'});
  assert.equal(h.store.read().drafts[0].body,'Unsynced local edit');
});

test('sending an existing remote draft checks its version, removes the local draft once and does not issue another remote deletion', async t => {
  const h=controllerHarness(t), input=draft({remoteDraftId:'send-draft',remoteMessageId:'send-version'});
  h.store.update(state => {state.drafts.push(input);});
  const result=await h.actions['draft.send']({...input,body:'Latest content to send'});
  assert.equal(result.sent,true);
  assert.equal(h.calls.send.length,1);
  assert.equal(h.calls.send[0].payload.draftId,'send-draft');
  assert.equal(h.calls.send[0].payload.expectedMessageId,'send-version');
  assert.equal(h.calls.send[0].payload.body,'Latest content to send');
  assert.equal(h.calls.save.length,0);
  assert.equal(h.calls.remove.length,0);
  assert.equal(h.store.read().drafts.length,0);
  assert.ok(h.store.read().logs.some(log => log.text==='郵件寄送成功'));
});

test('Gmail-confirmed send with a local persistence error is reported as sent and never logged as unsent', async t => {
  const h=controllerHarness(t), input=draft();
  h.gmail.send=async () => {throw mailError('SEND_CONFIRMED_LOCAL_ERROR','Gmail sent the mail; local write failed');};
  const result=await h.actions['draft.send'](input);
  assert.equal(result.sent,true);
  assert.match(result.warning,/已確認寄出/);
  assert.match(result.warning,/不要重寄/);
  assert.equal(h.store.read().drafts.length,0);
  assert.ok(h.store.read().logs.some(log => log.text==='郵件寄送成功'));
  assert.ok(h.store.read().logs.every(log => log.text!=='郵件未寄出'));
});

test('an uncertain send retains the latest draft and warns to check Gmail before retrying', async t => {
  const h=controllerHarness(t), input=draft();
  h.gmail.send=async () => {throw mailError('SEND_UNCERTAIN','Response was interrupted');};
  await assert.rejects(h.actions['draft.send'](input),{code:'SEND_UNCERTAIN'});
  const state=h.store.read();
  assert.equal(state.drafts[0].status,'send-uncertain');
  assert.equal(state.drafts[0].body,input.body);
  assert.ok(state.logs.some(log => log.text==='郵件寄送結果待確認'&&/檢查 Gmail/.test(log.detail)));
  assert.ok(state.logs.every(log => log.text!=='郵件未寄出'));
});

test('a cleanup write failure after successful send still reports sent without suggesting a retry', async t => {
  const h=controllerHarness(t), input=draft();
  h.gmail.send=async () => {
    h.store._atomicWrite=() => {throw new Error('Synthetic disk failure after Gmail accepted');};
    return {remoteId:'confirmed-sent-message'};
  };
  const result=await h.actions['draft.send'](input);
  assert.equal(result.sent,true);
  assert.equal(result.result.remoteId,'confirmed-sent-message');
  assert.match(result.warning,/已確認寄出/);
  assert.match(result.warning,/請勿重寄/);
  assert.equal(h.store.read().drafts[0].id,input.id);
  assert.ok(h.store.read().logs.every(log => log.text!=='郵件未寄出'));
});

test('mail content loads only legacy Gmail HTML and leaves complete local and plain mail offline',async t=>{
  const h=controllerHarness(t),legacy=sourceMessage(),calls=[];
  h.store.update(state=>{state.messages=[legacy,{...sourceMessage({id:'local:complete',source:'本機',accountId:'local',html:'<b>Saved HTML</b>',htmlVersion:1})},{...sourceMessage({id:'account-a:plain',html:null,htmlVersion:1})}];});
  h.gmail.ensureMessageContent=async id=>{calls.push(id);return{...legacy,html:'<a href="https://example.test">Link label</a>',htmlVersion:1};};
  assert.equal((await h.actions['mail.content']({id:legacy.id})).htmlVersion,1);
  assert.equal((await h.actions['mail.content']({id:'local:complete'})).html,'<b>Saved HTML</b>');
  assert.equal((await h.actions['mail.content']({id:'account-a:plain'})).html,null);assert.deepEqual(calls,[legacy.id]);
  assert.equal(h.calls.save.length+h.calls.send.length+h.calls.remove.length,0);
});

test('mail CID images use only the selected mail attachments, cache bytes, and allow a deliberate retry to refresh them',async t=>{
  const h=controllerHarness(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrS8AAAAASUVORK5CYII=','base64');
  const asset=await h.core.ingestBuffer(png,{name:'inline.png',mime:'image/png'}),mail=sourceMessage({attachments:[{assetId:asset.id,contentId:'logo@example.test',mimeType:'image/png',size:png.length}]});
  h.store.update(state=>{state.messages=[mail];});
  const result=await h.actions['mail.image']({id:mail.id,source:'cid:logo%40example.test'});assert.equal(result.dataUrl,'data:image/png;base64,'+png.toString('base64'));assert.equal(h.calls.download.length,0);
  await fs.promises.unlink(asset.path);
  assert.equal((await h.actions['mail.image']({id:mail.id,source:'cid:logo%40example.test'})).dataUrl,result.dataUrl);
  await assert.rejects(h.actions['mail.image']({id:mail.id,source:'cid:logo%40example.test',refresh:true}));
  await assert.rejects(h.actions['mail.image']({id:mail.id,source:'cid:unrelated@example.test'}));
  await assert.rejects(h.actions['mail.image']({id:mail.id,source:'file:///C:/private.png'}));
  await assert.rejects(h.actions['mail.image']({id:mail.id,source:'http://127.0.0.1/private.png'}));
  h.store.update(state=>{state.messages=[];});await assert.rejects(h.actions['mail.image']({id:mail.id,source:'cid:logo%40example.test'}));
});

test('mail links open only web or mailto URLs for an existing message and never launch local protocols',async t=>{
  const h=controllerHarness(t),mail=sourceMessage();h.store.update(state=>{state.messages=[mail];});
  for(const href of ['https://example.test/account?name=hello%20world','http://example.test/','mailto:person@example.test?subject=Hello'])assert.equal((await h.actions['mail.openLink']({id:mail.id,href})).opened,true);
  for(const href of ['javascript:alert(1)','data:text/html,hello','file:///C:/Windows/notepad.exe','ms-settings:display','https://name:password@example.test/','https://example.test/\r\nextra'])await assert.rejects(h.actions['mail.openLink']({id:mail.id,href}));
  assert.equal(h.calls.open.length,3);await assert.rejects(h.actions['mail.openLink']({id:'missing',href:'https://example.test/'}));assert.equal(h.calls.open.length,3);
});

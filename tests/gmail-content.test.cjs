'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Store}=require('../app/services/store.cjs');
const {GmailService}=require('../app/services/gmail.cjs');
const root=path.resolve(__dirname,'../.test-data/gmail-content-tests'),accountId='gmail:fixture@example.test',messageId=accountId+':message';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const cached=(extra={})=>({id:messageId,accountId,remoteId:'message',source:'Gmail',threadId:'thread',subject:'Cached subject',body:'Existing plain body',read:false,star:true,folder:'inbox',labelIds:['INBOX','UNREAD','STARRED'],labels:['kept label'],done:true,level:2,analysis:{summary:'kept analysis'},draftId:'kept-draft',attachments:[],...extra});
function full({html='<table><tr><td><a href="https://example.test/path">Link label</a></td></tr></table>',parts=[]}={}){
  return{id:'message',threadId:'fresh-thread',labelIds:['SENT'],payload:{mimeType:'multipart/mixed',headers:[{name:'Subject',value:'Different remote subject'}],parts:[
    {mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:Buffer.from('Different remote text').toString('base64url')}},...(html===null?[]:[{mimeType:'text/html',body:{data:Buffer.from(html).toString('base64url')}}])]},...parts]}};
}
async function fixture(t,{message=cached(),handler=()=>response(full())}={}){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));
  t.after(async()=>{assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir});store.update(state=>{state.accounts=[{id:accountId,provider:'gmail',connected:true,labels:[],historyId:'kept-cursor'}];state.messages=message?[message]:[];});
  const calls=[],waits=[],vault={get:async()=>null,set:async()=>{},delete:async()=>{}},service=new GmailService({store,vault,openExternal:()=>assert.fail('No browser should open'),readGate:{wait:async id=>waits.push(id)},fetchImpl:async(url,options)=>{
    const call={url:new URL(url),method:options.method||'GET',body:options.body};calls.push(call);assert.equal(call.url.origin,'https://gmail.googleapis.com');return handler(call);
  }});
  service.tokens.set(accountId,{accessToken:'synthetic-token',expiresAt:Date.now()+3600000});return{dataDir,store,service,calls,waits};
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('on-demand content fills HTML and CID metadata using GET only while retaining current flags, analysis and managed attachment data',async t=>{
  const existingAttachment={name:'logo.png',mimeType:'image/png',attachmentId:'image-part',size:3,assetId:'kept-local-asset',content:{type:'Buffer',data:[1,2,3]}},started=deferred(),release=deferred();
  const f=await fixture(t,{message:cached({attachments:[existingAttachment]}),handler:async call=>{assert.equal(call.url.searchParams.get('format'),'full');started.resolve();await release.promise;return response(full({parts:[{mimeType:'image/png',filename:'logo.png',headers:[{name:'Content-ID',value:'<logo@example.test>'},{name:'Content-Disposition',value:'inline'}],body:{attachmentId:'image-part',size:3}}]}));}});
  const pending=f.service.ensureMessageContent(messageId);await started.promise;f.store.update(state=>{state.messages[0].read=true;state.messages[0].done=false;state.messages[0].analysis.summary='latest local analysis';});const before=f.store.read();release.resolve();
  const result=await pending;assert.match(result.html,/<table>/);assert.equal(result.htmlVersion,1);assert.equal(result.attachments[0].contentId,'logo@example.test');assert.equal(result.attachments[0].contentDisposition,'inline');assert.equal(result.attachments[0].inline,true);
  assert.deepEqual(result.attachments[0].content,existingAttachment.content);assert.equal(result.attachments[0].assetId,'kept-local-asset');
  for(const [key,value] of Object.entries(before.messages[0]))if(key!=='attachments')assert.deepEqual(result[key],value,key+' must remain current');
  assert.deepEqual(f.store.read().accounts,before.accounts);assert.deepEqual(f.store.read().logs,before.logs);assert.equal(f.calls.length,1);assert(f.calls.every(call=>call.method==='GET'&&!call.body));assert.deepEqual(f.waits,[accountId]);
});

test('concurrent requests for the same legacy message share one load and cached HTML remains available offline',async t=>{
  const started=deferred(),release=deferred();const f=await fixture(t,{handler:async()=>{started.resolve();await release.promise;return response(full());}});
  const pending=Array.from({length:6},()=>f.service.ensureMessageContent(messageId));await started.promise;assert.equal(f.calls.length,1);release.resolve();
  const results=await Promise.all(pending);assert(results.every(message=>message.htmlVersion===1));assert.equal(f.service.contentLoads.size,0);
  f.store.update(state=>{state.accounts[0].connected=false;});assert.equal((await f.service.ensureMessageContent(messageId)).htmlVersion,1);assert.equal(f.calls.length,1);
});

test('confirmed plain-only messages are cached as null HTML and local mail never requests Gmail',async t=>{
  const f=await fixture(t,{handler:()=>response(full({html:null}))});assert.equal((await f.service.ensureMessageContent(messageId)).html,null);assert.equal((await f.service.ensureMessageContent(messageId)).htmlVersion,1);assert.equal(f.calls.length,1);
  const local=await fixture(t,{message:cached({accountId:'local',source:'本機',remoteId:null})});assert.deepEqual(await local.service.ensureMessageContent(messageId),local.store.read().messages[0]);assert.equal(local.calls.length,0);
});

test('content waits for the account lock and reuses a newer body populated by synchronization',async t=>{
  const f=await fixture(t),release=deferred(),started=deferred();
  const updating=f.service._lock(accountId,async()=>{started.resolve();await release.promise;f.store.update(state=>{state.messages[0].html='<p>Synced while waiting</p>';state.messages[0].htmlVersion=1;});});await started.promise;
  const pending=f.service.ensureMessageContent(messageId);assert.equal(f.calls.length,0);release.resolve();await updating;
  assert.equal((await pending).html,'<p>Synced while waiting</p>');assert.equal(f.calls.length,0);
});

for(const change of ['removed','account-changed','remote-changed','disconnected'])test('late HTML cannot restore or replace a message after it is '+change,async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{handler:async()=>{started.resolve();await release.promise;return response(full());}});
  const pending=f.service.ensureMessageContent(messageId);await started.promise;
  f.store.update(state=>{if(change==='removed')state.messages=[];else if(change==='account-changed')state.messages[0].accountId='different-account';else if(change==='remote-changed')state.messages[0].remoteId='different-message';else state.accounts[0].connected=false;});const before=f.store.read();release.resolve();
  await assert.rejects(pending);assert.deepEqual(f.store.read(),before);assert.equal(f.service.contentLoads.size,0);
});

test('separately stored HTML failure leaves the text cache intact and remains retryable',async t=>{
  let failed=true;const f=await fixture(t,{handler:call=>{
    if(call.url.pathname.endsWith('/attachments/html-part'))return failed?response({},503):response({data:Buffer.from('<p>Fetched HTML</p>').toString('base64url')});
    return response({id:'message',payload:{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:Buffer.from('Remote plain').toString('base64url')}},{mimeType:'text/html',body:{attachmentId:'html-part',size:19}}]}});
  }});const before=f.store.read();await assert.rejects(f.service.ensureMessageContent(messageId));assert.deepEqual(f.store.read(),before);assert.equal(f.service.contentLoads.size,0);
  failed=false;assert.equal((await f.service.ensureMessageContent(messageId)).html,'<p>Fetched HTML</p>');assert.equal(f.calls.length,4);assert(f.calls.every(call=>call.method==='GET'));
});

test('pending attachment references upgrade without dropping local bytes, and newly discovered inline metadata is retained',async t=>{
  const existing={name:'logo.png',mimeType:'image/png',size:3,attachmentId:'pending:0',assetId:'asset',content:{type:'Buffer',data:[1,2,3]}};
  const f=await fixture(t,{message:cached({attachments:[existing]}),handler:()=>response(full({parts:[
    {mimeType:'image/png',filename:'logo.png',headers:[{name:'Content-ID',value:'<first@example.test>'}],body:{attachmentId:'stable-first',size:3}},
    {mimeType:'image/jpeg',filename:'second.jpg',headers:[{name:'Content-ID',value:'<second@example.test>'}],body:{attachmentId:'stable-second',size:5}}
  ]}))});
  const result=await f.service.ensureMessageContent(messageId);assert.equal(result.attachments.length,2);assert.equal(result.attachments[0].attachmentId,'stable-first');assert.equal(result.attachments[0].assetId,existing.assetId);assert.deepEqual(result.attachments[0].content,existing.content);assert.equal(result.attachments[1].contentId,'second@example.test');
});

test('Gmail RAW attachment metadata stays small and raw downloads return exact inline bytes without mutating local mail',async t=>{
  const image=Buffer.from([137,80,78,71,255,0]),mime=Buffer.from(['From: sender@example.test','Content-Type: multipart/related; boundary="raw"','','--raw','Content-Type: text/html; charset=utf-8','','<p><img src="cid:raw-logo@example.test">Body</p>','--raw','Content-Type: image/png; name="logo.png"','Content-Disposition: inline','Content-ID: <raw-logo@example.test>','Content-Transfer-Encoding: base64','',image.toString('base64'),'--raw--',''].join('\r\n'));
  const f=await fixture(t,{handler:()=>response({id:'message',raw:mime.toString('base64url')})});const message=await f.service.ensureMessageContent(messageId);
  assert.match(message.html,/cid:raw-logo@example.test/);assert.equal(message.attachments[0].attachmentId,'raw:0');assert.equal(message.attachments[0].contentId,'raw-logo@example.test');assert.equal(Object.hasOwn(message.attachments[0],'content'),false);
  const before=f.store.read();assert.deepEqual(await f.service.downloadAttachment(accountId,'message','raw:0'),image);assert.deepEqual(f.store.read(),before);assert.equal(f.calls[1].url.searchParams.get('format'),'raw');assert(f.calls.every(call=>call.method==='GET'));
  await assert.rejects(f.service.downloadAttachment(accountId,'message','raw:-1'));assert.equal(f.calls.length,2);
});

test('missing local messages and mismatched Gmail response identities fail without creating a cache entry',async t=>{
  const empty=await fixture(t,{message:null});await assert.rejects(empty.service.ensureMessageContent(messageId),{code:'MAIL_NOT_FOUND'});assert.equal(empty.calls.length,0);
  const mismatched=await fixture(t,{handler:()=>response({...full(),id:'different-message'})}),before=mismatched.store.read();
  await assert.rejects(mismatched.service.ensureMessageContent(messageId),{code:'MAIL_CONTENT_CHANGED'});assert.deepEqual(mismatched.store.read(),before);
});

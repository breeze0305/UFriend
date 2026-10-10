'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const {Store}=require('../app/services/store.cjs');
const {GmailService,GMAIL_SCOPE}=require('../app/services/gmail.cjs');
const {parseEml}=require('../app/services/mail-util.cjs');

const accountId='gmail:me@example.com';
const account=()=>({id:accountId,provider:'gmail',source:'Gmail',email:'me@example.com',connected:true,status:'connected',
  historyId:null,initialDays:30,lastSyncAt:null,syncStatus:'idle',labels:[]});
const response=(data={},status=200)=>new Response(status===204?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const raw=(id,labelIds=['INBOX','UNREAD'],body='Body '+id)=>({id,threadId:'thread-'+id,historyId:'150',internalDate:'1700000000000',labelIds,payload:{
  mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'To',value:'me@example.com'},
    {name:'Subject',value:'Subject '+id},{name:'Message-ID',value:'<'+id+'@example.com>'}],
  body:{data:Buffer.from(body).toString('base64url'),size:Buffer.byteLength(body)}}});
const cached=(id,extra={})=>({id:accountId+':'+id,accountId,remoteId:id,threadId:'thread-'+id,source:'Gmail',subject:'Old '+id,body:'old',
  labelIds:['INBOX','UNREAD'],labels:[],folder:'inbox',read:false,star:false,...extra});

function context(t,{handler,tokenHandler,accounts=[account()],messages=[],openExternal=async()=>{},onAuthStatus=()=>{},oauthTimeoutMs=5000,
  readGate={wait:async()=>{}},retrySleep=async()=>{},retryRandom=()=>0}={}) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ufriend-backend-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('ufriend-backend-'));fs.rmSync(dataDir,{recursive:true,force:true});});
  const store=new Store({dataDir});
  store.update(state=>{state.accounts=accounts;state.messages=messages;});
  const values=new Map(accounts.map(a=>['gmail:'+a.id,{clientId:'desktop-client',clientSecret:'test-client-secret',refreshToken:'test-refresh-secret'}]));
  const vault={get:async key=>values.get(key),set:async(key,value)=>values.set(key,structuredClone(value)),delete:async key=>values.delete(key)};
  const calls=[];let tokenCount=0;
  const fetchImpl=async(url,options={})=>{
    const call={url:new URL(url),method:options.method||'GET',headers:options.headers||{},body:options.body};
    calls.push(call);
    if(call.url.href==='https://oauth2.googleapis.com/token') {tokenCount++;if(tokenHandler)return tokenHandler(call,tokenCount);return response({access_token:'access-'+tokenCount,refresh_token:'test-refresh-secret',expires_in:3600,scope:GMAIL_SCOPE});}
    if(handler)return handler(call);
    throw new Error('Unexpected request: '+url);
  };
  const service=new GmailService({store,vault,fetchImpl,openExternal,onAuthStatus,oauthTimeoutMs,readGate,retrySleep,retryRandom});
  t.after(()=>service.cancelConnect());
  return {service,store,vault,values,calls,tokenCount:()=>tokenCount};
}

function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function authorize(url,code='synthetic-code') {
  const auth=new URL(url),redirect=new URL(auth.searchParams.get('redirect_uri'));
  redirect.searchParams.set('state',auth.searchParams.get('state'));redirect.searchParams.set('code',code);
  assert.equal((await fetch(redirect)).status,200);
}

function oauthAllocator(t,ports,{holdClose=false}={}) {
  const closing=deferred(),callbacks=[],listenPorts=[];let handler,currentPort;
  const server=new EventEmitter();
  server.listen=(port,host,callback)=>{assert.equal(port,0);assert.equal(host,'127.0.0.1');currentPort=ports[Math.min(listenPorts.length,ports.length-1)];listenPorts.push(currentPort);queueMicrotask(callback);return server;};
  server.address=()=>({address:'127.0.0.1',family:'IPv4',port:currentPort});
  server.close=callback=>{closing.resolve();if(callback){if(holdClose)callbacks.push(callback);else queueMicrotask(callback);}return server;};
  server.closeAllConnections=()=>{};
  t.mock.method(http,'createServer',callback=>{handler=callback;return server;});
  return{listenPorts,closing:closing.promise,releaseClose:()=>{for(const callback of callbacks.splice(0))callback();},
    authorize:async url=>{const auth=new URL(url),redirect=new URL(auth.searchParams.get('redirect_uri'));assert.equal(Number(redirect.port),currentPort);
      redirect.searchParams.set('state',auth.searchParams.get('state'));redirect.searchParams.set('code','synthetic-code');
      const response={writeHead(status){assert.equal(status,200);return this;},end(_body,callback){queueMicrotask(callback);}};
      handler({method:'GET',url:redirect.pathname+redirect.search},response);
    }};
}

test('OAuth closes browser-blocked allocations before publishing one safe callback URL',async t=>{
  const allocator=oauthAllocator(t,[6000,6667,49152]),opened=[];
  const h=context(t,{accounts:[],handler:()=>response({emailAddress:'me@example.com'}),openExternal:async url=>{opened.push(new URL(url).searchParams.get('redirect_uri'));await allocator.authorize(url);}});
  await h.service.connect({clientId:'desktop-client'});
  assert.deepEqual(allocator.listenPorts,[6000,6667,49152]);assert.deepEqual(opened,['http://127.0.0.1:49152/oauth2callback']);
  assert.equal(h.tokenCount(),1);
});

test('OAuth stops after a bounded number of forbidden allocations without opening a browser',async t=>{
  const allocator=oauthAllocator(t,[6000]);let opened=0;
  const h=context(t,{accounts:[],openExternal:async()=>{opened++;}});
  await assert.rejects(h.service.connect({clientId:'desktop-client'}),{code:'AUTH_PORT_UNAVAILABLE'});
  assert.equal(allocator.listenPorts.length,16);assert.equal(opened,0);assert.equal(h.calls.length,0);assert.equal(h.service.connecting,false);
});

for(const cancelled of [true,false])test('OAuth '+(cancelled?'cancellation':'timeout')+' during forbidden-port close cannot start a late listener or browser',async t=>{
  const allocator=oauthAllocator(t,[6000,49152],{holdClose:true});let opened=0;
  const h=context(t,{accounts:[],oauthTimeoutMs:30,openExternal:async()=>{opened++;}});
  const pending=h.service.connect({clientId:'desktop-client'}),rejected=assert.rejects(pending,{code:cancelled?'AUTH_CANCELLED':'AUTH_TIMEOUT'});
  await allocator.closing;if(cancelled)h.service.cancelConnect();await rejected;
  allocator.releaseClose();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(allocator.listenPorts,[6000]);assert.equal(opened,0);assert.equal(h.calls.length,0);assert.equal(h.service.connecting,false);
});

test('Google error reasons give fixed, distinct advice without exposing provider details',async t=>{
  const cases=[
    ['insufficientPermissions',false,/未授予完整的 Gmail 權限/],
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT',true,/未授予完整的 Gmail 權限/],
    ['accessNotConfigured',false,/尚未啟用 Gmail API/],
    ['SERVICE_DISABLED',true,/尚未啟用 Gmail API/],
    ['domainPolicy',false,/Google Workspace 政策/],
    ['rateLimitExceeded',false,/Gmail API 請求達到速率限制/],
    ['userRateLimitExceeded',false,/此帳號的 Gmail API 請求達到速率限制/],
    ['dailyLimitExceeded',false,/每日配額已用盡/],
  ];
  for(const [reason,structured,advice] of cases) {
    const h=context(t,{handler:()=>response({error:{status:'PERMISSION_DENIED',message:'PRIVATE_PROVIDER_MESSAGE',
      errors:structured?[]:[{reason,message:'PRIVATE_NESTED_MESSAGE',location:'PRIVATE_LOCATION'}],
      details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:structured?reason:'UNKNOWN_PRIVATE_REASON',
        metadata:{consumer:'PRIVATE_PROJECT',service:'PRIVATE_URL'},domain:'PRIVATE_DOMAIN'}]}},403)});
    await assert.rejects(h.service._http('https://gmail.googleapis.com/gmail/v1/users/me/labels'),error=>{
      assert.equal(error.reason,reason);assert.equal(error.status,403);assert.equal(error.providerStatus,'PERMISSION_DENIED');
      assert.match(error.message,advice);assert.ok(!JSON.stringify(error).includes('PRIVATE_'));return true;
    });
  }
  const h=context(t,{handler:()=>response({error:{status:'RESOURCE_EXHAUSTED',message:'PRIVATE_STATUS_DETAIL'}},429)});
  await assert.rejects(h.service._http('https://gmail.googleapis.com/gmail/v1/users/me/labels'),error=>{
    assert.equal(error.reason,'RESOURCE_EXHAUSTED');assert.match(error.message,/配額或速率已達限制/);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_'));return true;
  });
});

test('unknown, malformed and non-ErrorInfo Google errors remain generic and private',async t=>{
  const errors=[null,{}, {error:null},{error:'PRIVATE_OAUTH_REASON'},
    {error:{message:'PRIVATE_MESSAGE',status:'PRIVATE_STATUS',errors:[null,{reason:'PRIVATE_REASON'},{reason:'__proto__'}],
      details:[null,{'@type':'PRIVATE_TYPE',reason:'SERVICE_DISABLED',metadata:{url:'PRIVATE_URL'}}]}},
    {error:{errors:{reason:'insufficientPermissions'},details:{reason:'SERVICE_DISABLED'}}}];
  for(const data of errors) {
    const h=context(t,{handler:()=>response(data,403)});
    await assert.rejects(h.service.listLabels(accountId),error=>{
      assert.equal(error.code,'HTTP_403');assert.equal(error.reason,'');assert.equal(error.providerStatus,'');
      assert.equal(error.operation,'labels.list');assert.match(error.message,/Google 未提供可辨識的原因/);
      assert.ok(!JSON.stringify(error).includes('PRIVATE_'));return true;
    });
  }
});

test('incomplete or invalid successful history responses preserve mail, labels and the sync cursor',async t=>{
  const cases=[
    ['empty',()=>new Response(''), 'GMAIL_INVALID_RESPONSE'],
    ['malformed',()=>new Response('{"history": PRIVATE_RESPONSE'), 'GMAIL_INVALID_RESPONSE'],
    ['null',()=>response(null), 'GMAIL_INVALID_RESPONSE'],
    ['array',()=>response([]), 'GMAIL_INVALID_RESPONSE'],
    ['interrupted',()=>new Response(new ReadableStream({start(controller){controller.error(new Error('PRIVATE_RESPONSE'));}})), 'NETWORK_ERROR'],
  ];
  for(const [_name,badResponse,code] of cases){
    const previous={...account(),historyId:'100',labels:[{id:'Label_old',name:'Old label'}],lastSyncAt:'2026-09-01T00:00:00.000Z'};
    const h=context(t,{accounts:[previous],messages:[cached('existing')],handler:call=>{
      if(call.url.pathname.endsWith('/labels'))return response({labels:[{id:'Label_new',name:'New label'}]});
      if(call.url.pathname.endsWith('/history'))return badResponse();
      if(call.url.pathname.endsWith('/drafts'))return response({});
      throw new Error('Unexpected request');
    }});
    const original=h.store.read().messages;
    await assert.rejects(h.service.sync(accountId),error=>{
      assert.equal(error.code,code);assert.equal(error.operation,'history.list');assert.ok(!error.message.includes('PRIVATE_RESPONSE'));return true;
    });
    const state=h.store.read();
    assert.equal(state.accounts[0].syncStatus,'error');assert.equal(state.accounts[0].historyId,'100');
    assert.equal(state.accounts[0].lastSyncAt,previous.lastSyncAt);assert.deepEqual(state.accounts[0].labels,previous.labels);
    assert.deepEqual(state.messages,original);assert.ok(!JSON.stringify(state.logs).includes('PRIVATE_RESPONSE'));
    assert.equal(h.calls.filter(call=>call.url.pathname.endsWith('/history')).length,1);
  }
});

test('unreadable successful writes report an uncertain outcome without retrying or saving fake mail',async t=>{
  for(const action of ['saveDraft','send'])for(const malformed of [true,false]){
    const h=context(t,{handler:()=>malformed?new Response('{"id": PRIVATE_RESPONSE'):new Response(new ReadableStream({start(controller){controller.error(new Error('PRIVATE_RESPONSE'));}}))});
    await assert.rejects(h.service[action](accountId,{to:'person@example.com',subject:'Synthetic subject',body:'Synthetic body'}),{code:action==='send'?'SEND_UNCERTAIN':'DRAFT_UNCERTAIN'});
    assert.equal(h.calls.filter(call=>call.url.hostname==='gmail.googleapis.com').length,1);
    assert.deepEqual(h.store.read().messages,[]);
  }
});

test('empty DELETE and revocation successes remain valid while non-JSON HTTP errors retain their status',async t=>{
  const h=context(t,{messages:[cached('draft',{draftId:'draft-1',folder:'drafts'})],handler:()=>new Response('')});
  await h.service.deleteDraft(accountId,'draft-1');assert.deepEqual(h.store.read().messages,[]);
  await h.service.disconnect(accountId,{revoke:true});assert.equal(h.store.read().accounts[0].connected,false);
  const errorContext=context(t,{handler:()=>new Response('PRIVATE_GATEWAY_PAGE',{status:503})});
  await assert.rejects(errorContext.service.listLabels(accountId),error=>error.status===503&&error.code==='HTTP_503'&&!error.message.includes('PRIVATE'));
});

test('a message-read denial saves useful sync advice without provider text or raw message IDs',async t=>{
  const h=context(t,{messages:[cached('existing')],handler:call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/labels'))return response({labels:[]});
    if(pathname.endsWith('/profile'))return response({historyId:'100'});
    if(pathname.endsWith('/messages'))return response({messages:[{id:'PRIVATE_REMOTE_ID'}]});
    if(pathname.endsWith('/drafts'))return response({drafts:[]});
    if(pathname.endsWith('/messages/existing'))return response(raw('existing'));
    return response({error:{errors:[{reason:'domainPolicy',message:'PRIVATE_PROVIDER_MESSAGE'}],
      message:'PRIVATE_PROVIDER_MESSAGE',details:[{metadata:{url:'PRIVATE_URL'}}]}},403);
  }});
  const before=structuredClone(h.store.read().messages);
  await assert.rejects(h.service.sync(accountId),error=>{
    assert.equal(error.operation,'messages.get');assert.equal(error.reason,'domainPolicy');
    assert.match(error.message,/讀取 Gmail 郵件內容失敗：.*Google Workspace 政策/);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_'));return true;
  });
  const state=h.store.read();
  assert.equal(state.accounts[0].connected,true);assert.equal(state.accounts[0].syncStatus,'error');
  assert.match(state.accounts[0].error,/讀取 Gmail 郵件內容失敗：.*Google Workspace 政策/);
  assert.equal(state.accounts[0].historyId,null);assert.deepEqual(state.messages,before);
  assert.ok(!JSON.stringify(state).includes('PRIVATE_'));
});

test('rate-limited GETs back off and succeed without refreshing credentials or extra requests',async t=>{
  const delays=[],waits=[];let attempts=0;
  const h=context(t,{readGate:{wait:async id=>waits.push(id)},retrySleep:async delay=>delays.push(delay),handler:()=>{
    attempts++;
    if(attempts===1)return response({error:{errors:[{reason:'rateLimitExceeded'}]}},403);
    if(attempts===2)return response({error:{status:'RESOURCE_EXHAUSTED'}},429);
    return response({labels:[{id:'INBOX',name:'INBOX'}]});
  }});
  assert.deepEqual(await h.service.listLabels(accountId),[{id:'INBOX',name:'INBOX'}]);
  assert.equal(attempts,3);assert.deepEqual(delays,[1000,2000]);assert.deepEqual(waits,[accountId,accountId,accountId]);
  assert.equal(h.tokenCount(),1);assert.equal(h.calls.length,4);
});

test('GET backoff pauses the shared account gate and stops after six failed attempts',async t=>{
  const events=[];let attempts=0;
  const h=context(t,{readGate:{wait:async id=>events.push(['wait',id]),defer:(id,delay)=>events.push(['defer',id,delay])},
    retrySleep:async()=>assert.fail('Shared gate must handle the delay'),retryRandom:()=>0.5,
    handler:()=>{attempts++;return response({error:{errors:[{reason:'userRateLimitExceeded'}]}},403);}});
  await assert.rejects(h.service.listLabels(accountId),error=>error.reason==='userRateLimitExceeded');
  assert.equal(attempts,6);assert.equal(h.tokenCount(),1);
  assert.deepEqual(events,[['wait',accountId],['defer',accountId,1125],['wait',accountId],['defer',accountId,2125],
    ['wait',accountId],['defer',accountId,4125],['wait',accountId],['defer',accountId,8125],['wait',accountId],
    ['defer',accountId,16125],['wait',accountId]]);
});

test('GET backoff honors bounded numeric Retry-After without retaining arbitrary header text',async t=>{
  for(const [header,expected] of [['3',3000],['60',60000],['61',1000],['PRIVATE_HEADER',1000]]) {
    let attempts=0;const delays=[];
    const h=context(t,{retrySleep:async delay=>delays.push(delay),handler:()=>{
      if(++attempts>1)return response({labels:[]});
      const limited=response({},429);limited.headers.set('Retry-After',header);return limited;
    }});
    assert.deepEqual(await h.service.listLabels(accountId),[]);assert.deepEqual(delays,[expected]);
  }
});

test('permission, policy, API setup, daily quota and unknown errors never retry',async t=>{
  for(const reason of ['insufficientPermissions','ACCESS_TOKEN_SCOPE_INSUFFICIENT','domainPolicy','accessNotConfigured','SERVICE_DISABLED','dailyLimitExceeded','UNKNOWN']) {
    let attempts=0;
    const h=context(t,{retrySleep:async()=>assert.fail('Non-rate error must not retry'),handler:()=>{
      attempts++;return response({error:{errors:[{reason}]}},403);
    }});
    await assert.rejects(h.service.listLabels(accountId));assert.equal(attempts,1);
  }
});

test('mutations never retry or use the read gate even when Google rate limits them',async t=>{
  for(const status of [403,429]) {
    let attempts=0;
    const h=context(t,{readGate:{wait:async()=>assert.fail('Writes must not use the read gate')},
      retrySleep:async()=>assert.fail('Writes must not retry'),handler:call=>{
        assert.equal(call.method,'POST');attempts++;return response({error:{errors:[{reason:'rateLimitExceeded'}]}},status);
      }});
    await assert.rejects(h.service._api(accountId,'messages/send',{method:'POST',body:{raw:'synthetic'}}),error=>error.status===status);
    assert.equal(attempts,1);assert.equal(h.tokenCount(),1);
  }
});

test('desktop OAuth validates state, uses S256 PKCE and loopback, and keeps credentials exclusively in vault',async t=>{
  let authUrl;
  const h=context(t,{accounts:[],handler:call=>{
    assert.equal(call.url.pathname,'/gmail/v1/users/me/profile');return response({emailAddress:'me@example.com',historyId:'900'});
  },openExternal:async url=>{
    authUrl=new URL(url);
    assert.equal(authUrl.origin,'https://accounts.google.com');assert.equal(authUrl.searchParams.get('scope'),GMAIL_SCOPE);
    const redirect=new URL(authUrl.searchParams.get('redirect_uri'));
    assert.equal(redirect.hostname,'127.0.0.1');assert.ok(Number(redirect.port)>0);
    redirect.searchParams.set('state','好'.repeat(authUrl.searchParams.get('state').length));
    redirect.searchParams.set('code','attack');
    assert.equal((await fetch(redirect)).status,400);
    redirect.searchParams.set('state',authUrl.searchParams.get('state'));redirect.searchParams.set('code','test-code');
    assert.equal((await fetch(redirect)).status,200);
  }});
  const connected=await h.service.connect({clientId:'desktop-client',clientSecret:'test-client-secret',days:90});
  assert.equal(connected.id,accountId);assert.equal(connected.initialDays,90);assert.equal(connected.historyId,null);
  const tokenCall=h.calls.find(call=>call.url.pathname==='/token'),body=new URLSearchParams(tokenCall.body);
  assert.equal(body.get('code'),'test-code');assert.equal(body.get('grant_type'),'authorization_code');
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),authUrl.searchParams.get('code_challenge'));
  assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
  assert.equal(h.values.get('gmail:'+accountId).refreshToken,'test-refresh-secret');
  const publicState=JSON.stringify(h.store.read());
  for(const secret of ['test-refresh-secret','test-client-secret','access-1','test-code'])assert.ok(!publicState.includes(secret));
  assert.equal(h.calls.length,2);
});

test('OAuth cancellation and timeout close their loopback listener without exchanging a token',async t=>{
  const cancelled=context(t,{accounts:[]});
  const pending=cancelled.service.connect({clientId:'desktop-client'});cancelled.service.cancelConnect();
  await assert.rejects(pending,error=>error.code==='AUTH_CANCELLED');
  assert.equal(cancelled.calls.length,0);
  let redirect;
  const timeout=context(t,{accounts:[],oauthTimeoutMs:30,openExternal:async url=>{redirect=new URL(url).searchParams.get('redirect_uri');}});
  await assert.rejects(timeout.service.connect({clientId:'desktop-client'}),error=>error.code==='AUTH_TIMEOUT');
  assert.equal(timeout.calls.length,0);
  await assert.rejects(fetch(redirect));
});

test('OAuth reports waiting only after browser launch succeeds, then completing, and supplies account selection and a validated login hint',async t=>{
  const launch=deferred(),browserOpened=deferred(),waiting=deferred(),statuses=[];
  const h=context(t,{accounts:[],handler:()=>response({emailAddress:'me@example.com'}),
    openExternal:async url=>{launch.resolve(url);await browserOpened.promise;},
    onAuthStatus:status=>{statuses.push(status);if(status==='waiting')waiting.resolve();}});
  const pending=h.service.connect({clientId:'desktop-client',loginHint:' me@example.com '});
  const url=await launch.promise,auth=new URL(url);
  assert.deepEqual(statuses,[]);
  assert.deepEqual(auth.searchParams.get('prompt').split(' ').sort(),['consent','select_account']);
  assert.equal(auth.searchParams.get('login_hint'),'me@example.com');
  browserOpened.resolve();await waiting.promise;
  await authorize(url);await pending;
  assert.deepEqual(statuses,['waiting','completing']);
});

test('a finished callback cannot emit late waiting, and throwing or rejecting status observers cannot break authentication',async t=>{
  for(const asynchronous of [false,true]) {
    const statuses=[];
    const h=context(t,{accounts:[],handler:()=>response({emailAddress:'me@example.com'}),openExternal:authorize,
      onAuthStatus:status=>{statuses.push(status);if(asynchronous)return Promise.reject(new Error('Observer failed'));throw new Error('Observer failed');}});
    const result=await h.service.connect({clientId:'desktop-client'});
    assert.equal(result.id,accountId);assert.deepEqual(statuses,['completing']);
  }
  const statuses=[],failed=context(t,{accounts:[],openExternal:async()=>{throw new Error('Browser launch failed');},onAuthStatus:status=>statuses.push(status)});
  await assert.rejects(failed.service.connect({clientId:'desktop-client'}),/無法開啟系統瀏覽器/);
  assert.deepEqual(statuses,[]);assert.equal(failed.calls.length,0);
});

test('cancelling while the browser launch is pending never sends a stale waiting status after an immediate retry',async t=>{
  const oldLaunch=deferred(),oldBrowser=deferred(),statuses=[];let opens=0;
  const h=context(t,{accounts:[],handler:()=>response({emailAddress:'me@example.com'}),onAuthStatus:status=>statuses.push(status),
    openExternal:async url=>{if(++opens===1){oldLaunch.resolve();await oldBrowser.promise;}else await authorize(url);}});
  const old=h.service.connect({clientId:'desktop-client'}),oldRejected=assert.rejects(old,{code:'AUTH_CANCELLED'});
  await oldLaunch.promise;h.service.cancelConnect();
  const retry=h.service.connect({clientId:'desktop-client'});
  await oldRejected;await retry;
  oldBrowser.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(statuses,['completing']);
  assert.equal(h.service.connecting,false);assert.equal(h.store.read().accounts.length,1);
});

test('cancellation while exchanging a token rejects promptly and its late response cannot overwrite a successful retry',async t=>{
  const tokenStarted=deferred(),lateToken=deferred();let profileCalls=0,writes=0;
  const h=context(t,{accounts:[],openExternal:authorize,
    tokenHandler:(_call,count)=>{if(count===1){tokenStarted.resolve();return lateToken.promise;}return response({access_token:'retry-access',refresh_token:'retry-refresh',scope:GMAIL_SCOPE});},
    handler:()=>{profileCalls++;return response({emailAddress:'me@example.com'});}});
  const set=h.vault.set;h.vault.set=async(...args)=>{writes++;return set(...args);};
  const old=h.service.connect({clientId:'desktop-client'}),oldRejected=assert.rejects(old,{code:'AUTH_CANCELLED'});
  await tokenStarted.promise;h.service.cancelConnect();
  const retry=h.service.connect({clientId:'desktop-client'});
  await oldRejected;
  assert.equal(writes,0);assert.equal(h.store.read().accounts.length,0);
  await retry;
  lateToken.resolve(response({access_token:'cancelled-access',refresh_token:'cancelled-refresh',scope:GMAIL_SCOPE}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(profileCalls,1);assert.equal(writes,1);
  assert.equal(h.values.get('gmail:'+accountId).refreshToken,'retry-refresh');
  assert.equal(h.service.tokens.get(accountId).accessToken,'retry-access');
  assert.equal(h.store.read().accounts.length,1);
});

test('cancellation while fetching the account profile cannot save a late account or credential after a retry',async t=>{
  const profileStarted=deferred(),lateProfile=deferred();let profileCalls=0,writes=0;
  const h=context(t,{accounts:[],openExternal:authorize,
    tokenHandler:(_call,count)=>response({access_token:'access-'+count,refresh_token:'refresh-'+count,scope:GMAIL_SCOPE}),
    handler:()=>{if(++profileCalls===1){profileStarted.resolve();return lateProfile.promise;}return response({emailAddress:'me@example.com'});}});
  const set=h.vault.set;h.vault.set=async(...args)=>{writes++;return set(...args);};
  const old=h.service.connect({clientId:'desktop-client'}),oldRejected=assert.rejects(old,{code:'AUTH_CANCELLED'});
  await profileStarted.promise;h.service.cancelConnect();
  const retry=h.service.connect({clientId:'desktop-client'});
  await oldRejected;assert.equal(h.values.size,0);assert.equal(h.store.read().accounts.length,0);
  await retry;
  lateProfile.resolve(response({emailAddress:'cancelled@example.com'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,1);assert.equal(h.values.size,1);
  assert.equal(h.values.get('gmail:'+accountId).refreshToken,'refresh-2');
  assert.deepEqual(h.store.read().accounts.map(value=>value.email),['me@example.com']);
  assert.ok(!JSON.stringify(h.store.read()).includes('cancelled@example.com'));
  h.service.cancelConnect();
  assert.equal(h.values.size,1);assert.equal(h.store.read().accounts[0].connected,true);
});

test('invalid login hints fail before opening a browser or making a request',async t=>{
  let launches=0;
  const h=context(t,{accounts:[],openExternal:async()=>{launches++;}});
  for(const loginHint of [null,42,{},'not-an-email','<me@example.com>','me@example.com\r\nextra','x'.repeat(255)+'@example.com']) {
    await assert.rejects(h.service.connect({clientId:'desktop-client',loginHint}),{code:'INVALID_LOGIN_HINT'});
  }
  assert.equal(launches,0);assert.equal(h.calls.length,0);assert.equal(h.service.connecting,false);
});

test('first sync pages the chosen range and drafts, commits the pre-scan cursor, and preserves other sources',async t=>{
  const h=context(t,{messages:[cached('gone',{done:true}),{id:'local:one',accountId:'local',body:'local'}],handler:call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/labels'))return response({labels:[{id:'Label_A',name:'工作'}]});
    if(pathname.endsWith('/profile'))return response({historyId:'100'});
    if(pathname.endsWith('/messages')) {
      assert.equal(call.url.searchParams.get('q'),'newer_than:30d');
      return call.url.searchParams.get('pageToken')?response({messages:[{id:'m2'}]}):response({messages:[{id:'m1'}],nextPageToken:'page-2'});
    }
    if(pathname.endsWith('/drafts'))return response({drafts:[{id:'d1',message:{id:'draft-message'}}]});
    if(pathname.endsWith('/messages/gone'))return response({},404);
    if(pathname.endsWith('/messages/draft-message'))return response(raw('draft-message',['DRAFT']));
    if(pathname.includes('/messages/'))return response(raw(pathname.split('/').at(-1),['INBOX','Label_A']));
    throw new Error('Unexpected '+pathname);
  }});
  const summary=await h.service.sync(accountId),state=h.store.read();
  assert.deepEqual({added:summary.added,removed:summary.removed,total:summary.total},{added:3,removed:1,total:3});
  assert.equal(state.accounts[0].historyId,'100');assert.equal(state.accounts[0].syncStatus,'success');
  assert.ok(state.messages.some(m=>m.id==='local:one'));
  assert.equal(state.messages.find(m=>m.remoteId==='draft-message').draftId,'d1');
  assert.deepEqual(state.messages.find(m=>m.remoteId==='m1').labels,['工作']);
  assert.ok(h.calls.findIndex(call=>call.url.pathname.endsWith('/profile'))<h.calls.findIndex(call=>call.url.pathname.endsWith('/messages')));
  assert.equal(h.calls.filter(call=>call.url.pathname.endsWith('/messages')).length,2);
  assert.ok(!h.calls.some(call=>call.url.pathname.endsWith('/send')));
});

test('incremental history deduplicates changes, removes deleted messages and keeps local manual state',async t=>{
  const connected=account();connected.historyId='100';connected.lastSyncAt='2026-01-01T00:00:00Z';
  const h=context(t,{accounts:[connected],messages:[cached('m1',{done:true}),cached('gone')],handler:call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/labels'))return response({labels:[]});
    if(pathname.endsWith('/history')) {
      assert.equal(call.url.searchParams.get('startHistoryId'),'100');
      return call.url.searchParams.get('pageToken')?response({historyId:'170',history:[{messagesDeleted:[{message:{id:'gone'}}]}]}):
        response({historyId:'160',nextPageToken:'page2',history:[{messagesAdded:[{message:{id:'m1'}}],labelsAdded:[{message:{id:'m1'}}]}]});
    }
    if(pathname.endsWith('/drafts'))return response({});
    if(pathname.endsWith('/messages/gone'))return response({},404);
    if(pathname.endsWith('/messages/m1'))return response(raw('m1',['INBOX','STARRED'],'new body'));
    throw new Error('Unexpected '+pathname);
  }});
  const result=await h.service.sync(accountId),mail=h.store.read().messages[0];
  assert.equal(result.removed,1);assert.equal(mail.body,'new body');assert.equal(mail.done,true);
  assert.equal(mail.star,true);assert.equal(mail.read,true);assert.equal(h.store.read().accounts[0].historyId,'170');
  assert.equal(h.calls.filter(call=>call.url.pathname.endsWith('/messages/m1')).length,1);
});

test('expired history performs full fallback; failed sync retains all prior mail and its cursor',async t=>{
  let fail=false;
  const connected=account();connected.historyId='100';
  const h=context(t,{accounts:[connected],messages:[cached('m1',{done:true})],handler:call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/labels'))return response({labels:[]});
    if(pathname.endsWith('/history'))return fail?response({historyId:'300',history:[{messagesAdded:[{message:{id:'m2'}},{message:{id:'m3'}}]}]}):response({},404);
    if(pathname.endsWith('/profile'))return response({historyId:'250'});
    if(pathname.endsWith('/messages'))return response({messages:[{id:'m2'}]});
    if(pathname.endsWith('/drafts'))return response({});
    if(pathname.endsWith('/messages/m3'))return response({},503);
    if(pathname.includes('/messages/'))return response(raw(pathname.split('/').at(-1),['INBOX'],fail?'should not commit':'initial'));
    throw new Error('Unexpected '+pathname);
  }});
  await h.service.sync(accountId);assert.equal(h.store.read().accounts[0].historyId,'250');
  assert.equal(h.store.read().messages.find(m=>m.remoteId==='m1').done,true);
  const before=h.store.read().messages;fail=true;
  await assert.rejects(h.service.sync(accountId),/HTTP 503/);
  const after=h.store.read();assert.deepEqual(after.messages,before);assert.equal(after.accounts[0].historyId,'250');
  assert.equal(after.accounts[0].syncStatus,'error');assert.equal(after.logs[0].status,'error');
});

test('401 refreshes once then retries; persistent authorization failure marks account for reconnect',async t=>{
  let requests=0,persistent=false;
  const h=context(t,{handler:call=>{
    assert.ok(call.url.pathname.endsWith('/labels'));requests++;
    if(persistent||requests===1)return response({},401);
    assert.equal(call.headers.Authorization,'Bearer access-1');return response({labels:[]});
  }});
  h.service.tokens.set(accountId,{accessToken:'stale',expiresAt:Date.now()+3600000});
  await h.service.listLabels(accountId);
  assert.equal(requests,2);assert.equal(h.tokenCount(),1);
  persistent=true;
  await assert.rejects(h.service.listLabels(accountId),error=>error.status===401);
  assert.equal(requests,4);assert.equal(h.tokenCount(),2);
  assert.equal(h.store.read().accounts[0].connected,false);
  assert.equal(h.store.read().accounts[0].status,'reauth-required');
});

test('mail modifications persist only confirmed results and report individual failures',async t=>{
  const h=context(t,{messages:[cached('m1'),cached('m2')],handler:call=>{
    if(call.url.pathname.endsWith('/messages/m1/modify'))return response({id:'m1',labelIds:['INBOX','STARRED']});
    if(call.url.pathname.endsWith('/messages/m2/modify'))return response({error:{message:'provider secret should not leak'}},403);
    if(call.url.pathname.endsWith('/messages/m1/trash'))return response({id:'m1',labelIds:['TRASH']});
    throw new Error('Unexpected '+call.url);
  }});
  const result=await h.service.modify(accountId,['m1','m2'],{addLabelIds:['STARRED'],removeLabelIds:['UNREAD']});
  assert.deepEqual(result.succeeded,['m1']);assert.equal(result.failed[0].id,'m2');
  assert.equal(h.store.read().messages[0].star,true);assert.equal(h.store.read().messages[1].star,false);
  assert.ok(!JSON.stringify(h.store.read()).includes('provider secret'));
  await h.service.modify(accountId,['m1'],{addLabelIds:['TRASH']});
  assert.equal(h.store.read().messages[0].folder,'trash');
  assert.ok(h.calls.some(call=>call.url.pathname.endsWith('/trash')));
});

test('draft create and replacement preserve remote draft identity, and failed delete keeps the draft',async t=>{
  let generation=0,failDelete=true;
  const h=context(t,{handler:async call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/drafts')&&call.method==='POST'||pathname.endsWith('/drafts/d1')&&call.method==='PUT') {
      generation++;const request=JSON.parse(call.body);const parsed=await parseEml(Buffer.from(request.message.raw,'base64url'));
      assert.equal(parsed.subject,generation===1?'First':'Updated');
      return response({id:'d1',message:{id:'draft-'+generation}});
    }
    if(pathname.includes('/messages/draft-'))return response(raw(pathname.split('/').at(-1),['DRAFT']));
    if(pathname.endsWith('/drafts/d1')&&call.method==='DELETE')return response({},failDelete?503:204);
    throw new Error('Unexpected '+pathname);
  }});
  const first=await h.service.saveDraft(accountId,{to:'you@example.com',subject:'First',body:'one'});
  const second=await h.service.saveDraft(accountId,{draftId:first.draftId,to:'you@example.com',subject:'Updated',body:'two'});
  assert.equal(second.draftId,'d1');assert.equal(h.store.read().messages.length,1);
  assert.equal(h.store.read().messages[0].remoteId,'draft-2');
  await assert.rejects(h.service.deleteDraft(accountId,'d1'),/503/);assert.equal(h.store.read().messages.length,1);
  failDelete=false;await h.service.deleteDraft(accountId,'d1');assert.deepEqual(h.store.read().messages,[]);
  assert.ok(!h.calls.some(call=>call.url.pathname.endsWith('/send')));
});

test('moving back to inbox untrashes only a message that is actually in Trash',async t=>{
  let trashed=false,untrashCalls=0;
  const h=context(t,{messages:[cached('m1')],handler:call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/messages/m1')){assert.equal(call.url.searchParams.get('format'),'minimal');return response({id:'m1',labelIds:trashed?['TRASH']:[]});}
    if(pathname.endsWith('/messages/m1/untrash')){untrashCalls++;return response({id:'m1',labelIds:[]});}
    if(pathname.endsWith('/messages/m1/modify'))return response({id:'m1',labelIds:['INBOX']});
    throw new Error('Unexpected '+pathname);
  }});
  await h.service.modify(accountId,['m1'],{addLabelIds:['INBOX'],removeLabelIds:['TRASH','SPAM']});
  assert.equal(untrashCalls,0);assert.equal(h.store.read().messages[0].folder,'inbox');
  trashed=true;
  await h.service.modify(accountId,['m1'],{addLabelIds:['INBOX'],removeLabelIds:['TRASH','SPAM']});
  assert.equal(untrashCalls,1);assert.equal(h.store.read().messages[0].folder,'inbox');
});

test('a remote draft edited by another client cannot be silently overwritten, sent or deleted with an old version',async t=>{
  const local=cached('draft-old',{folder:'drafts',draftId:'d1',body:'local edits'});
  const h=context(t,{messages:[local],handler:call=>{
    assert.equal(call.method,'GET');assert.ok(call.url.pathname.endsWith('/drafts/d1'));
    assert.equal(call.url.searchParams.get('format'),'minimal');
    return response({id:'d1',message:{id:'draft-new'}});
  }});
  const input={draftId:'d1',expectedMessageId:'draft-old',to:'you@example.com',body:'local edits'};
  await assert.rejects(h.service.saveDraft(accountId,input),error=>error.code==='DRAFT_CONFLICT');
  await assert.rejects(h.service.send(accountId,input),error=>error.code==='DRAFT_CONFLICT');
  await assert.rejects(h.service.deleteDraft(accountId,'d1',{expectedMessageId:'draft-old'}),error=>error.code==='DRAFT_CONFLICT');
  assert.equal(h.store.read().messages[0].body,'local edits');
  assert.ok(!h.calls.some(call=>call.url.hostname==='gmail.googleapis.com'&&call.method!=='GET'));
});

test('sending an edited remote draft uses drafts.send, carries reply references and atomically replaces the cached draft',async t=>{
  const h=context(t,{messages:[cached('draft-old',{folder:'drafts',draftId:'d1'})],handler:async call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/drafts/d1'))return response({id:'d1',message:{id:'draft-old'}});
    if(pathname.endsWith('/drafts/send')) {
      assert.equal(call.method,'POST');
      const payload=JSON.parse(call.body);assert.equal(payload.id,'d1');assert.equal(payload.message.threadId,'original-thread');
      const parsed=await parseEml(Buffer.from(payload.message.raw,'base64url'));
      assert.equal(parsed.subject,'Re: original');assert.equal(parsed.inReplyTo,'<original@example.com>');
      assert.deepEqual(parsed.references,['<original@example.com>']);return response({id:'sent-draft',labelIds:['SENT']});
    }
    if(pathname.endsWith('/messages/sent-draft'))return response(raw('sent-draft',['SENT']));
    throw new Error('Unexpected '+pathname);
  }});
  await h.service.send(accountId,{draftId:'d1',expectedMessageId:'draft-old',to:'you@example.com',subject:'Re: original',body:'updated',
    inReplyTo:'<original@example.com>',references:['<original@example.com>'],threadId:'original-thread'});
  const messages=h.store.read().messages;
  assert.equal(messages.length,1);assert.equal(messages[0].remoteId,'sent-draft');assert.equal(messages[0].folder,'sent');
  assert.ok(!h.calls.some(call=>call.method==='DELETE'||call.url.pathname.endsWith('/messages/send')));
});

test('getDraft loads the latest remote version and attachment metadata without changing independent local edits',async t=>{
  const h=context(t,{messages:[cached('draft-old',{draftId:'d1',folder:'drafts'})],handler:call=>{
    assert.equal(call.method,'GET');
    if(call.url.pathname.endsWith('/drafts/d1')) {
      assert.equal(call.url.searchParams.get('format'),'full');
      return response({id:'d1',message:{...raw('draft-new',['DRAFT']),payload:{mimeType:'multipart/mixed',parts:[
        {mimeType:'text/plain',partId:'0',body:{attachmentId:'BODY',size:100}},
        {mimeType:'application/pdf',filename:'review.pdf',partId:'1',body:{attachmentId:'PDF',size:512}}]}}});
    }
    if(call.url.pathname.endsWith('/messages/draft-new/attachments/BODY'))return response({data:Buffer.from('latest remote body').toString('base64url')});
    throw new Error('Unexpected '+call.url);
  }});
  h.store.update(state=>{state.drafts=[{id:'local-draft',remoteDraftId:'d1',body:'independent unsaved edits'}];});
  const latest=await h.service.getDraft(accountId,'d1');
  assert.equal(latest.remoteId,'draft-new');assert.equal(latest.draftId,'d1');assert.equal(latest.body,'latest remote body');
  assert.equal(latest.attachments[0].attachmentId,'PDF');
  assert.equal(h.store.read().messages.length,1);assert.equal(h.store.read().messages[0].remoteId,'draft-new');
  assert.equal(h.store.read().drafts[0].body,'independent unsaved edits');
  assert.ok(h.calls.filter(call=>call.url.hostname==='gmail.googleapis.com').every(call=>call.method==='GET'));
});

test('successful send survives a failed follow-up read and preserves Bcc; network ambiguity never retries',async t=>{
  let uncertain=false,sends=0;
  const h=context(t,{handler:async call=>{
    if(call.url.pathname.endsWith('/messages/send')) {
      sends++;if(uncertain)throw new Error('connection reset');
      const mime=Buffer.from(JSON.parse(call.body).raw,'base64url'),parsed=await parseEml(mime);
      assert.equal(parsed.bcc,'private@example.com');return response({id:'sent-1',threadId:'t-sent',labelIds:['SENT']});
    }
    if(call.url.pathname.endsWith('/messages/sent-1'))return response({},503);
    throw new Error('Unexpected '+call.url);
  }});
  assert.equal(sends,0);
  const sent=await h.service.send(accountId,{to:'you@example.com',bcc:'private@example.com',subject:'Real subject',body:'Literal body'});
  assert.equal(sends,1);assert.equal(sent.folder,'sent');assert.equal(sent.subject,'Real subject');
  assert.equal(sent.syncPending,true);assert.equal(h.store.read().messages.length,1);assert.equal(h.store.read().logs[0].text,'Gmail 郵件已寄出');
  uncertain=true;
  await assert.rejects(h.service.send(accountId,{to:'you@example.com',subject:'Second',body:'Do not retry'}),error=>error.code==='SEND_UNCERTAIN');
  assert.equal(sends,2);assert.equal(h.store.read().messages.length,1);
});

test('attachment downloads decode exact bytes and retrieve inline parts without a separate attachment ID',async t=>{
  const expected=Buffer.from([0,255,128,10]);
  const h=context(t,{handler:call=>{
    if(call.url.pathname.endsWith('/attachments/A1'))return response({data:expected.toString('base64url')});
    if(call.url.pathname.endsWith('/messages/m1'))return response({id:'m1',payload:{partId:'',parts:[{partId:'1',body:{data:expected.toString('base64url')}}]}});
    throw new Error('Unexpected '+call.url);
  }});
  assert.deepEqual(await h.service.downloadAttachment(accountId,'m1','A1'),expected);
  assert.deepEqual(await h.service.downloadAttachment(accountId,'m1','part:1'),expected);
});

test('server-side send ambiguity is not retried; confirmed delivery with a disk failure is explicitly distinguished',async t=>{
  let sends=0;
  const ambiguous=context(t,{handler:call=>{
    if(call.url.pathname.endsWith('/messages/send')){sends++;return response({},500);}
    throw new Error('Unexpected '+call.url);
  }});
  await assert.rejects(ambiguous.service.send(accountId,{to:'you@example.com',body:'one'}),error=>error.code==='SEND_UNCERTAIN');
  assert.equal(sends,1);
  const confirmed=context(t,{handler:call=>{
    if(call.url.pathname.endsWith('/messages/send'))return response({id:'sent-2',labelIds:['SENT']});
    if(call.url.pathname.endsWith('/messages/sent-2'))return response(raw('sent-2',['SENT']));
    throw new Error('Unexpected '+call.url);
  }});
  confirmed.store.update=()=>{throw new Error('disk full');};
  await assert.rejects(confirmed.service.send(accountId,{to:'you@example.com',body:'two'}),error=>error.code==='SEND_CONFIRMED_LOCAL_ERROR'&&error.message.includes('不要重寄'));
  assert.deepEqual(confirmed.store.read().messages,[]);
  assert.equal(confirmed.calls.filter(call=>call.url.pathname.endsWith('/send')).length,1);
});

test('attachments from a confirmed send recover their IDs on demand when the initial read failed',async t=>{
  let healthy=false;
  const bytes=Buffer.from('original attachment');
  const h=context(t,{handler:call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/messages/send'))return response({id:'sent-file',labelIds:['SENT']});
    if(pathname.endsWith('/attachments/A1'))return response({data:bytes.toString('base64url')});
    if(pathname.endsWith('/messages/sent-file'))return healthy?response({id:'sent-file',labelIds:['SENT'],payload:{mimeType:'multipart/mixed',parts:[
      {partId:'0',mimeType:'text/plain',body:{data:Buffer.from('body').toString('base64url')}},
      {partId:'1',filename:'notes.txt',mimeType:'text/plain',body:{attachmentId:'A1',size:bytes.length}}]}}):response({},503);
    throw new Error('Unexpected '+pathname);
  }});
  const sent=await h.service.send(accountId,{to:'you@example.com',body:'body',attachments:[{name:'notes.txt',mimeType:'text/plain',content:bytes}]});
  assert.equal(sent.attachments[0].attachmentId,'pending:0');healthy=true;
  assert.deepEqual(await h.service.downloadAttachment(accountId,'sent-file','pending:0'),bytes);
  assert.equal(h.store.read().messages[0].syncPending,false);
  assert.equal(h.store.read().messages[0].attachments[0].attachmentId,'A1');
});

test('disconnect preserves cached mail, erases credentials and blocks further requests; failed revocation does not claim success',async t=>{
  const h=context(t,{messages:[cached('m1')],handler:call=>{
    assert.equal(call.url.href,'https://oauth2.googleapis.com/revoke');return response({},503);
  }});
  await assert.rejects(h.service.disconnect(accountId,{revoke:true}),/503/);
  assert.equal(h.store.read().accounts[0].connected,true);assert.ok(h.values.size);
  await h.service.disconnect(accountId);
  assert.equal(h.values.size,0);assert.equal(h.store.read().messages.length,1);assert.equal(h.store.read().accounts[0].connected,false);
  const requestCount=h.calls.length;
  await assert.rejects(h.service.sync(accountId),error=>error.code==='AUTH_REQUIRED');
  assert.equal(h.calls.length,requestCount);
});

test('sync and user mutations on the same account serialize so stale sync data cannot undo a star action',async t=>{
  let release,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const h=context(t,{messages:[cached('m1')],handler:async call=>{
    const pathname=call.url.pathname;
    if(pathname.endsWith('/labels'))return response({labels:[]});
    if(pathname.endsWith('/profile'))return response({historyId:'100'});
    if(pathname.endsWith('/messages'))return response({messages:[{id:'m1'}]});
    if(pathname.endsWith('/drafts'))return response({});
    if(pathname.endsWith('/messages/m1')){entered();await gate;return response(raw('m1',['INBOX']));}
    if(pathname.endsWith('/messages/m1/modify'))return response({id:'m1',labelIds:['INBOX','STARRED']});
    throw new Error('Unexpected '+pathname);
  }});
  const syncing=h.service.sync(accountId);await ready;
  const modifying=h.service.modify(accountId,['m1'],{addLabelIds:['STARRED']});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(!h.calls.some(call=>call.url.pathname.endsWith('/modify')));
  release();await syncing;await modifying;
  assert.equal(h.store.read().messages[0].star,true);
});

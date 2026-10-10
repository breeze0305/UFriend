'use strict';

const http = require('node:http');
const {randomBytes,createHash,timingSafeEqual} = require('node:crypto');
const {buildMime,parseEml,decodeGmailMessage,applyGmailLabels,validateRecipients,normalizeContentId} = require('./mail-util.cjs');
const {GmailReadGate} = require('./gmail-read-gate.cjs');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
// WHATWG Fetch §2.9 (verified 2026-09-13): loopback HTTP has no bad-port exception.
// https://fetch.spec.whatwg.org/#port-blocking
const OAUTH_BAD_PORTS = new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

// Provider text can contain account, project, URL or message details. Only these
// fixed reason/status values and our own operation labels may reach the UI/log.
const GOOGLE_ERROR_ADVICE = Object.freeze({
  insufficientPermissions:'Google 未授予完整的 Gmail 權限，請重新連接並同意郵件讀取、草稿、寄送與管理權限。',
  ACCESS_TOKEN_SCOPE_INSUFFICIENT:'Google 未授予完整的 Gmail 權限，請重新連接並同意郵件讀取、草稿、寄送與管理權限。',
  accessNotConfigured:'此應用程式的 Google Cloud 專案尚未啟用 Gmail API，請由開發者啟用後再同步。',
  SERVICE_DISABLED:'此應用程式的 Google Cloud 專案尚未啟用 Gmail API，請由開發者啟用後再同步。',
  domainPolicy:'此帳號的 Google Workspace 政策禁止此操作，請聯絡網域管理員允許 UFriend 存取 Gmail。',
  rateLimitExceeded:'Gmail API 請求達到速率限制，請稍後再同步。',
  userRateLimitExceeded:'此帳號的 Gmail API 請求達到速率限制，請稍後再同步。',
  dailyLimitExceeded:'此應用程式的 Gmail API 每日配額已用盡，請由開發者檢查配額，或待配額重設後再同步。',
  RESOURCE_EXHAUSTED:'Gmail API 可用配額或速率已達限制，請稍後再同步；若持續發生，請由開發者檢查配額。',
});
const GOOGLE_ERROR_STATUSES = new Set(['PERMISSION_DENIED','RESOURCE_EXHAUSTED','UNAUTHENTICATED','FAILED_PRECONDITION']);
const API_OPERATIONS = Object.freeze({
  'labels.list':'讀取 Gmail 標籤',
  'profile.get':'讀取 Gmail 帳號資料',
  'messages.list':'列出 Gmail 郵件',
  'drafts.list':'列出 Gmail 草稿',
  'history.list':'讀取 Gmail 郵件異動',
  'messages.get':'讀取 Gmail 郵件內容',
  'attachments.get':'讀取 Gmail 郵件內文或附件',
});
function googleErrorDetails(data) {
  const error=data?.error;
  if(!error||typeof error!=='object'||Array.isArray(error))return{reason:'',providerStatus:''};
  const providerStatus=GOOGLE_ERROR_STATUSES.has(error.status)?error.status:'';
  const reasons=[...(Array.isArray(error.errors)?error.errors.map(item=>item?.reason):[]),
    ...(Array.isArray(error.details)?error.details.filter(item=>item?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo').map(item=>item.reason):[])];
  const reason=reasons.find(value=>typeof value==='string'&&Object.hasOwn(GOOGLE_ERROR_ADVICE,value))
    ||(providerStatus==='RESOURCE_EXHAUSTED'?'RESOURCE_EXHAUSTED':'');
  return{reason,providerStatus};
}
function apiOperation(path,method) {
  if(method!=='GET')return'';
  const collection={labels:'labels.list',profile:'profile.get',messages:'messages.list',drafts:'drafts.list',history:'history.list'};
  if(Object.hasOwn(collection,path))return collection[path];
  if(/^messages\/[^/]+\/attachments\/[^/]+$/.test(path))return'attachments.get';
  if(/^messages\/[^/]+$/.test(path))return'messages.get';
  return'';
}

class GmailError extends Error {
  constructor(message,{status=0,code='GMAIL_ERROR',reason='',providerStatus='',operation='',retryAfterMs=0}={}) {
    super(message);this.name='GmailError';this.status=status;this.code=code;
    this.reason=reason;this.providerStatus=providerStatus;this.operation=operation;this.retryAfterMs=retryAfterMs;
  }
}
const keyFor = accountId => 'gmail:'+accountId;
const idPart = value => {
  if (typeof value!=='string' || !value || value.length>2048) throw new GmailError('郵件識別碼格式錯誤');
  return encodeURIComponent(value);
};
const daysValue = value => {
  const days=Number(value);
  if (!Number.isInteger(days)||days<0||days>3650) throw new GmailError('首次同步範圍須為 0 至 3650 天；0 代表全部');
  return days;
};

function mergeAttachmentPresentation(current=[],incoming=[]){
  const existing=Array.isArray(current)?current:[],fresh=Array.isArray(incoming)?incoming:[],used=new Set();
  const merged=existing.map((attachment,index)=>{
    let position=fresh.findIndex((item,at)=>!used.has(at)&&attachment.attachmentId&&item.attachmentId===attachment.attachmentId);
    const cid=normalizeContentId(attachment.contentId);
    if(position<0&&cid)position=fresh.findIndex((item,at)=>!used.has(at)&&normalizeContentId(item.contentId)===cid);
    if(position<0&&!used.has(index)&&fresh[index]?.name===attachment.name&&fresh[index]?.mimeType===attachment.mimeType&&fresh[index]?.size===attachment.size)position=index;
    if(position<0)return attachment;
    used.add(position);const next={...attachment},source=fresh[position];
    for(const key of ['contentId','contentDisposition','inline'])if(next[key]===undefined||next[key]===null||next[key]==='')next[key]=source[key];
    if(next.contentId)next.contentId=normalizeContentId(next.contentId);
    // Confirmed sends may still hold a temporary local attachment reference.
    if(/^(?:pending|local):/.test(next.attachmentId||'')&&source.attachmentId)next.attachmentId=source.attachmentId;
    return next;
  });
  for(let index=0;index<fresh.length;index++)if(!used.has(index))merged.push(fresh[index]);
  return merged;
}

class GmailService {
  constructor({store,vault,openExternal,fetchImpl=globalThis.fetch,onChange=()=>{},onAuthStatus=()=>{},oauthTimeoutMs=180000,requestTimeoutMs=30000,
    readGate=new GmailReadGate(),retrySleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),retryRandom=Math.random}={}) {
    if (!store || !vault || !['get','set','delete'].every(name=>typeof vault[name]==='function')) throw new TypeError('GmailService requires store and vault');
    if (typeof openExternal!=='function' || typeof fetchImpl!=='function') throw new TypeError('GmailService requires openExternal and fetch');
    if(typeof readGate?.wait!=='function'||typeof retrySleep!=='function'||typeof retryRandom!=='function')throw new TypeError('GmailService requires a read gate and retry timing functions');
    Object.assign(this,{store,vault,openExternal,fetchImpl,onChange,onAuthStatus,oauthTimeoutMs,requestTimeoutMs,readGate,retrySleep,retryRandom});
    this.tokens=new Map();this.refreshes=new Map();this.locks=new Map();this.contentLoads=new Map();this.oauthCancel=null;this.connecting=false;this.connectAttempt=null;
  }

  _changed() { try { this.onChange(); } catch { /* Rendering must not turn a confirmed Gmail action into a failed one. */ } }
  _authStatus(status) { try { Promise.resolve(this.onAuthStatus(status)).catch(()=>{}); } catch { /* Progress observers must not break authorization. */ } }
  _log(text,detail='',status='success') { this.store.appendLog(text,detail,status);this._changed(); }
  _account(id,requireConnected=true) {
    const account=this.store.read().accounts.find(a=>a.id===id&&a.provider==='gmail');
    if (!account) throw new GmailError('找不到 Gmail 帳號');
    if (requireConnected&&!account.connected) throw new GmailError('此帳號需要重新連接',{code:'AUTH_REQUIRED'});
    return account;
  }
  listAccounts() { return this.store.read().accounts.filter(a=>a.provider==='gmail'); }
  _patchAccount(id,patch) { this.store.update(state=>{const account=state.accounts.find(a=>a.id===id);if(account)Object.assign(account,patch);});this._changed(); }
  _lock(id,work) {
    const previous=this.locks.get(id)||Promise.resolve();
    const current=previous.catch(()=>{}).then(work);
    this.locks.set(id,current);
    return current.finally(()=>{if(this.locks.get(id)===current)this.locks.delete(id);});
  }

  async _http(url,options={},operation='') {
    operation=Object.hasOwn(API_OPERATIONS,operation)?operation:'';
    const describe=message=>operation?API_OPERATIONS[operation]+'失敗：'+message:message;
    let response;
    try { response=await this.fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(this.requestTimeoutMs)}); }
    catch { throw new GmailError(describe('無法連線至 Gmail，請檢查網路後再試'),{code:'NETWORK_ERROR',operation}); }
    let data={},body;
    try { body=await response.text(); }
    catch {
      // Receiving headers does not mean the response body arrived. In
      // particular, a write may have succeeded remotely before the read failed.
      if(response.ok)throw new GmailError(describe('Gmail 回應未完整接收，請先同步並確認結果'),{code:'NETWORK_ERROR',operation});
    }
    if(body?.trim()) {
      try { data=JSON.parse(body); }
      catch {
        if(response.ok)throw new GmailError(describe('Gmail 回應格式不完整，請先同步並確認結果'),{code:'GMAIL_INVALID_RESPONSE',operation});
      }
      if(response.ok&&(!data||typeof data!=='object'||Array.isArray(data)))throw new GmailError(describe('Gmail 回應格式不完整，請先同步並確認結果'),{code:'GMAIL_INVALID_RESPONSE',operation});
    } else if(response.ok&&options.method!=='DELETE'&&url!==REVOKE_URL) {
      // Only these operations have a documented empty success body. Treating
      // an empty list/history response as {} would silently skip remote mail.
      throw new GmailError(describe('Gmail 回應內容為空，請先同步並確認結果'),{code:'GMAIL_INVALID_RESPONSE',operation});
    }
    if (!response.ok) {
      const providerCode=typeof data?.error==='string'?data.error:'';
      const messages={401:'Gmail 授權已失效，請重新連接',403:'Gmail 拒絕此操作，Google 未提供可辨識的原因，請稍後再同步；若持續發生，請聯絡開發者。',404:'Gmail 找不到這筆資料',429:'Gmail 請求過於頻繁，請稍後再試'};
      const code=providerCode==='invalid_grant'?'AUTH_REQUIRED':providerCode==='access_denied'?'AUTH_DENIED':'HTTP_'+response.status;
      const details=googleErrorDetails(data);
      const retryAfter=response.headers?.get?.('retry-after')||'';
      const retrySeconds=/^\d+(?:\.\d+)?$/.test(retryAfter)?Number(retryAfter):0;
      const retryAfterMs=retrySeconds>0&&retrySeconds<=60?Math.ceil(retrySeconds*1000):0;
      const message=code==='AUTH_REQUIRED'?'Gmail 授權已失效，請重新連接'
        :GOOGLE_ERROR_ADVICE[details.reason]||messages[response.status]||'Gmail 操作失敗（HTTP '+response.status+'）';
      throw new GmailError(describe(message),{status:response.status,code,...details,operation,retryAfterMs});
    }
    return data;
  }
  _postToken(values) { return this._http(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values).toString()}); }

  _authorize(clientId,loginHint,attempt) {
    return new Promise((resolve,reject)=>{
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
      const challenge=createHash('sha256').update(verifier).digest('base64url');
      let timer,finished=false,redirectUri,listenAttempts=0;
      const finish=(error,result)=>{
        if(finished)return;finished=true;clearTimeout(timer);
        if(this.oauthCancel===cancel)this.oauthCancel=null;
        if(attempt?.authorizeCancel===cancel)attempt.authorizeCancel=null;
        server.close(()=>{});server.closeAllConnections?.();
        error?reject(error):resolve(result);
      };
      const server=http.createServer((request,response)=>{
        let url;
        try { url=new URL(request.url,redirectUri); } catch { response.writeHead(400).end();return; }
        if(request.method!=='GET'||url.pathname!=='/oauth2callback'){response.writeHead(404).end();return;}
        const received=Buffer.from(url.searchParams.get('state')||''),expected=Buffer.from(state);
        if(received.length!==expected.length||!timingSafeEqual(received,expected)) {
          response.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end('授權狀態不符，請返回 UFriend 重新連接。');return;
        }
        const error=url.searchParams.get('error'),code=url.searchParams.get('code');
        response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'","Connection":"close"});
        response.end(error?'授權未完成，可以關閉此頁並返回 UFriend。':'已收到授權回應，可以關閉此頁並返回 UFriend。',()=>{
          if(error)finish(new GmailError('Google 授權已取消或遭拒絕',{code:'AUTH_DENIED'}));
          else if(!code||code.length>4096)finish(new GmailError('Google 未回傳有效的授權碼'));
          else finish(null,{code,verifier,redirectUri});
        });
      });
      server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
      server.on('error',()=>finish(new GmailError('無法啟動本機授權接收器，請稍後重試')));
      const cancel=()=>finish(new GmailError('已取消 Gmail 連接',{code:'AUTH_CANCELLED'}));
      this.oauthCancel=cancel;if(attempt)attempt.authorizeCancel=cancel;
      const listen=()=>{
        if(finished||attempt?.cancelled)return;
        if(++listenAttempts>16){finish(new GmailError('無法取得瀏覽器可用的本機授權埠，請稍後重試',{code:'AUTH_PORT_UNAVAILABLE'}));return;}
        server.listen(0,'127.0.0.1',async()=>{
          if(finished||attempt?.cancelled){server.close(()=>{});return;}
          const port=server.address().port;
          if(OAUTH_BAD_PORTS.has(port)){
            server.close(()=>{if(!finished&&!attempt?.cancelled)listen();});return;
          }
          redirectUri='http://127.0.0.1:'+port+'/oauth2callback';
          const url=new URL(AUTH_URL);
          url.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:SCOPE,
            access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256',...(loginHint?{login_hint:loginHint}:{})}).toString();
          try { await this.openExternal(url.toString());if(!finished&&!attempt?.cancelled)this._authStatus('waiting'); }
          catch { finish(new GmailError('無法開啟系統瀏覽器')); }
        });
      };
      // One deadline covers allocation and authorization; rebinding never extends it.
      timer=setTimeout(()=>finish(new GmailError('Gmail 授權逾時，請重新連接',{code:'AUTH_TIMEOUT'})),this.oauthTimeoutMs);
      listen();
    });
  }

  cancelConnect() {
    const attempt=this.connectAttempt;
    if(!attempt){this.oauthCancel?.();return;}
    // Once local persistence starts, finish or roll back the short transaction.
    // Cancelling it halfway could leave credentials and the account out of sync.
    if(attempt.committing)return;
    attempt.cancelled=true;attempt.authorizeCancel?.();attempt.cancel();
    if(this.connectAttempt===attempt){this.connectAttempt=null;this.connecting=false;}
  }
  async connect({clientId,clientSecret='',days=30,loginHint}={}) {
    if(this.connecting)throw new GmailError('已有 Gmail 授權進行中');
    if(typeof clientId!=='string'||!clientId.trim()||/[\s\r\n]/.test(clientId))throw new GmailError('請輸入 Google Desktop OAuth Client ID');
    if(typeof clientSecret!=='string'||/[\r\n]/.test(clientSecret))throw new GmailError('Client Secret 格式錯誤');
    if(loginHint!==undefined) {
      if(typeof loginHint!=='string')throw new GmailError('重新連接的電子郵件地址格式錯誤',{code:'INVALID_LOGIN_HINT'});
      loginHint=loginHint.trim();
      if(loginHint&&(loginHint.length>254||!/^[^\s@<>(),;:"\\\x00-\x1f\x7f]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(loginHint)))throw new GmailError('重新連接的電子郵件地址格式錯誤',{code:'INVALID_LOGIN_HINT'});
    }
    days=daysValue(days);this.connecting=true;
    const attempt={cancelled:false,committing:false,authorizeCancel:null};
    const cancellation=new Promise((_,reject)=>{attempt.cancel=()=>reject(new GmailError('已取消 Gmail 連接',{code:'AUTH_CANCELLED'}));});
    cancellation.catch(()=>{});
    this.connectAttempt=attempt;
    const check=()=>{if(attempt.cancelled)throw new GmailError('已取消 Gmail 連接',{code:'AUTH_CANCELLED'});};
    const wait=async work=>{check();const result=await Promise.race([work(),cancellation]);check();return result;};
    try {
      const authorization=await wait(()=>this._authorize(clientId,loginHint,attempt));
      this._authStatus('completing');
      const values={client_id:clientId,grant_type:'authorization_code',code:authorization.code,
        code_verifier:authorization.verifier,redirect_uri:authorization.redirectUri};
      if(clientSecret)values.client_secret=clientSecret;
      const token=await wait(()=>this._postToken(values));
      if(!token.access_token)throw new GmailError('Google 未回傳可用的授權');
      if(token.scope&&!token.scope.split(/\s+/).includes(SCOPE))throw new GmailError('未取得郵件讀取、草稿、寄送與管理權限，請重新授權',{code:'INSUFFICIENT_SCOPE'});
      const profile=await wait(()=>this._http(API+'/profile',{headers:{Authorization:'Bearer '+token.access_token}}));
      if(typeof profile.emailAddress!=='string'||!profile.emailAddress.includes('@'))throw new GmailError('無法取得 Gmail 帳號資料');
      const id='gmail:'+profile.emailAddress.toLowerCase();
      const previous=this.store.read().accounts.find(a=>a.id===id);
      const oldCredentials=await wait(()=>this.vault.get(keyFor(id)));
      const credentials={clientId,clientSecret,refreshToken:token.refresh_token||(oldCredentials?.clientId===clientId?oldCredentials.refreshToken:null)};
      if(!credentials.refreshToken)throw new GmailError('Google 未提供離線授權，請重新連接並同意存取');
      check();attempt.committing=true;
      await this.vault.set(keyFor(id),credentials);
      const account={...previous,id,provider:'gmail',source:'Gmail',email:profile.emailAddress,connected:true,status:'connected',
        initialDays:previous?.initialDays??days,historyId:previous?.historyId||null,lastSyncAt:previous?.lastSyncAt||null,
        syncStatus:previous?.lastSyncAt?'success':'idle',error:null,labels:previous?.labels||[]};
      try { this.store.update(state=>{state.accounts=state.accounts.filter(a=>a.id!==id);state.accounts.push(account);}); }
      catch(error) { if(oldCredentials)await this.vault.set(keyFor(id),oldCredentials);else await this.vault.delete(keyFor(id));throw error; }
      this.tokens.set(id,{accessToken:token.access_token,expiresAt:Date.now()+(Number(token.expires_in)||3600)*1000});
      this._log('Gmail 帳號已連接',account.email);
      return account;
    } finally { if(this.connectAttempt===attempt){this.connectAttempt=null;this.connecting=false;} }
  }

  disconnect(id,{revoke=false,removeLocal=false}={}) {
    return this._lock(id,async()=>{
      const account=this._account(id,false),credentials=await this.vault.get(keyFor(id));
      if(revoke&&credentials?.refreshToken)await this._http(REVOKE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:credentials.refreshToken}).toString()});
      await this.vault.delete(keyFor(id));this.tokens.delete(id);
      this.store.update(state=>{
        const target=state.accounts.find(a=>a.id===id);Object.assign(target,{connected:false,status:'disconnected',error:null});
        if(removeLocal)state.messages=state.messages.filter(message=>message.accountId!==id);
      });
      this._log('Gmail 帳號已中斷連接',account.email);
      return this._account(id,false);
    });
  }

  async _accessToken(id,force=false) {
    this._account(id);
    const cached=this.tokens.get(id);
    if(!force&&cached?.expiresAt>Date.now()+60000)return cached.accessToken;
    if(this.refreshes.has(id))return this.refreshes.get(id);
    const refresh=(async()=>{
      const credentials=await this.vault.get(keyFor(id));
      if(!credentials?.refreshToken||!credentials.clientId)throw new GmailError('此帳號需要重新連接',{code:'AUTH_REQUIRED'});
      const values={client_id:credentials.clientId,refresh_token:credentials.refreshToken,grant_type:'refresh_token'};
      if(credentials.clientSecret)values.client_secret=credentials.clientSecret;
      const token=await this._postToken(values);
      if(!token.access_token)throw new GmailError('Google 未回傳可用的授權',{code:'AUTH_REQUIRED'});
      if(token.refresh_token)await this.vault.set(keyFor(id),{...credentials,refreshToken:token.refresh_token});
      this.tokens.set(id,{accessToken:token.access_token,expiresAt:Date.now()+(Number(token.expires_in)||3600)*1000});
      return token.access_token;
    })();
    this.refreshes.set(id,refresh);
    try { return await refresh; }
    catch(error) { if(error.code==='AUTH_REQUIRED'||error.status===401){this.tokens.delete(id);this._patchAccount(id,{connected:false,status:'reauth-required',error:'Gmail 授權已失效，請重新連接'});}throw error; }
    finally { this.refreshes.delete(id); }
  }

  async _api(id,path,{method='GET',body,query={}}={}) {
    const url=new URL(API+'/'+path);
    for(const [key,value] of Object.entries(query))if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));
    const run=async token=>{
      for(let retry=0;;retry++) {
        if(method==='GET')await this.readGate.wait(id);
        try {return await this._http(url.toString(),{method,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},apiOperation(path,method));}
        catch(error) {
          const permanent=['insufficientPermissions','ACCESS_TOKEN_SCOPE_INSUFFICIENT','accessNotConfigured','SERVICE_DISABLED','domainPolicy','dailyLimitExceeded'].includes(error.reason);
          const limited=error.status===429||['rateLimitExceeded','userRateLimitExceeded'].includes(error.reason);
          // Retrying sends or other writes could duplicate a confirmed operation.
          if(method!=='GET'||retry>=5||permanent||!limited)throw error;
          const delay=Math.max(error.retryAfterMs,1000*2**retry+Math.floor(Math.min(1,Math.max(0,this.retryRandom()))*250));
          // The shared gate pauses queued workers too, so they do not retry together.
          if(typeof this.readGate.defer==='function')this.readGate.defer(id,delay);
          else await this.retrySleep(delay);
        }
      }
    };
    try { return await run(await this._accessToken(id)); }
    catch(error) {
      if(error.status!==401)throw error;
      this.tokens.delete(id);
      try { return await run(await this._accessToken(id,true)); }
      catch(second) { if(second.status===401){this.tokens.delete(id);this._patchAccount(id,{connected:false,status:'reauth-required',error:'Gmail 授權已失效，請重新連接'});}throw second; }
    }
  }

  async _pages(id,path,key,query={}) {
    const result=[],seen=new Set();let pageToken;
    do {
      const page=await this._api(id,path,{query:{...query,maxResults:100,pageToken}});
      result.push(...(page[key]||[]));pageToken=page.nextPageToken;
      if(pageToken&&seen.has(pageToken))throw new GmailError('Gmail 分頁回應重複，請重新同步');
      if(pageToken)seen.add(pageToken);
    } while(pageToken);
    return result;
  }
  async _history(id,historyId) {
    const changed=new Set(),seen=new Set();let pageToken,current=historyId;
    do {
      const page=await this._api(id,'history',{query:{startHistoryId:historyId,maxResults:100,pageToken}});
      for(const history of page.history||[]) {
        for(const key of ['messagesAdded','messagesDeleted','labelsAdded','labelsRemoved'])for(const change of history[key]||[])if(change.message?.id)changed.add(change.message.id);
      }
      current=page.historyId||current;pageToken=page.nextPageToken;
      if(pageToken&&seen.has(pageToken))throw new GmailError('Gmail 歷程分頁回應重複');
      if(pageToken)seen.add(pageToken);
    } while(pageToken);
    return {ids:changed,historyId:current};
  }
  async _fullRange(id,days,cached) {
    // Capture the cursor before reading pages. Changes during this scan are replayed next time.
    const profile=await this._api(id,'profile');
    if(!profile.historyId)throw new GmailError('Gmail 未回傳同步游標');
    const list=await this._pages(id,'messages','messages',{q:days?'newer_than:'+days+'d':undefined,includeSpamTrash:true});
    return {ids:new Set([...list.map(m=>m.id),...cached.map(m=>m.remoteId).filter(Boolean)]),historyId:profile.historyId};
  }
  async _fetchMessages(id,ids,labels) {
    const messages=[],missing=[],queue=[...ids];let next=0,failure;
    await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
      while(next<queue.length&&!failure) {
        const remoteId=queue[next++];
        try { messages.push(await this._getMessage(id,remoteId,labels)); }
        catch(error) { if(error.status===404)missing.push(remoteId);else failure=error; }
      }
    }));
    if(failure)throw failure;
    return {messages,missing};
  }
  async _getMessage(id,remoteId,labels=[]) {
    const raw=await this._api(id,'messages/'+idPart(remoteId),{query:{format:'full'}});
    return this._decodeMessage(id,raw,labels);
  }
  async _decodeMessage(id,raw,labels=[]) {
    const message=await decodeGmailMessage(raw,id,labels,{loadBody:async attachmentId=>{
      const body=await this._api(id,'messages/'+idPart(raw.id)+'/attachments/'+idPart(attachmentId));
      if(typeof body.data!=='string')throw new GmailError('Gmail 郵件內文未完整載入');
      return body.data;
    }});
    return {...message,syncPending:false};
  }

  async ensureMessageContent(messageId){
    const cached=this.store.read().messages.find(message=>message.id===messageId);
    if(!cached)throw new GmailError('找不到這封郵件。',{code:'MAIL_NOT_FOUND'});
    if(cached.htmlVersion===1||cached.source!=='Gmail'||!cached.remoteId)return cached;
    if(this.contentLoads.has(messageId))return this.contentLoads.get(messageId);
    const accountId=cached.accountId,remoteId=cached.remoteId;
    const currentMessage=()=>{
      const message=this.store.read().messages.find(item=>item.id===messageId);
      if(!message||message.source!=='Gmail'||message.accountId!==accountId||message.remoteId!==remoteId)throw new GmailError('郵件已移除或帳號已變更，請重新開啟。',{code:'MAIL_CONTENT_CHANGED'});
      return message;
    };
    const loading=this._lock(accountId,async()=>{
      const current=currentMessage();if(current.htmlVersion===1)return current;
      const account=this._account(accountId);
      const fetched=await this._getMessage(accountId,remoteId,account.labels||[]);
      this._account(accountId);const latest=currentMessage();
      if(fetched.id!==messageId||fetched.accountId!==accountId||fetched.remoteId!==remoteId)throw new GmailError('Gmail 回傳的郵件識別碼不符，內文未更新。',{code:'MAIL_CONTENT_CHANGED'});
      if(latest.htmlVersion===1)return latest;
      this.store.update(state=>{
        const message=state.messages.find(item=>item.id===messageId);
        message.html=fetched.html;message.htmlVersion=1;
        message.attachments=mergeAttachmentPresentation(message.attachments,fetched.attachments);
      });
      this._changed();return currentMessage();
    });
    this.contentLoads.set(messageId,loading);
    try{return await loading;}finally{if(this.contentLoads.get(messageId)===loading)this.contentLoads.delete(messageId);}
  }

  sync(id,{full=false,days}={}) {
    return this._lock(id,async()=>{
      const account=this._account(id),range=daysValue(days??account.initialDays??30);
      const cached=this.store.read().messages.filter(message=>message.accountId===id);
      this._patchAccount(id,{syncStatus:'syncing',error:null});
      try {
        const labels=(await this._api(id,'labels')).labels||[];
        let changes;
        if(!full&&account.historyId&&(days===undefined||range===account.initialDays)) {
          try { changes=await this._history(id,account.historyId); }
          catch(error) { if(error.status!==404)throw error;changes=await this._fullRange(id,range,cached); }
        } else changes=await this._fullRange(id,range,cached);
        const drafts=await this._pages(id,'drafts','drafts');
        const draftIds=new Map(drafts.filter(d=>d.message?.id).map(d=>[d.message.id,d.id]));
        for(const remoteId of draftIds.keys())changes.ids.add(remoteId);
        const {messages,missing}=await this._fetchMessages(id,changes.ids,labels);
        const missingIds=new Set(missing),updates=new Map(messages.map(message=>[message.id,{...message,...(draftIds.has(message.remoteId)?{draftId:draftIds.get(message.remoteId)}:{draftId:null})}]));
        const oldIds=new Set(cached.map(message=>message.id));
        const added=messages.filter(message=>!oldIds.has(message.id)).length;
        const removed=cached.filter(message=>missingIds.has(message.remoteId)).length;
        this.store.update(state=>{
          state.messages=state.messages.filter(message=>message.accountId!==id||!missingIds.has(message.remoteId)).map(message=>{
            const updated=updates.get(message.id);if(updated){updates.delete(message.id);return {...message,...updated};}
            return message.accountId===id?applyGmailLabels(message,message.labelIds,labels):message;
          });
          state.messages.push(...updates.values());
          const target=state.accounts.find(a=>a.id===id);
          Object.assign(target,{historyId:changes.historyId,initialDays:range,labels,lastSyncAt:new Date().toISOString(),syncStatus:'success',status:'connected',error:null});
        });
        this._log('Gmail 同步完成',account.email+' · 新增 '+added+' 封，更新 '+(messages.length-added)+' 封');
        return {account:this._account(id),added,updated:messages.length-added,removed,total:this.store.read().messages.filter(message=>message.accountId===id).length};
      } catch(error) {
        this._patchAccount(id,{syncStatus:'error',error:error.message});
        this._log('Gmail 同步失敗',account.email+' · '+error.message,'error');
        throw error;
      }
    });
  }

  listLabels(id) {
    return this._lock(id,async()=>{
      const labels=(await this._api(id,'labels')).labels||[];
      this._patchAccount(id,{labels});return labels;
    });
  }
  createLabel(id,name) {
    return this._lock(id,async()=>{
      if(typeof name!=='string'||!name.trim()||name.length>225)throw new GmailError('標籤名稱不可為空，且最多 225 個字元');
      const label=await this._api(id,'labels',{method:'POST',body:{name:name.trim(),labelListVisibility:'labelShow',messageListVisibility:'show'}});
      const account=this._account(id);this._patchAccount(id,{labels:[...(account.labels||[]).filter(l=>l.id!==label.id),label]});
      this._log('已建立 Gmail 標籤',name.trim());return label;
    });
  }
  _storeLabels(id,raw) {
    const account=this._account(id);
    this.store.update(state=>{
      const index=state.messages.findIndex(message=>message.accountId===id&&message.remoteId===raw.id);
      if(index>=0)state.messages[index]=applyGmailLabels(state.messages[index],raw.labelIds||[],account.labels||[]);
    });
    this._changed();
    return this.store.read().messages.find(message=>message.accountId===id&&message.remoteId===raw.id);
  }

  modify(id,remoteIds,{addLabelIds=[],removeLabelIds=[]}={}) {
    return this._lock(id,async()=>{
      this._account(id);
      if(!Array.isArray(remoteIds)||!remoteIds.length||remoteIds.length>1000)throw new GmailError('請選取 1 至 1000 封郵件');
      if(!Array.isArray(addLabelIds)||!Array.isArray(removeLabelIds)||[...addLabelIds,...removeLabelIds].some(label=>typeof label!=='string'||!label||label.length>1024))throw new GmailError('標籤識別碼格式錯誤');
      if(addLabelIds.some(label=>removeLabelIds.includes(label)))throw new GmailError('不可同時加入和移除同一標籤');
      const result={succeeded:[],failed:[],messages:[]};
      for(const remoteId of new Set(remoteIds)) {
        try {
          const messagePath='messages/'+idPart(remoteId);let raw;
          if(addLabelIds.includes('TRASH')) { raw=await this._api(id,messagePath+'/trash',{method:'POST'});this._storeLabels(id,raw); }
          else if(removeLabelIds.includes('TRASH')) {
            raw=await this._api(id,messagePath,{query:{format:'minimal'}});
            if((raw.labelIds||[]).includes('TRASH'))raw=await this._api(id,messagePath+'/untrash',{method:'POST'});
            this._storeLabels(id,raw);
          }
          const add=addLabelIds.filter(label=>label!=='TRASH'),remove=removeLabelIds.filter(label=>label!=='TRASH');
          if(add.length||remove.length) { raw=await this._api(id,messagePath+'/modify',{method:'POST',body:{addLabelIds:add,removeLabelIds:remove}});this._storeLabels(id,raw); }
          if(!raw)throw new GmailError('未指定郵件操作');
          result.succeeded.push(remoteId);
          const local=this.store.read().messages.find(message=>message.accountId===id&&message.remoteId===remoteId);
          if(local)result.messages.push(local);
        } catch(error) { result.failed.push({id:remoteId,error:error.message}); }
      }
      this._log(result.failed.length?'Gmail 郵件操作部分失敗':'Gmail 郵件操作完成',
        '成功 '+result.succeeded.length+' 封，失敗 '+result.failed.length+' 封',result.failed.length?'warning':'success');
      return result;
    });
  }

  async _confirmedMessage(id,remote,mime,labelIds,draftId=null) {
    let message;
    try { message=await this._getMessage(id,remote.id,this._account(id).labels||[]); }
    catch {
      // Gmail accepted the mutation already. A failed follow-up read must not invite a duplicate send.
      const parsed=mime?await parseEml(mime,{accountId:id}):{};
      message=applyGmailLabels({...parsed,id:id+':'+remote.id,accountId:id,remoteId:remote.id,threadId:remote.threadId||remote.id,
        source:'Gmail',date:parsed.date||new Date().toISOString(),syncPending:true,
        attachments:(parsed.attachments||[]).map(({content,...attachment},index)=>({...attachment,attachmentId:'pending:'+index,pending:true}))},remote.labelIds||labelIds,this._account(id,false).labels||[]);
    }
    if(draftId)message.draftId=draftId;
    return message;
  }
  _upsertMessage(id,message,{removeDraftId}={}) {
    this.store.update(state=>{
      if(removeDraftId)state.messages=state.messages.filter(m=>m.accountId!==id||m.draftId!==removeDraftId);
      const index=state.messages.findIndex(m=>m.id===message.id);
      if(index>=0)state.messages[index]={...state.messages[index],...message};else state.messages.push(message);
    });
    this._changed();return message;
  }
  async _checkDraftVersion(id,draftId,expectedMessageId) {
    if(!draftId||!expectedMessageId)return;
    const current=await this._api(id,'drafts/'+idPart(draftId),{query:{format:'minimal'}});
    if(current.message?.id!==expectedMessageId)throw new GmailError('這份 Gmail 草稿已在其他地方修改。本機內容已保留，請先同步並核對遠端版本。',{code:'DRAFT_CONFLICT',status:409});
  }
  getDraft(id,draftId) {
    return this._lock(id,async()=>{
      const account=this._account(id);
      const draft=await this._api(id,'drafts/'+idPart(draftId),{query:{format:'full'}});
      if(!draft.message?.id)throw new GmailError('Gmail 草稿回應缺少郵件資料');
      const message={...await this._decodeMessage(id,draft.message,account.labels||[]),draftId:draft.id||draftId};
      // Only the server cache changes; independently edited local workspace drafts are untouched.
      this._upsertMessage(id,message,{removeDraftId:draftId});
      return message;
    });
  }
  saveDraft(id,mail={}) {
    return this._lock(id,async()=>{
      const account=this._account(id);
      await this._checkDraftVersion(id,mail.draftId,mail.expectedMessageId);
      const mime=await buildMime({...mail,from:account.email});
      const message={raw:mime.toString('base64url')};if(mail.threadId)message.threadId=mail.threadId;
      let saved;
      try { saved=await this._api(id,mail.draftId?'drafts/'+idPart(mail.draftId):'drafts',{method:mail.draftId?'PUT':'POST',body:{message}}); }
      catch(error) {
        if(['NETWORK_ERROR','GMAIL_INVALID_RESPONSE'].includes(error.code)||error.status>=500)throw new GmailError('未收到 Gmail 草稿儲存回應，請先同步草稿再決定是否重試。',{code:'DRAFT_UNCERTAIN'});
        throw error;
      }
      if(!saved.id||!saved.message?.id)throw new GmailError('Gmail 草稿回應缺少識別碼');
      try {
        const parsed=await this._confirmedMessage(id,saved.message,mime,['DRAFT'],saved.id);
        this._upsertMessage(id,parsed,{removeDraftId:mail.draftId});
        this._log('Gmail 草稿已儲存',account.email);return parsed;
      } catch { throw new GmailError('Gmail 已儲存草稿，但本機資料保存失敗。請同步草稿，不要重複新增。',{code:'DRAFT_CONFIRMED_LOCAL_ERROR'}); }
    });
  }
  deleteDraft(id,draftId,{expectedMessageId}={}) {
    return this._lock(id,async()=>{
      this._account(id);
      await this._checkDraftVersion(id,draftId,expectedMessageId);
      try { await this._api(id,'drafts/'+idPart(draftId),{method:'DELETE'}); }
      catch(error) { if(error.status!==404)throw error; }
      this.store.update(state=>{state.messages=state.messages.filter(message=>message.accountId!==id||message.draftId!==draftId);});
      this._log('Gmail 草稿已刪除');return {deleted:true,draftId};
    });
  }

  /** This is the sole send entry point. Nothing in connect, sync, or saveDraft calls it. */
  send(id,mail={}) {
    return this._lock(id,async()=>{
      const account=this._account(id);
      await this._checkDraftVersion(id,mail.draftId,mail.expectedMessageId);
      const hasContent=['to','cc','bcc','subject','body','attachments'].some(key=>Object.hasOwn(mail,key));
      let mime;
      if(!mail.draftId||hasContent) { validateRecipients(mail);mime=await buildMime({...mail,from:account.email}); }
      let payload,path;
      if(mail.draftId) { path='drafts/send';payload={id:mail.draftId};if(mime)payload.message={raw:mime.toString('base64url')}; }
      else { path='messages/send';payload={raw:mime.toString('base64url')}; }
      if(mail.threadId) { if(path==='drafts/send'&&payload.message)payload.message.threadId=mail.threadId;else if(path==='messages/send')payload.threadId=mail.threadId; }
      let sent;
      try { sent=await this._api(id,path,{method:'POST',body:payload}); }
      catch(error) {
        if(['NETWORK_ERROR','GMAIL_INVALID_RESPONSE'].includes(error.code)||error.status>=500)throw new GmailError('未收到 Gmail 寄送回應，結果尚不確定。請先檢查寄件備份再決定是否重試。',{code:'SEND_UNCERTAIN'});
        throw error;
      }
      if(!sent.id)throw new GmailError('Gmail 寄送回應缺少識別碼，請先檢查寄件備份再決定是否重試。',{code:'SEND_UNCERTAIN'});
      try {
        const message=await this._confirmedMessage(id,sent,mime,['SENT']);
        this._upsertMessage(id,message,{removeDraftId:mail.draftId});
        this._log('Gmail 郵件已寄出',account.email);return message;
      } catch { throw new GmailError('Gmail 已確認寄出，但本機資料保存失敗。請同步寄件備份，不要重寄。',{code:'SEND_CONFIRMED_LOCAL_ERROR'}); }
    });
  }

  async downloadAttachment(id,messageId,attachmentId) {
    this._account(id);idPart(messageId);idPart(attachmentId);
    if(attachmentId.startsWith('raw:')){
      const index=Number(attachmentId.slice(4));
      if(!/^raw:\d+$/.test(attachmentId)||!Number.isSafeInteger(index))throw new GmailError('附件識別碼格式錯誤');
      const raw=await this._api(id,'messages/'+idPart(messageId),{query:{format:'raw'}});
      if(typeof raw.raw!=='string')throw new GmailError('Gmail 未回傳完整郵件內容');
      const parsed=await parseEml(Buffer.from(raw.raw,'base64url'),{accountId:id}),attachment=parsed.attachments[index];
      if(!attachment)throw new GmailError('找不到附件，請重新同步此郵件');
      return attachment.content;
    }
    if(attachmentId.startsWith('pending:')) {
      const index=Number(attachmentId.slice(8));
      if(!Number.isInteger(index)||index<0)throw new GmailError('附件識別碼格式錯誤');
      const message=await this._getMessage(id,messageId,this._account(id).labels||[]);
      const attachment=message.attachments[index];
      if(!attachment)throw new GmailError('找不到附件，請重新同步此郵件');
      this._upsertMessage(id,message);
      return this.downloadAttachment(id,messageId,attachment.attachmentId);
    }
    if(attachmentId.startsWith('part:')) {
      const raw=await this._api(id,'messages/'+idPart(messageId),{query:{format:'full'}});
      const wanted=attachmentId.slice(5);
      const find=part=>part.partId===wanted?part:(part.parts||[]).map(find).find(Boolean);
      const part=find(raw.payload||{});
      if(!part?.body?.data)throw new GmailError('找不到附件內容，請重新同步此郵件');
      return Buffer.from(part.body.data,'base64url');
    }
    const body=await this._api(id,'messages/'+idPart(messageId)+'/attachments/'+idPart(attachmentId));
    if(typeof body.data!=='string')throw new GmailError('Gmail 未回傳附件內容');
    return Buffer.from(body.data,'base64url');
  }
}

module.exports={GmailService,GMAIL_SCOPE:SCOPE};

'use strict';

const {randomUUID}=require('node:crypto');
const {modelSource,restoredSource,selectedSource,trackModelRun}=require('./model-source.cjs');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const MAX_CHAT_OUTPUT=16000;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const emptyChat=()=>({source:'local',messages:[],draft:'',pendingText:'',status:'idle',error:'',errorCode:'',errorRequestId:'',revision:0});
const copy=value=>JSON.parse(JSON.stringify(value));
function restoredChat(value){
  const chat={...emptyChat(),...(object(value)?value:{})};
  chat.source=restoredSource(chat.source);
  // A renderer snapshot may contain these fields; they are never history.
  delete chat.partialText;delete chat.streamId;
  if(!Array.isArray(chat.messages))chat.messages=[];
  if(typeof chat.draft!=='string')chat.draft='';
  if(typeof chat.pendingText!=='string')chat.pendingText='';
  if(!Number.isSafeInteger(chat.revision)||chat.revision<0)chat.revision=0;
  if(chat.status==='running'){
    if(!chat.draft)chat.draft=chat.pendingText;
    chat.pendingText='';chat.status='cancelled';chat.error='上次對話已中斷，問題已保留，可重新傳送。';chat.errorCode='MODEL_STREAM_INTERRUPTED';chat.errorRequestId='';chat.revision++;
  }
  return chat;
}
function conversation(chat=emptyChat()){
  const timestamp=new Date().toISOString();
  return{id:randomUUID(),title:'新對話',createdAt:timestamp,updatedAt:timestamp,chat:copy(chat)};
}
function initializeChat(state){
  const existing=object(state.chatHistory)&&Array.isArray(state.chatHistory.conversations)?state.chatHistory:null;
  const ids=new Set(),conversations=[];
  for(const entry of existing?.conversations||[]){
    if(!object(entry))continue;
    const item={...entry,chat:restoredChat(entry.chat)};
    if(typeof item.id!=='string'||!item.id||ids.has(item.id))item.id=randomUUID();
    ids.add(item.id);
    if(typeof item.title!=='string'||!item.title.trim())item.title='新對話';
    if(typeof item.createdAt!=='string')item.createdAt=new Date().toISOString();
    if(typeof item.updatedAt!=='string')item.updatedAt=item.createdAt;
    conversations.push(item);
  }
  let active=conversations.find(entry=>entry.id===existing?.activeId);
  if(!active){
    // An older state has only chat. Preserve that exact message/draft payload
    // as a conversation rather than replacing it with a new empty history.
    active=conversation(restoredChat(state.chat));conversations.unshift(active);
  }else if(object(state.chat))active.chat=restoredChat(state.chat);
  state.chatHistory={version:1,activeId:active.id,conversations};
  state.chat=copy(active.chat);
}
function findConversation(state,id){
  const entry=typeof id==='string'&&state.chatHistory.conversations.find(item=>item.id===id);
  if(!entry)throw new Error('找不到這段對話。');
  return entry;
}
function syncActiveChat(state){
  const entry=findConversation(state,state.chatHistory.activeId);
  entry.chat=copy(state.chat);entry.updatedAt=new Date().toISOString();
}
function changeChat(core,mutator,...details){
  return core.change(state=>{mutator(state);syncActiveChat(state);},...details);
}
function overlayChatStream(state,stream){
  const visible=!!stream&&state.chat?.status==='running'&&state.chatHistory?.activeId===stream.conversationId&&state.chat.revision===stream.revision&&!stream.controller?.signal.aborted;
  return{...state,chat:{...state.chat,streamId:visible?stream.streamId:'',partialText:visible?stream.partialText:''}};
}
function clearChatStream(core,stream=core.chatStream){
  if(!stream)return;
  clearTimeout(stream.timer);stream.timer=null;
  if(core.chatStream===stream)core.chatStream=null;
}
function scheduleChatStream(core,stream){
  if(stream.timer)return;
  stream.timer=setTimeout(()=>{
    stream.timer=null;
    if(core.chatStream!==stream||core.active.get('chat')!==stream.controller||stream.controller.signal.aborted)return;
    // Stream events contain one unfinished bubble, not a complete mail store.
    try{
      if(typeof core.onChatStream==='function')core.onChatStream({conversationId:stream.conversationId,streamId:stream.streamId,partialText:stream.partialText});
      else core.onChange();
    }catch{/* A renderer notification failure must not alter model history. */}
  },50);
  stream.timer.unref?.();
}
function chatFailure(code,message){return Object.assign(new Error(message),{code});}
function failureMessage(error,code){
  if(code==='MODEL_OUTPUT_LIMIT')return'回覆達到長度上限，未保存不完整答案。請縮小問題範圍，或要求較精簡的回覆後重試。';
  if(code==='MODEL_STREAM_INTERRUPTED')return'回覆傳輸中斷，未收到完整答案。問題已保留，請重試。';
  if(code==='MODEL_INPUT_TOO_LONG')return'這段對話超過模型的上下文容量，請縮短問題或新增對話後重新開始。';
  if(code==='MODEL_INVALID_OUTPUT')return'模型沒有回傳完整的對話文字，問題已保留，可重新傳送。';
  return String(error.message||'對話未能完成，請稍後再試。').slice(0,500);
}
function waitFor(work,signal){
  return new Promise((resolve,reject)=>{
    const cancelled=()=>finish(reject,Object.assign(new Error('已停止產生回覆。'),{name:'AbortError'}));
    let done=false;
    const finish=(callback,value)=>{if(done)return;done=true;signal.removeEventListener('abort',cancelled);callback(value);};
    if(signal.aborted){cancelled();return;}
    signal.addEventListener('abort',cancelled,{once:true});
    Promise.resolve().then(work).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}
const chatMethods={
  setChatSource(value){
    const source=modelSource(value);
    if(this.store.read().chat.source===source)return this.snapshot();
    this.cancelChat();
    return changeChat(this,state=>{state.chat.source=source;},null);
  },
  newChat(){
    const chat=this.store.read().chat;
    if(chat.status!=='running'&&!chat.messages.length&&!chat.draft.trim()&&!chat.pendingText.trim())return this.snapshot();
    this.cancelChat();
    return changeChat(this,state=>{
      syncActiveChat(state);
      const entry=conversation();state.chatHistory.conversations.unshift(entry);
      state.chatHistory.activeId=entry.id;state.chat=copy(entry.chat);
    },'新增 LLM 對話');
  },
  selectChat(id){
    const state=this.store.read();findConversation(state,id);
    if(state.chatHistory.activeId===id)return this.snapshot();
    this.cancelChat();
    return changeChat(this,state=>{
      syncActiveChat(state);const entry=findConversation(state,id);
      state.chatHistory.activeId=id;state.chat=copy(entry.chat);
    },'切換 LLM 對話');
  },
  renameChat(id,title){
    if(typeof title!=='string'||!title.trim()||title.trim().length>80||/[\r\n\x00]/.test(title))throw new Error('對話名稱須為 1～80 字元的單行文字。');
    findConversation(this.store.read(),id);
    return changeChat(this,state=>{const entry=findConversation(state,id);entry.title=title.trim();entry.updatedAt=new Date().toISOString();},'重新命名 LLM 對話');
  },
  deleteChat(id){
    const current=this.store.read();findConversation(current,id);
    if(current.chatHistory.activeId===id)this.cancelChat();
    return changeChat(this,state=>{
      state.chatHistory.conversations=state.chatHistory.conversations.filter(entry=>entry.id!==id);
      if(state.chatHistory.activeId!==id)return;
      if(!state.chatHistory.conversations.length)state.chatHistory.conversations.push(conversation());
      const next=state.chatHistory.conversations[0];state.chatHistory.activeId=next.id;state.chat=copy(next.chat);
    },'刪除 LLM 對話');
  },
  saveChatDraft(text){
    if(typeof text!=='string'||text.length>16000)throw new Error('每個問題最多 16,000 字元。');
    if(this.store.read().chat.draft===text)return this.snapshot();
    return changeChat(this,state=>{state.chat.draft=text;},null);
  },
  cancelChat(){
    clearChatStream(this);
    this.active.get('chat')?.abort();this.active.delete('chat');
    if(this.store.read().chat.status!=='running')return this.snapshot();
    return changeChat(this,state=>{
      const chat=state.chat;if(!chat.draft)chat.draft=chat.pendingText;
      chat.pendingText='';chat.status='cancelled';chat.error='';chat.errorCode='';chat.errorRequestId='';chat.revision++;
    },'已停止 LLM 對話');
  },
  async sendChat(text,source){
    const initial=this.store.read(),chat=initial.chat;
    source=selectedSource(source,chat.source);
    if(this.active.has('chat'))throw new Error('正在產生回覆，請等候完成或停止。');
    if(typeof text!=='string'||!text.trim()||text.length>16000)throw new Error('請輸入 1～16,000 字元的問題。');
    const input=[...chat.messages.map(({role,content})=>({role,content})),{role:'user',content:text.trim()}];
    if(input.length>31||input.reduce((total,message)=>total+(message.content?.length||0),0)>64000)throw new Error('這段對話已達容量上限，請新增對話後重新開始。');
    if(input.some((message,index)=>message.role!==(index%2?'assistant':'user')||typeof message.content!=='string'||!message.content.trim()||message.content.length>16000))throw new Error('已保存的對話格式不完整，請新增對話後重新開始。');
    const controller=trackModelRun(new AbortController(),'llm',source);this.active.set('chat',controller);
    const conversationId=initial.chatHistory.activeId;
    const stream={conversationId,streamId:randomUUID(),revision:chat.revision,partialText:'',controller,timer:null,error:null};
    this.chatStream=stream;
    const current=()=>{if(this.active.get('chat')!==controller)return false;const state=this.store.read();return state.chatHistory.activeId===conversationId&&state.chat.revision===chat.revision;};
    const onDelta=delta=>{
      // CRUD/cancel abort this controller; do not clone the whole store per token.
      if(controller.signal.aborted||this.active.get('chat')!==controller||this.chatStream!==stream)return;
      if(typeof delta!=='string'||stream.partialText.length+delta.length>MAX_CHAT_OUTPUT){
        stream.error=chatFailure(typeof delta==='string'?'MODEL_OUTPUT_LIMIT':'MODEL_INVALID_OUTPUT','模型回覆增量無效。');
        controller.abort();return;
      }
      if(!delta)return;
      stream.partialText+=delta;scheduleChatStream(this,stream);
    };
    try{changeChat(this,state=>{state.chat.source=source;state.chat.status='running';state.chat.pendingText=text.trim();state.chat.draft='';state.chat.error='';state.chat.errorCode='';state.chat.errorRequestId='';},'開始 LLM 對話','','started');}
    catch(error){controller.abort();clearChatStream(this,stream);if(this.active.get('chat')===controller)this.active.delete('chat');throw error;}
    try{
      const result=await waitFor(()=>this.models.run('llm',{task:'chat',source,input:{messages:input},signal:controller.signal,onDelta}),controller.signal);
      if(!current())return this.snapshot();
      if(stream.error)throw stream.error;
      const completion=[result,result?.meta];
      const finishReasons=completion.flatMap(part=>[part?.finishReason,part?.finish_reason]).filter(reason=>reason!==undefined);
      if(completion.some(part=>part?.truncated===true||part?.complete===false)||finishReasons.some(reason=>['length','max_tokens'].includes(reason))||typeof result?.text==='string'&&result.text.length>MAX_CHAT_OUTPUT)throw chatFailure('MODEL_OUTPUT_LIMIT','模型回覆達到長度上限。');
      if(finishReasons.some(reason=>reason!=='stop'))throw chatFailure('MODEL_INVALID_OUTPUT','模型未正常完成對話回覆。');
      if(!object(result)||typeof result.text!=='string'||!result.text.trim()||stream.partialText&&stream.partialText.trim()!==result.text.trim())throw chatFailure('MODEL_INVALID_OUTPUT','模型沒有回傳完整的對話文字。');
      const meta={source};for(const key of ['model','backend'])if(typeof result.meta?.[key]==='string'&&result.meta[key].length<=250)meta[key]=result.meta[key];
      const createdAt=new Date().toISOString();
      clearChatStream(this,stream);
      changeChat(this,state=>{
        const entry=findConversation(state,conversationId);
        if(entry.title==='新對話'&&!state.chat.messages.length)entry.title=text.trim().replace(/\s+/g,' ').slice(0,32);
        state.chat.messages.push({id:randomUUID(),role:'user',content:text.trim(),createdAt,meta:{source}},{id:randomUUID(),role:'assistant',content:result.text.trim(),createdAt,meta});
        state.chat.pendingText='';state.chat.status='done';state.chat.error='';state.chat.errorCode='';state.chat.errorRequestId='';
      },'LLM 對話完成');
    }catch(error){
      if(!current())return this.snapshot();
      error=stream.error||error;
      const code=typeof error.code==='string'&&/^MODEL_[A-Z_]{1,80}$/.test(error.code)?error.code:error.name==='AbortError'?'MODEL_CANCELLED':'MODEL_REQUEST_FAILED';
      const requestId=UUID.test(error.requestId||'')?error.requestId:'';
      const cancelled=code==='MODEL_CANCELLED'||error.name==='AbortError';
      clearChatStream(this,stream);
      changeChat(this,state=>{
        if(!state.chat.draft)state.chat.draft=state.chat.pendingText;
        state.chat.pendingText='';state.chat.status=cancelled?'cancelled':code==='MODEL_NOT_CONFIGURED'?'waiting-model':'error';
        state.chat.error=cancelled?'':failureMessage(error,code);state.chat.errorCode=code;state.chat.errorRequestId=requestId;
      },'LLM 對話未完成',[code,requestId].filter(Boolean).join(' '),code==='MODEL_NOT_CONFIGURED'?'blocked':cancelled?'cancelled':'error');
      if(!cancelled)try{this.onChatError?.({code,requestId,conversationId,streamId:stream.streamId});}catch{/* Diagnostics are independent of preserving the question. */}
    }finally{clearChatStream(this,stream);if(this.active.get('chat')===controller)this.active.delete('chat');}
    return this.snapshot();
  },
};
module.exports={initializeChat,chatMethods,overlayChatStream};

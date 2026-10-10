'use strict';

const {initializeChat}=require('./chat.cjs');

function clearAllChats(core){
  const history=core.store.read().chatHistory.conversations.filter(entry=>entry.chat.messages.length||entry.chat.draft||entry.chat.pendingText||entry.chat.status==='running'||entry.title!=='新對話');
  const deletedConversations=history.length,deletedMessages=history.reduce((count,entry)=>count+entry.chat.messages.length,0);
  // Existing cancellation clears stream timers and makes late results inert.
  core.cancelChat();
  core.store.purge(state=>{
    delete state.chatHistory;delete state.chat;
    initializeChat(state);
  });
  core.onChange();
  return{deletedConversations,deletedMessages};
}

async function clearAllLogs({store,diagnostics,onChange=()=>{}}){
  const deletedEntries=store.read().logs.length;
  store.purge(state=>{state.logs=[];});
  const {deletedFiles}=await diagnostics.clear();
  onChange();
  return{deletedEntries,deletedFiles};
}

module.exports={clearAllChats,clearAllLogs};

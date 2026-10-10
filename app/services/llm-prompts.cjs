'use strict';

const TASK_VARIABLES={chat:['text'],polish:['text','use','tone'],mail:['referenceTime','date','recipient','sender','senderEmail','contentContext','to','cc','lines'],translate:['text','sourceLanguage','targetLanguage']};
const requiredFor=task=>task==='mail'?'lines':'text';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function placeholders(template,task){
  const names=[];
  const rest=template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_match,name)=>{name=name.trim();if(!TASK_VARIABLES[task].includes(name))throw new Error('Prompt 包含不支援的變數。');names.push(name);return'';});
  if(rest.includes('{{')||rest.includes('}}'))throw new Error('Prompt 的變數括號不完整，請使用 {{name}}。');
  return names;
}
function validatePrompt(task,value){
  if(!Object.hasOwn(TASK_VARIABLES,task)||!object(value)||typeof value.system!=='string'||typeof value.user!=='string'
      ||value.system.length>12000||value.user.length>16000)throw new Error('Prompt 格式錯誤：系統提示最多 12,000 字元，使用者模板最多 16,000 字元。');
  placeholders(value.system,task);const names=placeholders(value.user,task);
  if(!names.includes(requiredFor(task)))throw new Error('使用者模板必須包含 {{'+requiredFor(task)+'}}，以帶入這項工作的原文。');
  return{system:value.system,user:value.user};
}
function validatePromptOverrides(value){
  if(!object(value)||Object.keys(value).some(key=>!Object.hasOwn(TASK_VARIABLES,key)))throw new Error('LLM Prompt 設定格式錯誤。');
  return Object.fromEntries(Object.entries(value).map(([task,prompt])=>[task,validatePrompt(task,prompt)]));
}
module.exports={TASK_VARIABLES,validatePrompt,validatePromptOverrides};

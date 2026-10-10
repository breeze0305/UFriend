'use strict';

const runningModels=new WeakMap();

function modelSource(value){
  if(value!=='local'&&value!=='cloud')throw Object.assign(new Error('請選擇本地或雲端模型來源。'),{code:'MODEL_INVALID_SOURCE'});
  return value;
}
function restoredSource(value){return value==='cloud'?'cloud':'local';}
function selectedSource(value,previous){return modelSource(value===undefined?(previous??'local'):value);}
function defaultModelSource(settings,kind){
  if(!['llm','ocr','whisper'].includes(kind))throw new Error('模型工作類型錯誤。');
  return restoredSource(settings?.modelDefaults?.[kind]);
}
function modelDefaults(patch,current={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['llm','ocr','whisper'].includes(key)))throw new Error('預設模型來源設定格式錯誤。');
  return Object.fromEntries(['llm','ocr','whisper'].map(kind=>[kind,Object.hasOwn(patch,kind)?modelSource(patch[kind]):restoredSource(current[kind])]));
}
function trackModelRun(controller,kind,source){
  runningModels.set(controller,{kind,source:modelSource(source)});
  return controller;
}
function matchingModelRun(controller,source,kinds){
  const run=runningModels.get(controller);
  return!!run&&run.source===source&&kinds.includes(run.kind);
}

module.exports={modelSource,restoredSource,selectedSource,defaultModelSource,modelDefaults,trackModelRun,matchingModelRun};

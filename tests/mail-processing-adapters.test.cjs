'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
const {CloudApiAdapter}=require('../app/models/cloud-api.cjs');

const finalNotice='最新通知：原訂會議已取消，今天無須回覆。';
const summary='原訂會議已取消，今天無須回覆。';
const profileMarker='SYNTHETIC-PROFILE-NOT-FOR-PRIVATE-TASKS';
const promptMarker='SYNTHETIC-CUSTOM-MAIL-PROMPT';
const input=()=>({messages:[{id:'adapter-long-fixture',subject:'合成長信通知',
  body:[...Array.from({length:36},(_,index)=>`參考項目 ${index+1}：`+'測試資料'.repeat(35)+'。'),finalNotice].join('\n\n'),
  date:'2026-09-17T08:00:00+08:00',sender:'sender@example.test',to:['receiver@example.test'],cc:['copy@example.test']}],
  referenceTime:'2026-09-17T09:00:00+08:00',recipient:'receiver@example.test'});
const configured=()=>({localBackend:'pc-api',devLlm:{endpoint:'http://127.0.0.1:8765'},
  api:{endpoint:'https://original-provider.example.test/v1',model:'original-model',temperature:0.2},preferredLanguage:'zh-TW',
  personalProfile:{enabled:true,name:profileMarker},llmPrompts:{mail:{system:promptMarker,user:'{"custom":"'+promptMarker+'","lines":{{lines}}}'}}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const completion=(value,finish='stop')=>json({choices:[{index:0,finish_reason:finish,message:{role:'assistant',content:JSON.stringify(value)}}]});
const success=(source,value)=>source==='local'?json({apiVersion:'1',...value}):completion(value);
const capacity=(source,code)=>source==='local'?json({error:{code}},code==='MODEL_INPUT_TOO_LONG'?413:422):
  code==='MODEL_INPUT_TOO_LONG'?json({error:{code:'input_too_long'}},413):completion({summary:'Synthetic truncated response'},'length');
const finalResult=()=>({analyses:[{id:'adapter-long-fixture',summary,priority:2,reason:'今天無須行動。',evidence:[finalNotice]}]});

function decode(source,payload){
  if(source==='local')return{task:payload.task,input:payload.input};
  const data=JSON.parse(payload.messages.filter(message=>message.role==='user').at(-1).content);
  if(data.mail&&Array.isArray(data.lines)){
    const instructions=payload.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n');
    // Identify the requested output fields independently of the output budget.
    const task=instructions.includes('"summary"')&&instructions.includes('"priority"')?'mail-compose':
      instructions.includes('"evidenceIds"')?'mail-select':'unexpected-private-task';
    return{task,input:data};
  }
  return{task:'mail',input:data};
}
function privateValue(request){
  const ids=[...new Set([request.input.lines[0][0],request.input.lines.at(-1)[0]])];
  return request.task==='mail-select'?{evidenceIds:ids}:
    {summary,reason:'今天無須行動。',priority:2,evidenceIds:[request.input.lines.at(-1)[0]],meta:{model:'local-fixture-model',backend:'fixture-api'}};
}
function fixture(source,{trigger='MODEL_INPUT_TOO_LONG',onRequest}={}){
  const settings=configured(),requests=[],reads={settings:0,key:0};let key='original-synthetic-key';
  const f={source,settings,requests,reads,setKey(value){key=value;}};
  const fetchImpl=async(url,args)=>{
    const payload=JSON.parse(args.body),request={url,args,payload,text:args.body,...decode(source,payload)};requests.push(request);
    const override=await onRequest?.(request,f);if(override)return override;
    if(request.task==='mail')return capacity(source,trigger);
    if(!['mail-select','mail-compose'].includes(request.task))throw new Error('Unexpected synthetic request task.');
    return success(source,privateValue(request));
  };
  const getSettings=()=>{reads.settings++;return settings;},getApiKey=()=>{reads.key++;return key;};
  f.adapter=source==='local'?new LocalLlmApiAdapter({getSettings,fetchImpl}):new CloudApiAdapter({getSettings,getApiKey,fetchImpl});
  return f;
}
function assertLegacyResult(result,original){
  assert.equal(result.apiVersion,'1');assert.equal(result.analyses.length,1);
  const analysis=result.analyses[0];assert.deepEqual(Object.keys(analysis).sort(),['evidence','id','priority','reason','summary']);
  assert.equal(analysis.id,original.messages[0].id);assert.equal(analysis.summary,summary);assert.equal(analysis.priority,2);assert.deepEqual(analysis.evidence,[finalNotice]);
  for(const quote of analysis.evidence)assert(original.messages[0].body.includes(quote)||original.messages[0].subject.includes(quote));
  assert.equal(result.meta.processingMode,'segmented');assert(Number.isInteger(result.meta.chunkCount)&&result.meta.chunkCount>1&&result.meta.chunkCount<=128);
}
function assertSourceExcerpts(result,original){
  const mail=original.messages[0],analysis=result.analyses[0];
  assert.equal(result.apiVersion,'1');assert.equal(result.analyses.length,1);assert.equal(analysis.id,mail.id);
  assert.equal(result.meta.processingMode,'source-excerpts');assert.equal(result.meta.processingFailure,'MODEL_OUTPUT_LIMIT');
  assert.equal(analysis.priority,2);assert.match(analysis.reason,/原文摘錄/);
  assert(analysis.summary.length>0&&analysis.summary.length<=1900);assert(analysis.evidence.length>0&&analysis.evidence.length<=8);
  for(const quote of [...analysis.summary.split('\n\n'),...analysis.evidence])assert(mail.subject.includes(quote)||mail.body.includes(quote),'Capacity fallback must contain literal source text.');
  assert(analysis.summary.includes(finalNotice));assert.notEqual(analysis.summary,summary);
}
function assertPrivateInputs(requests){
  assert.match(requests[0].text,new RegExp(profileMarker));assert.match(requests[0].text,new RegExp(promptMarker));
  for(const request of requests.filter(item=>item.task!=='mail')){
    assert.doesNotMatch(request.text,new RegExp(profileMarker+'|'+promptMarker+'|UPDATED-PROFILE|UPDATED-PROMPT'));
    assert.deepEqual(Object.keys(request.input).sort(),['lines','mail','recipient','referenceTime']);
    assert(!Object.hasOwn(request.input.mail,'body'));
    if(Object.hasOwn(request.payload,'task'))assert.deepEqual(Object.keys(request.payload).sort(),['input','task']);
  }
}
const cancelled=error=>{assert(error.name==='AbortError'||error.code==='MODEL_CANCELLED');return true;};

for(const source of ['local','cloud']){
  for(const trigger of ['MODEL_INPUT_TOO_LONG','MODEL_OUTPUT_LIMIT'])test(`${source} real adapter falls back from ${trigger} through selection and composition to original-source evidence`,async()=>{
    const f=fixture(source,{trigger}),data=input(),original=structuredClone(data),progress=[];
    const result=await f.adapter.run({task:'mail',input:data,onProgress:(_percentage,detail)=>progress.push({...detail})});
    assertLegacyResult(result,original);assert.deepEqual(data,original);
    assert.equal(f.requests[0].task,'mail');assert.equal(f.requests.at(-1).task,'mail-compose');
    const selections=f.requests.filter(request=>request.task==='mail-select');assert(selections.length>1);assert.equal(f.requests.length,selections.length+2);
    const submitted=selections.flatMap(request=>request.input.lines.map(line=>line[1]));
    assert.deepEqual(submitted,[original.messages[0].subject,...original.messages[0].body.split('\n\n')]);
    assert.equal(progress[0].stage,'mail-chunks');assert.equal(progress[0].chunkIndex,0);
    assert.equal(progress.at(-1).stage,'mail-merge');assert.equal(progress.at(-1).chunkIndex,selections.length);assert.equal(progress.at(-1).chunkTotal,selections.length);
    assertPrivateInputs(f.requests);if(source==='cloud')assert.equal(f.adapter.activeRuns.size,0);
    if(source==='cloud')for(const request of f.requests.filter(item=>item.task!=='mail'))assert.equal(request.payload.max_completion_tokens,request.task==='mail-select'?1024:1536);
  });

  for(const selection of ['empty','all'])test(`${source} accepts ${selection} segment selection while composition still cites original text`,async()=>{
    const f=fixture(source,{onRequest:request=>request.task==='mail-select'?success(source,{evidenceIds:selection==='empty'?[]:request.input.lines.map(line=>line[0])}):undefined});
    const original=input(),result=await f.adapter.run({task:'mail',input:original});
    assertLegacyResult(result,original);
    const selections=f.requests.filter(request=>request.task==='mail-select');assert(selections.length>1);
    if(selection==='all')assert(selections.some(request=>request.input.lines.length>8));
    assert(f.requests.at(-1).input.lines.some(([,text])=>text===finalNotice));
  });

  for(const count of [0,9])test(`${source} rejects composition with ${count} evidence IDs after accepting a broad segment selection`,async()=>{
    const f=fixture(source,{onRequest:request=>{
      if(request.task==='mail-select')return success(source,{evidenceIds:request.input.lines.map(line=>line[0])});
      if(request.task==='mail-compose'){
        assert(request.input.lines.length>=9);
        return success(source,{...privateValue(request),evidenceIds:request.input.lines.slice(0,count).map(line=>line[0])});
      }
    }});
    await assert.rejects(f.adapter.run({task:'mail',input:input()}),{code:'MODEL_INVALID_OUTPUT'});
    assert.equal(f.requests.at(-1).task,'mail-compose');assert.equal(f.requests.filter(request=>request.task==='mail-compose').length,1);
    if(source==='cloud')assert.equal(f.adapter.activeRuns.size,0);
  });

  test(`${source} cancellation after the first segment prevents every later HTTP request`,async()=>{
    const f=fixture(source),controller=new AbortController();
    await assert.rejects(f.adapter.run({task:'mail',input:input(),signal:controller.signal,onProgress:(_percentage,detail)=>{
      if(detail.stage==='mail-chunks'&&detail.chunkIndex===1)controller.abort();
    }}),cancelled);
    assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-select']);
    await Promise.resolve();assert.equal(f.requests.length,2);if(source==='cloud')assert.equal(f.adapter.activeRuns.size,0);
  });

  test(`${source} aborting during a private HTTP response propagates to its signal and never composes a summary`,async()=>{
    const controller=new AbortController(),f=fixture(source,{onRequest:request=>{if(request.task==='mail-select')controller.abort();}});
    await assert.rejects(f.adapter.run({task:'mail',input:input(),signal:controller.signal}),cancelled);
    assert.deepEqual(f.requests.map(request=>request.task),['mail','mail-select']);assert.equal(f.requests[1].args.signal.aborted,true);
    if(source==='cloud')assert.equal(f.adapter.activeRuns.size,0);
  });

  test(`${source} one fallback keeps its initial settings and credentials while private tasks omit profile and custom prompt`,async()=>{
    let nextRun=false;
    const f=fixture(source,{onRequest:(request,fixture)=>{
      if(nextRun&&request.task==='mail')return success(source,finalResult());
      const step=fixture.requests.length;
      if(step===1||step===2){
        fixture.settings.localBackend='ugen300';fixture.settings.devLlm.endpoint=`http://127.0.0.1:${9800+step}`;
        fixture.settings.api.endpoint=`https://changed-${step}.example.test/v1`;fixture.settings.api.model=`changed-model-${step}`;fixture.settings.api.temperature=1.1;
        fixture.settings.personalProfile.name='UPDATED-PROFILE';fixture.settings.llmPrompts.mail={system:'UPDATED-PROMPT',user:'{{lines}}'};fixture.setKey(`changed-synthetic-key-${step}`);
      }
    }});
    const data=input(),result=await f.adapter.run({task:'mail',input:data});assertLegacyResult(result,data);assertPrivateInputs(f.requests);
    assert.equal(f.reads.settings,1);assert.equal(f.reads.key,source==='cloud'?1:0);
    for(const request of f.requests){
      assert.equal(request.url,source==='local'?'http://127.0.0.1:8765/v1/llm':'https://original-provider.example.test/v1/chat/completions');
      if(source==='cloud'){assert.equal(request.payload.model,'original-model');assert.equal(request.payload.temperature,0.2);assert.equal(request.args.headers.Authorization,'Bearer original-synthetic-key');}
    }
    if(source==='cloud')assert.equal(result.meta.model,'original-model');
    const previousCount=f.requests.length;nextRun=true;f.settings.localBackend='pc-api';
    // The next call must take a fresh snapshot, rather than retaining the prior
    // pipeline's settings indefinitely. Give its custom prompt valid JSON too.
    f.settings.llmPrompts.mail.user='{"updated":{{lines}}}';
    await f.adapter.run({task:'mail',input:data});assert.equal(f.requests.length,previousCount+1);
    const latest=f.requests.at(-1);assert.equal(latest.url,source==='local'?'http://127.0.0.1:9802/v1/llm':'https://changed-2.example.test/v1/chat/completions');
    if(source==='cloud'){assert.equal(latest.payload.model,'changed-model-2');assert.equal(latest.args.headers.Authorization,'Bearer changed-synthetic-key-2');}
    assert.equal(f.reads.settings,2);assert.equal(f.reads.key,source==='cloud'?2:0);
  });

  for(const stage of ['mail-select','mail-compose'])for(const attack of ['forged','duplicate'])test(`${source} rejects ${attack} evidence IDs from ${stage} without publishing a final analysis`,async()=>{
    const f=fixture(source,{onRequest:request=>{
      if(request.task!==stage)return;
      const value=privateValue(request),id=request.input.lines[0][0];
      value.evidenceIds=attack==='forged'?[200000]:[id,id];return success(source,value);
    }});
    await assert.rejects(f.adapter.run({task:'mail',input:input()}),{code:'MODEL_INVALID_OUTPUT'});
    assert.equal(f.requests.at(-1).task,stage);
    if(stage==='mail-select'){assert.equal(f.requests.length,2);assert(!f.requests.some(request=>request.task==='mail-compose'));}
    if(source==='cloud')assert.equal(f.adapter.activeRuns.size,0);
  });
}

test('cloud context-length code whitelist on HTTP 400 triggers the private fallback',async()=>{
  for(const code of ['context_length_exceeded','max_context_length_exceeded','input_too_long']){
    const f=fixture('cloud',{onRequest:request=>request.task==='mail'?json({error:{code,message:'Synthetic capacity error.'}},400):undefined});
    assertLegacyResult(await f.adapter.run({task:'mail',input:input()}),input());assert(f.requests.some(request=>request.task==='mail-select'));
  }
});

test('other cloud HTTP 400 failures never fall back based on message text or loosely matching codes',async()=>{
  for(const body of [{error:{code:'invalid_model',message:'context_length_exceeded'}},{error:{code:'prefix_context_length_exceeded'}},{error:{code:'CONTEXT_LENGTH_EXCEEDED'}},{error:{message:'input too long'}},{code:'context_length_exceeded'}]){
    const f=fixture('cloud',{onRequest:()=>json(body,400)});
    await assert.rejects(f.adapter.run({task:'mail',input:input()}),{code:'MODEL_API_INCOMPATIBLE'});
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].task,'mail');assert.equal(f.adapter.activeRuns.size,0);
  }
});

const incompleteMarkers=[
  ['finishReason length',{finishReason:'length'}],['finishReason max_tokens',{finishReason:'max_tokens'}],
  ['finish_reason length',{finish_reason:'length'}],['finish_reason max_tokens',{finish_reason:'max_tokens'}],
  ['truncated true',{truncated:true}],['complete false',{complete:false}],
];
for(const stage of ['mail-select','mail-compose']){
  for(const location of ['top','meta'])for(const [name,marker]of incompleteMarkers)test(`local replaces incomplete ${stage} with ${location} ${name} with marked source excerpts`,async()=>{
    const data=input(),original=structuredClone(data),f=fixture('local',{onRequest:request=>{
      if(request.task!==stage)return;
      const value=privateValue(request);
      return success('local',location==='meta'?{...value,meta:{...value.meta,...marker}}:{...value,...marker});
    }});
    assertSourceExcerpts(await f.adapter.run({task:'mail',input:data}),original);
    assert.deepEqual(data,original);assert.equal(f.requests.at(-1).task,stage);
    if(stage==='mail-select')assert(!f.requests.some(request=>request.task==='mail-compose'));
    else assert.equal(f.requests.filter(request=>request.task===stage).length,1);
  });

  for(const marker of [{finish_reason:'max_tokens'},{truncated:true}])test(`local ${stage} top-level success flags cannot hide incomplete meta ${Object.keys(marker)[0]}`,async()=>{
    const f=fixture('local',{onRequest:request=>request.task===stage?success('local',{
      ...privateValue(request),finishReason:'stop',complete:true,meta:marker,
    }):undefined});
    const original=input();assertSourceExcerpts(await f.adapter.run({task:'mail',input:original}),original);
    if(stage==='mail-select')assert(!f.requests.some(request=>request.task==='mail-compose'));
  });

  for(const finish of ['length','max_tokens'])test(`cloud ${stage} with ${finish} retains explicit capacity or invalid-output handling`,async()=>{
    const f=fixture('cloud',{onRequest:request=>request.task===stage?completion(privateValue(request),finish):undefined});
    const original=input();
    if(finish==='length')assertSourceExcerpts(await f.adapter.run({task:'mail',input:original}),original);
    else await assert.rejects(f.adapter.run({task:'mail',input:original}),{code:'MODEL_INVALID_OUTPUT'});
    assert.equal(f.requests.at(-1).task,stage);assert.equal(f.adapter.activeRuns.size,0);
    if(stage==='mail-select')assert(!f.requests.some(request=>request.task==='mail-compose'));
    else assert.equal(f.requests.filter(request=>request.task===stage).length,1);
  });
}

for(const stage of ['mail-select','mail-compose'])test(`local legacy API rejection of ${stage} requests PC LLM API 0.1.6 and a service restart`,async()=>{
  const f=fixture('local',{onRequest:request=>request.task===stage?json({error:{code:'MODEL_INVALID_REQUEST'}},400):undefined});
  await assert.rejects(f.adapter.run({task:'mail',input:input()}),error=>{assert.equal(error.code,'MODEL_API_INCOMPATIBLE');assert.match(error.message,/0\.1\.6/);assert.match(error.message,/長信分段/);assert.match(error.message,/重新啟動服務/);return true;});
  assert.equal(f.requests.at(-1).task,stage);if(stage==='mail-select')assert.equal(f.requests.length,2);
});

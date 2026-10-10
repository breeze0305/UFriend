'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runMailPipeline,sourceLines,repeatedSummary,validateProcessingInput,validateProcessingOutput,LIMITS}=require('../app/models/mail-processing.cjs');
const input=body=>({messages:[{id:'synthetic-long',subject:'合成通知',body,date:'2026-09-17T08:00:00+08:00',sender:'sender@example.invalid',to:['receiver@example.invalid'],cc:[]}],referenceTime:'2026-09-17T09:00:00+08:00',recipient:'receiver@example.invalid'});
const error=code=>Object.assign(new Error(code),{code});
const compose=(data)=>({apiVersion:'1',summary:'會議已取消，無須回覆。',reason:'今天無須行動。',priority:2,evidenceIds:[data.lines.at(-1)[0]],meta:{backend:'fixture'}});
const shortLimits={...LIMITS,chunkCharacters:70,chunkLines:3,finalCharacters:700,finalLines:32};

function assertSourceExcerpts(result,data,code){
  const mail=data.messages[0],analysis=result.analyses[0];
  assert.equal(result.apiVersion,'1');assert.equal(result.analyses.length,1);assert.equal(analysis.id,mail.id);
  assert.equal(result.meta.processingMode,'source-excerpts');assert.equal(result.meta.processingFailure,code);
  assert.equal(analysis.priority,2);assert.match(analysis.reason,/原文摘錄/);
  assert(analysis.summary.length>0&&analysis.summary.length<=1900);assert(analysis.evidence.length>0&&analysis.evidence.length<=8);
  for(const quote of [...analysis.summary.split('\n\n'),...analysis.evidence])assert(mail.subject.includes(quote)||mail.body.includes(quote),'Capacity fallback must contain literal source text.');
}

test('ordinary successful mail uses one call and retains its established result',async()=>{
  const data=input('單封簡短通知。'),result={analyses:[{id:'synthetic-long',summary:'簡短通知。'}]};let calls=0;
  assert.equal(await runMailPipeline({input:data,run:async task=>{calls++;assert.equal(task,'mail');return result;}}),result);assert.equal(calls,1);
});

test('all source fragments are read before one global decision and returned quotes map to originals',async()=>{
  const data=input('原訂會議要求今天 15:00 前回覆。\n\n場地原為二樓。\n\n提供參考資料一。\n\n提供參考資料二。\n\n最新通知：會議已取消，無須回覆。');
  const original=structuredClone(data),reads=[],stages=[];let decisions=0;
  const result=await runMailPipeline({input:data,limits:shortLimits,onProgress:(_p,detail)=>stages.push({...detail}),run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    if(task==='mail-select'){reads.push(...payload.lines.map(line=>line[1]));return{evidenceIds:payload.lines.map(line=>line[0])};}
    decisions++;assert(reads.includes('最新通知：會議已取消，無須回覆。'));return compose(payload);
  }});
  assert.deepEqual(data,original);assert.equal(decisions,1);
  assert.deepEqual(reads,sourceLines(data.messages[0]).map(line=>line[1]));
  assert.deepEqual(result.analyses[0].evidence,['最新通知：會議已取消，無須回覆。']);assert.equal(result.analyses[0].priority,2);
  assert.equal(result.meta.processingMode,'segmented');assert(result.meta.chunkCount>1);
  assert.equal(stages[0].chunkIndex,0);assert.equal(stages.at(-1).stage,'mail-merge');assert.equal(stages.at(-1).chunkIndex,stages.at(-1).chunkTotal);
});

for(const selection of ['empty','incidental'])test(`dates, amounts, conditional actions and status survive ${selection} model selection with adjacent context`,async()=>{
  const context='核對方式與作業背景說明。',deadline='請於2026/09/19 15:30前確認行程。';
  const amount='付款總額為NT$1,280。',condition='若尚未付款，請於收到通知後3日內補繳；若已付款則無須再次付款。';
  const latest='最新通知：原行程已取消，無須補繳。',appendix='這是一般參考附錄。';
  const data=input([context,deadline,'項目為住宿訂金。',amount,'銀行相關資料。',condition,latest,appendix].join('\n\n'));
  const original=structuredClone(data),required=[context,deadline,'項目為住宿訂金。',amount,'銀行相關資料。',condition,latest],reads=[];let compositions=0;
  const result=await runMailPipeline({input:data,limits:shortLimits,run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    if(task==='mail-select'){
      reads.push(...payload.lines.map(line=>line[1]));
      return{evidenceIds:selection==='empty'?[]:payload.lines.filter(([,text])=>text===appendix).map(([id])=>id)};
    }
    compositions++;
    for(const text of required)assert(payload.lines.some(([,value])=>value===text),text+' must reach final composition unchanged.');
    const ids=payload.lines.map(([id])=>id);assert.deepEqual(ids,[...ids].sort((a,b)=>a-b));
    const id=payload.lines.find(([,text])=>text===latest)[0];
    return{...compose(payload),summary:latest,evidenceIds:[id]};
  }});
  assert.deepEqual(data,original);assert.deepEqual(reads,sourceLines(data.messages[0]).map(line=>line[1]));
  assert.equal(compositions,1);assert.deepEqual(result.analyses[0].evidence,[latest]);
});

test('a reduction pass cannot discard a protected deadline, condition or adjacent source context',async()=>{
  const before='核對方式說明。',critical='若資料有誤，請於2026/09/19 15:30前回覆。',after='其他補充說明。';
  const data=input(['參考資料甲。','參考資料乙。','連絡窗口資料。',before,critical,after,'參考資料丙。','參考資料丁。'].join('\n\n'));
  let selections=0,compositions=0;
  const result=await runMailPipeline({input:data,limits:{...LIMITS,finalLines:4},run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    if(task==='mail-select')return{evidenceIds:++selections===1?payload.lines.map(([id])=>id):[]};
    compositions++;assert.equal(selections,2);
    assert.deepEqual(payload.lines.map(([,text])=>text),[data.messages[0].subject,before,critical,after]);
    return{...compose(payload),summary:critical,evidenceIds:[payload.lines.find(([,text])=>text===critical)[0]]};
  }});
  assert.equal(compositions,1);assert.deepEqual(result.analyses[0].evidence,[critical]);
});

test('capacity errors adaptively split a segment without skipping either half',async()=>{
  const data=input('第一件待辦。\n\n第二件待辦。\n\n第三件待辦。\n\n第四件待辦。'),seen=[],progress=[];
  const result=await runMailPipeline({input:data,onProgress:(_p,p)=>progress.push(p),run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    if(task==='mail-select'){if(payload.lines.length>2)throw error('MODEL_INPUT_TOO_LONG');seen.push(...payload.lines.map(l=>l[0]));return{evidenceIds:payload.lines.map(l=>l[0])};}
    return compose(payload);
  }});
  assert.deepEqual(seen,sourceLines(data.messages[0]).map(line=>line[0]));
  assert.equal(result.meta.chunkCount,3);assert.equal(progress.at(-1).chunkTotal,3);assert.equal(progress.at(-1).chunkIndex,3);
});

test('intermediate selection failure never produces a partial final result',async()=>{
  let selections=0,compositions=0;
  await assert.rejects(runMailPipeline({input:input('一號通知。\n\n二號通知。\n\n三號通知。\n\n四號通知。'),limits:{...shortLimits,chunkLines:1},run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_OUTPUT_LIMIT');
    if(task==='mail-compose'){compositions++;return compose(payload);}
    if(++selections===2)throw error('MODEL_API_UNAVAILABLE');return{evidenceIds:[payload.lines[0][0]]};
  }}),{code:'MODEL_API_UNAVAILABLE'});assert.equal(compositions,0);assert.equal(selections,2);
});

test('IDs outside the current chunk or merge cannot become apparent original evidence',async()=>{
  for(const attackStage of ['mail-select','mail-compose']){
    await assert.rejects(runMailPipeline({input:input('不可捏造這段原文。'),run:async(task,payload)=>{
      if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
      if(task===attackStage)return task==='mail-select'?{evidenceIds:[900]}:{...compose(payload),evidenceIds:[900]};
      return{evidenceIds:payload.lines.map(line=>line[0])};
    }}),{code:'MODEL_INVALID_OUTPUT'});
  }
});

test('cancellation between segments prevents all subsequent requests',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(runMailPipeline({input:input('一號。\n\n二號。\n\n三號。'),signal:controller.signal,limits:{...shortLimits,chunkLines:1},onProgress:(_p,d)=>{if(d.chunkIndex===1)controller.abort();},run:async(task,payload)=>{
    calls++;if(task==='mail')throw error('MODEL_OUTPUT_LIMIT');return{evidenceIds:[payload.lines[0][0]]};
  }}),{name:'AbortError'});assert.equal(calls,2);
});

test('late cancellation after a final HTTP response never publishes that result',async()=>{
  const controller=new AbortController();
  await assert.rejects(runMailPipeline({input:input('合成通知。'),signal:controller.signal,run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    if(task==='mail-select')return{evidenceIds:[payload.lines[0][0]]};
    controller.abort();return compose(payload);
  }}),{name:'AbortError'});
});

test('persistent output repetition triggers source selection, without accepting the repeated summary',async()=>{
  const repetition='這是圖片的相機介面與多種控制項目的細節描述，包含鏡頭光圈以及快門速度。'.repeat(5),tasks=[];
  assert.equal(repeatedSummary(repetition),true);assert.equal(repeatedSummary('會議已取消，無須回覆。'),false);
  const result=await runMailPipeline({input:input('主要事件：會議已取消。'),run:async(task,payload)=>{
    tasks.push(task);if(task==='mail')return{analyses:[{summary:repetition}]};
    return task==='mail-select'?{evidenceIds:[payload.lines.at(-1)[0]]}:compose(payload);
  }});
  assert.deepEqual(tasks,['mail','mail-select','mail-compose']);assert.equal(result.analyses[0].summary,'會議已取消，無須回覆。');
});

test('nonshrinking reduction stops model calls and publishes marked literal source excerpts',async()=>{
  let selected=0,composed=0;
  const data=input('第一項完整通知。\n\n第二項完整通知。'),original=structuredClone(data);
  const result=await runMailPipeline({input:data,limits:{...LIMITS,finalCharacters:1},run:async(task,payload)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    if(task==='mail-compose'){composed++;return compose(payload);}
    selected++;return{evidenceIds:payload.lines.map(line=>line[0])};
  }});assertSourceExcerpts(result,data,'MODEL_INPUT_TOO_LONG');assert.deepEqual(data,original);assert.equal(composed,0);assert.equal(selected,2);
});

test('oversized segment counts fail before sending any private content',async()=>{
  let calls=0;await assert.rejects(runMailPipeline({input:input('一。\n\n二。\n\n三。'),limits:{...LIMITS,chunkLines:1,maxChunks:2},run:async()=>{calls++;throw error('MODEL_INPUT_TOO_LONG');}}),{code:'MODEL_INPUT_TOO_LONG'});assert.equal(calls,1);
});

test('unrelated authentication and invalid-result failures do not trigger more model calls',async()=>{
  for(const code of ['MODEL_CLOUD_AUTH_FAILED','MODEL_API_BUSY','MODEL_INVALID_OUTPUT','MODEL_REVIEW_REQUIRED']){
    let calls=0;await assert.rejects(runMailPipeline({input:input('合成。'),run:async()=>{calls++;throw error(code);}}),{code});assert.equal(calls,1);
  }
});

test('splitting preserves Unicode source spans and omits only marker-only decoration',()=>{
  const mail=input('【網址】\n\n[【網址】]【網址】\n\n----\n\n'+('中文🙂'.repeat(130))+'\n\n日期：2026/09/17。').messages[0],lines=sourceLines(mail);
  for(const [,text]of lines){assert(mail.subject.includes(text)||mail.body.includes(text));assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text));}
  assert(lines.some(([,text])=>text==='日期：2026/09/17。'));assert(!lines.some(([,text])=>text.includes('【網址】')));
});

test('wrapped table cells stay together and evidence never crosses a URL replacement',()=>{
  const mail=input('航段一\n星湖機場 海灣機場\nXY101 2026/12/24 19:50\n\n報到方式【網址】至少提前一小時完成。').messages[0];
  const lines=sourceLines(mail);
  assert(lines.some(([,text])=>text==='航段一\n星湖機場 海灣機場\nXY101 2026/12/24 19:50'));
  assert(lines.some(([,text])=>text==='報到方式'));assert(lines.some(([,text])=>text==='至少提前一小時完成。'));
  assert(lines.every(([,text])=>!text.includes('【網址】')&&(mail.body.includes(text)||mail.subject.includes(text))));
});

test('compose output limits stop and retain critical source facts as marked excerpts',async()=>{
  const tasks=[];
  const facts=['請於2026/09/19 15:30前回覆確認。','若資料正確則無須修改。','最新通知：原訂會議已取消。'];
  const data=input(facts.join('\n\n')),original=structuredClone(data);
  const result=await runMailPipeline({input:data,run:async(task,data)=>{
    tasks.push(task);if(task==='mail'||task==='mail-compose')throw error('MODEL_OUTPUT_LIMIT');return{evidenceIds:data.lines.map(l=>l[0])};
  }});assertSourceExcerpts(result,data,'MODEL_OUTPUT_LIMIT');assert.deepEqual(data,original);
  for(const fact of facts)assert(result.analyses[0].summary.includes(fact));
  assert.deepEqual(tasks,['mail','mail-select','mail-compose']);
});

test('request and elapsed-time budgets terminate a fallback without further model use',async()=>{
  let calls=0;
  const data=input('合成通知。');
  const result=await runMailPipeline({input:data,limits:{...LIMITS,maxCalls:1},run:async(task,data)=>{
    calls++;if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');return{evidenceIds:[data.lines[0][0]]};
  }});assertSourceExcerpts(result,data,'MODEL_INPUT_TOO_LONG');assert.equal(calls,2);
  await assert.rejects(runMailPipeline({input:input('合成通知。'),limits:{...LIMITS,timeoutMs:10},run:async(task,_data,signal)=>{
    if(task==='mail')throw error('MODEL_INPUT_TOO_LONG');
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
  }}),{code:'MODEL_API_TIMEOUT'});
});

test('processing contracts reject excess fields, forged citations and overlong final summaries',()=>{
  const mail=input('原文。').messages[0];delete mail.body;
  const data={mail,referenceTime:'2026-09-17T09:00:00Z',recipient:'receiver@example.invalid',lines:[[7,'原文。']]};
  assert.deepEqual(validateProcessingInput(data),data);
  for(const value of [{...data,prompt:'injected'},{...data,lines:[[7,'甲'],[7,'乙']]},{...data,lines:[[1,'x'.repeat(1001)]]},{...data,mail:{...mail,body:'secret'}}])assert.throws(()=>validateProcessingInput(value),{code:'MODEL_INVALID_REQUEST'});
  for(const [field,lengths]of [['summary',[1000,1001]],['reason',[160,161]]])for(const length of lengths)
    assert.throws(()=>validateProcessingOutput('mail-compose',{...compose(data),[field]:'字'.repeat(length)},data),{code:'MODEL_OUTPUT_LIMIT'});
  // Distinct source points exercise capacity without triggering repetition detection.
  const summary=Array.from({length:1000},(_,index)=>String.fromCodePoint(0x4e00+index)).join('').slice(0,999);
  assert.doesNotThrow(()=>validateProcessingOutput('mail-compose',{...compose(data),summary,reason:'由'.repeat(159)},data));
  assert.throws(()=>validateProcessingOutput('mail-select',{evidenceIds:[7],summary:'extra'},data),{code:'MODEL_INVALID_OUTPUT'});
  assert.throws(()=>validateProcessingOutput('mail-select',{evidenceIds:[7,7]},data),{code:'MODEL_INVALID_OUTPUT'});
});

test('selection permits zero through 64 unique IDs while composition remains limited to one through eight',()=>{
  const mail=input('原文。').messages[0];delete mail.body;
  const data=validateProcessingInput({mail,referenceTime:'2026-09-17T09:00:00Z',recipient:'receiver@example.invalid',
    lines:Array.from({length:64},(_,index)=>[index,'合成原文 '+index])});
  for(const count of [0,1,8,9,64]){
    const evidenceIds=data.lines.slice(0,count).map(([id])=>id),output={evidenceIds};
    assert.deepEqual(validateProcessingOutput('mail-select',output,data).evidenceIds,evidenceIds);
    assert.deepEqual(output,{evidenceIds});
  }
  for(const count of [1,8]){
    const evidenceIds=data.lines.slice(0,count).map(([id])=>id);
    assert.deepEqual(validateProcessingOutput('mail-compose',{...compose(data),evidenceIds},data).evidenceIds,evidenceIds);
  }
  for(const count of [0,9,64])assert.throws(()=>validateProcessingOutput('mail-compose',{...compose(data),evidenceIds:data.lines.slice(0,count).map(([id])=>id)},data),{code:'MODEL_INVALID_OUTPUT'});
  const over={...data,lines:[...data.lines,[64,'多出的一行']]};
  assert.throws(()=>validateProcessingInput(over),{code:'MODEL_INVALID_REQUEST'});
  assert.throws(()=>validateProcessingOutput('mail-select',{evidenceIds:over.lines.map(([id])=>id)},over),{code:'MODEL_INVALID_OUTPUT'});
});

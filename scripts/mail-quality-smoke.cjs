'use strict';

// Invoked only by scripts/smoke.cjs after its isolated-workspace guards.
// Rendering fixtures exercise no real account, model, attachment or remote image.
const assert=require('node:assert/strict');

module.exports=async function mailQualitySmoke({win,core,actions,nav,click,setValue,evaluate,uiWait,waitFor,screenshot}){
  const saved=structuredClone(core.store.read()),size=win.getSize(),originalRun=core.models.run;
  const id='synthetic-mail-source-quality',shots=[],date=new Date().toISOString();
  const facts=[
    '原文请求汇款账号信息，账号名称为测试资料。',
    '去程：2027/03/12，AB101，台北 TPE 09:30 → 東京 NRT 13:40；飛行時間 3 小時 10 分。',
    '回程：2027/03/18，AB102，東京 NRT 15:00 → 台北 TPE 18:10。',
    '已收款 TWD 12,680。免費託運行李 2 件，每件 23 公斤；手提行李 1 件，最多 7 公斤。',
    '請於起飛至少 1 小時前完成報到。條件與詳情請參閱完整郵件。',
    '僅為合成的原文內容：<img src=x onerror="window.__sourceFactExecuted=true"> & 不執行標籤。'
  ];
  const protectedContent='https://example.invalid/账号?主题=汇款 reader@example.invalid `const 账号 = "简体";`';
  const summary='求助信 - 请求汇款账号信息。<确认> & 保留完整摘要。\n'+protectedContent;
  const visibleSummary='求助信 - 請求匯款帳號資訊。<確認> & 保留完整摘要。\n'+protectedContent;
  const fixture={id,accountId:'local',source:'本機',sender:'Synthetic Air',email:'sender@example.invalid',to:'reader@example.invalid',subject:'合成测试：请求汇款账号信息',body:facts.join('\n\n')+'\n\n完整原信仍保留在此。',date,folder:'inbox',read:true,done:false,level:0,prioritySource:'model',attachments:[],analysis:{summary,priority:0,reason:'账号信息需核对。',sourceFacts:facts,evidence:[facts[0]],analyzedAt:date,category:'finance',categoryStatus:'done',meta:{source:'local',model:'Synthetic fixture'},quality:{summaryMode:'source-excerpts',priorityReview:true,sourceFactsTruncated:true,contentLimited:false,imageTextUnavailable:true,issues:['duration-mismatch']}}};
  core.models.run=()=>{throw new Error('Mail summary UI smoke must not invoke a model.');};
  const refresh=()=>win.webContents.send('ufriend:change',actions.bootstrap());
  const verifyCard=expected=>evaluate(expected=>{
    const card=document.querySelector('#mail-analysis-result .mf-analysis'),heading=card?.querySelector('h2'),category=card?.querySelector('.mf-mail-category'),summary=card?.querySelector('.mf-analysis-summary');
    return !!heading&&!!category&&summary?.textContent===expected&&summary.children.length===0&&card.textContent===heading.textContent+category.textContent+expected&&
      !card.querySelector('.mf-analysis-facts,.mf-analysis-evidence,.mf-analysis-quality,.mf-analysis-source,.mf-analysis-mode,.mf-priority-review,.mf-mail-analysis-notice');
  },expected);
  const verifyLayout=()=>evaluate(()=>{const page=document.querySelector('#mf-page'),card=document.querySelector('.mf-analysis');return !!card&&page.scrollWidth<=page.clientWidth+1&&card.scrollWidth<=card.clientWidth+1;});
  const verifyOriginal=()=>evaluate(expected=>{const body=document.querySelector('#mail-body-view'),card=document.querySelector('#mail-analysis-result');return body?.querySelector('.mf-bodytext')?.textContent===expected&&!body.querySelector('img')&&!window.__sourceFactExecuted&&!!(card.compareDocumentPosition(body)&Node.DOCUMENT_POSITION_FOLLOWING);},fixture.body);
  try{
    core.store.update(state=>{state.messages=[structuredClone(fixture)];});refresh();await nav('home');
    await uiWait('An unverified model priority remains in the review group',()=>{const card=document.querySelector('[data-action="open-mail"][data-id="synthetic-mail-source-quality"]');return card?.dataset.level==='review'&&document.querySelector('#mf-page').textContent.includes('待核對');});
    for(const [width,height,language,theme] of [[1080,820,'zh-TW','light'],[640,640,'en','dark']]){
      win.setSize(width,height);await actions['settings.save']({uiLanguage:language,theme});refresh();await nav('home');
      await uiWait('Synthetic summary fixture remains available',()=>!!document.querySelector('[data-action="open-mail"][data-id="synthetic-mail-source-quality"]'));
      await click('[data-action="open-mail"][data-id="'+id+'"]');
      await uiWait('The full summary appears and the priority control still offers review',({language,summary})=>{
        const result=document.querySelector('.mf-analysis-summary'),option=document.querySelector('#mail-level')?.selectedOptions[0];
        return result?.textContent===summary&&option?.value===''&&option.textContent===(language==='en'?'Needs review':'待核對');
      },{language,summary:visibleSummary});
      assert(await verifyCard(visibleSummary),'The card contains only its heading, category and escaped Traditional Chinese summary, with protected text unchanged.');
      assert(await verifyOriginal(),'The complete original email remains below the summary as plain text.');
      assert(await verifyLayout(),'The summary card must fit the viewport.');
      assert.deepEqual(core.store.read().messages.find(mail=>mail.id===id).analysis,fixture.analysis,'Opening the summary must preserve the existing simplified analysis in storage.');
      assert.deepEqual(core.snapshot().messages.find(mail=>mail.id===id).analysis,{...fixture.analysis,summary:visibleSummary,reason:'帳號資訊需核對。'},'Snapshots convert only generated summary and reason fields.');
      await evaluate(()=>document.querySelector('.mf-analysis').scrollIntoView({block:'start'}));
      await screenshot('53-mail-summary-'+width+'-'+language);shots.push({width,height,language,theme,state:'summary-only'});
      await click('[data-action="mail-back"]');
    }
    await actions['settings.save']({uiLanguage:'zh-TW',theme:'light'});refresh();await nav('home');await click('[data-action="open-mail"][data-id="'+id+'"]');
    await setValue('#mail-level','1','change');
    await waitFor('A human can deliberately set the priority of an unverified model result',()=>{const mail=core.snapshot().messages.find(mail=>mail.id===id);return mail.level===1&&mail.prioritySource==='manual';});
    await uiWait('The manual priority selection is retained outside the summary',()=>document.querySelector('#mail-level')?.value==='1');
    await evaluate(()=>{window.__summaryPriority=document.querySelector('#mail-level');window.__summaryPriority.focus();window.__summaryOriginal=document.querySelector('#mail-body-view').innerHTML;});
    const updated=summary+' 账号信息已更新。',visibleUpdated=visibleSummary+' 帳號資訊已更新。';
    core.store.update(state=>{const mail=state.messages.find(mail=>mail.id===id);mail.analysis.summary=updated;mail.analysis.quality={summaryMode:'source-excerpts',priorityReview:true,sourceFactsTruncated:true,contentLimited:true,imageTextUnavailable:false,attachmentTextUnavailable:true,issues:['attachment-unavailable','duration-mismatch']};});refresh();
    await uiWait('A live summary update converts simplified text and preserves the focused manual priority control',updated=>document.querySelector('.mf-analysis-summary')?.textContent===updated&&document.querySelector('#mail-level')===window.__summaryPriority&&document.activeElement===window.__summaryPriority&&window.__summaryPriority.value==='1',visibleUpdated);
    assert(await verifyCard(visibleUpdated),'Live updates must not restore source facts, evidence, notices or model details.');
    assert(await verifyOriginal(),'Live summary updates preserve the complete original email.');
    assert(await evaluate(()=>document.querySelector('#mail-body-view').innerHTML===window.__summaryOriginal),'Live summary updates do not rebuild the original message.');
    const stored=core.store.read().messages.find(mail=>mail.id===id);
    assert.equal(stored.analysis.summary,updated);assert.equal(stored.analysis.reason,fixture.analysis.reason);assert.equal(stored.subject,fixture.subject);
    assert.deepEqual(stored.analysis.sourceFacts,facts);assert.deepEqual(stored.analysis.evidence,[facts[0]]);assert.equal(stored.analysis.quality.attachmentTextUnavailable,true);assert.equal(stored.prioritySource,'manual');assert.equal(stored.level,1);
    return{screenshots:shots,summaryOnly:true,completeSummaryEscaped:true,originalBodyPreserved:true,storedAnalysisPreserved:true,traditionalSummaryDisplayed:true,protectedSummaryTextPreserved:true,manualPriorityAndFocusPreserved:true,liveSummaryUpdatePreserved:true};
  }finally{
    core.models.run=originalRun;win.setSize(...size);
    core.store.update(state=>{state.messages=saved.messages;state.mailAnalysis=saved.mailAnalysis;});
    await actions['settings.save']({uiLanguage:saved.settings.uiLanguage,theme:saved.settings.theme});refresh();await nav('home');
  }
};

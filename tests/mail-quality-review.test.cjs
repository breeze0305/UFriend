'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sourceFacts,verifiableImmediate,applyMailQuality}=require('../app/services/mail-quality.cjs');
const today='2026-09-17T09:00:00+08:00',sent='2026-09-17T08:00:00+08:00';

test('leaked model metadata is replaced with literal mail passages while technical source fields remain valid',()=>{
  const body='本週可領取折價券，限指定商品使用。',input={subject:'優惠通知',body};
  for(const leaked of ['urgency: 今天一般','"urgency": "今天一般"','user_profile 沒有提供資料','imageTextUnavailable=true','textLimited=false','attachmentCount為0','referenceTime為今天','evidenceIds: []']){
    const result=applyMailQuality({input,analysis:{summary:body+' '+leaked,reason:'優惠通知。',priority:2,evidence:[body]},category:'promotion'});
    assert(result.quality.issues.includes('model-metadata-in-summary'),leaked);assert.equal(result.quality.summaryMode,'source-excerpts');
    assert(result.quality.priorityReview);assert(!result.summary.includes(leaked));assert(result.summary.includes(body));
  }
  const technical='請在測試文件說明 user_profile、imageTextUnavailable、textLimited、attachmentCount、referenceTime、evidenceIds 與 urgency 欄位。';
  const result=applyMailQuality({input:{subject:'介面文件',body:technical},analysis:{summary:technical+' urgency: 今天一般',reason:'更新文件。',priority:1,evidence:[technical]},category:'work'});
  assert(!result.quality.issues.includes('model-metadata-in-summary'));assert.equal(result.quality.summaryMode,'generated');
  const ordinary='Market urgency remains low. No action required.';
  const leaked=applyMailQuality({input:{subject:'Market update',body:ordinary},analysis:{summary:ordinary+' urgency: 今天一般',reason:'No action required.',priority:2,evidence:[ordinary]},category:'promotion'});
  assert(leaked.quality.issues.includes('model-metadata-in-summary'));assert.equal(leaked.quality.summaryMode,'source-excerpts');
});

test('an identical historical sentence never replaces the earliest current acknowledgement',()=>{
  const body='收到成功\n\n本次原文補充。\n\n收到成功\n\nOn September 16, 2026, Author <sender@example.invalid> wrote:\n\n收到成功';
  const result=sourceFacts({subject:'合成回覆',body}),copies=result.candidates.filter(item=>item.text==='收到成功');
  assert.equal(result.thread.boundaryKnown,true);assert.equal(copies.length,1);
  assert.equal(copies[0].origin,'current');assert.equal(copies[0].index,1);
  assert(result.facts.some(item=>item.origin==='current'&&item.text.includes(copies[0].text)));assert(body.includes(copies[0].text));
});

test('current source content takes precedence over identical subject and historical text',()=>{
  const body='收到成功\n\nOn September 16, 2026, Author <sender@example.invalid> wrote:\n\n收到成功';
  const result=sourceFacts({subject:'收到成功',body}),copy=result.candidates.find(item=>item.text==='收到成功');
  assert.equal(copy.origin,'current');assert.equal(copy.index,1);
});

test('deadline verification never treats a month/day suffix from another year as today',()=>{
  for(const deadline of ['2027/09/17','2025-09-17','2027年9月17日','2026/09/18','2026/08/17','2026/09/170','19/17']){
    assert.equal(verifiableImmediate('請於'+deadline+' 14:30前回覆。',sent,today),false,deadline);
  }
  for(const deadline of ['2026/09/17','2026-9-17','2026年9月17日','9/17','09-17','9月17日','今天']){
    assert.equal(verifiableImmediate('請於'+deadline+' 14:30前回覆。',sent,today),true,deadline);
  }
});

test('relative or yearless dates from stale mail and competing dates remain unverified',()=>{
  assert.equal(verifiableImmediate('請於今天14:30前回覆。','2026-09-16T08:00:00+08:00',today),false);
  assert.equal(verifiableImmediate('請於9/17 14:30前回覆。','2025-09-16T08:00:00+08:00',today),false);
  assert.equal(verifiableImmediate('請於9/17 14:30前回覆。','',today),false);
  assert.equal(verifiableImmediate('請於2026/09/17或2027/09/17 14:30前回覆。',sent,today),false);
  assert.equal(verifiableImmediate('請於2026/09/17或9/18 14:30前回覆。',sent,today),false);
  assert.equal(verifiableImmediate('如果由你負責，請於今天14:30前回覆。',sent,today),false);
  assert.equal(verifiableImmediate('請立即處理。',sent,today),true);
  assert.equal(verifiableImmediate('請立即處理。','2026-09-16T08:00:00+08:00',today),false);
  for(const text of ['請明天立即回覆。','請於2027/09/17立即回覆。','請今天14:30前不要回覆。','請於收到通知後立即回覆。'])assert.equal(verifiableImmediate(text,sent,today),false,text);
});

function qualityCase(body,summary,reason,{priority=2,category='account',evidence=[body],...extra}={}){
  const input={id:'quality-scope',subject:'合成服務通知',body,date:sent,sender:'Synthetic sender',senderEmail:'sender@example.invalid',to:['reader@example.invalid'],cc:[],
    contentContext:{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:false},...extra};
  const first=applyMailQuality({input,analysis:{summary,reason,priority,evidence},recipient:'reader@example.invalid',referenceTime:today,category});
  const second=applyMailQuality({input,analysis:first,recipient:'reader@example.invalid',referenceTime:today,category});
  return{input,first,second};
}

test('reason-only conflicts never replace a correct summary on either quality pass',()=>{
  const body='訂閱服務已啟用，款項新臺幣1200元已收到。',summary='訂閱已啟用，款項已收到。';
  for(const [reason,issue]of [
    ['請再支付 USD 90。','currency-mismatch'],
    ['本次款項為9999元。','number-mismatch'],
    ['請查看附件完成設定。','attachment-unavailable'],
    ['referenceTime為今天。','model-metadata-in-summary']
  ]){
    const {first,second}=qualityCase(body,summary,reason,{category:'finance'});
    for(const result of [first,second]){
      assert(result.quality.issues.includes(issue),issue);assert.equal(result.summary,summary);
      assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,true);
      assert.deepEqual(result.evidence,[body]);assert.equal(result.priority,2);
      assert(!result.reason.includes('摘要或待辦'));
    }
    assert.deepEqual(second.sourceFacts,first.sourceFacts);
  }
});

test('omitted status wording and weak literal overlap are diagnostics rather than proof of a wrong gist',()=>{
  const body='您的會員服務已啟用。本信只是通知，目前無須行動。\n\n歡迎再次造訪。';
  const summary='這封信通知會員服務目前已經啟用。';
  const {first,second}=qualityCase(body,summary,'僅通知服務狀態，今天無待辦。',{evidence:['歡迎再次造訪。']});
  for(const result of [first,second]){
    assert(result.quality.issues.includes('no-action-status-missing'));assert(result.quality.issues.includes('evidence-unrelated'));
    assert.equal(result.summary,summary);assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,false);
  }
  const acknowledgement='收到成功\n\nOn September 16, 2026, Sender <sender@example.invalid> wrote:\n> 請提供專案資料。';
  const gist='本封是對已寄出的專案資料表示感謝。';
  const result=qualityCase(acknowledgement,gist,'對資料的致謝回信，今天無待辦。',{category:'work'});
  for(const pass of [result.first,result.second]){
    assert(pass.quality.issues.includes('latest-status-conflict'));assert.equal(pass.summary,gist);
    assert.equal(pass.quality.summaryMode,'generated');assert.equal(pass.quality.priorityReview,false);
  }
});

test('explicit duties still conflict with an acknowledged completion or an explicit no-action source',()=>{
  for(const body of [
    '您的設定已移轉，目前無須採取任何行動。',
    '收到成功\n\nOn September 16, 2026, Sender <sender@example.invalid> wrote:\n> 請提供專案資料。'
  ]){
    const {first,second}=qualityCase(body,'請再次提交資料。','需要再次提交資料。',{priority:1,category:'work'});
    for(const result of [first,second]){
      assert.equal(result.quality.summaryMode,'source-excerpts');assert.equal(result.quality.priorityReview,true);
      assert.notEqual(result.summary,'請再次提交資料。');
    }
  }
});

test('conditional-action claims are scoped to the faulty field without blocking descriptive mentions',()=>{
  for(const [body,description,duty]of [
    ['如果這次登入不是本人操作，請重設密碼。','本信為登入提醒，並提供密碼重設說明。','請立即重設密碼。'],
    ['如果商品有瑕疵，請提出申訴。','本信說明商品的申訴處理方式。','請提出申訴。']
  ]){
    const neutral=qualityCase(body,description,'是否符合處理條件尚未確認。');
    for(const result of [neutral.first,neutral.second]){
      assert(!result.quality.issues.includes('conditional-action-overstated'));assert.equal(result.summary,description);
      assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,true);
    }
    const reasonOnly=qualityCase(body,description,duty);
    for(const result of [reasonOnly.first,reasonOnly.second]){
      assert(result.quality.issues.includes('conditional-action-overstated'));assert.equal(result.summary,description);
      assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,true);
    }
    const summaryWrong=qualityCase(body,duty,'是否符合處理條件尚未確認。');
    for(const result of [summaryWrong.first,summaryWrong.second]){
      assert(result.quality.issues.includes('conditional-action-overstated'));assert.equal(result.quality.summaryMode,'source-excerpts');
      assert.equal(result.quality.priorityReview,true);assert.notEqual(result.summary,duty);
    }
  }
  const direct=qualityCase('商品已確認有瑕疵，請提出申訴。','請提出申訴。','請提出申訴。',{priority:1});
  assert(!direct.first.quality.issues.includes('conditional-action-overstated'));assert.equal(direct.first.quality.summaryMode,'generated');
});

test('questions and nominal uses of need do not turn a conditional-action gist into a directive',()=>{
  const cases=[
    ['如果這次登入不是本人操作，請重設密碼。','是否需要重設密碼取決於登入是否為本人操作。'],
    ['如果這次登入不是本人操作，請重設密碼。','本信提供重設密碼所需要的操作說明。'],
    ['如果商品有瑕疵，請提出申訴並提供照片。','本信說明申訴所需要的資料。']
  ];
  for(const [body,summary]of cases){
    const {first,second}=qualityCase(body,summary,'是否符合處理條件尚未確認。');
    for(const result of [first,second]){
      assert(!result.quality.issues.includes('conditional-action-overstated'),summary);
      assert.equal(result.summary,summary);assert.equal(result.quality.summaryMode,'generated');
      assert.equal(result.quality.priorityReview,true);
    }
  }
  for(const summary of ['你需要重設密碼。','是否需要協助，請立即重設密碼。']){
    const {first,second}=qualityCase(cases[0][0],summary,'是否符合處理條件尚未確認。');
    for(const result of [first,second]){
      assert(result.quality.issues.includes('conditional-action-overstated'),summary);
      assert.equal(result.quality.summaryMode,'source-excerpts');assert.notEqual(result.summary,summary);
    }
  }
});

test('a missing minimum-spend detail is advisory but an explicit waiver remains a scoped conflict',()=>{
  const body='優惠券50元，結帳時滿399元才能抵用。',gist='收到優惠券50元。';
  for(const summary of [gist,'優惠券50元並非無門檻，須滿399元才能使用。','優惠券50元，不是不限消費金額。']){
    const {first,second}=qualityCase(body,summary,'優惠資訊。',{category:'promotion'});
    for(const result of [first,second]){
      assert.equal(result.summary,summary);assert.equal(result.quality.summaryMode,'generated');
      assert.equal(result.quality.priorityReview,false);
    }
  }
  for(const claim of ['優惠券50元，不限消費金額即可使用。','優惠券50元，無最低消費門檻。','This coupon has no minimum spend.']){
    const wrongSummary=qualityCase(body,claim,'優惠資訊。',{category:'promotion'});
    for(const result of [wrongSummary.first,wrongSummary.second]){
      assert(result.quality.issues.includes('condition-missing'),claim);
      assert.equal(result.quality.summaryMode,'source-excerpts');assert.equal(result.quality.priorityReview,true);
      assert.notEqual(result.summary,claim);assert(result.summary.includes('滿399元'));
    }
    const wrongReason=qualityCase(body,gist,claim,{category:'promotion'});
    for(const result of [wrongReason.first,wrongReason.second]){
      assert(result.quality.issues.includes('condition-missing'),claim);assert.equal(result.summary,gist);
      assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,true);
    }
  }
});

test('future duties support a gist without becoming today duties or losing genuine conditions',()=>{
  const future='所有使用者請於明天重設密碼。',conditional='如果這次登入不是本人操作，請立即重設密碼。';
  const summary='本信通知需要重設密碼。';
  for(const [body,review]of [[future,false],[conditional+future,true]]){
    const {first,second}=qualityCase(body,summary,'明天才有例行重設作業。');
    for(const result of [first,second]){
      assert(!result.quality.issues.includes('conditional-action-overstated'));
      assert.equal(result.summary,summary);assert.equal(result.quality.summaryMode,'generated');
      assert.equal(result.quality.priorityReview,review);assert.equal(result.priority,2);
    }
  }
  const conditionalFuture='如果這次登入不是本人操作，請於明天重設密碼。';
  const faithful=qualityCase(conditionalFuture,conditionalFuture,'只有符合条件時才需處理。');
  for(const result of [faithful.first,faithful.second]){
    assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,false);
  }
  const overstated=qualityCase(conditionalFuture,'明天需要重設密碼。','明天才有待辦。');
  for(const result of [overstated.first,overstated.second]){
    assert(result.quality.issues.includes('conditional-action-overstated'));
    assert.equal(result.quality.summaryMode,'source-excerpts');assert.equal(result.priority,2);
  }
});

test('a generated consequence keeps the governing directive without making descriptive claims into duties',()=>{
  const body='請於取件完成後24小時內確認包裹商品，若有疑慮請至申訴網頁填寫止付款項。';
  const summary='請確認包裹商品內容是否正確無誤後，在取件完成後的24小時內進行申訴。';
  for(const claim of [summary,'請確認包裹商品，然後提出申訴。']){
    const {first,second}=qualityCase(body,claim,'請確認包裹商品。',{priority:1});
    for(const result of [first,second]){
      assert(result.quality.issues.includes('conditional-action-overstated'));
      assert.equal(result.quality.summaryMode,'source-excerpts');assert(result.summary.includes('若有疑慮'));
    }
  }
  for(const gist of ['本信通知應檢查包裹商品，並提供有疑慮時的申訴方式。','請確認包裹商品，提出申訴的方法可參閱原文。']){
    const {first,second}=qualityCase(body,gist,'請確認包裹商品。',{priority:1});
    for(const result of [first,second]){
      assert(!result.quality.issues.includes('conditional-action-overstated'));
      assert.equal(result.summary,gist);assert.equal(result.quality.summaryMode,'generated');
    }
  }
  const direct=qualityCase('請於取件完成後24小時內確認包裹商品並進行申訴。',summary,'請確認並提出申訴。',{priority:1});
  assert(!direct.first.quality.issues.includes('conditional-action-overstated'));assert.equal(direct.first.summary,summary);
});

test('optional unsubscribe footers cannot become duties but allow neutral and conditional summaries',()=>{
  const body='信用卡優惠資訊。\n\n收到此郵件是因為您是註冊會員，如欲取消訂閱，請點擊這裡。';
  const gist='通知信用卡優惠，並提供取消訂閱方式。';
  const claim='通知信用卡優惠。用戶需要確認是否為註冊會員並查看如何取消訂閱。';
  for(const summary of [gist,'如欲取消訂閱，請點擊信中的連結。','本信提供取消訂閱所需要的說明。']){
    const {first,second}=qualityCase(body,summary,'優惠資訊。',{category:'promotion'});
    for(const result of [first,second]){
      assert(!result.quality.issues.includes('conditional-action-overstated'));
      assert.equal(result.summary,summary);assert.equal(result.quality.summaryMode,'generated');
      // Preserve the existing review of this unresolved source condition;
      // the new guard must not turn its neutral mention into a summary error.
      assert.equal(result.quality.priorityReview,true);assert.equal(result.priority,2);
    }
  }
  const wrongSummary=qualityCase(body,claim,'優惠資訊。',{category:'promotion'});
  for(const result of [wrongSummary.first,wrongSummary.second]){
    assert(result.quality.issues.includes('conditional-action-overstated'));assert.equal(result.quality.summaryMode,'source-excerpts');
  }
  const wrongReason=qualityCase(body,gist,claim,{category:'promotion'});
  for(const result of [wrongReason.first,wrongReason.second]){
    assert(result.quality.issues.includes('conditional-action-overstated'));assert.equal(result.summary,gist);
    assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,true);
  }
  const direct=qualityCase('方案已完成移轉，請取消訂閱舊方案。','需要取消訂閱舊方案。','方案移轉通知。');
  assert(!direct.first.quality.issues.includes('conditional-action-overstated'));assert.equal(direct.first.quality.summaryMode,'generated');
});

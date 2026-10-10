'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {applyMailQuality,sourceFacts,currentRequests,verifiableImmediate}=require('../app/services/mail-quality.cjs');
const referenceTime='2026-09-17T10:00:00+08:00',date='2026-09-17T08:00:00+08:00';
const recipient='reader@example.invalid';
function inputFor(body,extra={}){
  return{id:'synthetic-deadline',subject:'合成來源',body,date,sender:'Synthetic sender',senderEmail:'sender@example.invalid',to:[recipient],cc:[],
    contentContext:{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:false},...extra};
}
function requests(body,extra={}){
  const input=inputFor(body,extra);
  return currentRequests(sourceFacts(input).facts,{date:input.date,referenceTime,identity:{senderIsRecipient:input.senderEmail===recipient}});
}
function assess(body,{priority=2,category='work',...extra}={}){
  const input=inputFor(body,extra);
  const analysis={summary:body,reason:'依原文記錄目前狀態。',priority,evidence:[body]};
  return applyMailQuality({input,analysis,recipient,referenceTime,category});
}
function review(body,expected,options){
  const result=assess(body,options);
  assert.equal(result.quality.issues.includes('priority-unverified'),expected,body);
  assert.equal(result.priority,options?.priority??2,'The check withholds a grade without inventing a replacement.');
  return result;
}

test('an event clock cannot borrow a reply action from an unrelated footer',()=>{
  for(const text of [
    '每週二12:00開搶優惠。\n\n此信為自動發送，請勿回覆。',
    '活動於今天12:00開始。請勿回覆這封通知。',
    '客服服務時間09:00至18:00。\n\n請勿直接回覆。',
    'Sale opens at 12:00. This is an automated email. Do not reply.',
    '活動今天12:00開始。\n\n如需協助，請回覆我們。'
  ])review(text,false,{category:'promotion'});
});

test('genuine current delivery deadlines remain doubtful when the model says no task, with or without please',()=>{
  for(const text of ['請今天17:00前交回資料。','今天17:00前交稿。','資料今天截止，提交定稿。','Please submit the report by today 17:00.']){
    review(text,true);review(text,true,{category:'promotion'});
  }
  const text='已報名成功，請今天17:00前回覆設備需求。';
  review(text,true,{category:'promotion'});
  review(text,false,{priority:0,category:'promotion'});
});

test('explicit adjacent deadline continuations remain attached to their action',()=>{
  for(const text of [
    '請交回資料。截止時間是今天17:00。',
    '請提交定稿。\n截止時間是今天17:00。',
    '請交回資料。\n\n上述任務期限為今天17:00。',
    '今天17:00前，請交回資料。',
    '期限為今天17:00。\n請提交資料。',
    'Please submit the report. Deadline: today 17:00.'
  ])review(text,true);
  assert.equal(verifiableImmediate('請交回資料。截止時間是今天17:00。',date,referenceTime),true);
});

test('explicitly negated, cancelled and completed actions are not active deadlines',()=>{
  for(const text of [
    '請今天17:00前不要回覆。',
    '今天17:00前不需交稿。',
    '原定今天17:00回覆已取消。',
    '請於今天17:00前交回資料。上述要求已取消。',
    '我已於今天17:00寄出報告。',
    '報告今天17:00已寄出。',
    'Do not reply by today 17:00.',
    'We have already sent the report today at 17:00.'
  ])review(text,false);
  review('會議已取消，請今天17:00前回覆新的可用時段。',true);
  review('請今天17:00前交稿，不需回覆這封信。',true);
});

test('future dates do not contradict no task today; an unresolved past deadline remains doubtful',()=>{
  for(const text of ['請於2026/10/20 17:00前回覆。','請於2027年9月17日17:00前交稿。','請於10/20 17:00前回覆。','請明天17:00前提交資料。','請下週17:00前提交資料。'])review(text,false);
  review('請於2026/09/16 17:00前回覆，目前尚未回覆。',true);
  review('請明天17:00前回覆。',true,{date:'2026-09-15T08:00:00+08:00'});
  review('請於今天或2026/10/20 17:00前回覆，日期尚待確認。',true);
});

test('conditional recipient work is uncertain rather than a verified immediate obligation',()=>{
  for(const text of ['如果由你負責，請今天17:00前交回資料。','若收到核准，今天17:00前提交定稿。','If approval arrives, please submit by today 17:00.']){
    review(text,true);review(text,true,{priority:0});
    assert.equal(verifiableImmediate(text,date,referenceTime),false);
  }
});

test('explicit third-party delivery and outgoing self commitments retain their distinct roles',()=>{
  for(const text of ['同事會今天17:00前寄出報告。','請同事今天17:00前回覆。','They will submit the report by today 17:00.','我會今天17:00前寄出報告。'])review(text,false);
  review('我會今天17:00前寄出報告。',true,{senderEmail:recipient,to:['other@example.invalid']});
  review('我已承諾今天17:00前交稿。',true,{senderEmail:recipient,to:['other@example.invalid']});
  review('我會今天17:00前寄出報告。',true,{senderEmail:''});
  review('同事會今天17:00前寄出報告。請你今天18:00前確認內容。',true);
});

test('purchase acknowledgments with optional detail and help links cannot verify a task',()=>{
  const bodies=[
    '感謝您的購買。\n\n如要檢視交易詳情，請造訪\n【網址】。\n\n此電子郵件是由系統自動產生。請勿回覆。如果您需要額外協助，請造訪商店客服。',
    'Thank you for your purchase. If you want to view transaction details, please visit our website.\n\nThis email is automated. Do not reply. If you need additional help, please contact customer support.'
  ];
  for(const body of bodies)for(const category of ['other','work','promotion']){
    const result=review(body,true,{priority:1,category});
    assert.equal(result.quality.priorityReview,true);
    assert.equal(result.quality.summaryMode,'generated');
    assert.equal(result.summary,body);
  }
});

test('optional self-service conditions stay attached across commas and wrapped lines',()=>{
  for(const body of [
    '如需協助，請聯絡客服。',
    '若您想查看訂單詳情，請造訪網站。',
    '如果需要額外協助，\n請造訪客服中心。',
    '如需協助，請聯絡客服，若您想查看交易詳情，請造訪網站。',
    'If you need further assistance,\nplease visit our help center.',
    'If you wish to view your receipt, please open your account page.',
    'If you need help, please contact support, if you want to view details, please visit our website.'
  ])review(body,true,{priority:1,category:'other'});
});

test('negated requests cannot verify a task or suppress a separate request',()=>{
  for(const body of ['請勿直接回覆。','請不要回覆這封信。','不需要回覆。','Please do not reply.','You are not required to reply.'])review(body,true,{priority:1});
  for(const body of [
    '請勿回覆這封通知，請提交報名表。',
    '請不要回覆但請確認付款資料。',
    '請勿回覆但須提交申請表。',
    'Please do not reply, but please submit the report.',
    'Please do not reply and please confirm your attendance.'
  ])review(body,false,{priority:1});
});

test('conditional work stays unresolved and does not verify an ordinary or no-task grade',()=>{
  for(const body of [
    '如果由你負責，請提交定稿。',
    '如果付款失敗，請聯絡客服。',
    '如需申請補助，請提交申請表。',
    'If approval arrives, please submit the report.',
    'If the payment fails, please contact support.',
    '如要檢視交易詳情，請造訪網站，並請確認金額。',
    '如需協助，請造訪客服並上傳身分證明。',
    '如需協助，請聯絡客服，並上傳身分證明。',
    '如要檢視交易詳情必須確認本人身分。',
    'If you need help, please visit support and upload your documents.',
    'If you need help, please contact support, and upload your documents.',
    'If you want to view your receipt you must confirm your identity.'
  ]){
    assert(requests(body).unresolvedConditional.length>0,body);
    assert.equal(requests(body).current.length,0,body);
    for(const priority of [1,2])review(body,true,{priority,category:'other'});
  }
  for(const body of ['如需協助，請聯絡客服。請回覆設備需求。','If you need help, please contact support; please submit the report.']){
    assert.equal(requests(body).unresolvedConditional.length,0);
    assert.equal(requests(body).current.length,1);
    review(body,false,{priority:1,category:'other'});
  }
});

test('decorated negations and optional inquiries cannot verify a current task',()=>{
  for(const body of [
    '※請勿直接回覆。',
    '• Please do not reply.',
    '* 請不要回覆。',
    '- You are not required to reply.',
    '若您有任何疑問，請聯絡客服。',
    '若對訂單明細有疑問，請查看線上說明。',
    '若欲查看完整資訊，請登入會員網站查看。',
    '若對交易明細有疑問或欲查看完整資訊，請至線上帳戶查看。',
    '若有疑問或您希望查閱收據，請前往會員中心。',
    '※請勿直接回覆此信，若對紀錄明細有疑問或欲查看完整資訊，請至網站 https://example.invalid/details 查看。'
  ]){
    const result=review(body,true,{priority:1,category:'other'});
    assert.equal(result.summary,body);
    assert.deepEqual(result.evidence,[body]);
    assert(result.sourceFacts.every(text=>('合成來源\n'+body).includes(text)));
  }
});

test('inquiry filtering retains conditional problem domains and work without claiming they occurred',()=>{
  for(const body of [
    '若對付款失敗有疑問，請聯絡客服。',
    '若對扣款異常或付款爭議有疑問，請聯絡客服。',
    '若對重複扣款有疑問，請聯絡客服。',
    '若對盜刷交易有疑問，請聯絡客服。',
    '若對未經同意的扣款有疑問，請聯絡客服。',
    '若付款失敗或欲查看明細，請聯絡客服。',
    '若有疑問，請至網站提交申請表。',
    '若有疑問，請至網站繳費。',
    '若有疑問，請登入系統驗證身分。',
    '若有疑問，請前往現場辦理申訴。',
    '如需協助，請登入系統修改收件地址。',
    '若有疑問，請至現場出示證件。',
    '若有疑問，請到門市領貨。',
    '若有疑問，請前往櫃台繳款。',
    '若有疑問，請至网站查看，並上傳身分證明。',
    '若有疑問，請登入網站查看並上傳身分證明。',
    '若有疑問，請至網站 https://example.invalid/help 並上傳身分證明。',
    'If you need help, please visit https://example.invalid/help and upload your documents.',
  ]){
    assert(requests(body).unresolvedConditional.length>0,body);
    for(const priority of [1,2])review(body,true,{priority,category:'other'});
  }
  for(const body of [
    '付款已失敗，請聯絡客服。',
    '若有疑問，請聯絡客服。請提交定稿。',
    '※請勿回覆，請上傳定稿。',
    '• Please do not reply, but please submit the report.',
    '若您有任何疑問？請提交異常報告。',
    'If you want to view details? Please upload your report.',
    'Was your payment rejected, or do you dispute the amount? Please submit a claim.'
  ])review(body,false,{priority:1,category:'other'});
});

test('request clauses preserve thousands separators and do not strip numeric prefixes',()=>{
  for(const body of [
    '如需協助，請查看 NT$1,250.50 並上傳付款證明。',
    'If you need help, please check US1,200 and upload your documents.',
    'If you need help, please check USD 1,250.50, and upload your documents.',
    '如需協助，請查看 NT$1,250.50，並上傳付款證明。',
    '若欲查看明細，請至網站查看 NT$1,250.50，請確認付款資料。'
  ]){
    assert(requests(body).unresolvedConditional.length>0,body);
    const result=review(body,true,{priority:1,category:'other'});
    assert.equal(result.summary,body);
    assert.deepEqual(result.evidence,[body]);
  }
  for(const body of ['- 請提交核銷資料。','1. 請提交核銷資料。'])review(body,false,{priority:1,category:'other'});
  review('※請於2026/09/21 17:00前提交核銷資料。',false,{priority:2,category:'other'});
  for(const body of [
    '如需協助，請查看 NT$1,250.50。',
    'If you need help, please check US1,200.',
    '如需協助，請查看 -NT$1,250.50 的明細。',
    '如需協助，請查看 2026/09/21 的明細。',
    '- 2026/09/21 交易金額為 -NT$1,250.50。'
  ]){
    const result=review(body,true,{priority:1,category:'other'});
    assert.equal(result.summary,body);
    assert.deepEqual(result.evidence,[body]);
    assert(result.sourceFacts.every(text=>('合成來源\n'+body).includes(text)));
  }
});

test('optional navigation cannot borrow a negated coordinated action or a later sentence',()=>{
  for(const body of [
    '如需協助，請至網站 https://example.invalid/help 並無須另行操作。',
    '如需協助，請至網站 https://example.invalid/help 並不要上傳任何文件。',
    '如需協助，請至網站，並無須另行操作。',
    '如需協助，請至網站，並不要上傳任何文件。',
    '如需協助，請至網站，並已完成上傳。',
    'If you need help, please visit https://example.invalid/help and do not upload any documents.',
    'If you need help, please visit our website, and do not reply.',
    '如需協助，請至網站 https://example.invalid/help。並不要上傳文件。'
  ]){
    const result=review(body,true,{priority:1,category:'other'});
    assert.equal(result.summary,body);
    assert.deepEqual(result.evidence,[body]);
  }
  for(const body of [
    '如需協助，請至網站 https://example.invalid/help 並不要回覆但請上傳定稿。',
    '如需協助，請至網站，並不要回覆但請上傳定稿。',
    '如需協助，請至網站 https://example.invalid/help 並上傳定稿。',
    '如需協助，請至網站，並修改收件地址。',
    'If you need help, please visit https://example.invalid/help and do not reply but please upload the report.'
  ]){
    assert(requests(body).unresolvedConditional.length>0,body);
    for(const priority of [1,2])review(body,true,{priority,category:'other'});
  }
  const independent='如需協助，請至網站 https://example.invalid/help 並無須另行操作。請上傳定稿。';
  assert.equal(requests(independent).unresolvedConditional.length,0);
  assert.equal(requests(independent).current.length,1);
  review(independent,false,{priority:1,category:'other'});
});

test('unproved conditions retain their scope and cannot endorse either ordinary work or no work',()=>{
  for(const body of [
    '如果您沒有請求此一次性動態密碼(OTP)，請立即更改您的密碼以保護帳戶安全。',
    '如果您的申請需要補件，請上傳文件。',
    '若客服人員已聯絡您，請回覆確認。',
    '若尚未完成身分驗證，\n請登入帳戶確認身分。',
    '如已申請退款，請提供收款帳戶。',
    'Please contact support if your payment fails.',
    'Unless you have already paid, please pay the invoice.',
    '付款已失敗。如果付款失敗，請聯絡客服。',
    '如果付款失敗，請至網站 https://example.invalid/help 申請協助。'
  ]){
    const state=requests(body);
    assert.equal(state.current.length,0,body);
    assert.equal(state.unresolvedConditional.length,1,body);
    assert(state.unresolvedConditional[0].condition.length>0);
    for(const priority of [1,2]){
      const result=review(body,true,{priority,category:'other'});
      assert.equal(result.summary,body);assert.deepEqual(result.evidence,[body]);
      assert.equal(result.quality.summaryMode,'generated');
    }
  }
});

test('verified current instructions remain separate from unresolved conditions',()=>{
  for(const body of [
    '付款已失敗，請聯絡客服。',
    '已由你負責，請提交定稿。',
    '已收到核准，請提交申請表。',
    '您已回報這次登入不是本人操作，請更改密碼。',
    '身分驗證尚未完成，請登入帳戶確認身分。',
    'Your payment failed. Please contact support.'
  ]){
    assert.equal(requests(body).current.length,1,body);
    assert.equal(requests(body).unresolvedConditional.length,0,body);
    review(body,false,{priority:1,category:'other'});
  }
  const mixed='如果付款失敗，請聯絡客服。請回覆本次會議的參加人數。';
  assert.equal(requests(mixed).current.length,1);
  assert.equal(requests(mixed).unresolvedConditional.length,1);
  for(const priority of [1,2])review(mixed,true,{priority,category:'other'});
  const immediate='請今天17:00前交回資料。如果不是您要求的登入驗證，請立即更改密碼。';
  assert.equal(requests(immediate).current.length,1);
  assert.equal(requests(immediate).unresolvedConditional.length,1);
  review(immediate,false,{priority:0});
});

test('inactive conditional actions cannot create uncertainty or consume later independent work',()=>{
  for(const body of [
    '如果付款失敗，請勿再次付款。',
    'If the payment fails, do not reply to this notification.',
    '如果付款失敗，請客服人員聯絡客戶。',
    '若付款失敗，客服人員將聯絡您。',
    '如果由你負責，請交回表單。上述要求已取消。',
    '如果付款失敗，請明天聯絡客服。',
    '如果付款失敗，請於2027/09/17聯絡客服。',
    '如果需要協助，請回覆我們。',
    'If you need help, please reply to this email.',
    '若對帳務明細有疑問或欲查看完整資訊，請至本行網路銀行 https://example.invalid/details 存款交易明細查看。',
    '如需協助，請至網站 https://example.invalid/help 並已完成上傳。'
  ]){
    assert.deepEqual(requests(body),{current:[],unresolvedConditional:[]},body);
    review(body,false,{priority:2,category:'other'});
    const later=body+'\n請提交目前的報告。';
    assert.equal(requests(later).current.length,1,later);
    assert.equal(requests(later).unresolvedConditional.length,0,later);
    review(later,false,{priority:1,category:'other'});
  }
});

test('request and application nouns do not become imperatives',()=>{
  for(const body of ['您的請求已完成。','您的申請已收到，無需另行操作。','您的请求已完成。']){
    assert.deepEqual(requests(body),{current:[],unresolvedConditional:[]},body);
    review(body,true,{priority:1,category:'other'});
    const later=body+'請上傳文件。';
    assert.equal(requests(later).current.length,1,later);
    review(later,false,{priority:1,category:'other'});
  }
  for(const body of ['請申請補助。','請求您協助上傳文件。']){
    assert.equal(requests(body).current.length,1,body);
    review(body,false,{priority:1,category:'other'});
  }
});

test('conditional ru prefixes retain uncertainty without matching descriptive ru words',()=>{
  for(const body of ['如非本人操作，請更改密碼。','如未收到款項，請聯絡客服。','如遇付款失敗，請重試。']){
    const state=requests(body);
    assert.equal(state.current.length,0,body);
    assert.equal(state.unresolvedConditional.length,1,body);
    for(const priority of [1,2])review(body,true,{priority,category:'other'});
  }
  for(const body of ['如期收到文件，請確認內容。','如下所述，請提交報告。']){
    const state=requests(body);
    assert.equal(state.current.length,1,body);
    assert.equal(state.unresolvedConditional.length,0,body);
    review(body,false,{priority:1,category:'other'});
  }
});

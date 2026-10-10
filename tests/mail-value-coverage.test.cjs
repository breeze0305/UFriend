'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {applyMailQuality}=require('../app/services/mail-quality.cjs');
const {requiredCurrentValueFragments}=require('../app/services/mail-value-coverage.cjs');
const input=body=>({id:'synthetic',subject:'合成通知',body,date:'2026-09-17T08:00:00+08:00',sender:'Sender',senderEmail:'sender@example.invalid',to:['reader@example.invalid'],cc:[]});
function analyze(body,summary){
  return applyMailQuality({input:input(body),analysis:{summary,reason:'僅通知，無須行動。',priority:2,evidence:[body.split('\n')[0]]},recipient:'reader@example.invalid',referenceTime:'2026-09-17T09:00:00+08:00',category:'finance'});
}
test('support numbers and routine opening hours do not invalidate a complete payment summary',()=>{
  for(const ending of ['客服電話02-87654321；服務時間09:00–18:00。','\n\n客服專線：02-87654321\n客服時間\n09:00–18:00']){
    const result=analyze('已收到款項 NT$500。'+ending,'已收到款項 NT$500。');
    assert.equal(result.quality.summaryMode,'generated');
    assert(!result.quality.issues.includes('missing-important-facts'));
  }
});
test('an omitted amount remains available without replacing the payment-status gist',()=>{
  const result=analyze('已收到款項 NT$500，客服專線02-87654321，服務時間09:00–18:00。','款項已收到。');
  assert(result.quality.issues.includes('missing-important-facts'));
  assert.equal(result.quality.summaryMode,'generated');assert.equal(result.summary,'款項已收到。');
  assert.equal(result.quality.priorityReview,false);assert(result.sourceFacts.some(text=>text.includes('NT$500')));
});
test('a completed latest message does not have to repeat monetary values from prior correspondence',()=>{
  const body='已收到付款，目前無須採取任何行動。\n\nOn September 16, 2026, Sender <sender@example.invalid> wrote:\n請支付 NT$500。';
  const result=analyze(body,'已收到付款，目前無須採取任何行動。');
  assert.equal(result.quality.summaryMode,'generated');
  assert(!result.quality.issues.includes('missing-important-facts'));
});
test('omitted latest prices and dates are diagnostics without being summary failures',()=>{
  const body='退款金額改為 NT$700，退款日為2026/09/18。\n\nOn September 16, 2026, Sender <sender@example.invalid> wrote:\n退款 NT$500。';
  for(const summary of ['退款金額改為 NT$700。','退款日為2026/09/18。']){
    const result=analyze(body,summary);assert(result.quality.issues.includes('missing-important-facts'));
    assert.equal(result.summary,summary);assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,false);
  }
});
test('typed values retain event times and support deadlines without collecting contact identifiers',()=>{
  assert.deepEqual(requiredCurrentValueFragments('客服時間09:00–18:00，請於17:30前提交申請。'),['17:30']);
  assert.deepEqual(requiredCurrentValueFragments('客服時間09:00–18:00。\n會議14:30開始。'),['14:30']);
  assert.deepEqual(requiredCurrentValueFragments('付款 NT$500，電話02-87654321，地址18號。'),['NT$500']);
  assert.deepEqual(requiredCurrentValueFragments('會議2026/09/18 14:30，請於13:45前報到。'),['2026/09/18','14:30','13:45']);
});
test('currency prefixes and multiple minimum spends remain diagnostic rather than mandatory summary details',()=>{
  for(const amount of ['$300','NT$300','TWD 300','新臺幣300','€300','300元']){
    const body='消費滿 '+amount+' 才能使用優惠券。';
    const result=applyMailQuality({input:input(body),analysis:{summary:'優惠券已發放。',reason:'優惠資訊。',priority:2,evidence:[body]},category:'promotion'});
    assert(result.quality.issues.includes('condition-missing'),amount);
    assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,false);
  }
  const body='消費滿 $300 可用甲券。單筆消費滿 $299 可用乙券。';
  const result=applyMailQuality({input:input(body),analysis:{summary:'消費滿 $300 可使用優惠券。',reason:'優惠資訊。',priority:2,evidence:[body]},category:'promotion'});
  assert(result.quality.issues.includes('condition-missing'));
  assert.equal(result.summary,'消費滿 $300 可使用優惠券。');assert.equal(result.quality.summaryMode,'generated');
  assert(result.sourceFacts.some(text=>text.includes('$299')));
});
test('telephone and identifier separators are not interpreted as calendar dates',()=>{
  for(const other of ['電話02-12-34-56。','訂位代號AB12-24CD。']){
    const result=analyze('已收到款項 NT$500。'+other,'已收到款項 NT$500。');
    assert(!result.quality.issues.includes('missing-important-facts')),other;
  }
  assert.deepEqual(requiredCurrentValueFragments('退款日期2026/09/18；活動期間9/18-9/20；錯誤識別34/56。'),['2026/09/18','9/18-9/20']);
});
test('currency units before and after an amount have the same missing-value protection',()=>{
  for(const amount of ['新臺幣700','新台幣700','700 TWD','700 USD','TWD700']){
    const result=analyze('退款金額為'+amount+'。','已確認退款。');
    assert(result.quality.issues.includes('missing-important-facts'),amount);
  }
});

test('shop names, age ranges, ticket codes and routine contact windows are not mandatory dates or deadlines',()=>{
  for(const [body,summary] of [
    ['訂單已確認，總額 NT$500。\n\n取件地點：7-11 統一便利商店。','訂單已確認，總額 NT$500，於統一便利商店取件。'],
    ['付款已收到 NT$500。\n\n會員方案適用3-11歲兒童。','付款已收到 NT$500，會員方案適用三到十一歲兒童。'],
    ['付款已收到 NT$500。\n\n簽註 / Endorsements: /C1*3-4 NONEND/ -BG ZZ','付款已收到 NT$500。'],
    ['訂單已確認，總額 NT$500。\n\n任何問題，歡迎與我們聯繫(週一至週五，09:00~18:00\n例假日休息)。','訂單已確認，總額 NT$500。'],
  ]){
    assert.deepEqual(requiredCurrentValueFragments(body),['NT$500']);
    const result=applyMailQuality({input:{...input(body),subject:'合成訂單通知'},analysis:{summary,reason:summary,priority:2,evidence:[body]},category:'finance'});
    assert(!result.quality.issues.includes('missing-important-facts'),body);
    assert.equal(result.quality.summaryMode,'generated');
  }
});

test('hyphenated dates with calendar context and deadlines near contact information still remain required',()=>{
  assert.deepEqual(requiredCurrentValueFragments('會議日期9-18 14:30。\n請於9-17前回覆。'),['9-18','14:30','9-17']);
  assert.deepEqual(requiredCurrentValueFragments('活動適用3-11歲兒童，日期9/18-9/20。'),['9/18-9/20']);
  assert.deepEqual(requiredCurrentValueFragments('歡迎與我們聯繫(週一至週五，09:00~18:00)。\n請於17:30前提交，款項NT$500。'),['17:30','NT$500']);
  assert.deepEqual(requiredCurrentValueFragments('退款金額 NT$500。\n\n退款日期：\n9-18'),['NT$500','9-18']);
  assert.deepEqual(requiredCurrentValueFragments('付款已收到 NT$500。\n\nPlease contact us Monday-Friday 09:00-18:00.'),['NT$500']);
  assert.deepEqual(requiredCurrentValueFragments('Customer service hours 09:00-18:00; meeting starts at 17:30.'),['17:30']);
  assert.deepEqual(requiredCurrentValueFragments('Customer service hours 09:00-18:00; please submit the form by 17:30.'),['17:30']);
});

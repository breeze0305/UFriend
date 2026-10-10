'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {applyMailQuality,sourceFacts,criticalSourceText}=require('../app/services/mail-quality.cjs');
const time='2026-09-17T10:00:00+08:00';
const mail=(body,extra={})=>({id:'synthetic-quality',subject:'合成通知',body,date:'2026-09-17T08:00:00+08:00',sender:'Sender',senderEmail:'sender@example.invalid',to:['reader@example.invalid'],cc:[],contentContext:{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:false},...extra});
function run(input,summary,{reason=summary,priority=1,category='work',evidence=[input.body]}={}){
  return applyMailQuality({input,analysis:{summary,reason,priority,evidence,meta:{backend:'fixture'}},recipient:'reader@example.invalid',referenceTime:time,category});
}
function literalFacts(input,result){
  assert(result.summary.length<=2000);assert(result.sourceFacts.length<=32);
  assert(result.sourceFacts.every(text=>text.length<=1000&&(input.body.includes(text)||input.subject.includes(text))));
  assert(result.evidence.every(text=>input.body.includes(text)||input.subject.includes(text)));
}

test('a new currency cannot be introduced while literal source excerpts remain available',()=>{
  const input=mail('秋季票價 TWD 18008 起，活動至2026/09/20。');const result=run(input,'機票18008美元起。',{category:'promotion'});
  assert(result.quality.issues.includes('currency-mismatch'));assert.equal(result.quality.summaryMode,'source-excerpts');
  assert(!result.summary.includes('美元'));assert(result.summary.includes('TWD 18008'));assert.equal(result.quality.priorityReview,true);literalFacts(input,result);
});
test('correct currency and supplied numbers are retained without claiming semantic verification',()=>{
  const input=mail('交易金額 TWD 1200。');const result=run(input,'交易金額為新台幣1200。',{category:'finance',priority:2});
  assert(!result.quality.issues.includes('currency-mismatch'));assert(!result.quality.issues.includes('number-mismatch'));assert.equal(result.quality.summaryMode,'generated');assert.equal(result.summary,'交易金額為新台幣1200。');
});
test('an invented numeric value is not accepted because unrelated source URLs contain it',()=>{
  const input=mail('應付金額 TWD 420。連結 https://example.invalid/99999');const result=run(input,'應付金額 TWD 99999。');
  assert(result.quality.issues.includes('number-mismatch'));assert(!result.summary.includes('99999'));literalFacts(input,result);
});
test('booking references and departure clocks cannot be relabelled as flight numbers or durations',()=>{
  const input=mail('訂位代號 / Booking ref : SYNTH7\n\n航班 XY101，出發19:50；飛行時間 / Duration : 11:10。');
  const result=run(input,'航班SYNTH7，飛行時間19:50。');
  assert(result.quality.issues.includes('identifier-mismatch'));assert(result.quality.issues.includes('duration-mismatch'));
  assert(result.summary.includes('XY101'));assert(result.summary.includes('Duration : 11:10'));literalFacts(input,result);
});
test('checked baggage counts do not justify changing the explicit carry-on allowance',()=>{
  const input=mail('Checked Baggage : 2PC\n\n手提行李 / CARRY-ON BAG: AAABBB: MAX 1PC\n\nLB=重量');
  const result=run(input,'可攜帶手提行李2件。');assert(result.quality.issues.includes('number-mismatch'));literalFacts(input,result);
});
test('thousands of stores cannot silently become tens of stores',()=>{
  const input=mail('Shop at 50k+ Stores.');const result=run(input,'可於50家商店購買。',{category:'promotion'});
  assert(result.quality.issues.includes('number-mismatch'));assert(result.summary.includes('50k+ Stores'));literalFacts(input,result);
});
test('omitted arrival details are advisory while an invented security duty stays protected',()=>{
  let input=mail('請於收到包裹到店簡訊後7天內取件，取件後24小時內驗貨。');
  const summary='收到通知後7天內取件，24小時內驗貨。';
  let result=run(input,summary);assert(result.quality.issues.includes('condition-missing'));assert.equal(result.summary,summary);
  assert.equal(result.quality.summaryMode,'generated');assert(result.sourceFacts.some(text=>text.includes('到店簡訊後7天')));
  input=mail('如果這不是您的登入，請立即重設密碼。');result=run(input,'需要立即重設密碼。',{priority:0,category:'account'});
  assert(result.quality.issues.includes('condition-missing'));assert(result.quality.issues.includes('conditional-action-overstated'));assert(result.summary.includes('如果'));assert.equal(result.quality.priorityReview,true);literalFacts(input,result);
});
test('latest acknowledgement is kept before historical quoted requests',()=>{
  const input=mail('收到成功\n\nSender <sender@example.invalid>於 2026年9月16日寫道：\n\n> 請提供薪資資料，金額3000元。');
  const result=run(input,'需要提供薪資資料，金額3000元。');
  assert(result.quality.issues.includes('latest-status-conflict'));assert(result.summary.startsWith('最新內容：收到成功'));assert(result.summary.includes('往來引文：'));literalFacts(input,result);
});
test('an outbound request does not become an obligation for its author',()=>{
  const input=mail('再麻煩確認資料。',{senderEmail:'reader@example.invalid',to:['other@example.invalid']});const result=run(input,'再麻煩確認資料。');
  assert.equal(result.priority,1);assert.equal(result.quality.priorityReview,true);assert.match(result.reason,/核對/);
  const self=run({...input,to:['reader@example.invalid']},'再麻煩確認資料。');assert(!self.reason.includes('本人寄給對方'));
});
test('missing image text keeps the subject rather than replacing it with a service footer',()=>{
  const input=mail('系統自動發送；若有疑義請致電客服專線。',{subject:'合成防詐新服務說明',contentContext:{attachmentCount:0,unreadImageCount:3,imageTextUnavailable:true,textLimited:true}});
  const result=run(input,'請查看附件了解服務。',{category:'account'});
  assert(result.quality.issues.includes('attachment-unavailable'));assert(result.quality.issues.includes('image-text-unavailable'));
  assert(result.summary.includes('合成防詐新服務說明'));assert(!result.summary.includes('附件'));assert.equal(result.quality.priorityReview,true);literalFacts(input,result);
});
test('real attachments and a short text-only acknowledgement are not called missing images',()=>{
  const input=mail('請查看附件。',{contentContext:{attachmentCount:1,unreadImageCount:0,imageTextUnavailable:false,textLimited:true}});
  const result=run(input,'請查看附件。');assert(!result.quality.issues.includes('attachment-unavailable'));assert.equal(result.quality.imageTextUnavailable,false);assert.equal(result.quality.attachmentTextUnavailable,true);
});
test('a model urgency claim needs a current explicit action and clock deadline',()=>{
  let input=mail('請於今天14:30前回覆資料。');let result=run(input,input.body,{priority:0});assert.equal(result.quality.priorityReview,false);
  input=mail('請於今天14:30前回覆資料。',{date:'2026-09-01T08:00:00+08:00'});result=run(input,input.body,{priority:0});assert.equal(result.quality.priorityReview,true);assert(result.quality.issues.includes('priority-unverified'));
});
test('an already paid receipt is not a demand to pay again; unpaid invoices remain distinct',()=>{
  let input=mail('Thank you for your purchase. Payment was successful. TWD 1200.',{subject:'Your receipt'});let result=run(input,'付款成功，金額TWD 1200。',{category:'finance'});assert.equal(result.priority,1);assert.equal(result.quality.priorityReview,true);
  input=mail('尚未付款，請於今天14:30前支付1200元。',{subject:'付款通知'});result=run(input,input.body,{category:'finance',priority:0});assert.equal(result.priority,0);assert.equal(result.quality.priorityReview,false);
});
test('missing dates, amounts and exceptions remain visible as source facts',()=>{
  const input=mail('請於2026/09/20前取件。\n\n取件後24小時內驗貨；若週三或週日取件，最晚於隔日9:30前申訴。\n\n訂單總額 NT$6500。');const result=run(input,'請於2026/09/20前取件。',{category:'finance'});
  assert(result.quality.issues.includes('missing-important-facts'));for(const value of ['24小時','週三或週日','9:30','NT$6500'])assert(result.sourceFacts.some(text=>text.includes(value)));literalFacts(input,result);
});
test('source excerpts and review issues survive a second classification pass',()=>{
  const input=mail('活動票價 TWD 18008。');const first=run(input,'票價18008美元。',{category:undefined});
  const second=applyMailQuality({input,analysis:first,recipient:'reader@example.invalid',referenceTime:time,category:'promotion'});
  assert(second.quality.issues.includes('currency-mismatch'));assert.equal(second.quality.summaryMode,'source-excerpts');assert.equal(second.quality.priorityReview,true);literalFacts(input,second);
});
test('source fact retention is bounded, Unicode-safe and never splices across omitted URLs',()=>{
  const input=mail(Array.from({length:50},(_,i)=>`第${i}筆金額TWD ${i+100}。`+'中🙂'.repeat(320)+' https://example.invalid/path/'+i+' 後段原文。').join('\n\n'));
  const result=run(input,'共有資料。');literalFacts(input,result);assert.equal(result.sourceFacts.length,32);
  for(const text of result.sourceFacts)assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text));
  assert.equal(sourceFacts(input).truncated,true);
});
test('retention signals preserve negations and dates without declaring the recipient has a task',()=>{
  for(const text of ['已取消，今天無須回覆。','請於收到到店簡訊後7日內取件。','Flight XY101 2026/12/24 19:50','Total TWD 1200'])assert.equal(criticalSourceText(text),true);
  for(const text of ['[【網址】]','背景資料格式說明。','Copyright 2026. All rights reserved.'])assert.equal(criticalSourceText(text),false);
});

test('implicit deadlines and outgoing self commitments are never downgraded by absent request keywords',()=>{
  for(const input of [mail('今天14:30前交回設計稿。'),mail('我會今天14:30前寄設計稿。',{senderEmail:'reader@example.invalid',to:['other@example.invalid']})]){
    const actionable=run(input,input.body,{priority:1});assert.equal(actionable.priority,1);
    const overlooked=run(input,input.body,{priority:2});assert.equal(overlooked.quality.priorityReview,true);
  }
});

test('marketing and receipt categories cannot erase separately requested work',()=>{
  const promotion=mail('已報名成功，請今天14:30前回覆設備需求。');
  assert.equal(run(promotion,promotion.body,{category:'promotion',priority:0}).priority,0);
  assert.equal(run(promotion,promotion.body,{category:'promotion',priority:2}).quality.priorityReview,true);
  const receipt=mail('Payment successful. Please upload identity documents.',{subject:'Receipt'});
  assert.equal(run(receipt,receipt.body,{category:'finance',priority:1}).priority,1);
});

test('an explicit current deadline conflicts with an informational model grade',()=>{
  const input=mail('請於今天14:30前回覆資料。'),result=run(input,input.body,{priority:2});
  assert.equal(result.quality.priorityReview,true);assert(result.quality.issues.includes('priority-unverified'));
});

test('image limitations remain visible even when a long footer supplies enough text',()=>{
  const input=mail('一般說明。'.repeat(40),{contentContext:{attachmentCount:0,unreadImageCount:4,imageTextUnavailable:true,textLimited:false}});
  const result=run(input,'一般說明。',{priority:2});assert.equal(result.quality.imageTextUnavailable,true);assert.equal(result.quality.contentLimited,false);
});

test('an attachment warning in the source cannot justify an invented attached document',()=>{
  const input=mail('請勿開啟不明附件。'),result=run(input,'請查看附件了解細節。');
  assert(result.quality.issues.includes('attachment-unavailable'));assert.equal(result.quality.priorityReview,true);
});

test('adjacent source table cells fit in bounded literal excerpts including the final leg',()=>{
  const cells=Array.from({length:75},(_,i)=>'表格欄位'+i+'：'+(i+1));
  cells.push('回程航班 AB203','23:30 出發','05:40 抵達');
  const input=mail(cells.join('\n\n')),result=run(input,'部分表格資料。');
  const text=result.sourceFacts.join('\n');for(const fact of cells)assert(text.includes(fact));
  assert(result.sourceFacts.length<10);literalFacts(input,result);
});

test('dense quoted history cannot evict the latest acknowledgement from facts or excerpts',()=>{
  const history=Array.from({length:40},(_,i)=>'請於2026/09/17 14:30前付款 TWD '+(i+100)+'。'+'重要原文'.repeat(190)).join('\n\n');
  const input=mail('收到成功\n\nOn September 16, 2026, Author <author@example.invalid> wrote:\n\n'+history);
  const result=run(input,'請於2026/09/17 14:30前付款。',{priority:0});
  assert(result.sourceFacts.some(text=>text.startsWith('收到成功')));assert(result.summary.startsWith('最新內容：收到成功'));literalFacts(input,result);
});

test('a support contact in the same paragraph does not suppress a real payable amount',()=>{
  const input=mail('應繳 1000 元。若有疑義請洽客服專線。'),result=run(input,'一般資訊。');
  assert(result.sourceFacts.some(text=>text.includes('應繳 1000 元')));assert(criticalSourceText(input.body));literalFacts(input,result);
});

test('invisible preview padding does not exhaust the excerpt budget',()=>{
  const input=mail('Subscription receipt '+('͏‌ '.repeat(200))+'\n\nPayment received 78.60.\n\n24 months + 3 months extra.');
  const result=run(input,'已付款。');assert(result.sourceFacts.some(text=>text.includes('78.60')));
  assert(result.sourceFacts.every(text=>text.length<200));literalFacts(input,result);
});

test('attachment-only messages do not invent an account change from an email address',()=>{
  const input=mail('reader@example.invalid',{subject:'Travel info',contentContext:{attachmentCount:2,unreadImageCount:0,imageTextUnavailable:false,textLimited:true}});
  const result=run(input,'您的電子郵件地址已更新。');assert.equal(result.quality.summaryMode,'source-excerpts');
  assert(result.summary.includes('Travel info'));assert(!result.summary.includes('已更新'));assert.equal(result.quality.priorityReview,true);literalFacts(input,result);
});

test('an explicit no-action status and safety prohibition must not disappear from generated text',()=>{
  let input=mail('您的設定已移轉。您目前不必採取任何行動。');let result=run(input,'您的設定已移轉，請查看設定。');
  assert(result.quality.issues.includes('no-action-status-missing'));assert(result.summary.includes('不必採取任何行動'));
  input=mail('安全提醒：請切勿充電、擠壓或使用。建議妥善包裝交由回收。');result=run(input,'建議妥善包裝交由回收。');
  assert(result.quality.issues.includes('safety-instruction-missing'));assert(result.summary.includes('切勿充電'));literalFacts(input,result);
});

test('a coupon gist may omit minimum-spend details without claiming no conditions exist',()=>{
  const input=mail('電子書優惠券50元，結帳時滿399元即可抵用，每券限用一次。');
  const result=run(input,'收到電子書優惠券50元。',{category:'promotion',priority:2});
  assert(result.quality.issues.includes('condition-missing'));assert.equal(result.summary,'收到電子書優惠券50元。');
  assert.equal(result.quality.summaryMode,'generated');assert.equal(result.quality.priorityReview,false);
  assert(result.sourceFacts.some(text=>text.includes('滿399元')));literalFacts(input,result);
});

test('a model grade conflicts with its own explicit no-action reason',()=>{
  const input=mail('若非您本人操作，請修改密碼。');
  const result=run(input,input.body,{priority:1,reason:'此為系統通知，並未要求行動或確認。'});assert.equal(result.quality.priorityReview,true);
});

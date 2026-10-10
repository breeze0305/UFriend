'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sourceFacts,applyMailQuality}=require('../app/services/mail-quality.cjs');
const mail=body=>({subject:'Synthetic notice',body});
const url=index=>'[https://example.invalid/'+index+'/'+'x'.repeat(1200)+']';
function excerpts(input){return applyMailQuality({input,analysis:{summary:'',priority:2,reason:'',quality:{summaryMode:'source-excerpts'}}});}
function checkLiteral(input,result){
  assert(result.sourceFacts.length<=32);assert(result.summary.length<=1900);
  assert(result.sourceFacts.every(text=>text.length<=1000&&(input.body.includes(text)||input.subject.includes(text))));
}
function flightCards(count,{wide=false}={}){
  return Array.from({length:count},(_,i)=>{
    const pad=wide?'合成地名'.repeat(20):'';
    const cells=['出發城市'+pad,'目的城市'+i+pad,'航空公司'+i+pad,`11\n月 ${i+1} 日 週一 - 11 月 ${i+2} 日 週二`,`TWD${i+10001} 起`];
    return{cells,body:'flight\n'+url(i)+'\n\n'+cells.map((cell,j)=>cell+url(i+'-'+j)).join('\n\n')};
  });
}

test('linked flight cards retain complete route, carrier, dates and price under the fact limit',()=>{
  const cards=flightCards(12),input=mail('限時活動\n\n【9/17 12:00 開搶】\n\nimage description\n'+url('banner')+'\n\n'+cards.map(c=>c.body).join('\n\n'));
  const result=excerpts(input),joined=result.sourceFacts.join('\n');
  assert(result.summary.includes('9/17 12:00 開搶'));assert(!result.sourceFacts.some(text=>text==='image description'||text==='flight'));
  let retained=0;
  for(const {cells} of cards){
    const priceKept=joined.includes(cells.at(-1));
    if(priceKept){retained++;for(const cell of cells)assert(joined.includes(cell),'retained price lost its card cell: '+cell);}
    else for(const cell of cells.slice(1))assert(!joined.includes(cell),'incomplete card left a stray cell: '+cell);
  }
  assert(retained>=4);assert.equal(sourceFacts(input).truncated,true);checkLiteral(input,result);
});

test('the summary budget keeps linked cards whole instead of emitting an isolated amount',()=>{
  const cards=flightCards(12,{wide:true}),input=mail('活動\n\n'+cards.map(c=>c.body).join('\n\n')),result=excerpts(input);
  assert(result.summary.includes(cards[0].cells.at(-1)));
  for(const {cells}of cards){const included=cells.slice(1).map(text=>result.summary.includes(text));assert(included.every(Boolean)||included.every(value=>!value),'summary split a linked card');}
  checkLiteral(input,result);
});

test('linked product names remain paired with their own prices and never the next product',()=>{
  const cards=Array.from({length:14},(_,i)=>({name:'合成產品名稱'+i,price:'TWD'+(51001+i)+' 起'}));
  const input=mail('商品資訊\n\n'+cards.map(({name,price},i)=>name+url(i)+'\n\n'+name+url(i+'copy')+'\n\n規格示例'+url(i+'spec')+'\n\n'+price).join('\n\n'));
  const result=excerpts(input),joined=result.sourceFacts.join('\n');
  for(let i=0;i<cards.length;i++){
    const {name,price}=cards[i];if(joined.includes(price))assert(joined.includes(name));
    if(i<cards.length-1)assert(!result.sourceFacts.some(text=>text.includes(price)&&text.includes(cards[i+1].name)));
  }
  assert(result.sourceFacts.some(text=>text.includes(cards[0].price)));checkLiteral(input,result);
});

test('repeated baggage values remain attached to every retained route',()=>{
  const value='免費 UP TO 50LB 23KG N 62LI 158LCM';
  const rows=['甲地 到 乙地 第一件 託運行李 （2 件） FREE BAGGAGE ALLOWANCE:','丙地 到 丁地 第一件 託運行李 （2 件） FREE BAGGAGE ALLOWANCE:'];
  const input=mail('行李規定\n\n'+rows.map(row=>row+'\n\n'+value).join('\n\n')),result=excerpts(input);
  for(const row of rows)assert(result.sourceFacts.some(text=>text.includes(row)&&text.includes(value)));
  assert.equal(result.summary.split(value).length-1,2);checkLiteral(input,result);
});

test('three flight legs, payment total and baggage survive long receipt boilerplate',()=>{
  const legs=Array.from({length:3},(_,i)=>`ORIGIN${i} Terminal: A DESTINATION${i} Terminal: B XY${i+101} 19:50\n24Dec2026 21:30\n24Dec2026\n\n飛行時間 / Duration : 01:40`);
  const legal=Array.from({length:24},(_,i)=>'條款 '+i+'：If you change your booking, additional charges may apply. '+('一般說明內容。'.repeat(32))).join('\n\n');
  const input=mail('電子機票收據\n\n'+legs.join('\n\n')+'\n\n總額 / Total Amount: TWD 24680\n\n'+legal+'\n\n手提行李 / CARRY-ON BAG: AAABBB: MAX 1PC CARRY7KG\n\n託運行李 / Checked Baggage: 2PC UP TO 23KG'),result=excerpts(input);
  for(const token of ['XY101','XY102','XY103','TWD 24680','MAX 1PC','2PC UP TO 23KG'])assert(result.summary.includes(token),'missing receipt fact '+token);
  checkLiteral(input,result);
});

test('an image label followed by unrelated prose is not treated as a linked route record',()=>{
  const input=mail('image description\n'+url('image')+'\n\n說明甲\n'+url('a')+'\n\n說明乙\n'+url('b')+'\n\n說明丙\n'+url('c')+'\n\nTWD 7500'),source=sourceFacts(input);
  assert(source.facts.every(item=>item.group===undefined));assert(source.facts.some(item=>item.text.includes('TWD 7500')));
});

test('omitting separate phone and copyright footer numbers does not invalidate a correct payment summary',()=>{
  const summary='已收到款項 NT$500。';
  for(const footer of ['客服專線：02-87654321','Copyright:2026','版權所有：2024–2026']){
    const input=mail(summary+'\n\n'+footer),source=sourceFacts(input);
    assert.equal(source.truncated,false);assert.equal(source.candidates.find(item=>item.text===footer)?.critical,false);
    const result=applyMailQuality({input,analysis:{summary,reason:summary,priority:2,evidence:[summary]},category:'finance'});
    assert.equal(result.quality.summaryMode,'generated');assert(!result.quality.issues.includes('missing-important-facts'));assert.equal(result.summary,summary);
    checkLiteral(input,result);
  }
});

test('payment amounts and real deadlines remain essential when a support contact shares their paragraph',()=>{
  for(const body of ['客服專線：02-87654321；應付款 NT$500。','客服專線：02-87654321；應付款 500 TWD。','請於2026/09/18 14:00前回覆資料；客服專線：02-87654321。']){
    const input=mail(body),source=sourceFacts(input),result=excerpts(input);
    assert(source.facts.some(item=>item.critical&&item.text===body));assert(result.summary.includes(body));checkLiteral(input,result);
  }
});

test('source passage capacity alone does not replace a correct promotional summary or flag its priority',()=>{
  const summary='每週二12:00開搶，日韓機票最高折 $1,300。',input=mail(summary+'\n\n'+flightCards(12).map(card=>card.body).join('\n\n'));
  const analysis={summary,reason:'促銷資訊。',priority:2,evidence:[summary]};
  const result=applyMailQuality({input,analysis,category:'promotion'});
  assert.equal(result.quality.sourceFactsTruncated,true);assert.equal(result.quality.summaryMode,'generated');
  assert.equal(result.quality.priorityReview,false);assert.deepEqual(result.quality.issues,[]);assert.equal(result.summary,summary);
  const short=applyMailQuality({input:mail('活動資訊。'),analysis:{summary:'活動資訊。',priority:2,quality:{sourceFactsTruncated:true}},category:'promotion'});
  assert.equal(short.quality.sourceFactsTruncated,false,'The marker is recomputed locally.');
  const rebuilt=excerpts(input);assert.equal(rebuilt.quality.summaryMode,'source-excerpts');assert(rebuilt.summary.includes(summary));checkLiteral(input,rebuilt);
});

test('missing amounts and deadlines remain visible without replacing a neutral gist',()=>{
  for(const body of ['應付金額 NT$800。','請於2026/09/18 15:30前回覆。']){
    const result=applyMailQuality({input:mail(body),analysis:{summary:'收到通知。',reason:'需要查看。',priority:2},category:'finance'});
    assert(result.quality.issues.includes('missing-important-facts'));assert.equal(result.quality.summaryMode,'generated');assert.equal(result.summary,'收到通知。');
    assert(result.sourceFacts.includes(body));
  }
});

test('a condition and action separated by tracking links remain one retained passage',()=>{
  const body='登入失敗，若非您本人操作，請至個人資料'+url('account')+'修改您的密碼，並聯絡服務中心'+url('support')+'告知異常情況。';
  const input=mail(body),result=excerpts(input),source=sourceFacts(input);
  for(const text of ['若非您本人操作','修改您的密碼','告知異常情況'])assert(result.summary.includes(text));
  const members=source.facts.filter(item=>item.origin==='current');assert.equal(new Set(members.map(item=>item.group)).size,1);
  checkLiteral(input,result);
});

test('wrapped long conditional sentences retain the condition before the consequence',()=>{
  const condition='若本次驗證已通過 '+('合成驗證方式、'.repeat(26))+'驗證服務',consequence='，您將無需出示付款憑證。';
  const input=mail(condition+'\n'+url('verify')+consequence+'\n\n'+flightCards(12).map(card=>card.body).join('\n\n')),result=excerpts(input);
  assert(result.summary.includes(condition));assert(result.summary.includes(consequence));checkLiteral(input,result);
});

test('ordinary prose, linked labels and pickup conditions remain available without date or amount keywords',()=>{
  const body=['Event opening October 20–22.','We will host a full-day workshop '+url('event')+'focusing on reliable network design.','* Example Card '+url('card')+'指定訂房回饋 4.5%。','* 取件者需告知真實姓名及手機末三碼，方可付款取件。','週一至週四：電商與遊戲；週五至週日：餐飲與行動支付。','【方案】每月0.5GB，與免費方案併用每月1.5GB。','推薦遊戲：Synthetic Game A、Synthetic Game B。'].join('\n\n');
  const input=mail(body),result=excerpts(input);
  for(const text of ['October 20–22','full-day workshop','network design','Example Card','4.5%','手機末三碼','週一至週四','每月1.5GB','Synthetic Game A'])assert(result.summary.includes(text),'missing ordinary source content: '+text);
  checkLiteral(input,result);
});

test('confidentiality or contact boilerplate cannot suppress a payment and deadline in the same passage',()=>{
  for(const business of ['請於2026/09/18 17:30前付款 NT$800。本電子郵件內容含機密資訊。','請於2026/09/18 17:30前付款 NT$800，與我們聯繫（週一至週五，09:00~18:00）。']){
    const input=mail('更新通知。\n\n'+business+'\n\n'+flightCards(12).map(card=>card.body).join('\n\n')),result=excerpts(input);
    assert(result.summary.includes('2026/09/18 17:30'));assert(result.summary.includes('NT$800'));checkLiteral(input,result);
  }
});

test('numbered conditional rules retain both the qualifying condition and the exception as one unit',()=>{
  const input=mail('條件通知。\n\n注意事項: 1. 若本次已完成驗證'+url('verified')+'，您將無需出示憑證。若只輸入簡短驗證碼，仍需出示憑證。\n2. 請於出發1小時前完成報到。\n\n'+flightCards(12).map(card=>card.body).join('\n\n')),result=excerpts(input);
  assert(result.summary.includes('若本次已完成驗證'));assert(result.summary.includes('仍需出示憑證'));assert(result.summary.includes('出發1小時前完成報到'));checkLiteral(input,result);
});

test('repeated class and baggage cells stay with all three ticket records and the payable total is retained separately',()=>{
  const legs=Array.from({length:3},(_,i)=>`ORIGIN${i} DESTINATION${i} XY${101+i} 08:00\n24Dec2026 11:00\n24Dec2026\n\nClass: V Operated by: Synthetic Air\n\nMarketed by: Synthetic Air\n\nBaggage: 2PC Booking status: OK\n\nDuration: 03:00`);
  const input=mail('Booking ref: ABCXYZ\n\nTicket number: 999 1234567890\n\n'+legs.join('\n\n')+'\n\nFare: TWD 12345\nTaxes: TWD 678\nTotal Amount: TWD 13023'),result=excerpts(input);
  assert.equal(result.summary.split('Class: V').length-1,3);assert.equal(result.summary.split('Baggage: 2PC').length-1,3);
  for(const text of ['XY101','XY102','XY103','ABCXYZ','999 1234567890','Total Amount: TWD 13023'])assert(result.summary.includes(text));checkLiteral(input,result);
});

test('offer scope labels stay attached to a first complete flight card under capacity pressure',()=>{
  const cards=flightCards(12),firstScope='航空方案甲｜限時8折起',secondScope='航空方案乙｜限時9折起';
  const input=mail('機票優惠。\n\n'+firstScope+'\n\n'+cards.slice(0,6).map(card=>card.body).join('\n\n')+'\n\n'+secondScope+'\n\n'+cards.slice(6).map(card=>card.body).join('\n\n')),result=excerpts(input);
  for(const [scope,card]of [[firstScope,cards[0]],[secondScope,cards[6]]]){
    assert(result.summary.includes(scope));for(const cell of card.cells)assert(result.summary.includes(cell));
  }
  checkLiteral(input,result);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareMailAnalysisInput}=require('../app/services/mail-analysis-input.cjs');

const mail=(subject='',body='')=>({id:'mail-1',subject,body,date:'2026-09-14',sender:'sender@example.invalid',to:['to@example.invalid'],cc:['cc@example.invalid']});
const invalid=work=>assert.throws(work,{code:'INVALID_MAIL_ANALYSIS'});
const longUrl=`https://example.invalid/track?q=${'Ab012-_~%2F'.repeat(22000)}`;

test('only subject and body copies shorten HTTP, HTTPS and explicit www URLs',()=>{
  const raw=mail('文件 HTTP://example.invalid/a','網站 HTTPS://EXAMPLE.invalid/b?q=1&next=%2Fhome#go 與 WWW.example.invalid/path');
  raw.to.push('www.person@example.invalid');
  raw.extra={nested:['keep']};
  const snapshot=structuredClone(raw),prepared=prepareMailAnalysisInput(raw);
  assert.equal(prepared.input.subject,'文件 【網址】');
  assert.equal(prepared.input.body,'網站 【網址】 與 【網址】');
  assert.equal(prepared.changed,true);
  assert.deepEqual(raw,snapshot);
  for(const key of ['id','date','sender','to','cc','extra'])assert.deepEqual(prepared.input[key],raw[key]);
  prepared.input.to.push('new@example.invalid');prepared.input.extra.nested.push('changed');
  assert.deepEqual(raw,snapshot);
  assert.deepEqual(Object.keys(prepared.input).sort(),Object.keys(raw).sort());
});

test('long query is replaced completely while emoji and adjacent Chinese prose survive',()=>{
  const raw=mail('📌 核對文件',`前文😀${longUrl}。請於2026/09/15繳交NT$1,280；謝謝。`);
  const prepared=prepareMailAnalysisInput(raw);
  assert.equal(prepared.input.body,'前文😀【網址】。請於2026/09/15繳交NT$1,280；謝謝。');
  const serialized=JSON.stringify(prepared.input);
  assert.equal(serialized.includes('https://'),false);
  assert.equal(serialized.includes('Ab012'),false);
  assert.equal(raw.body.length>200000,true);
  assert.deepEqual(prepared.restoreEvidence(['前文😀【網址】。請於2026/09/15繳交NT$1,280；謝謝。']),['前文😀','。請於2026/09/15繳交NT$1,280；謝謝。']);
});

test('Chinese punctuation, quotation marks and enclosing brackets remain with adjacent facts',()=>{
  const raw=mail('連結「https://example.invalid/a」2026/09/15','(https://example.invalid/a)NT$1280 [http://example.invalid/b]9/16，HTTPS://example.invalid/c。正文 https://example.invalid/d請回覆。 "www.example.invalid/e"下一段。');
  const prepared=prepareMailAnalysisInput(raw);
  assert.equal(prepared.input.subject,'連結「【網址】」2026/09/15');
  assert.equal(prepared.input.body,'(【網址】)NT$1280 [【網址】]9/16，【網址】。正文 【網址】請回覆。 "【網址】"下一段。');
});

test('balanced URL parentheses, encoded paths, ports and query characters are included',()=>{
  const link='https://example.invalid:8443/a_(b)?x=(one)&next=%E6%96%87%E4%BB%B6#part';
  const raw=mail('',`資料 (${link}).`),prepared=prepareMailAnalysisInput(raw);
  assert.equal(prepared.input.body,'資料 (【網址】).');
  assert.deepEqual(prepared.restoreEvidence(['資料 (【網址】).']),[raw.body]);
});

test('email addresses, dates, decimals, bare domains and incomplete URL prefixes stay intact',()=>{
  const raw=mail('2026/09/14 價格 123.45','user@www.example.invalid user@sub.www.example.invalid www.name@www.example.invalid example.invalid abcwww.example.invalid abc-www.example.invalid sub.www.example.invalid www. http:// https:// 不變');
  const prepared=prepareMailAnalysisInput(raw);
  assert.equal(prepared.changed,false);
  assert.deepEqual(prepared.input,raw);
  assert.deepEqual(prepared.restoreEvidence(['user@www.example.invalid','2026/09/14','123.45']),['user@www.example.invalid','2026/09/14','123.45']);
});

test('short URL evidence restores exactly the corresponding contiguous original substring',()=>{
  const link='https://example.invalid/r?a=2&b=%2F',raw=mail('會議通知',`😀 前段\n請看${link}，9/15回覆。\n後段`),prepared=prepareMailAnalysisInput(raw);
  assert.deepEqual(prepared.restoreEvidence(['請看【網址】，9/15回覆。','😀 前段']),[`請看${link}，9/15回覆。`,'😀 前段']);
});

test('raw evidence length uses UTF-16 code units without slicing emoji',()=>{
  const prefix='前文'+'😀'.repeat(10),suffix='後文🧑‍💻';
  const base='https://example.invalid/';
  const fit=base+'a'.repeat(1000-prefix.length-suffix.length-base.length);
  const exact=prepareMailAnalysisInput(mail('',prefix+fit+suffix));
  assert.deepEqual(exact.restoreEvidence([prefix+'【網址】'+suffix]),[prefix+fit+suffix]);
  const over=prepareMailAnalysisInput(mail('',prefix+fit+'b'+suffix));
  assert.deepEqual(over.restoreEvidence([prefix+'【網址】'+suffix]),[prefix,suffix]);
});

test('long URL evidence retains separate real text on both sides and never fabricates a join',()=>{
  const raw=mail('不可拿這個標題代替',`確認付款${longUrl}交易完成`),prepared=prepareMailAnalysisInput(raw);
  const evidence=prepared.restoreEvidence(['確認付款【網址】交易完成']);
  assert.deepEqual(evidence,['確認付款','交易完成']);
  for(const quote of evidence){assert.ok(raw.body.includes(quote));assert.ok(quote.length<=1000);}
  assert.equal(evidence.includes('確認付款交易完成'),false);
  assert.equal(evidence.some(quote=>quote.includes('【網址】')),false);
});

test('pure generated markers are skipped but never replaced with unrelated subject text',()=>{
  const raw=mail('可引用的原始標題',longUrl),prepared=prepareMailAnalysisInput(raw);
  invalid(()=>prepared.restoreEvidence(['【網址】']));
  assert.deepEqual(prepared.restoreEvidence(['【網址】','可引用的原始標題']),['可引用的原始標題']);
  invalid(()=>prepareMailAnalysisInput(mail('',`(${longUrl})`)).restoreEvidence(['(【網址】)']));
});

test('URL wrappers and decorative symbols do not become evidence or create restoration ambiguity',()=>{
  const raw=mail('已確認付款',[
    '<https://example.invalid/first>',
    '<https://example.invalid/second>',
    '[https://example.invalid/image.png]',
    '👉 https://example.invalid/promotion ✅',
    `★ ${longUrl} ★`
  ].join('\n'));
  const prepared=prepareMailAnalysisInput(raw);
  const wrappers=['<【網址】>','[【網址】]','👉 【網址】 ✅','★ 【網址】 ★'];
  for(const fragment of wrappers){
    assert.throws(()=>prepared.restoreEvidence([fragment]),error=>
      error.code==='INVALID_MAIL_ANALYSIS'&&error.message==='模型僅引用網址替代標記，沒有可核對的原文文字。');
    assert.deepEqual(prepared.restoreEvidence([fragment,'已確認付款']),['已確認付款']);
  }
  invalid(()=>prepared.restoreEvidence(Array(4).fill('<【網址】>')));
  assert.deepEqual(prepared.restoreEvidence([...wrappers,'已確認付款']),['已確認付款']);
});

test('real words and amounts surrounding wrapped links remain exact textual evidence',()=>{
  const raw=mail('',`已付款 NT$1,280 <https://example.invalid/receipt>\n${longUrl} 金額 €25`);
  const prepared=prepareMailAnalysisInput(raw);
  assert.deepEqual(prepared.restoreEvidence(['已付款 NT$1,280 <【網址】>','【網址】 金額 €25']),[
    '已付款 NT$1,280 <https://example.invalid/receipt>',' 金額 €25'
  ]);
});

test('native marker text is preserved and distinguished from generated markers',()=>{
  const raw=mail('原生【網址】字樣',`詳情${longUrl}結束`),prepared=prepareMailAnalysisInput(raw);
  assert.deepEqual(prepared.restoreEvidence(['原生【網址】字樣','詳情【網址】結束']),['原生【網址】字樣','詳情','結束']);
  assert.deepEqual(prepareMailAnalysisInput(mail('【網址】','原文')).restoreEvidence(['【網址】']),['【網址】']);
});

test('all matching locations are checked and native/generated marker collisions remain rejected',()=>{
  for(const raw of [
    mail('請看【網址】','請看https://example.invalid/a'),
    mail('請看https://example.invalid/a','請看【網址】'),
    mail('', '請看https://example.invalid/a\n請看https://example.invalid/b\n請看【網址】')
  ])assert.throws(()=>prepareMailAnalysisInput(raw).restoreEvidence(['請看【網址】']),error=>
    error.code==='INVALID_MAIL_ANALYSIS'&&error.message==='模型引用對應到同一封郵件的不同原文位置，無法確認一致的文字證據。');
  const mixed=prepareMailAnalysisInput(mail('',
    '前https://example.invalid/a中【網址】後\n前【網址】中https://example.invalid/b後'));
  invalid(()=>mixed.restoreEvidence(['前【網址】中【網址】後']));
});

test('different generated URLs retain their shared exact text without choosing a URL or joining its sides',()=>{
  const pairs=[
    ['https://example.invalid/a','https://example.invalid/b'],
    [longUrl+'a',longUrl+'b'],
    ['https://example.invalid/a',longUrl],
    [longUrl,'https://example.invalid/b']
  ];
  for(const [first,second] of pairs){
    const raw=mail('',`請看<${first}>，確認完成。\n請看<${second}>，確認完成。`);
    const evidence=prepareMailAnalysisInput(raw).restoreEvidence(['請看<【網址】>，確認完成。']);
    assert.deepEqual(evidence,['請看<','>，確認完成。']);
    assert(evidence.every(quote=>raw.body.includes(quote)));
    assert(evidence.every(quote=>!quote.includes('https://')&&!quote.includes('【網址】')));
    assert(!evidence.includes('請看<>，確認完成。'));
  }
});

test('shared exact text is safe across subject and body with different generated URLs',()=>{
  const raw=mail('請看https://example.invalid/a，已確認。',`請看${longUrl}，已確認。\n其他原文`);
  assert.deepEqual(prepareMailAnalysisInput(raw).restoreEvidence(['請看【網址】，已確認。','其他原文']),
    ['請看','，已確認。','其他原文']);
});

test('shared evidence preserves every literal piece around multiple ambiguous URLs',()=>{
  const first='先看https://example.invalid/a，再看https://example.invalid/b，完成。';
  const second=`先看${longUrl}，再看https://example.invalid/c，完成。`;
  const third='先看https://example.invalid/d，再看https://example.invalid/e，完成。';
  const prepared=prepareMailAnalysisInput(mail('',[first,second,third].join('\n')));
  assert.deepEqual(prepared.restoreEvidence(['先看【網址】，再看【網址】，完成。']),['先看','，再看','，完成。']);
});

test('shared evidence from ambiguous short URLs still obeys the eight-fragment limit',()=>{
  const pairs=Array.from({length:5},(_,i)=>({
    raw:`前段${i} https://example.invalid/${i}/a後段${i}\n前段${i} https://example.invalid/${i}/b後段${i}`,
    quote:`前段${i} 【網址】後段${i}`
  }));
  const prepared=prepareMailAnalysisInput(mail('',pairs.map(pair=>pair.raw).join('\n')));
  assert.equal(prepared.restoreEvidence(pairs.slice(0,4).map(pair=>pair.quote)).length,8);
  invalid(()=>prepared.restoreEvidence(pairs.map(pair=>pair.quote)));
});

test('identical restoration at repeated locations and duplicate evidence safely deduplicate',()=>{
  const repeated='請看https://example.invalid/a';
  const prepared=prepareMailAnalysisInput(mail(repeated,`${repeated}\n${repeated}\n已確認`));
  assert.deepEqual(prepared.restoreEvidence(['請看【網址】','請看【網址】','已確認']),[repeated,'已確認']);
  assert.deepEqual(prepareMailAnalysisInput(mail('相同原文','相同原文')).restoreEvidence(['相同原文','相同原文']),['相同原文']);
});

test('partial generated markers and fabricated quotations are rejected',()=>{
  const prepared=prepareMailAnalysisInput(mail('通知','請看https://example.invalid/a。'));
  for(const quote of ['網址','【網','址】','請看【網','這是偽造證據','請看。'])invalid(()=>prepared.restoreEvidence([quote]));
});

test('restoration never silently discards evidence beyond the eight-fragment limit',()=>{
  const pairs=Array.from({length:5},(_,i)=>({raw:`前段${i} ${longUrl}後段${i}`,quote:`前段${i} 【網址】後段${i}`}));
  const prepared=prepareMailAnalysisInput(mail('',pairs.map(pair=>pair.raw).join('\n')));
  assert.equal(prepared.restoreEvidence(pairs.slice(0,4).map(pair=>pair.quote)).length,8);
  invalid(()=>prepared.restoreEvidence(pairs.map(pair=>pair.quote)));
});

test('malformed or oversized evidence is rejected and no-URL text retains whitespace',()=>{
  const prepared=prepareMailAnalysisInput(mail('',`  原文  ${'文'.repeat(1001)}`));
  assert.deepEqual(prepared.restoreEvidence(['  原文  ']),['  原文  ']);
  for(const fragments of [null,[],[''],[' '],[2],Array(9).fill('原文'),['文'.repeat(1001)]])invalid(()=>prepared.restoreEvidence(fragments));
});

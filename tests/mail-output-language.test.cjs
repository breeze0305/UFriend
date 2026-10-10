'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {traditionalMailText,traditionalMailAnalysis}=require('../app/services/mail-output-language.cjs');

test('mail prose uses Traditional Chinese and Taiwan terms, including the reported account summary',()=>{
  assert.equal(traditionalMailText('求助信 - 请求汇款账号信息'),'求助信 - 請求匯款帳號資訊');
  assert.equal(traditionalMailText('账户余额和账单'),'帳戶餘額和帳單');
  assert.equal(traditionalMailText('服务器软件和用户信息'),'伺服器軟體和使用者資訊');
  assert.equal(traditionalMailText('头发、发展、皇后、干燥、干部'),'頭髮、發展、皇后、乾燥、幹部');
});

test('conversion preserves URLs, mail addresses and code while converting surrounding prose',()=>{
  const url='https://example.invalid/请求?账号=123',address='请求@example.invalid';
  const code='```js\nconst 账号 = "请求";\n```';
  const text=`请提供 ${address}\n链接 ${url}\n邮箱 mailto:${address}\n代码 \`账号\`\n${code}\n订单完成`;
  assert.equal(traditionalMailText(text),`請提供 ${address}\n連結 ${url}\n郵箱 mailto:${address}\n程式碼 \`账号\`\n${code}\n訂單完成`);
  assert.equal(traditionalMailText('请查看 www.example.invalid/订单'),'請檢視 www.example.invalid/订单');
  assert.equal(traditionalMailText('请看 ~~~\n账号\n~~~\n订单'),'請看 ~~~\n账号\n~~~\n訂單');
  assert.equal(traditionalMailText('请看 ```js\nconst 账号 = "请求";'),'請看 ```js\nconst 账号 = "请求";');
});

test('links and addresses stop at sentence punctuation so adjacent prose is converted',()=>{
  assert.equal(traditionalMailText('请打开https://example.invalid/请求?账号=123，然后检查账号。'),'請開啟https://example.invalid/请求?账号=123，然後檢查帳號。');
  assert.equal(traditionalMailText('请联系：请求@example.invalid；确认账号信息。'),'請聯絡：请求@example.invalid；確認帳號資訊。');
  assert.equal(traditionalMailText('请发信到「mailto:请求@example.invalid」，确认账号。'),'請發信到「mailto:请求@example.invalid」，確認帳號。');
  assert.equal(traditionalMailText('[查看账号](https://example.invalid/请求)然后确认账号。'),'[檢視帳號](https://example.invalid/请求)然後確認帳號。');
  assert.equal(traditionalMailText('请查看 https://example.invalid/订单(账号)。'),'請檢視 https://example.invalid/订单(账号)。');
  assert.equal(traditionalMailText('[查看账号](https://example.invalid/订单(账号(确认)))然后检查账号。'),'[檢視帳號](https://example.invalid/订单(账号(确认)))然後檢查帳號。');
  assert.equal(traditionalMailText('[查看账号](https://example.invalid/订单)确认[链接](https://example.invalid/账号)完成。'),'[檢視帳號](https://example.invalid/订单)確認[連結](https://example.invalid/账号)完成。');
});

test('numbers, identifiers, foreign text and line breaks remain unchanged, and conversion is stable on repeated snapshots',()=>{
  const text='订单 AB-123，USD 1,500，2026/09/21\nPlease reply. 日本語。\r\n已完成付款，後續無須回覆。';
  const expected='訂單 AB-123，USD 1,500，2026/09/21\nPlease reply. 日本語。\r\n已完成付款，後續無須回覆。';
  assert.equal(traditionalMailText(text),expected);
  assert.equal(traditionalMailText(expected),expected);
  assert.equal(traditionalMailText(text),expected);
  const existing='商店通知已發送新的折價券，可自行決定是否使用。';
  assert.equal(traditionalMailText(existing),existing);
});

test('only generated summary and reason fields are converted without mutating evidence or analysis metadata',()=>{
  const evidence=Object.freeze(['请提供汇款账号']),sourceFacts=Object.freeze(['请求账号信息']);
  const analysis=Object.freeze({summary:'请求账号信息',reason:'请提供汇款账号',evidence,sourceFacts,priority:1,category:'account',fingerprint:'unchanged',meta:{model:'简体模型'}});
  const converted=traditionalMailAnalysis(analysis);
  assert.equal(converted.summary,'請求帳號資訊');assert.equal(converted.reason,'請提供匯款帳號');
  assert.equal(converted.evidence,evidence);assert.equal(converted.sourceFacts,sourceFacts);assert.equal(converted.meta,analysis.meta);
  assert.equal(converted.fingerprint,'unchanged');assert.equal(converted.priority,1);assert.equal(converted.category,'account');
  assert.equal(analysis.summary,'请求账号信息');assert.equal(analysis.reason,'请提供汇款账号');
  assert.equal(traditionalMailAnalysis(converted),converted);
});

test('empty, absent and nontext legacy fields are preserved',()=>{
  for(const value of ['',undefined,null,17])assert.equal(traditionalMailText(value),value);
  for(const value of [undefined,null,[],{evidence:['原文']},{summary:17,reason:null}])assert.equal(traditionalMailAnalysis(value),value);
  assert.deepEqual(traditionalMailAnalysis({reason:'请求信息'}),{reason:'請求資訊'});
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {LIMITED_TEXT_CHARACTERS,getMailContentContext,splitMailThread}=require('../app/services/mail-content-context.cjs');

test('content metadata is bounded to facts about local text, image tags and attachment records',()=>{
  const mail={subject:'服務說明',body:'請參閱本次服務說明。',html:'<img src="https://example.invalid/details.png">',attachments:[{name:'local.pdf'},{name:'logo.png',inline:true}]};
  const before=structuredClone(mail);
  assert.deepEqual(getMailContentContext(mail),{attachmentCount:2,unreadImageCount:1,imageTextUnavailable:true,textLimited:true});
  assert.deepEqual(mail,before);
  assert.deepEqual(getMailContentContext(null),{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:true});
});

test('text availability strips URLs, generated placeholders, decorations and invisible marks',()=>{
  const url='https://example.invalid/track?token='+'abc123'.repeat(1000);
  assert.equal(getMailContentContext({body:`😀 <>【網址】[] ${url}\u034f\u200c\u00a0 \n ${'文'.repeat(LIMITED_TEXT_CHARACTERS-1)}`} ).textLimited,true);
  assert.equal(getMailContentContext({body:'文'.repeat(LIMITED_TEXT_CHARACTERS)}).textLimited,false);
  assert.equal(getMailContentContext({body:'2026'.repeat(LIMITED_TEXT_CHARACTERS/4)}).textLimited,false);
  assert.equal(getMailContentContext({subject:'文'.repeat(200),body:'短文'}).textLimited,true);
});

test('many images do not imply limited body text, and an image alt does not imply its pixels were read',()=>{
  const html=Array.from({length:30},(_,index)=>`<img src="https://example.invalid/${index}.png" alt="說明">`).join('');
  assert.deepEqual(getMailContentContext({body:'完整的文字正文。'.repeat(50),html}),{attachmentCount:0,unreadImageCount:30,imageTextUnavailable:true,textLimited:false});
  assert.equal(getMailContentContext({body:'短通知',html:null}).textLimited,true);
});

test('HTML parsing ignores fake tags in comments, escaped text and inert containers',()=>{
  const html='<!-- <img src="https://example.invalid/comment.png"> -->'+
    '&lt;img src="https://example.invalid/escaped.png"&gt;'+
    '<script>const image="<img src=\"https://example.invalid/script.png\">";</script>'+
    '<style>.x:before{content:"<img src=\"https://example.invalid/style.png\">"}</style>'+
    '<template><img src="https://example.invalid/template.png"></template>'+
    '<textarea><img src="https://example.invalid/textarea.png"></textarea>'+
    '<div title="<img src=\'https://example.invalid/attribute.png\'>"><IMG SRC="https://example.invalid/real.png"></div>';
  assert.equal(getMailContentContext({html}).unreadImageCount,1);
});

test('visible image count excludes one-pixel, hidden and recognizable tracking images',()=>{
  const html=[
    '<img src="https://example.invalid/a.gif" width="1" height="1">',
    '<img src="https://example.invalid/b.gif" style="height:1px;width: 1px!important">',
    '<img src="https://example.invalid/c.gif" width="0">',
    '<img src="https://example.invalid/d.gif" hidden>',
    '<div style="display:none"><img src="https://example.invalid/e.gif"></div>',
    '<img src="https://example.invalid/f.gif" style="visibility:hidden">',
    '<img src="https://example.invalid/pixel.gif?token=x">',
    '<img src="https://example.invalid/wf/open?token=x">',
    '<img src="https://example.invalid/beacon.png">',
    '<img alt="missing source">',
    '<img src="https://track.example.invalid/banner.png?tracking=yes" width="600" height="300">',
    '<img src="cid:details@example.invalid">',
    '<img src="data:image/png;base64,synthetic" width="200" height="100">',
    '<img src="https://example.invalid/strip.png" width="1" height="300">'
  ].join('');
  assert.equal(getMailContentContext({html}).unreadImageCount,4);
});

test('thread boundaries retain literal current/history spans including CRLF and attribution',()=>{
  for(const attribution of [
    'A Person <person@example.invalid> 於 2026年9月16日 週三 上午9:00 寫道：',
    'A Person 于 2026/09/16 写道:',
    '在 2026年9月16日，A Person <person@example.invalid> 写道：',
    'On Wed, Sep 16, 2026 at 9:00 AM A Person <person@example.invalid> wrote:',
    'On September 16 at 9:00 AM, A Person wrote:',
    '-----Original Message-----',
    '-------- 原始郵件 --------'
  ]){
    const current='收到，已完成修改。😀\r\n\r\n',history=attribution+'\r\n過去的通知內容。\r\n';
    const result=splitMailThread(current+history);
    assert.deepEqual(result,{current,history,boundaryKnown:true},attribution);
    assert.equal(result.current+result.history,current+history);
  }
});

test('folded reply headers are recognized without normalizing their original content',()=>{
  for(const history of [
    'On Wed, Sep 16, 2026 at 9:00 AM\nA Person <person@example.invalid>\nwrote:\nOlder body',
    'A Person <person@example.invalid> 於 2026年9月16日\n週三 上午9:00 寫道：\n先前內容'
  ]){
    const current='新的回覆\n\n';
    assert.deepEqual(splitMailThread(current+history),{current,history,boundaryKnown:true});
  }
});

test('leading quote lines locate history while retaining blank quoted lines',()=>{
  for(const history of ['> 原本約定明天開會。\n> 請帶資料。','>\n> Older instructions.\n','> 2026/09/16 請回覆。']){
    const current='這件事已完成。\n\n';
    assert.deepEqual(splitMailThread(current+history),{current,history,boundaryKnown:true});
  }
});

test('inline and bottom replies after bare quoted lines remain available as uncertain current content',()=>{
  for(const body of [
    '我的回覆如下：\n\n> 請明天交稿。\n\n我今天已經提交，請查收。',
    '> Please send the draft tomorrow.\n\nI have sent it today.',
    '逐項回覆。\n\n> 第一個問題。\n第一個答案。\n> 第二個問題。\n第二個答案。',
    '新的內容😀\r\n\r\n> 舊要求。\r\n>\r\n\r\n已經完成。😀\r\n',
    '目前回覆\n> 需要幾件設備？\n\n2',
    '目前回覆\n> 請確認收到。\n\n👍',
    '目前回覆\n> 舊要求。\n\n```txt\nnew response\n```',
  ]){
    assert.deepEqual(splitMailThread(body),{current:body,history:'',boundaryKnown:false},body);
  }
});

test('blank unquoted lines do not invalidate a continuous quote block but actual reply text does',()=>{
  const current='新的內容\n\n',history='>\n> 舊要求一。\n\n  > 舊要求二。\n \t\n';
  assert.deepEqual(splitMailThread(current+history),{current,history,boundaryKnown:true});
  const answered=current+history+'新回覆在這裡。';
  assert.deepEqual(splitMailThread(answered),{current:answered,history:'',boundaryKnown:false});
});

test('an explicit dated attribution still establishes the start of a quoted conversation',()=>{
  const current='新回覆已確認。\r\n\r\n';
  const history='On September 16, 2026, A Person wrote:\r\n> 更早的問題。\r\n當時的回答。\r\n';
  assert.deepEqual(splitMailThread(current+history),{current,history,boundaryKnown:true});
});

test('ordinary prose, greater-than comparisons and fenced/indented code are not reply boundaries',()=>{
  for(const body of [
    '我於今天寫道：提醒大家準時。\n這是一般文句。',
    '作者於 2026 年度的產品文件寫道：\n這是本次文章內容。',
    'A colleague wrote: a note about planning.',
    'On the whiteboard someone wrote:\nThis is a note.',
    'Please read the Original Message section below.\nAnother sentence.',
    'Original Message\nA description without a quoted-mail separator.',
    'if (count > limit) return true;\nvalue >= 10\n>= 20\n>> log.txt\n> 3',
    '    > codeValue\n    const x = 1;',
    '```js\n> codeValue\nOn Sep 16, 2026, a person wrote:\n-----Original Message-----\n```\nNew prose.',
    '~~~text\n> example text\n~~~\nCurrent text.'
  ])assert.deepEqual(splitMailThread(body),{current:body,history:'',boundaryKnown:false},body);
});

test('first real history boundary wins after a code block, with nested history preserved',()=>{
  const current='範例：\n```txt\n> sample\n```\n目前已取消。\n';
  const history='On Wed, Sep 16, 2026, A Person wrote:\n> 舊期限\n-----Original Message-----\n更早內容';
  assert.deepEqual(splitMailThread(current+history),{current,history,boundaryKnown:true});
  assert.deepEqual(splitMailThread(''),{current:'',history:'',boundaryKnown:false});
});

test('first-only selection stops at a clear quote even when unquoted replies follow',()=>{
  for(const history of [
    '> 請明天提交資料。\n\n我今天已經提交。',
    '> Older instructions.\n\nA later unquoted answer.\n> Another older question.\nAnother answer.',
    '>\r\n> 舊要求。\r\n\r\n後面的回覆😀\r\n',
    '> Earlier discussion.\n\n```txt\nlater answer\n```'
  ]){
    const current='這封只通知本次進度。😀\r\n\r\n',body=current+history;
    assert.deepEqual(splitMailThread(body,{firstOnly:true}),{current,history,boundaryKnown:true});
    assert.deepEqual(splitMailThread(body),{current:body,history:'',boundaryKnown:false});
  }
  const history='> Earlier instructions.\n\nA bottom reply.';
  assert.deepEqual(splitMailThread(history,{firstOnly:true}),{current:'',history,boundaryKnown:true});
});

test('first-only selection keeps literal dated Gmail attributions and longer folds in history',()=>{
  for(const history of [
    'A Person <person@example.invalid> 於 2026年9月20日 週日 上午9:00 寫道：\r\n> 舊內容。\r\n後來的回覆。',
    'On Sun, Sep 20, 2026 at 9:00 AM\nA Person\n<person@example.invalid>\nwrote:\n> Older body.\nA later reply.',
    'A Person <person@example.invalid>\n於 2026年9月20日 週日\n上午9:00 寫道：\n舊內容。',
    '在 2026年9月20日，A Person <person@example.invalid> 写道：\n舊內容。'
  ]){
    const current='本次正文。\n\n';
    assert.deepEqual(splitMailThread(current+history,{firstOnly:true}),{current,history,boundaryKnown:true});
  }
});

test('first-only folded attribution recognition never absorbs a preceding current sentence',()=>{
  for(const [current,history]of [
    ['On September 20, we completed the deployment.\n','On September 19, 2026, A Person wrote:\n> Please deploy the update.'],
    ['我於今天完成修改。\n','A Person <person@example.invalid> 於 2026年9月19日 寫道：\n> 請修改資料。'],
    ['我於今天完成修改。\n','A Person <person@example.invalid>\n於 2026年9月19日 週六\n上午9:00 寫道：\n> 請修改資料。'],
    ['On Monday we shipped the update.\n','On September 19, 2026 at 9:00 AM\nA Person\n<person@example.invalid>\nwrote:\n> Older request.'],
    ['On another topic,\n','On September 19, 2026, A Person wrote:\n> Earlier question.']
  ])assert.deepEqual(splitMailThread(current+history,{firstOnly:true}),{current,history,boundaryKnown:true});
});

test('first-only selection recognizes dated Outlook header clusters without a separator',()=>{
  for(const history of [
    'From: A Person <person@example.invalid>\r\nSent: Sunday, September 20, 2026 9:00 AM\r\nTo: Reader <reader@example.invalid>\r\nSubject: Earlier discussion\r\n\r\nOlder body.',
    '寄件者：測試寄件者\n寄件日期：2026年9月20日 上午9:00\n收件者：測試收件者\n主旨：先前通知\n\n舊內容。',
    '发件人: 测试寄件者\n发送时间: 2026/09/20 9:00\n收件人: 测试收件者\n抄送: 另一位收件者\n主题: 先前通知\n旧内容。',
    '____________________________\n\nFrom: A Person <person@example.invalid>\nSent:\n    September 20, 2026 9:00 AM\nTo: Reader\nSubject:\n\nOlder body.'
  ]){
    const current='本次確認已完成。\n\n',body=current+history;
    assert.deepEqual(splitMailThread(body,{firstOnly:true}),{current,history,boundaryKnown:true});
    assert.deepEqual(splitMailThread(body),{current:body,history:'',boundaryKnown:false});
  }
});

test('first-only selection excludes explicit forwarded sections and any later replies',()=>{
  for(const marker of ['---------- Forwarded message ---------','-----Forwarded mail-----','---------- 轉寄的郵件 ---------','----- 转发邮件 -----','Begin forwarded message:','轉寄的訊息：']){
    const current='提供本次簡短說明。\n\n',history=marker+'\nFrom: Sender\nForwarded body.\n\nLater commentary.';
    assert.deepEqual(splitMailThread(current+history,{firstOnly:true}),{current,history,boundaryKnown:true},marker);
  }
});

test('first-only selection preserves ordinary From labels, comparisons and fenced or indented examples',()=>{
  for(const body of [
    'From: The product team\nThis describes a field rather than an earlier message.',
    'From: Field example\nSent: Display this label\nTo: Another field\nSubject: Documentation',
    'From: A Person\nThis is an ordinary paragraph.\nSent: September 20, 2026\nTo: Reader\nSubject: A later example',
    'On the board someone wrote:\nA note without a date.',
    'person@example.invalid\n請參閱目前的說明。',
    'Comparison examples:\n> threshold\n> maxAllowed + margin\n> 20 MB\n>= 20\n>> output.txt\n> 3',
    '    > exampleCode\n    From: Example\n    Sent: September 20, 2026\n    To: Reader\n    Subject: Code',
    '```text\nFrom: Sender\nSent: September 20, 2026\nTo: Reader\nSubject: Sample\n----- Forwarded message -----\n```\nCurrent body.',
    '~~~text\n> Example quote.\nBegin forwarded message:\n~~~\nCurrent body.'
  ])assert.deepEqual(splitMailThread(body,{firstOnly:true}),{current:body,history:'',boundaryKnown:false},body);
});

test('first-only content context measures the selected body and excludes recognized quoted HTML tails',()=>{
  const current='目前僅有簡短通知。\n\n',history='On September 20, 2026, Sender wrote:\n'+('完整的舊郵件文字。'.repeat(100));
  const image='<img src="cid:current@example.invalid">',quotedImage='<img src="cid:older@example.invalid">';
  for(const quotedHtml of [
    '<blockquote>'+quotedImage+'</blockquote>',
    '<div class="gmail_quote">'+quotedImage+'</div>',
    '<div class="wrapper GMAIL_QUOTE other">'+quotedImage+'</div>',
    '<div id="divRplyFwdMsg">From: Earlier sender</div>'+quotedImage
  ]){
    const mail={body:current+history,html:image+quotedHtml+quotedImage,attachments:[{name:'attachment.pdf'}]},before=structuredClone(mail);
    assert.deepEqual(getMailContentContext(mail,{firstOnly:true}),{attachmentCount:1,unreadImageCount:1,imageTextUnavailable:true,textLimited:true});
    assert.deepEqual(getMailContentContext({...mail,body:current},{firstOnly:true}),getMailContentContext(mail,{firstOnly:true}));
    assert.deepEqual(getMailContentContext(mail),{attachmentCount:1,unreadImageCount:3,imageTextUnavailable:true,textLimited:false});
    assert.deepEqual(mail,before);
  }
  const quotedOnly={body:current+history,html:'<blockquote>'+quotedImage+'</blockquote>'};
  assert.deepEqual(getMailContentContext(quotedOnly,{firstOnly:true}),{attachmentCount:0,unreadImageCount:0,imageTextUnavailable:false,textLimited:true});
  assert.equal(getMailContentContext({body:'完整的本次正文。'.repeat(30)+history},{firstOnly:true}).textLimited,false);
});

test('unrecognized or inactive HTML quote markers do not hide available current images',()=>{
  const image='<img src="cid:current@example.invalid">';
  for(const html of [
    '<div class="ordinary_quote">'+image+'</div>',
    '<hr>'+image,
    '<template><blockquote><img src="cid:template@example.invalid"></blockquote></template>'+image,
    '<div hidden><div class="gmail_quote"><img src="cid:hidden@example.invalid"></div></div>'+image
  ])assert.equal(getMailContentContext({body:'目前正文',html},{firstOnly:true}).unreadImageCount,1,html);
});

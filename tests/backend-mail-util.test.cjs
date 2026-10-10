'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseEml,buildMime,decodeGmailMessage,validateRecipients,replyRecipients}=require('../app/services/mail-util.cjs');

test('MIME round trip preserves Chinese headers, Bcc, literal body and binary attachment; EML hash deduplicates',async()=>{
  const mime=await buildMime({from:'寄件者 <me@example.com>',to:'收件者 <you@example.com>',cc:'cc@example.com',bcc:'private@example.com',
    subject:'明天開會 ✉',body:'您好，\n明天 14:00 開會。\n<script>literal text</script>',attachments:[{name:'../資料.bin',mimeType:'application/octet-stream',content:Buffer.from([0,255,42,128])}]});
  assert.match(mime.toString(),/Bcc: private@example\.com/i);
  const one=await parseEml(mime),two=await parseEml(mime);
  assert.equal(one.id,two.id);assert.equal(one.source,'本機');assert.equal(one.subject,'明天開會 ✉');
  assert.match(one.body,/<script>literal text<\/script>/);assert.equal(one.bcc,'private@example.com');
  assert.equal(one.attachments[0].name,'資料.bin');assert.deepEqual(one.attachments[0].content,Buffer.from([0,255,42,128]));
  assert.equal(one.html,null);assert.equal(one.htmlVersion,1);
});

test('HTML-only EML keeps a plain-text fallback and preserves its original untrusted HTML',async()=>{
  const source='From: me@example.com\r\nTo: you@example.com\r\nSubject: html\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'+
    '<html><head><script>throw new Error("bad")</script></head><body><p>Meeting at <b>14:00</b></p><img src="https://tracker.invalid/pixel"></body></html>';
  const parsed=await parseEml(Buffer.from(source));
  assert.match(parsed.body,/Meeting at 14:00/);assert.doesNotMatch(parsed.body,/<(?:script|img|html)/);
  assert.equal(parsed.html,source.split('\r\n\r\n')[1]);assert.equal(parsed.htmlVersion,1);
});

test('Gmail multipart alternative prefers text, resolves charset and keeps separate attachment metadata',async()=>{
  const raw={id:'m1',threadId:'t1',internalDate:'1700000000000',labelIds:['INBOX','UNREAD','STARRED','Label_A'],payload:{
    mimeType:'multipart/mixed',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'=?UTF-8?B?5ris6Kmm?='}],parts:[
      {mimeType:'multipart/alternative',parts:[
        {partId:'0.0',mimeType:'text/plain',headers:[{name:'Content-Type',value:'text/plain; charset=iso-8859-1'}],body:{data:Buffer.from([67,97,102,233]).toString('base64url'),size:4}},
        {partId:'0.1',mimeType:'text/html',body:{data:Buffer.from('<b>Do not duplicate this</b>').toString('base64url')}}]},
      {partId:'1',mimeType:'application/pdf',filename:'report.pdf',body:{attachmentId:'A1',size:1234}}]}};
  const mail=await decodeGmailMessage(raw,'gmail:me@example.com',[{id:'Label_A',name:'工作'}]);
  assert.equal(mail.body,'Café');assert.equal(mail.subject,'測試');assert.equal(mail.read,false);assert.equal(mail.star,true);
  assert.equal(mail.html,'<b>Do not duplicate this</b>');assert.equal(mail.htmlVersion,1);
  assert.deepEqual(mail.labels,['工作']);assert.equal(mail.date,'2023-11-14T22:13:20.000Z');
  assert.deepEqual(mail.attachments,[{name:'report.pdf',mimeType:'application/pdf',attachmentId:'A1',size:1234,contentId:null,contentDisposition:null,inline:false}]);
});

test('Gmail can retrieve separately stored text bodies without treating them as file attachments',async()=>{
  let requested;
  const mail=await decodeGmailMessage({id:'m2',payload:{mimeType:'text/plain',body:{attachmentId:'large-body',size:100}},labelIds:[]},'gmail:a',[],{
    loadBody:async id=>{requested=id;return Buffer.from('Large body text').toString('base64url');}
  });
  assert.equal(requested,'large-body');assert.equal(mail.body,'Large body text');assert.deepEqual(mail.attachments,[]);
  assert.equal(mail.html,null);assert.equal(mail.htmlVersion,1);
});

test('EML and Gmail RAW retain HTML tables, links and CID references without embedding binary bytes in Gmail state',async()=>{
  const image=Buffer.from([137,80,78,71,0,255]),html='<html><body><table><tr><td><img src="cid:logo@example.test"></td><td><a href="https://example.test/booking">查看行程</a></td></tr></table></body></html>';
  const mime=Buffer.from(['From: Example <sender@example.test>','To: reader@example.test','Subject: HTML presentation','MIME-Version: 1.0','Content-Type: multipart/related; boundary="related"','','--related','Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(html).toString('base64'),'--related','Content-Type: image/png; name="logo.png"','Content-Disposition: inline; filename="logo.png"','Content-ID: <logo@example.test>','Content-Transfer-Encoding: base64','',image.toString('base64'),'--related--',''].join('\r\n'));
  const local=await parseEml(mime);assert.equal(local.html,html);assert.equal(local.htmlVersion,1);assert(!local.html.includes('data:'));
  assert.equal(local.attachments[0].contentId,'logo@example.test');assert.equal(local.attachments[0].contentDisposition,'inline');assert.equal(local.attachments[0].inline,true);assert.deepEqual(local.attachments[0].content,image);
  const gmail=await decodeGmailMessage({id:'raw-message',threadId:'raw-thread',raw:mime.toString('base64url'),labelIds:['INBOX','UNREAD']},'gmail:fixture');
  assert.equal(gmail.html,html);assert.equal(gmail.body,local.body);assert.equal(gmail.attachments[0].attachmentId,'raw:0');assert.equal(gmail.attachments[0].contentId,'logo@example.test');assert.equal(Object.hasOwn(gmail.attachments[0],'content'),false);assert.equal(gmail.read,false);
});

test('nested Gmail FULL alternatives load separated HTML bodies and retain inline part metadata without fetching image bytes',async()=>{
  const html=Buffer.from('<table><tr><td>Caf\xe9 <a href="https://example.test/path">Details</a><img src="cid:logo@example.test"></td></tr></table>','latin1'),requested=[];
  const mail=await decodeGmailMessage({id:'nested',payload:{mimeType:'multipart/alternative',parts:[
    {mimeType:'text/plain',body:{data:Buffer.from('Keep the exact plain alternative').toString('base64url')}},
    {mimeType:'multipart/related',parts:[
      {mimeType:'text/html',headers:[{name:'Content-Type',value:'text/html; charset=iso-8859-1'}],body:{attachmentId:'html-body',size:html.length}},
      {partId:'1.1',mimeType:'image/png',headers:[{name:'Content-ID',value:' <logo@example.test> '},{name:'Content-Disposition',value:'inline'}],body:{attachmentId:'image-body',size:100}},
      {partId:'1.2',mimeType:'image/jpeg',headers:[{name:'Content-ID',value:'<second@example.test>'}],body:{data:Buffer.from('image').toString('base64url'),size:5}}
    ]}
  ]}},'gmail:fixture',[],{loadBody:async id=>{requested.push(id);assert.equal(id,'html-body');return html.toString('base64url');}});
  assert.equal(mail.body,'Keep the exact plain alternative');assert.match(mail.html,/Café/);assert.match(mail.html,/<a href="https:\/\/example.test\/path">Details<\/a>/);assert.match(mail.html,/cid:logo@example.test/);
  assert.deepEqual(requested,['html-body']);assert.deepEqual(mail.attachments.map(item=>[item.attachmentId,item.contentId,item.inline]),[['image-body','logo@example.test',true],['part:1.2','second@example.test',true]]);
});

test('HTML documents attached as files cannot replace the actual Gmail message body',async()=>{
  const mail=await decodeGmailMessage({id:'attachment-only-html',payload:{mimeType:'multipart/mixed',parts:[
    {mimeType:'text/plain',body:{data:Buffer.from('Actual body').toString('base64url')}},
    {partId:'1',mimeType:'text/html',filename:'attached.html',headers:[{name:'Content-Disposition',value:'attachment; filename="attached.html"'}],body:{data:Buffer.from('<h1>Separate document</h1>').toString('base64url')}}
  ]}},'gmail:fixture');
  assert.equal(mail.body,'Actual body');assert.equal(mail.html,null);assert.equal(mail.htmlVersion,1);assert.equal(mail.attachments[0].contentDisposition,'attachment');assert.equal(mail.attachments[0].inline,false);
});

test('mixed plain body sections stay visible in EML, RAW and FULL HTML without duplicating alternative text',async()=>{
  const plain='Independent instructions\nLiteral <script>alert(1)</script> & text.',alternative='Plain alternative only',html='<html><body><table><tr><td>Rich body</td></tr></table></body></html>';
  const mime=Buffer.from(['From: sender@example.test','Content-Type: multipart/mixed; boundary="mixed"','','--mixed','Content-Type: text/plain; charset=utf-8','',plain,'--mixed','Content-Type: multipart/alternative; boundary="alternative"','','--alternative','Content-Type: text/plain; charset=utf-8','',alternative,'--alternative','Content-Type: text/html; charset=utf-8','',html,'--alternative--','--mixed--',''].join('\r\n'));
  const local=await parseEml(mime),raw=await decodeGmailMessage({id:'mixed',raw:mime.toString('base64url')},'gmail:fixture');
  const full=await decodeGmailMessage({id:'mixed',payload:{mimeType:'multipart/mixed',parts:[
    {mimeType:'text/plain',body:{data:Buffer.from(plain).toString('base64url')}},
    {mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:Buffer.from(alternative).toString('base64url')}},{mimeType:'text/html',body:{data:Buffer.from(html).toString('base64url')}}]}
  ]}},'gmail:fixture');
  for(const message of [local,raw,full]){
    assert.match(message.body,/Independent instructions/);assert.match(message.body,/Plain alternative only/);
    assert.match(message.html,/Independent instructions/);assert.match(message.html,/<table>/);assert(!message.html.includes(alternative));
    assert(!message.html.includes('<script>'));assert.match(message.html,/&lt;script&gt;/);assert.match(message.html,/&amp; text/);
  }
});

test('recipient validation and MIME headers reject header injection; missing attachment data is not sent',async()=>{
  assert.throws(()=>validateRecipients({to:'invalid'}),/有效的收件者/);
  assert.throws(()=>validateRecipients({to:'valid@example.com\r\nBcc: attacker@example.com'}),/不可包含換行/);
  assert.deepEqual(validateRecipients({to:'Name <valid@example.com>',bcc:'b@example.com'}),['valid@example.com','b@example.com']);
  await assert.rejects(buildMime({subject:'hello\r\nBcc: attacker@example.com'}),/不可包含換行/);
  await assert.rejects(buildMime({attachments:[{name:'missing.pdf',path:'C:/secret.pdf'}]}),/附件內容尚未載入/);
});

test('EML replies preserve complete RFC references and use the conversation root for local grouping',async()=>{
  const parsed=await parseEml(Buffer.from('From: a@example.com\r\nTo: b@example.com\r\nMessage-ID: <third@example.com>\r\nIn-Reply-To: <second@example.com>\r\nReferences: <root@example.com> <second@example.com>\r\n\r\nreply'));
  assert.equal(parsed.threadId,'<root@example.com>');
  assert.deepEqual(parsed.references,['<root@example.com>','<second@example.com>']);
  assert.equal(parsed.inReplyTo,'<second@example.com>');
});

test('reply all preserves quoted commas and substring addresses while excluding exact self and duplicate mailboxes',async()=>{
  const result=replyRecipients({from:'Sender <sender@example.com>',to:'"Doe, John" <john@example.com>, Anna <anna@example.com>, Joanna <joanna@example.com>',
    cc:'JOHN@EXAMPLE.COM, someone@example.com, sender@example.com',bcc:'secret@example.com'},'ANNA@EXAMPLE.COM',true);
  assert.equal(result.to,'"Sender" <sender@example.com>');
  assert.equal(result.cc,'"Doe, John" <john@example.com>, "Joanna" <joanna@example.com>, someone@example.com');
  assert.equal(result.bcc,'');
  const parsed=await parseEml(await buildMime({from:'anna@example.com',...result,subject:'Reply',body:'test'}));
  assert.match(parsed.cc,/Doe, John/);assert.match(parsed.cc,/joanna@example.com/);assert.doesNotMatch(parsed.cc,/\bAnna </);
  assert.doesNotMatch(parsed.cc,/secret@example.com/);
});

test('reply respects Reply-To and replies to original recipients when the sender is self',()=>{
  assert.deepEqual(replyRecipients({from:'sender@example.com',replyTo:'Support <support@example.com>',to:'me@example.com'},'me@example.com'),{to:'"Support" <support@example.com>',cc:'',bcc:''});
  assert.deepEqual(replyRecipients({from:'ME@example.com',to:'you@example.com',cc:'other@example.com'},'me@example.com',true),{to:'you@example.com',cc:'other@example.com',bcc:''});
});

'use strict';

const {createHash} = require('node:crypto');
const {simpleParser} = require('mailparser');
const nodemailer = require('nodemailer');
const addressparser = require('nodemailer/lib/addressparser');

const MAX_MAIL_BYTES = 35 * 1024 * 1024;
const SYSTEM_LABELS = new Set(['INBOX','SPAM','TRASH','UNREAD','STARRED','IMPORTANT','SENT','DRAFT','CHAT','CATEGORY_PERSONAL','CATEGORY_SOCIAL','CATEGORY_PROMOTIONS','CATEGORY_UPDATES','CATEGORY_FORUMS']);
const parserOptions = {skipHtmlToText:false,skipTextToHtml:false,skipTextLinks:true,skipImageLinks:true,keepCidLinks:true,maxHtmlLengthToParse:8*1024*1024};
const b64url = value => Buffer.from(value || '', 'base64url');
const safeName = name => {
  let value=String(name||'attachment').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').replace(/[. ]+$/,'');
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))value='_'+value;
  return value||'attachment';
};
const addresses = value => Array.isArray(value) ? value.map(addresses).filter(Boolean).join(', ') : value?.text || '';
const references = parsed => Array.isArray(parsed.references)?parsed.references:parsed.references?[parsed.references]:[];
const normalizeContentId = value => typeof value==='string'?value.trim().replace(/^<|>$/g,'').trim()||null:null;
const textFragmentHtml = text => '<div>'+text.replace(/[&<>"']/g,value=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value])).replace(/\r\n?|\n/g,'<br>')+'</div>';
function attachmentPresentation(contentId,disposition){
  const value=String(disposition||'').split(';',1)[0].trim().toLowerCase();
  const contentDisposition=['inline','attachment'].includes(value)?value:null;
  return{contentId:normalizeContentId(contentId),contentDisposition,inline:contentDisposition==='inline'||!!normalizeContentId(contentId)};
}

function applyGmailLabels(message,labelIds=[],labels=[]) {
  const ids = [...new Set(labelIds)];
  const names = new Map(labels.map(label=>[label.id,label.name]));
  return {...message,labelIds:ids,read:!ids.includes('UNREAD'),star:ids.includes('STARRED'),
    folder:ids.includes('TRASH')?'trash':ids.includes('SPAM')?'spam':ids.includes('DRAFT')?'drafts':ids.includes('INBOX')?'inbox':ids.includes('SENT')?'sent':'archive',
    labels:ids.filter(id=>!SYSTEM_LABELS.has(id)).map(id=>names.get(id)||id)};
}

function parsedFields(parsed) {
  const from = parsed.from?.value?.[0];
  const date = parsed.date instanceof Date && Number.isFinite(+parsed.date) ? parsed.date.toISOString() : null;
  return {sender:from?.name||from?.address||'',email:from?.address||'',from:addresses(parsed.from),
    to:addresses(parsed.to),cc:addresses(parsed.cc),bcc:addresses(parsed.bcc),replyTo:addresses(parsed.replyTo),
    subject:parsed.subject||'',body:parsed.text||'',html:typeof parsed.html==='string'&&parsed.html?parsed.html:null,htmlVersion:1,date,messageId:parsed.messageId||'',
    inReplyTo:parsed.inReplyTo||'',references:references(parsed),snippet:(parsed.text||'').replace(/\s+/g,' ').slice(0,180)};
}

/** Preserve original HTML as untrusted content; only a sandboxed, sanitized view may render it. */
async function parseEml(input,{accountId='local'}={}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > MAX_MAIL_BYTES) throw new Error('郵件超過 35 MB，請縮小檔案後再匯入');
  const parsed = await simpleParser(bytes,parserOptions);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {id:accountId+':'+hash,accountId,remoteId:null,threadId:references(parsed)[0]||parsed.inReplyTo||parsed.messageId||hash,
    source:accountId==='local'?'本機':'Gmail',...parsedFields(parsed),folder:'inbox',read:false,star:false,labels:[],labelIds:[],
    attachments:parsed.attachments.map((attachment,index)=>({name:safeName(attachment.filename),mimeType:attachment.contentType||'application/octet-stream',
      attachmentId:'local:'+hash+':'+index,size:attachment.size,content:attachment.content,...attachmentPresentation(attachment.contentId,attachment.contentDisposition)}))};
}

const headerValue = (part,name) => (part.headers||[]).find(h=>h.name.toLowerCase()===name.toLowerCase())?.value || '';

/** Gmail FULL payloads expose decoded part bytes as base64url, with attachment bodies fetched separately. */
async function decodeGmailMessage(raw,accountId,labels=[],{loadBody}={}) {
  if (!raw?.id) throw new Error('Gmail 郵件缺少識別碼');
  if (raw.raw) {
    const parsed = await parseEml(b64url(raw.raw),{accountId});
    return applyGmailLabels({...parsed,id:accountId+':'+raw.id,remoteId:raw.id,threadId:raw.threadId||raw.id,
      historyId:raw.historyId||null,source:'Gmail',date:validInternalDate(raw.internalDate)||parsed.date,
      // Gmail bytes stay provider-backed instead of becoming large JSON Buffer objects.
      attachments:parsed.attachments.map(({content,...attachment},index)=>({...attachment,attachmentId:'raw:'+index}))},raw.labelIds,labels);
  }
  const payload = raw.payload || {};
  const headers = (payload.headers||[]).map(h=>String(h.name).replace(/[\r\n:]/g,'')+': '+String(h.value)).join('\r\n');
  const parsed = await simpleParser(headers+'\r\n\r\n',parserOptions);
  const attachments = [];
  async function visit(part) {
    const mime = String(part.mimeType||'').toLowerCase();
    const disposition = headerValue(part,'content-disposition');
    const isAttachment = !!part.filename || /^attachment\b/i.test(disposition) || (!mime.startsWith('multipart/') && !['text/plain','text/html',''].includes(mime));
    if (isAttachment) {
      attachments.push({name:safeName(part.filename),mimeType:mime||'application/octet-stream',
        attachmentId:part.body?.attachmentId||'part:'+(part.partId||''),size:part.body?.size||0,...attachmentPresentation(headerValue(part,'content-id'),disposition)});
      return {text:'',html:null,hasPlain:false};
    }
    if (part.parts?.length) {
      const values = await Promise.all(part.parts.map(visit));
      if (mime==='multipart/alternative') {
        const text=values.find(v=>v.hasPlain)||values.find(v=>v.text)||{text:'',hasPlain:false};
        return{...text,html:values.filter(value=>value.html).at(-1)?.html||null};
      }
      // Mixed/related siblings are additive body parts, not alternative copies.
      const hasHtml=values.some(value=>value.html);
      return {text:values.map(v=>v.text).filter(Boolean).join('\n\n'),html:hasHtml?values.map(v=>v.html||(v.text?textFragmentHtml(v.text):'')).filter(Boolean).join('\n'):null,hasPlain:values.some(v=>v.hasPlain)};
    }
    let data=part.body?.data;
    if(!data&&part.body?.attachmentId&&loadBody)data=await loadBody(part.body.attachmentId);
    if (!data || !['text/plain','text/html'].includes(mime)) return {text:'',html:null,hasPlain:mime==='text/plain'&&!part.body?.size};
    const contentType = headerValue(part,'content-type') || mime+'; charset=utf-8';
    const partMail = await simpleParser('Content-Type: '+contentType+'\r\nContent-Transfer-Encoding: base64\r\n\r\n'+b64url(data).toString('base64'),parserOptions);
    return {text:partMail.text||'',html:mime==='text/html'&&typeof partMail.html==='string'&&partMail.html?partMail.html:null,hasPlain:mime==='text/plain'};
  }
  const content=await visit(payload),body=content.text;
  return applyGmailLabels({id:accountId+':'+raw.id,accountId,remoteId:raw.id,threadId:raw.threadId||raw.id,source:'Gmail',
    ...parsedFields(parsed),body,html:content.html,htmlVersion:1,snippet:raw.snippet||body.replace(/\s+/g,' ').slice(0,180),
    date:validInternalDate(raw.internalDate)||parsedFields(parsed).date,historyId:raw.historyId||null,attachments},raw.labelIds,labels);
}

function validInternalDate(value) {
  const number = Number(value);
  return value!=null && value!=='' && Number.isFinite(number) && Number.isFinite(+new Date(number)) ? new Date(number).toISOString() : null;
}

function cleanHeader(value,name) {
  if (value===undefined || value===null) return '';
  const string = String(value);
  if (/[\r\n\x00]/.test(string)) throw new Error(name+' 不可包含換行');
  return string;
}

function recipientAddresses(mail) {
  const flatten = values => values.flatMap(value=>value.group ? flatten(value.group) : [value.address]);
  return ['to','cc','bcc'].flatMap(name=>flatten(addressparser(cleanHeader(mail[name],name)))).filter(Boolean);
}

function validateRecipients(mail) {
  const values = recipientAddresses(mail);
  if (!values.length || values.some(value=>!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))) throw new Error('請輸入有效的收件者電子郵件');
  return values;
}

/** Compare mailbox addresses exactly; quoted display names and group addresses remain intact. */
function replyRecipients(message,selfEmail='',all=false) {
  const flatten=values=>values.flatMap(value=>value.group?flatten(value.group):[value]);
  const parse=value=>flatten(addressparser(cleanHeader(value,'郵件地址'))).filter(value=>value.address);
  const self=String(selfEmail).trim().toLowerCase(),seen=new Set(self?[self]:[]);
  const unique=values=>values.filter(value=>{
    const key=value.address.trim().toLowerCase();
    if(seen.has(key))return false;seen.add(key);return true;
  });
  const format=values=>values.map(value=>value.name?
    '"'+value.name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'" <'+value.address+'>':value.address).join(', ');
  let targets=unique(parse(message.replyTo||message.from||message.email||''));
  // Replying to one's own sent mail targets the original recipients.
  if(!targets.length)targets=unique(parse(message.to||''));
  const cc=all?unique([...parse(message.to||''),...parse(message.cc||'')]):[];
  return {to:format(targets),cc:format(cc),bcc:''};
}

/** Generates MIME locally. Stream transport does not connect to SMTP or send anything. */
async function buildMime(mail) {
  const attachments = (mail.attachments||[]).map(attachment=>{
    if (attachment.content==null) throw new Error('附件內容尚未載入：'+safeName(attachment.name));
    const content = Buffer.isBuffer(attachment.content) ? attachment.content :
      attachment.content instanceof Uint8Array ? Buffer.from(attachment.content) :
      typeof attachment.content==='string' ? Buffer.from(attachment.content,'base64') : null;
    if (!content) throw new Error('附件內容格式不正確');
    return {filename:safeName(attachment.name||attachment.filename),contentType:attachment.mimeType||attachment.contentType||'application/octet-stream',content};
  });
  if (attachments.reduce((sum,item)=>sum+item.content.length,0)>25*1024*1024) throw new Error('附件總大小不可超過 25 MB');
  const options = {from:cleanHeader(mail.from,'寄件者'),to:cleanHeader(mail.to,'收件者'),cc:cleanHeader(mail.cc,'副本'),
    bcc:cleanHeader(mail.bcc,'密件副本'),subject:cleanHeader(mail.subject,'主旨'),text:String(mail.body||''),attachments,
    disableFileAccess:true,disableUrlAccess:true,keepBcc:true};
  if (mail.inReplyTo) options.inReplyTo=cleanHeader(mail.inReplyTo,'In-Reply-To');
  if (mail.references) options.references=Array.isArray(mail.references)?mail.references.map(value=>cleanHeader(value,'References')):cleanHeader(mail.references,'References');
  const transport = nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows'});
  const {message} = await transport.sendMail(options);
  if (message.length>MAX_MAIL_BYTES) throw new Error('郵件編碼後超過 35 MB');
  return message;
}

module.exports = {parseEml,buildMime,decodeGmailMessage,applyGmailLabels,validateRecipients,replyRecipients,normalizeContentId};

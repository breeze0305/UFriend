'use strict';

const {Parser}=require('htmlparser2');
const {prepareMailAnalysisInput}=require('./mail-analysis-input.cjs');

// This is only a measure of available body text, not a claim that a reader has
// read it or that a short message is necessarily missing information.
const LIMITED_TEXT_CHARACTERS=80;
const INERT_TAGS=new Set(['script','style','title','textarea','template','head']);
const asText=value=>typeof value==='string'?value:'';

function pixelDimension(value){
  const match=/^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(value||'');
  return match?Number(match[1]):null;
}
function presentation(attributes){
  const declarations=new Map();
  for(const part of asText(attributes.style).split(';')){
    const colon=part.indexOf(':');if(colon===-1)continue;
    declarations.set(part.slice(0,colon).trim().toLowerCase(),part.slice(colon+1).replace(/\s*!important\s*$/i,'').trim().toLowerCase());
  }
  return{hidden:Object.hasOwn(attributes,'hidden')||declarations.get('display')==='none'||declarations.get('visibility')==='hidden',
    width:pixelDimension(declarations.get('width')??attributes.width),height:pixelDimension(declarations.get('height')??attributes.height)};
}
function knownTrackingImage(source){
  let pathname;
  try{pathname=new URL(source,'https://mail.invalid/').pathname.toLowerCase();}catch{return false;}
  // Restrict this to recognizable pixel endpoints. A tracking hostname or a
  // tracking query parameter alone does not make a real banner decorative.
  return /\/(?:pixel|tracking[-_]?pixel|beacon|open|tracking)\.(?:gif|png|jpe?g|webp)(?:\/)?$/.test(pathname)||/\/wf\/open\/?$/.test(pathname);
}
function unreadImages(html,{firstOnly=false}={}){
  let count=0,historyStarted=false;
  const excluded=[];
  const parser=new Parser({
    onopentag(name,attributes){
      const parentExcluded=excluded.at(-1)||false,style=presentation(attributes);
      const inactive=parentExcluded||INERT_TAGS.has(name)||style.hidden;
      // These are structural mail quotation markers. An ordinary image or
      // horizontal rule is not enough to identify the end of current content.
      if(firstOnly&&!inactive&&(name==='blockquote'||asText(attributes.class).split(/\s+/).some(value=>value.toLowerCase()==='gmail_quote')
        ||asText(attributes.id).toLowerCase()==='divrplyfwdmsg'))historyStarted=true;
      const isExcluded=inactive||historyStarted;
      excluded.push(isExcluded);
      if(name!=='img'||isExcluded)return;
      const source=asText(attributes.src).trim();
      if(!source||knownTrackingImage(source))return;
      if(style.width===0||style.height===0||style.width!==null&&style.height!==null&&style.width<=1&&style.height<=1)return;
      count++;
    },
    onclosetag(){excluded.pop();}
  },{decodeEntities:true});
  parser.end(html);
  return count;
}

function getMailContentContext(mail,{firstOnly=false}={}){
  const originalBody=asText(mail?.body),selectedBody=firstOnly?splitMailThread(originalBody,{firstOnly:true}).current:originalBody;
  const body=prepareMailAnalysisInput({subject:'',body:selectedBody}).input.body.replaceAll('【網址】','');
  let characters=0;
  for(const character of body)if(/[\p{L}\p{N}]/u.test(character)&&++characters>=LIMITED_TEXT_CHARACTERS)break;
  const unreadImageCount=unreadImages(asText(mail?.html),{firstOnly});
  return{attachmentCount:Array.isArray(mail?.attachments)?mail.attachments.length:0,unreadImageCount,
    imageTextUnavailable:unreadImageCount>0,textLimited:characters<LIMITED_TEXT_CHARACTERS};
}

const HAS_DATE=/(?:\d{2,4}年\s*\d{1,2}月\s*\d{1,2}日|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\b|\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)/i;
function replyHeader(text){
  if(/^On\s+.{1,700}\bwrote:\s*$/i.test(text))return HAS_DATE.test(text);
  const chinese=/^(?:.{1,250}(?:於|于)\s*|在\s*)(.{1,500})(?:寫道|写道)[：:]\s*$/u.exec(text);
  return!!chinese&&HAS_DATE.test(chinese[1]);
}

function mailHeaderField(text){
  const match=/^ {0,3}(From|Sent|Date|To|Cc|Subject|寄件者|寄件人|發件者|发件人|寄件日期|寄件時間|寄件时间|傳送時間|传送时间|發送時間|发送时间|日期|收件者|收件人|副本|抄送|主旨|主題|主题)\s*[:：]\s*(.*)$/i.exec(text);
  if(!match)return null;
  const label=match[1],kind=/^(?:From|寄件者|寄件人|發件者|发件人)$/i.test(label)?'from':/^(?:Sent|Date|寄件日期|寄件時間|寄件时间|傳送時間|传送时间|發送時間|发送时间|日期)$/i.test(label)?'date':/^(?:To|收件者|收件人)$/i.test(label)?'to':/^(?:Subject|主旨|主題|主题)$/i.test(label)?'subject':'cc';
  return{kind,value:match[2]};
}
function outlookHeader(lines,start){
  if(mailHeaderField(lines[start]?.text||'')?.kind!=='from')return false;
  const fields=new Map();let previous=null,length=0;
  for(let index=start;index<Math.min(lines.length,start+12);index++){
    const text=lines[index].text;if((length+=text.length)>1800)return false;
    if(!text.trim())continue;
    const field=mailHeaderField(text);
    if(field){
      if(fields.has(field.kind)&&field.kind!=='cc')return false;
      fields.set(field.kind,field);previous=field;
    }else if(previous&&/^[ \t]+\S/.test(text))previous.value+=' '+text.trim();
    else return false;
    if(fields.get('from')?.value&&HAS_DATE.test(fields.get('date')?.value||'')&&fields.get('to')?.value&&fields.has('subject'))return true;
  }
  return false;
}
const FORWARDED_HEADER=/^ {0,3}(?:[-_]{2,}\s*(?:Forwarded message|Forwarded mail|轉寄(?:的)?(?:郵件|訊息)|转发(?:的)?(?:邮件|消息))\s*[-_]{2,}|Begin forwarded message\s*:|(?:轉寄(?:的)?(?:郵件|訊息)|转发(?:的)?(?:邮件|消息))\s*[：:])\s*$/i;
const MAILBOX_LINE=/^\s*(?:[^<>\r\n]{0,150}<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)\s*$/;
function comparisonQuote(content){
  return /^(?:[A-Za-z_$][\w.$]*|\d+(?:\.\d+)?\s*[A-Za-z%]+|(?:[A-Za-z_$][\w.$]*|\d+(?:\.\d+)?)(?:\s*[+*/%\-]\s*(?:[A-Za-z_$][\w.$]*|\d+(?:\.\d+)?))+)$/.test(content.trim());
}

function splitMailThread(body,{firstOnly=false}={}){
  body=asText(body);
  const lines=[...body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match=>match[0].length).map(match=>({start:match.index,text:match[0].replace(/[\r\n]+$/,'')}));
  let fence=null,quoteStart=null;
  const split=index=>({current:body.slice(0,index),history:body.slice(index),boundaryKnown:true});
  for(let index=0;index<lines.length;index++){
    const line=lines[index],text=line.text;
    const code=/^ {0,3}(`{3,}|~{3,})/.exec(text);
    if(code){
      if(!fence)fence={character:code[1][0],length:code[1].length};
      else if(code[1][0]===fence.character&&code[1].length>=fence.length&&new RegExp('^ {0,3}'+fence.character+'{'+fence.length+',}\\s*$').test(text))fence=null;
      quoteStart=null;continue;
    }
    if(fence)continue;
    if(/^ {0,3}[-_]{2,}\s*(?:Original Message|原始郵件|原始邮件|原始訊息|原始消息)\s*[-_]{2,}\s*$/i.test(text))return split(line.start);
    if(firstOnly){
      if(FORWARDED_HEADER.test(text)||outlookHeader(lines,index))return split(line.start);
      if(/^ {0,3}[_-]{5,}\s*$/.test(text)){
        let next=index+1;while(next<lines.length&&next<=index+3&&!lines[next].text.trim())next++;
        if(outlookHeader(lines,next))return split(line.start);
      }
    }
    // Only join folded attributions for recognition; returned spans always
    // slice the untouched body. First-only mode also accepts a folded mailbox
    // line and longer wrapping without looking for subsequent current replies.
    if(/^ {0,3}(?:On\s|在\s|.{1,250}(?:於|于)\s*)/u.test(text)||firstOnly&&MAILBOX_LINE.test(text)){
      let candidate='';
      for(let length=0;length<(firstOnly?5:3)&&index+length<lines.length;length++){
        const next=lines[index+length].text.trim();if(!next||next.length>750)break;
        // A complete attribution on the next line is its own boundary, not
        // evidence that the preceding current sentence belongs to its header.
        if(firstOnly&&length>0&&replyHeader(next))break;
        candidate+=(candidate?' ':'')+next;
        if(replyHeader(candidate))return split(line.start);
        // Genuine wrapped dates/mailboxes do not require absorbing a complete
        // prose sentence such as "我於今天完成修改。" or "On Monday we shipped."
        if(firstOnly&&/[.!?。！？]\s*$/.test(next))break;
      }
    }
    const quote=/^ {0,3}>[ \t]?(.*)$/.exec(text);
    if(quote){
      const content=quote[1];
      if(!content.trim()){quoteStart??=line.start;continue;}
      if(!/^[=>]/.test(content)&&/[\p{L}]/u.test(content)&&(!firstOnly||!comparisonQuote(content))){
        // Conversation-aware callers retain uncertain inline/bottom replies.
        // First-only callers deliberately stop at the first clear quote and
        // never recover later unquoted replies from the remainder.
        if(!firstOnly&&lines.slice(index+1).some(next=>next.text.trim()&&!/^ {0,3}>/.test(next.text)))return{current:body,history:'',boundaryKnown:false};
        return split(quoteStart??line.start);
      }
    }
    quoteStart=null;
  }
  return{current:body,history:'',boundaryKnown:false};
}

module.exports={LIMITED_TEXT_CHARACTERS,getMailContentContext,splitMailThread};

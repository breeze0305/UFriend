'use strict';

// This is a narrow missing-value check, not a semantic completeness score.
// Match typed values in the current message; arbitrary numbers in contact
// details, identifiers, quotations or the same paragraph are not required.
const AMOUNT=/(?:(?:\b(?:TWD|NTD|USD|EUR|JPY|CNY|RMB|HKD|SGD)|新[臺台]幣|[臺台]幣|美元|日圓|日元|歐元|港幣|英鎊)\s*[-+]?\s*\d[\d,]*(?:\.\d+)?|(?:NT|US|HK|S)?[$¥￥€£]\s*[-+]?\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:新[臺台]幣|美元|[臺台]幣|日圓|日元|歐元|港幣|英鎊|元|圓|円|(?:TWD|NTD|USD|EUR|JPY|CNY|RMB|HKD|SGD)\b))/gi;
const DATE=/(?<![A-Za-z\d/.-])(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{1,2}月\s*\d{1,2}日|\d{1,2}\/\d{1,2}\s*[-~～–—至]\s*\d{1,2}\/\d{1,2}|\d{1,2}[/-]\d{1,2}|\d{1,2}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{4})(?![A-Za-z\d/.-])/gi;
const CLOCK=/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g;
const CONTACT_HOURS=/(?:客服|服務|服务|營業|营业|辦公|办公|開放|开放)[^。\n]{0,12}(?:時間|时间|時段|时段)|\b(?:customer service|support|business|office|opening) hours\b|(?:聯繫|联系|聯絡|联络|\bcontact\b)[^。\n]{0,30}(?:週[一二三四五六日天]|周[一二三四五六日天]|星期|\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b)/i;
const EXPLICIT_DEADLINE=/(?:請|请|必須|必须|務必|务必|需於|需于|截止|到期|\b(?:please|must|required|deadline|due|expires?)\b)/i;
const COPYRIGHT=/(?:copyright|all rights reserved|版權所有|版权所有|©)/i;
function validCalendarValue(fragment){
  if(/[A-Za-z]/.test(fragment))return true;
  const parts=fragment.match(/\d+/g).map(Number),triples=parts.length===3?[parts]:parts.length===4?[[2024,...parts.slice(0,2)],[2024,...parts.slice(2)]]:[[2024,...parts]];
  return triples.every(([year,month,day])=>{
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
  });
}
function requiredCalendarValue(match,text,preceding){
  const fragment=match[0];if(!validCalendarValue(fragment))return false;
  if(!/^\d{1,2}-\d{1,2}$/.test(fragment))return true;
  const before=text.slice(Math.max(0,match.index-24),match.index),after=text.slice(match.index+fragment.length);
  if(/[\w*+/=]$/.test(before)||/^\s*(?:歲|岁|年齡|年龄|(?:years?\s+old|year-olds?)\b)/i.test(after))return false;
  // A short hyphenated pair is also a shop name, age range or identifier.
  // Require calendar context before treating this ambiguous notation as a date.
  const calendarContext=before.trim()?before:preceding;
  return /(?:日期|時間|时间|期間|期间|期限|截止|到期|有效|出發|出发|抵達|抵达|回程|去程|會議|会议|活動|活动|開始|开始|結束|结束|報到|报到|付款日|退款日|收件日|寄件日|(?:於|于|自|從|从|至|到)\s*$|\b(?:date|deadline|due|valid|on|by|before|after|from|to|until|through|depart|arriv|schedul)\w*)/i.test(calendarContext)
    ||/^\s*(?:日|前|後|后|起|止|截止|到期|開始|开始|結束|结束)/.test(after);
}

function requiredCurrentValueFragments(current){
  const fragments=[];
  let preceding='';
  for(const clause of String(current||'').split(/\r?\n|(?<=[。！？；;，])|(?<=[.!?])\s+(?=[A-Z])/u)){
    const text=clause.trim();if(!text)continue;
    for(const match of text.matchAll(AMOUNT))fragments.push(match[0]);
    if(!COPYRIGHT.test(text))for(const match of text.matchAll(DATE))if(requiredCalendarValue(match,text,preceding))fragments.push(match[0]);
    // A routine support window is not an appointment or an action deadline.
    // Keep deadlines even if the same sentence also mentions a support desk.
    const bareHours=/^[\d\s:：–—~～至到-]+[)）。，;；]*$/.test(text);
    const deadlineText=text.replace(/\bplease\s+(?:contact|call|e-?mail)\b/gi,'');
    if(!(CONTACT_HOURS.test(text)||bareHours&&CONTACT_HOURS.test(preceding))||EXPLICIT_DEADLINE.test(deadlineText)){
      for(const match of text.matchAll(CLOCK))fragments.push(match[0]);
    }
    preceding=text;
  }
  return fragments;
}

module.exports={requiredCurrentValueFragments};

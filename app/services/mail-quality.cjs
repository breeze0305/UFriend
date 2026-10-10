'use strict';

const {prepareMailAnalysisInput}=require('./mail-analysis-input.cjs');
const {splitMailThread}=require('./mail-content-context.cjs');
const {requiredCurrentValueFragments}=require('./mail-value-coverage.cjs');
const MAX_FACTS=32;
const ISSUES=new Set(['currency-mismatch','number-mismatch','identifier-mismatch','duration-mismatch','condition-missing','conditional-action-overstated','latest-status-conflict','evidence-unrelated','missing-important-facts','image-text-unavailable','attachment-text-unavailable','attachment-unavailable','priority-unverified','model-capacity-limited','model-metadata-in-summary','safety-instruction-missing','no-action-status-missing']);
const letters=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const meaningful=text=>/[\p{L}\p{N}]/u.test(text.replaceAll('【網址】','').replace(/\[?cid:[^\s\]]+\]?/gi,''));
const dates=/(?:\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}\b|\d{1,2}月\s*\d{1,2}日|\b\d{1,2}:\d{2}\b|\b\d{1,2}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{4}\b)/i;
const money=/(?:\b(?:TWD|USD|EUR|JPY|CNY|RMB|HKD|SGD)\s*\d|(?:NT|US|HK|S)?\$\s*\d|\d[\d,.]*\s*(?:元|圓|円|美元|台幣|新台幣|日圓|歐元|英鎊)|\d+(?:\.\d+)?%)/i;
const state=/(?:已(?:完成|確認|確認|收|付|取消|結清|寄|出貨|送達|撤|改)|收到成功|收訖|結清|無須|無需|不需|不用|撤銷|取消|改期|尚未|未完成|失敗|\b(?:paid|received|confirmed|cancelled|canceled|completed|rescheduled|failed)\b)/i;
const conditions=/(?:如果|若|如有|如您|如你|一旦|除非|否則|後\s*\d|前\s*\d|\b(?:if|unless|after|before|within|until|only|except)\b)/i;
const request=/(?:請|请|必須|必须|務必|务必|麻煩|麻烦|需於|需要|\b(?:please|must|required|reply|respond)\b)/i;
const fields=/(?:航班|航段|行李|艙|艙等|班機|訂位|付款|支付|金額|總額|合計|訂單|驗貨|取件|申訴|\b(?:flight|departure|arrival|duration|baggage|carry[ -]?on|checked bag|fare|total|amount|booking|payment)\b)/i;
const footer=/(?:copyright|all rights reserved|unsubscribe|privacy policy|取消訂閱|隱私(?:權|條款)|版權所有|客服專線|官方帳號|例假日|view (?:this email|in (?:a )?browser)|在瀏覽器|瀏覽器觀看|訂閱設定)/i;
const sameAddress=(a,b)=>typeof a==='string'&&a&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

function criticalSourceText(text){
  // These are retention signals, never a semantic classifier or an obligation
  // detector. In particular, an if-clause is retained together with its action.
  return meaningful(text)&&(state.test(text)||money.test(text)||dates.test(text)||request.test(text)&&conditions.test(text)||fields.test(text)&&/\d/.test(text));
}
const routineFooter=/(?:本(?:電子訊息|電子郵件)[\s\S]{0,65}機密|the information contained in this message[\s\S]{0,65}confidential|if you are not the intended recipient|(?:copyright|all rights reserved|取消訂閱|unsubscribe|opt[ -]out)[\s\S]{0,180}(?:請勿(?:直接)?回覆|do not reply)|(?:與我們聯繫|客服|contact us)[\s\S]{0,80}(?:週[一二三四五六日]|\b(?:monday|weekday)s?\b)[\s\S]{0,40}\d{1,2}:\d{2}|(?:customer (?:success|support)|success team|help center)[\s\S]{0,200}24\/7)/i;
const footerOnly=text=>routineFooter.test(text)&&!requiredCurrentValueFragments(text).length||footer.test(text)&&!criticalSourceText(text);

// Keep ordinary excerpts small enough that several independent records can
// share the summary budget. Linked records still compete as complete units.
const EXCERPT_PART_LIMIT=360;
const excerptDates=/(?:\d\s*月\s*\d{1,2}\s*日|\b\d{1,2}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{4}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\b)/i;
const excerptMoney=text=>money.test(text)||/\d[\d,.]*\s*(?:TWD|USD|EUR|JPY|CNY|RMB|HKD|SGD)\b/i.test(text);
const decoration=text=>/^(?:image(?: description)?|flight|hotel|logo|spacer|banner|icon|圖片|圖示)$/i.test(text.trim());
function pieces(text){
  const result=[];let block=0,sectionIndex=0;
  for(const paragraph of text.split(/\r?\n[\t \u00a0\r]*\n|\r?\n(?=[\t ]*(?:\d{1,2}[.)、](?:\s|$)|總額\s*(?:\/|:|：)|Total Amount\s*[:：]))|[\u00AD\u034F\u200B-\u200F\uFEFF][\u00AD\u034F\u200B-\u200F\uFEFF\s]{29,}/i)){
    const section=/^\s*(?:[^:\n]{1,15}[:：]\s*)?\d{1,2}[.)、]\s*(?:若|如果|如有|如您|如你|\bif\b|\bunless\b)/i.test(paragraph)&&paragraph.length<=1200?sectionIndex:undefined;sectionIndex++;
    let rest=paragraph.replace(/^[\s\[\]<>]+|[\s\[\]<>]+$/g,'');
    while(rest){
      let end=Math.min(rest.length,EXCERPT_PART_LIMIT);
      if(end<rest.length){
        const sentenceEnd=/[。！？!?](?:[）)」”\"])?|\.(?=\s|$)/g;
        const breaks=[...rest.slice(0,end).matchAll(sentenceEnd)],last=breaks.at(-1);
        if(last)end=last.index+last[0].length;
        else{
          // A wrapped line or tracking link is not a sentence boundary. Keep
          // the complete clause, including its condition, whenever it fits.
          const next=[...rest.slice(end,1000).matchAll(sentenceEnd)][0];
          if(next)end+=next.index+next[0].length;
          else end=Math.min(rest.length,1000);
        }
        if(/[\uD800-\uDBFF]/.test(rest[end-1]))end--;
      }
      const part=rest.slice(0,end).trim();rest=rest.slice(end).trim();
      // Each literal fragment stays separate from a removed URL, but every
      // side of the same passage competes for space as one complete unit.
      const passages=part.includes('【網址】')?part.split(/(?<=[。！？!?])(?=[^）)」”\"])(?!$)|(?<=\.)(?=\s|$)/):[part];
      for(const passage of passages){
        for(const fragment of passage.split('【網址】')){
          const clean=fragment.replace(/^[\s\[\]<>]+|[\s\[\]<>]+$/g,'');
          if(meaningful(clean))result.push({text:clean,block,section});
        }
        block++;
      }
    }
  }
  return result;
}
function retentionUnits(items){
  const units=[];
  for(const item of items){
    const previous=units.at(-1);
    if(item.group!==undefined&&previous&&previous[0].group===item.group)previous.push(item);
    else units.push([item]);
  }
  return units;
}
function sourceFacts(input){
  const prepared=prepareMailAnalysisInput({subject:input.subject||'',body:input.body||''});
  const thread=splitMailThread(prepared.input.body),candidates=[];
  const rawThread=splitMailThread(input.body||''),rawSources={subject:input.subject||'',current:rawThread.current,history:rawThread.history};
  for(const [origin,text]of [['subject',prepared.input.subject],['current',thread.current],['history',thread.history]]){
    let cursor=0;
    for(const piece of pieces(text)){
      const part=piece.text;
      let restored;try{restored=prepared.restoreEvidence([part]);}catch{continue;}
      for(const quote of restored){
        if(quote.length>1000)continue;
        const rawStart=rawSources[origin].indexOf(quote,cursor),rawEnd=rawStart<0?-1:rawStart+quote.length;
        if(rawEnd>=0)cursor=rawEnd;
        const hasDate=dates.test(part)||excerptDates.test(part),hasMoney=excerptMoney(part);
        let score=(origin==='subject'?18:0)+(origin==='current'?2:0)+(hasMoney?9:0)+(hasDate?7:0)+(state.test(part)?6:0)
          +(fields.test(part)&&/\d/.test(part)?8:0)+(request.test(part)?3:0)+(conditions.test(part)?3:0)-(footerOnly(part)?18:0);
        // A footer phone/year is not an omitted business value merely because
        // it follows a colon. Other amount and deadline signals still apply.
        const labelledValue=part.length<=100&&!footerOnly(part)&&/^[^\n:：]{1,35}[:：]\s*[^\n]*\d/.test(part);if(labelledValue)score+=4;
        const clocks=[...part.matchAll(/\b\d{1,2}:\d{2}\b/g)].length;
        const itinerary=!footerOnly(part)&&(clocks>=2&&!conditions.test(part)||/(?:航班\s*\d\s*:|航空公司\s*\(班號\)|飛行時間|Duration\s*:)/i.test(part)&&/\d/.test(part));
        const allowance=part.length<=140&&/(?:\d\s*(?:KG|PC)\b|CARRY\d+KG|每名旅客\s*\d|託運行李\s*（\d|手提行李袋\s*（\d|^免費 (?:UP TO|CARRY))/i.test(part);
        const total=/(?:^支付|^\d[\d,.]*\s*[A-Z]{3}[^\n]{0,15}合計|(?:^|\n)\s*總額|\btotal amount\b)/i.test(part)&&hasMoney;
        const temporalNotice=part.length<=120&&hasDate&&(clocks===1||/(?:截止|期間|只到|到期|開搶|最後一天|deadline|expires|valid until)/i.test(part));
        const offerScope=part.length<=160&&/(?:\d+(?:\.\d+)?\s*折|買[一1]送[一1]|半價|限時優惠|\b(?:buy one get one|limited.time offer)\b)/i.test(part);
        const recordId=part.length<=160&&/(?:訂位代號|機票號碼|票號|\b(?:booking ref|ticket number)\b)[^。\n]{0,60}[A-Z\d]/i.test(part);
        const timedAction=!footerOnly(part)&&request.test(part)&&/(?:前|內|\b(?:before|within|at least)\b)/i.test(part)&&/(?:\d|一|二|三|\b(?:one|two|three)\b)\s*(?:個?小時|分鐘|天|日|hours?|minutes?|days?)|\d{1,2}:\d{2}/i.test(part);
        if(itinerary)score+=clocks>=2?50:24;if(allowance)score+=24;if(total)score+=26;if(temporalNotice)score+=27;
        if(offerScope)score+=28;if(recordId)score+=30;if(timedAction)score+=38;
        if(!footerOnly(part)&&/(?:不得|不可|禁止|\b(?:not|never|cannot|mustn't|don't)\b)/i.test(part))score+=6;
        if(decoration(part))score=-30;
        candidates.push({text:quote,clean:part,origin,score,critical:origin!=='subject'&&!footerOnly(part)&&(criticalSourceText(part)||hasDate||hasMoney||allowance||labelledValue),index:candidates.length,rawStart,rawEnd,itinerary,allowance,total,offerScope,block:origin+'-'+piece.block,section:piece.section===undefined?undefined:origin+'-'+piece.section});
      }
    }
  }
  // Linked cards are kept as a whole: a price must not outlive its route,
  // carrier and travel dates simply because repeated labels were deduplicated.
  for(let i=0;i<candidates.length;i++){
    const item=candidates[i];if(!excerptMoney(item.clean)||item.clean.length>85)continue;
    let start=i;
    for(let j=i-1;j>=Math.max(0,i-7);j--){
      const before=candidates[j];if(before.origin!==item.origin||before.group!==undefined||before.clean.length>140||excerptMoney(before.clean))break;
      if(decoration(before.clean)){if(/^flight$/i.test(before.clean)&&i-j>=5&&candidates.slice(j+1,i).some(c=>dates.test(c.clean)||excerptDates.test(c.clean)))start=j+1;break;}
    }
    if(start===i){
      // Repeated adjacent linked names commonly identify product/hotel cards.
      for(let j=Math.max(0,i-5);j<i-1;j++){
        const a=candidates[j],b=candidates[j+1];
        if(a.origin===item.origin&&a.group===undefined&&letters(a.clean).length>4&&letters(a.clean)===letters(b.clean)
          &&candidates.slice(j,i).every(c=>c.clean.length<=140&&!excerptMoney(c.clean)&&!decoration(c.clean))){start=j;break;}
      }
    }
    if(start<i){
      const marker=candidates[start-1],heading=candidates[start-2];
      const withHeading=marker&&/^flight$/i.test(marker.clean)&&heading?.offerScope===true&&heading.origin===item.origin&&heading.group===undefined;
      const score=Math.max(25,withHeading?heading.score:0);
      for(const member of candidates.slice(start,i+1)){member.group='linked-'+start;member.score=Math.max(member.score,score);}
      if(withHeading)heading.group='linked-'+start;
    }
  }
  // Allowance labels and repeated values belong to their own route. A value
  // cannot be globally deduplicated away from the next route's label.
  for(let i=0;i<candidates.length;i++){
    const item=candidates[i];if(item.group!==undefined||!item.allowance)continue;
    const previous=candidates[i-1];
    if(previous&&previous.origin===item.origin&&previous.group===undefined&&previous.clean.length<110
      &&!previous.allowance&&/(?:行李規定|Baggage Policy|^[A-Z]{6}$)/i.test(previous.clean)){previous.group=item.group='allowance-'+i;previous.score=Math.max(previous.score,item.score);}
    else item.group='allowance-'+i;
    const next=candidates[i+1];
    if(next&&next.origin===item.origin&&next.group===undefined&&next.allowance
      &&(/^(?:免費|第二件託運行李|2nd Checked Bag)/i.test(next.clean)||/^(?:第一件託運行李|1st Checked Bag)/i.test(item.clean)))next.group=item.group;
  }
  // The repeated class/baggage cells after a flight row describe that row,
  // even when their literal values match another leg. Retain the complete
  // short record before deduplication can detach those cells from the route.
  for(let i=0;i<candidates.length;i++){
    const item=candidates[i];if(!item.itinerary||! /\b[A-Z]{2}\s*\d{1,4}\b/.test(item.clean)||[...item.clean.matchAll(/\b\d{1,2}:\d{2}\b/g)].length<2)continue;
    const record=[item];
    for(let j=i+1;j<Math.min(candidates.length,i+7);j++){
      const next=candidates[j];if(next.origin!==item.origin||next.clean.length>360||/(?:\b[A-Z]{2}\s*\d{1,4}\b)[\s\S]*\d{1,2}:\d{2}/.test(next.clean))break;
      record.push(next);if(/(?:飛行時間|Duration)\s*(?:\/\s*Duration\s*)?[:：]/i.test(next.clean))break;
    }
    if(record.some(member=>/\bClass\s*:/.test(member.clean))&&record.some(member=>/\bOperated by\s*:/.test(member.clean))
      &&record.at(-1).clean.match(/(?:飛行時間|Duration)\s*(?:\/\s*Duration\s*)?[:：]/i)&&record.reduce((sum,member)=>sum+member.text.length,0)<=1000){
      const score=Math.max(...record.map(member=>member.score));for(const member of record){member.group='flight-record-'+i;member.score=score;}
    }
  }
  for(let i=0;i<candidates.length;i++){
    const item=candidates[i];if(!/(?:航班\s*\d\s*:)/.test(item.clean))continue;
    const record=[item];
    for(let j=i+1;j<Math.min(candidates.length,i+7);j++){
      const next=candidates[j];if(next.origin!==item.origin||next.clean.length>200||/(?:航班\s*\d\s*:)/.test(next.clean))break;
      if(!/(?:去程:|到達:|航空公司\s*\(班號\)|飛行時間:|機型:|票價類型\/艙等:)/.test(next.clean))break;
      record.push(next);
    }
    if(record.some(member=>/航空公司\s*\(班號\)/.test(member.clean))&&record.some(member=>/去程:/.test(member.clean))){
      const score=Math.max(...record.map(member=>member.score));for(const member of record){member.group='flight-record-'+i;member.score=score;}
    }
  }
  const sections=new Map();
  for(const item of candidates)if(item.section!==undefined){if(!sections.has(item.section))sections.set(item.section,[]);sections.get(item.section).push(item);}
  for(const unit of sections.values())if(unit.length>1&&unit.every(item=>item.group===undefined&&!decoration(item.clean))){
    const score=Math.max(...unit.map(item=>item.score))+(unit.some(item=>conditions.test(item.clean))&&unit.some(item=>state.test(item.clean)||request.test(item.clean))?28:0);
    for(const item of unit){item.group='section-'+item.section;item.score=score;}
  }
  const passages=new Map();
  for(const item of candidates){if(!passages.has(item.block))passages.set(item.block,[]);passages.get(item.block).push(item);}
  for(const unit of passages.values())if(unit.length>1&&unit.every(item=>item.group===undefined&&!decoration(item.clean))){
    const score=Math.max(...unit.map(item=>item.score));
    for(const item of unit){item.group='passage-'+item.block;item.score=score;}
  }
  const filtered=candidates.filter(item=>!decoration(item.clean));
  const first=filtered.find(item=>item.origin==='current');if(first)first.score+=15;
  // Deduplicate whole units, never individual cells inside different records.
  const byText=new Map();
  for(const unit of retentionUnits(filtered)){
    const key=unit.map(item=>item.text).join('\u0000'),old=byText.get(key);
    if(!old||unit[0].origin==='current'&&old[0].origin!=='current')byText.set(key,unit);
  }
  const unique=[...byText.values()].flat(),grouped=[];
  for(const item of unique){
    const previous=grouped.at(-1),raw=rawSources[item.origin];
    const newItinerary=/(?:航班\s*\d\s*:)/.test(item.clean)||[...item.clean.matchAll(/\b\d{1,2}:\d{2}\b/g)].length>=2&&/\b[A-Z]{2}\s*\d{1,4}\b/.test(item.clean);
    const compatible=previous&&previous.group===item.group&&(item.group!==undefined||previous.itinerary===item.itinerary&&previous.allowance===item.allowance&&previous.total===item.total)&&!newItinerary&&Math.abs(previous.score-item.score)<=10;
    if(compatible&&previous.origin===item.origin&&previous.rawStart>=0&&item.rawStart>=previous.rawEnd
      &&item.rawEnd-previous.rawStart<=EXCERPT_PART_LIMIT&&/^\s*$/.test(raw.slice(previous.rawEnd,item.rawStart))){
      previous.text=raw.slice(previous.rawStart,item.rawEnd);previous.clean=previous.text;previous.rawEnd=item.rawEnd;
      previous.score=Math.max(previous.score,item.score);previous.critical||=item.critical;
    }else grouped.push({...item});
  }
  const currentHead=grouped.find(item=>item.origin==='current');
  const units=retentionUnits(grouped).filter(unit=>unit.some(item=>item.score>=2||item===currentHead));
  units.sort((a,b)=>Number(b.includes(currentHead))-Number(a.includes(currentHead))||Math.max(...b.map(c=>c.score))-Math.max(...a.map(c=>c.score))||a[0].index-b[0].index);
  const selected=[];for(const unit of units)if(selected.length+unit.length<=MAX_FACTS)selected.push(...unit);
  selected.sort((a,b)=>a.index-b.index);
  if(!selected.length&&unique.length)selected.push(unique[0]);
  return{facts:selected,candidates:unique,thread,prepared:prepared.input,truncated:grouped.some(item=>item.score>=2&&!selected.includes(item))};
}

const currencies={TWD:/(?:\bTWD\b|NT\$|新[臺台]幣|[臺台]幣)/i,USD:/(?:\bUSD\b|US\$|美元|美金)/i,EUR:/(?:\bEUR\b|歐元|欧元|€)/i,
  JPY:/(?:\bJPY\b|日圓|日元|日円)/i,CNY:/(?:\b(?:CNY|RMB)\b|人民幣|人民币)/i,HKD:/(?:\bHKD\b|HK\$|港幣|港币)/i,SGD:/(?:\bSGD\b|新加坡元|新幣|新币)/i};
function numberTokens(text){
  const result=new Set();
  for(const match of text.normalize('NFKC').matchAll(/\d+(?:,\d{3})*(?:\.\d+)?(?:[kKmM](?![a-z]))?/g)){
    const raw=match[0].replaceAll(',',''),unit=/[km]$/i.test(raw)?raw.at(-1).toLowerCase():'';
    const number=unit?Number(raw.slice(0,-1))*(unit==='k'?1000:1000000):Number(raw);
    if(Number.isFinite(number))result.add(String(number));
  }
  return result;
}
function overlap(a,b){
  const left=letters(a),right=letters(b);if(!left||!right)return false;
  if(left.includes(right)||right.includes(left))return true;
  for(let i=0;i<left.length-3;i++)if(right.includes(left.slice(i,i+4)))return true;
  return false;
}
function excerptSummary(facts,thread,limited=false){
  const currentHead=facts.find(item=>item.origin==='current');
  const line=item=>(thread.boundaryKnown&&item.origin==='current'?'最新內容：':item.origin==='history'?'往來引文：':'')+item.text;
  const units=retentionUnits(facts).filter(unit=>!(unit[0].origin==='subject'&&(currentHead&&letters(currentHead.clean).includes(letters(unit[0].clean))||thread.boundaryKnown&&!limited&&facts.some(other=>other.origin==='current'&&!footerOnly(other.clean)))));
  units.sort((a,b)=>Number(b.includes(currentHead))-Number(a.includes(currentHead))||Number(a[0].origin==='history')-Number(b[0].origin==='history')||Math.max(...b.map(c=>c.score))-Math.max(...a.map(c=>c.score))||a[0].index-b[0].index);
  const keep=[];let size=0;
  for(const unit of units){const cost=unit.reduce((sum,item)=>sum+line(item).length+2,0);if(size+cost>1900)continue;keep.push(...unit);size+=cost;}
  keep.sort((a,b)=>a.index-b.index);
  if(!keep.length&&facts[0])keep.push(facts[0]);
  return keep.map(line).join('\n\n')||'可用的郵件文字不足，請查看原始郵件。';
}
function optionalSelfServiceCondition(text){
  if(/(?:請|请|必須|必须|務必|务必|需於|截止|期限)|\b(?:please|must|required|deadline|due)\b/i.test(text))return false;
  const chinese=/^(?:如果|若|如)(?:您|你)?(.+)$/.exec(text);
  if(chinese)return chinese[1].split(/或者|或/).every(part=>{
    const condition=part.trim().replace(/^(?:您|你)/,'');
    // Only plain information objects qualify. An arbitrary question about a
    // charge, dispute or failure is not proof of an optional information lookup.
    const informationQuestion=/^(?:(?:對|对)(?:本次|此|這份|这份|該|该)?(?:(?:帳務|账务|交易|訂單|订单|紀錄|记录|費用|费用)?(?:明細|明细|資訊|信息|詳情|详情|內容|内容|說明|说明|紀錄|记录)|收據|收据|發票|发票))?有(?:任何|其他|更多)?(?:疑問|疑问)$/.test(condition);
    return informationQuestion||/^(?:需(?:要)?(?:額外|额外|更多|進一步|进一步)?(?:協助|协助|幫助|帮助)|(?:想(?:要)?|要|希望|欲)(?:檢視|检视|查看|查閱|查阅|瞭解|了解|閱讀|阅读)[^，,。;；\n]{0,55})$/.test(condition);
  });
  return /^if you (?:need (?:additional |further |more )?(?:help|assistance)|(?:want|wish|would like) to (?:view|see|check|read|review) [^,.;\n]{1,80})$/i.test(text);
}
function optionalSelfServiceAction(text){
  // A choice to open details or contact help is not an accepted obligation.
  // Keep any clause that also contains work, a deadline, or a second action.
  const navigation=/^(?:請|请)\s*(?:您|你)?\s*(?:至|到|前往|登入)\s*(?:本行|本公司|本服務|本服务|我們的|我们的|您的|你的|官方|指定|線上|线上|會員|会员)?(?:網路銀行|網上銀行|線上銀行|线上银行|會員中心|会员中心|服務中心|服务中心|網站|网站|網頁|网页|平台|系統|系统|帳戶|账户|入口|App)(?:\s*(?:(?:檢視|检视|查看|查閱|查阅|查詢|查询|閱讀|阅读)[^，,。;；\n]{0,55}|(?:存款|交易|帳務|账务|訂單|订单|費用|费用){0,2}(?:明細|明细|資訊|信息|詳情|详情)(?:檢視|检视|查看|查閱|查阅|查詢|查询|閱讀|阅读)))?$/i.test(text);
  return (navigation||/^(?:請|请)\s*(?:您|你)?\s*(?:造訪|访问|瀏覽|浏览|檢視|检视|查看|查閱|查阅|閱讀|阅读|參閱|参阅|聯絡|联络|聯繫|联系|洽詢|洽询)|^please\s+(?:visit|open|view|read|check|contact)\b/i.test(text))
    &&!/(?:必須|必须|務必|务必|需於|需要|截止|期限|交回|提交|繳交|缴交|支付|付款|上傳|上传|確認|确认|完成|填寫|填写|回覆|回复|並|并|然後|然后|同時|同时|以及|但)|\b(?:must|required|deadline|due|submit|upload|send|return|reply|respond|pay|confirm|complete|process|and|then|also|but)\b/i.test(text)
    &&!/(?:請|请|\bplease\b)/i.test(text.replace(/^(?:請|请|please)\s*/i,''));
}
function optionalHelpReply(condition,action){
  return optionalSelfServiceCondition(condition)&&/(?:協助|协助|幫助|帮助)|\b(?:help|assistance)\b/i.test(condition)
    &&/^(?:請|请)(?:您|你)?回覆(?:我們|我们|本信|此信|這封信|这封信)?$|^please reply(?: to (?:us|this (?:email|message)))?$/i.test(action);
}
const requestCondition=/^(?:如果|若|如(?=您|你|需|有|要|欲|已|非|未|遇)|除非|一旦)|^(?:if|unless|when|once)\b/i;
const coordinatedRequest=/^(?:並|并|再|然後|然后|同時|同时|以及)\s*|^(?:and|then|also)\b\s*/i;
function requestDirective(text,imperativeOnly=false){
  return /(?<!申)(?:請|请)(?!求)|(?:請求|请求)(?:您|你)|(?:必須|必须|務必|务必|麻煩|麻烦|需於)|\b(?:please|must|required)\b/i.exec(text)
    ||(!imperativeOnly?/(?:需要)|\b(?:reply|respond)\b/i.exec(text):null);
}
function requestStates(text,{date,referenceTime,identity={},generatedContinuations=false}={}){
  const result={current:[],unresolvedConditional:[]},sentences=text.split(/[。！？!?；;]|\.(?=\s|$)|\n\s*\n/);
  for(let sentenceIndex=0;sentenceIndex<sentences.length;sentenceIndex++){
    const sentence=sentences[sentenceIndex];
    // A condition scopes actions in this sentence, including wrapped lines
    // and coordinated actions. A new sentence starts with no assumed facts.
    let condition='',previousDirective=false;
    // Interpret list decoration locally; source facts and evidence remain
    // literal. Do not strip numeric lists, signed amounts, dates or quotes.
    const clauses=sentence.split(/，|,(?!\d)|(?<!\d),|\n|(?=(?:但(?:是)?|並|并|另|也)\s*(?:請|请|務必|务必))|(?=(?:並|并|然後|然后|同時|同时|以及)\s*(?:無須|無需|不需|不須|不必|不用|不要|已|上傳|上传|提交|修改|更改|更新|繳費|缴费|繳款|缴款|領貨|领货|出示|操作))|\b(?:and|but)\s+(?=please\b)|(?=\b(?:and|then|also)\s+(?:do not|don't|no need|already|we have|I have|upload|submit|send|return|reply|respond|pay|confirm|complete|process)\b)/i).map(part=>part.trim()
      .replace(/^(?:[※•]\s*)+/u,'')
      .replace(/^[-*][\t ]+(?=(?:請|请|無須|無需|不需|不須|不必|不用|不要|如果|若|如|please\b|do not\b|don't\b|no need\b|you\b|if\b))/i,'')).filter(Boolean);
    for(let index=0;index<clauses.length;index++){
      let clause=clauses[index];
      if(requestCondition.test(clause)){
        // "請求 OTP" and "申請補助" describe the condition, not a second
        // directive. Only a following imperative starts its consequence.
        const action=requestDirective(clause,true);
        if(!action){condition=clause;previousDirective=false;continue;}
        condition=clause.slice(0,action.index).trim();
        clause=clause.slice(action.index).trim();
      }else{
        const postfix=/(?:如果|若|除非)|\b(?:if|unless)\b/i.exec(clause);
        if(postfix){condition=clause.slice(postfix.index);clause=clause.slice(0,postfix.index).trim();}
      }
      const joined=coordinatedRequest.exec(clause);
      if(joined)clause=clause.slice(joined[0].length).trim();
      // Generated wording can attach a consequence to an earlier "請…後":
      // "在…內進行申訴" still shares that imperative. This is only a claim
      // check; source request/priority interpretation keeps its prior scope.
      const temporalLead=generatedContinuations?/^(?:在|於|于)[^，,。;；\n]{0,80}(?:後|后|前|內|内)\s*/.exec(clause):null;
      const continuedAction=generatedContinuations&&/^(?:(?:進行|进行|提出|辦理|办理)?(?:申訴|申诉)|(?:重設|重置)(?:密碼|密码)|reset\b)(?!的|方式|方法|說明|说明)/i.test(clause.slice(temporalLead?.[0].length||0));
      const inherited=previousDirective&&Boolean(joined||temporalLead&&continuedAction);
      const explicit=Boolean(requestDirective(clause));
      if(!explicit&&!(inherited&&(continuedAction||deadlineAction.test(clause)||/(?:修改|更改|更新|補件|补件|繳費|缴费|繳款|缴款|領貨|领货|出示|操作)/.test(clause))))continue;
      previousDirective=true;
      // Exclude a negated request only within its own clause. A subsequent
      // request in the same excerpt must still reach the uncertainty check.
      const separateAction=/(?:但|並|并|然後|然后|同時|同时)|\b(?:and|then|also|but)\b/i.test(clause);
      if(!separateAction&&(/^(?:(?:請|请)\s*(?:勿|不要)|無須|無需|不需(?:要)?|不須|不必|不用)[^，,。;；\n]*$/i.test(clause)
        ||/^(?:please\s+)?(?:do not|don't|no need to|you (?:do not need|don't need|are not required) to)\s+/i.test(clause)))continue;
      if(!separateAction&&/^(?:不要|已(?:經|经)?|曾)|^(?:already|(?:I|we) have)\b/i.test(clause))continue;
      if(optionalSelfServiceCondition(condition)&&optionalSelfServiceAction(clause)||optionalHelpReply(condition,clause))continue;
      const nextSentence=(sentences[sentenceIndex+1]||'').trim();
      if(index===clauses.length-1&&/^(?:上述|該|该|此|這|这)(?:要求|任務|任务|交辦|交办|待辦|待办)\s*(?:已(?:經|经)?取消|已撤銷|已撤销)|^(?:this|that|the above) (?:request|task|requirement) (?:has been|is|was) cancel(?:l)?ed\b/i.test(nextSentence))continue;
      const passage=condition?condition+'，'+clause:clause;
      if(anotherPersonsDeadline(clause,identity.senderIsRecipient)||definitelyFutureDeadline(passage,date,referenceTime))continue;
      result[condition?'unresolvedConditional':'current'].push({text:clause,condition});
    }
  }
  return result;
}
function currentRequests(facts,context={}){
  const result={current:[],unresolvedConditional:[]};
  for(let index=0;index<facts.length;index++){
    const item=facts[index];if(item.origin!=='current'||footerOnly(item.clean))continue;
    let text=item.clean;
    // A removed URL is not a clause boundary. Rejoin only literal fragments
    // of the same passage for interpretation; source facts remain untouched.
    while(item.group?.startsWith('passage-')&&facts[index+1]?.group===item.group&&facts[index+1].origin==='current')text+=' '+facts[++index].clean;
    const state=requestStates(text,context);
    result.current.push(...state.current);result.unresolvedConditional.push(...state.unresolvedConditional);
  }
  return result;
}
function todayKey(iso){const time=Date.parse(iso);return Number.isFinite(time)?new Date(time+8*60*60*1000).toISOString().slice(0,10):'';}
function dateIsToday(sentence,today,sent){
  const [year,month,day]=today.split('-').map(Number),full=[],short=[];
  // Remove complete dates before reading month/day forms, otherwise 9/17 in
  // 2027/9/17 could incorrectly validate a 2026/9/17 deadline.
  let remaining=sentence.replace(/(?<!\d)(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?!\d)/g,(match,y,m,d)=>{
    full.push([Number(y),Number(m),Number(d)]);return' '.repeat(match.length);
  }).replace(/(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g,(match,y,m,d)=>{
    full.push([Number(y),Number(m),Number(d)]);return' '.repeat(match.length);
  });
  for(const match of remaining.matchAll(/(?<![\d/-])(\d{1,2})[/-](\d{1,2})(?![\d/-])|(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g))short.push([Number(match[1]||match[3]),Number(match[2]||match[4])]);
  // Multiple different dates in one sentence do not establish which date
  // belongs to the recipient's deadline. Leave that ambiguity for review.
  if(full.some(([y,m,d])=>y!==year||m!==month||d!==day)||short.some(([m,d])=>m!==month||d!==day))return false;
  if(full.length)return true;
  if(short.length)return sent.slice(0,4)===today.slice(0,4);
  return sent===today&&/(?:今天|今日|\btoday\b)/i.test(sentence);
}
const deadlineAction=/(?:交回|交稿|提交|繳交|缴交|交付|寄出|寄送|寄(?:給|给)?|回覆|回复|上傳|上传|支付|付款|確認|确认|完成|處理|处理|\b(?:submit|upload|send|return|reply|respond|pay|confirm|complete|process)\b)/i;
const deadlineTime=/(?:今天|今日|截止|期限|最晚|\b(?:today|deadline|due)\b|\d{1,2}:\d{2}|\d{1,2}\s*(?:點|点|時|时))/i;
const conditionalDeadline=/(?:如果|若|除非|\b(?:if|unless)\b)/i;
function negatedDeadline(text){
  return /(?:請勿|请勿|無須|無需|不需|不須|不必|不用|不要)[^。\n]{0,30}(?:交|寄|回|上傳|上传|付|確認|确认|完成|處理|处理)|\b(?:do not|don't|no need to|not required to)\s+(?:submit|upload|send|return|reply|respond|pay|confirm|complete|process)\b/i.test(text)
    ||/(?:已(?:經|经)?取消|取消了|已撤銷|已撤销|\b(?:has been|is|was) cancel(?:l)?ed\b)/i.test(text)
    ||!request.test(text)&&/(?:已(?:經|经)?\s*(?:(?:於|于|在)?\s*(?:今天|今日|昨天|昨日|\d{4}[/-]\d{1,2}[/-]\d{1,2})?\s*(?:\d{1,2}:\d{2})?\s*)(?:交回|交稿|提交|繳交|缴交|交付|寄出|寄送|回覆|回复|上傳|上传|支付|付款|完成))|^(?:I|we)\s+have\s+(?:already\s+)?(?:submitted|uploaded|sent|returned|replied|responded|paid|completed)\b/i.test(text);
}
function anotherPersonsDeadline(text,senderIsRecipient){
  // Only explicit roles can rule out this particular action. Unknown names or
  // an unqualified instruction remain possible recipient work.
  if(/(?:請|请)[^。\n]{0,8}(?:你|您)|\byou\s+(?:must|need|are required)\b/i.test(text))return false;
  if(senderIsRecipient===false&&/(?:我|我們|我们)(?:將|将|會|会|負責|负责)|\b(?:I|we)\s+(?:will|shall|am going to|are going to)\b/i.test(text))return true;
  return /(?:同事|對方|对方|他們|他们|她們|她们|他|她|供應商|供应商|廠商|厂商|客服人員|客服人员)[^。\n]{0,12}(?:將|将|會|会|負責|负责)|^(?:請|请)(?:同事|對方|对方|他們|他们|她們|她们|他|她|供應商|供应商|廠商|厂商|客服人員|客服人员)|\b(?:he|she|they|the supplier|the sender|a colleague)\s+(?:will|shall|is to|are to)\b/i.test(text);
}
function deadlinePassages(text,{senderIsRecipient}={}){
  const clauses=String(text||'').split(/[。！？!?；;\n]|\.(?=\s|$)|，|,(?!\d)|(?<!\d),/).map(part=>part.trim()).filter(Boolean),passages=[];
  for(let index=0;index<clauses.length;index++){
    const clause=clauses[index];if(!deadlineAction.test(clause))continue;
    const previous=clauses[index-1]||'',next=clauses[index+1]||'';
    let passage=clause;
    // A date cannot borrow an action from another paragraph. Only a directly
    // attached condition/date clause or an explicit deadline continuation is
    // joined, e.g. "請交回資料。截止時間是今天17:00。".
    if(conditionalDeadline.test(previous)||!deadlineAction.test(previous)&&deadlineTime.test(previous)&&/(?:前|截止|期限|最晚|\b(?:by|before|deadline|due)\b)/i.test(previous))passage=previous+'，'+passage;
    if(!deadlineTime.test(passage)&&/^(?:(?:上述|該項|该项|本次|此項|此项|這項|这项)(?:工作|任務|任务|事項|事项)?\s*)?(?:截止|期限|最晚|\b(?:deadline|due|by|before)\b)/i.test(next))passage+='，'+next;
    const withdrawal=/^(?:(?:上述|該|该|此|這|这)(?:要求|任務|任务|交辦|交办|期限|待辦|待办)\s*)?(?:已(?:經|经)?取消|已撤銷|已撤销)/i.test(next)
      ||/^(?:上述|該|该|此|這|这)(?:要求|任務|任务|交辦|交办|期限|待辦|待办)[^。\n]{0,8}(?:不需|無需|無須|不必|不用)/i.test(next)
      ||/^(?:不需|無需|無須|不必|不用)/i.test(next)&&clause.match(deadlineAction)?.[0]===next.match(deadlineAction)?.[0];
    if(withdrawal)passage+='，'+next;
    if(negatedDeadline(passage)||anotherPersonsDeadline(passage,senderIsRecipient))continue;
    passages.push(passage);
  }
  return passages;
}
function definitelyFutureDeadline(text,date,referenceTime){
  const today=todayKey(referenceTime),sent=todayKey(date);if(!today)return false;
  if(/(?:今天|今日|\btoday\b)/i.test(text))return false;
  const found=[];let invalid=false;
  const add=(year,month,day)=>{
    const value=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)));
    if(value.getUTCFullYear()!==Number(year)||value.getUTCMonth()!==Number(month)-1||value.getUTCDate()!==Number(day)){invalid=true;return;}
    found.push(value.toISOString().slice(0,10));
  };
  const remaining=text.replace(/(?<!\d)(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?!\d)|(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g,(match,y1,m1,d1,y2,m2,d2)=>{add(y1||y2,m1||m2,d1||d2);return' '.repeat(match.length);});
  for(const match of remaining.matchAll(/(?<![\d/-])(\d{1,2})[/-](\d{1,2})(?![\d/-])|(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g)){
    if(!sent)invalid=true;else add(sent.slice(0,4),match[1]||match[3],match[2]||match[4]);
  }
  if(found.length)return!invalid&&found.every(day=>day>today);
  if(sent&&/(?:明天|明日|後天|后天|\btomorrow\b)/i.test(text)){
    const days=/(?:後天|后天)/.test(text)?2:1;return new Date(Date.parse(sent+'T00:00:00Z')+days*86400000).toISOString().slice(0,10)>today;
  }
  return sent===today&&/(?:下週|下周|下個月|下个月|\b(?:next week|next month)\b)/i.test(text);
}
function possibleDeadline(text,date,referenceTime,identity){
  return deadlinePassages(text,identity).some(passage=>deadlineTime.test(passage)&&!definitelyFutureDeadline(passage,date,referenceTime));
}
function verifiableImmediate(text,date,referenceTime,identity){
  const today=todayKey(referenceTime),sent=todayKey(date);if(!today)return false;
  for(const sentence of deadlinePassages(text,identity)){
    if(!request.test(sentence)||conditions.test(sentence)&&/(?:如果|若|除非|\bif\b|unless)/i.test(sentence)
      ||/(?:明天|明日|後天|后天|下週|下周|下個月|下个月|無須|無需|不用|不必|不要|請勿|请勿|\b(?:tomorrow|next week|next month|do not|no need|not required)\b)/i.test(sentence))continue;
    if(/(?:立即|馬上|马上|立刻|\bimmediately\b)/i.test(sentence)&&sent===today){
      if(/(?:後|后|收到|完成|\bafter\b)/i.test(sentence))continue;
      if(/\d{1,4}[/-]\d{1,2}|\d{1,2}月/.test(sentence)&&!dateIsToday(sentence,today,sent))continue;
      return true;
    }
    if(/\d{1,2}:\d{2}|\d{1,2}\s*(?:點|点|時|时)/.test(sentence)&&/(?:前|截止|before|\bby\b)/i.test(sentence)
      &&dateIsToday(sentence,today,sent))return true;
  }
  return false;
}

function generatedConflicts(text,original,content){
  const issues=new Set();
  // Internal prompt/schema labels are not mail facts. Permit them when the
  // original actually discusses those fields, such as a technical email.
  for(const match of text.matchAll(/\b(user_profile|imageTextUnavailable|textLimited|attachmentCount|referenceTime|evidenceIds)\b|\b(urgency)["']?\s*[:：]/gi)){
    const key=match[1]||match[2];
    const inSource=key.toLowerCase()==='urgency'?/\burgency["']?\s*[:：]|\burgency\b\s*(?:欄位|字段|field\b)|(?:欄位|字段|\bfield)\s*["']?urgency\b/i.test(original):new RegExp('\\b'+key+'\\b','i').test(original);
    if(!inSource)issues.add('model-metadata-in-summary');
  }
  for(const pattern of Object.values(currencies))if(pattern.test(text)&&!pattern.test(original))issues.add('currency-mismatch');
  const available=numberTokens(original),numbers=numberTokens(text);
  if([...numbers].some(number=>!available.has(number)))issues.add('number-mismatch');
  if(content.attachmentCount===0&&(/(?:查看|參閱|打开|開啟|见|見|查閱|附上|附有).{0,12}(?:附件|附檔)|(?:see|view|open|attached|enclosed)[^.!\n]{0,24}(?:attachment|file|document)/i.test(text)
    ||/(?:附件|附檔|attachment)/i.test(text)&&!/(?:附件|附檔|attachment)/i.test(original)))issues.add('attachment-unavailable');
  const booking=/(?:Booking ref\s*:?|訂位代號\s*[：:]?)\s*([a-z\d]{5,10})/i.exec(original);
  if(booking&&new RegExp('(?:航班|班機|flight)[^。\n]{0,16}'+booking[1],'i').test(text))issues.add('identifier-mismatch');
  const durations=[...original.matchAll(/(?:Duration\s*[:：]|飛行時間\s*[:：])\s*(\d{1,2}:\d{2})/gi)].map(match=>match[1]);
  if(durations.length&&[...text.matchAll(/(?:飛行時間|飞行时间|飛行時長|飞行时长|duration)[^\d。\n]{0,12}(\d{1,2}:\d{2})/gi)].some(match=>!durations.includes(match[1])))issues.add('duration-mismatch');
  const carry=/(?:手提行李\s*\/\s*CARRY-ON BAG)[\s\S]*?(?:\n\nLB=|\n\n免付費|$)/i.exec(original)?.[0];
  if(carry){
    const counts=new Set([...carry.matchAll(/MAX\s*(\d+)\s*PC/gi)].map(match=>Number(match[1])));
    const written=[...text.matchAll(/(?:手提行李|隨身行李|随身行李|carry.on bag)[^\d。\n]{0,12}(\d+)\s*(?:件|PC)|(?:([一二兩两三四五六七八九])|([1-9]))件手提行李/gi)];
    const digits={'一':1,'二':2,'兩':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    if(counts.size&&written.some(match=>!counts.has(Number(match[1]||match[3]||digits[match[2]]))))issues.add('number-mismatch');
  }
  const stores=[...original.matchAll(/(\d+(?:\.\d+)?)\s*([kKmM])\+?\s*(?:stores|shops|merchants)\b/gi)].map(match=>Number(match[1])*(match[2].toLowerCase()==='k'?1000:1000000));
  if(stores.length&&[...text.matchAll(/(\d+)\s*(?:家|間|间)(?:商店|商家|店家|店舖|店鋪|店铺)?/g)].some(match=>!stores.includes(Number(match[1]))))issues.add('number-mismatch');
  return issues;
}
function assertedGeneratedRequests(text,context){
  return requestStates(text,{...context,generatedContinuations:true}).current.filter(item=>{
    // A question about necessity or a noun phrase such as "所需要的資料"
    // does not assert that the recipient must perform the mentioned action.
    // Keep an actual imperative in the same clause independently of that use.
    return !/(?:是否|所)\s*需要|需要\s*的/.test(item.text)||Boolean(requestDirective(item.text,true));
  });
}
function deniesMinimumSpend(text){
  const waiver=/(?:不限(?:消費|消费|訂單|订单)?(?:金額|金额)|(?:無|没有|沒有|不設|不设)(?:最低(?:消費|消费|訂單|订单)(?:金額|金额)?(?:門檻|门槛|限制)?|(?:消費|消费)(?:門檻|门槛|限制)|(?:使用)?(?:門檻|门槛))|\b(?:no|without(?: any| a)?)\s+minimum\s+(?:spend|spending|purchase|order)(?:\s+amount)?\b)/i;
  for(const clause of text.split(/[，,。；;\n]|\.(?=\s|$)/)){
    const match=waiver.exec(clause);if(!match)continue;
    // "並非無門檻" / "not without a minimum spend" preserves the condition.
    if(!/(?:並非|并非|不是|不代表|\bnot)\s*$/i.test(clause.slice(0,match.index)))return true;
  }
  return false;
}
function applyMailQuality({input,analysis,recipient='',referenceTime,category}){
  const result={...analysis},source=sourceFacts(input),original=source.prepared.subject+'\n'+source.prepared.body;
  const summary=String(analysis.summary||''),reason=String(analysis.reason||''),generated=summary+'\n'+reason;
  // Stored issues are diagnostics. Recompute the scope of a conflict from
  // this pass, so an earlier reason error never becomes a summary error.
  const issues=new Set((analysis.quality?.issues||[]).filter(code=>ISSUES.has(code))),summaryHard=new Set(),reasonHard=new Set();
  const inheritedExcerpt=analysis.quality?.summaryMode==='source-excerpts';
  const content=input.contentContext||{},attachments=Number.isInteger(content.attachmentCount)&&content.attachmentCount>0;
  const limited=(content.imageTextUnavailable===true||attachments)&&content.textLimited===true;
  const identity={senderIsRecipient:input.senderEmail&&recipient?sameAddress(input.senderEmail,recipient):undefined};
  const requestContext={date:input.date,referenceTime,identity},requests=currentRequests(source.facts,requestContext);
  const mark=(set,code)=>{set.add(code);issues.add(code);};
  if(limited&&content.imageTextUnavailable===true)issues.add('image-text-unavailable');
  if(limited&&attachments)issues.add('attachment-text-unavailable');
  if(!inheritedExcerpt){
    // A duty scheduled for tomorrow still supports a gist about that duty.
    // Only today's priority review may exclude definitely future requests.
    const statementContext={identity},sourceRequests=currentRequests(source.facts,statementContext);
    // Optional unsubscribe instructions often live in an omitted footer. Read
    // that scope only to check subscription claims, never to create a task.
    const subscriptionRequests=requestStates(source.thread.current,statementContext);
    for(const [text,hard]of [[summary,summaryHard],[reason,reasonHard]])for(const code of generatedConflicts(text,original,content))mark(hard,code);
    const latest=source.thread.current;
    const noAction=/(?:目前|現在|现在)?\s*(?:無需|無須|不必|不需|不須)[^。\n]{0,12}(?:行動|行动|處理|处理|回覆|回复)|\bno action (?:is )?(?:required|needed)\b/i;
    if(noAction.test(latest)&&!noAction.test(summary))issues.add('no-action-status-missing');
    if(/(?:安全提醒|安全警告|\bsafety (?:warning|notice)\b)/i.test(latest)
      &&/(?:切勿|請勿|禁止|不要|停止|\b(?:do not|must not|never)\b)/i.test(latest)
      &&!/(?:切勿|請勿|禁止|不要|停止|不得|不可|\b(?:do not|must not|never)\b)/i.test(summary))mark(summaryHard,'safety-instruction-missing');
    const acknowledged=source.thread.boundaryKnown&&/(?:收到成功|已收(?:到|訖)|資料收到|received successfully)/i.test(latest);
    if(acknowledged&&!/(?:收到|收訖|收讫|收件成功|已接收|received)/i.test(summary))issues.add('latest-status-conflict');
    for(const [text,hard]of [[summary,summaryHard],[reason,reasonHard]]){
      const writtenRequests=assertedGeneratedRequests(text,statementContext);
      if(writtenRequests.length&&!sourceRequests.current.length){
        if(noAction.test(latest))mark(hard,'no-action-status-missing');
        if(acknowledged)mark(hard,'latest-status-conflict');
      }
      for(const [action,scope]of [[/(?:重設|重置|reset)/i,sourceRequests],[/(?:申訴|申诉)/i,sourceRequests],[/(?:取消訂閱|取消订阅|退訂|退订|\bunsubscribe\b)/i,subscriptionRequests]]){
        const conditional=scope.unresolvedConditional.some(item=>action.test(item.text+' '+item.condition))||source.facts.some(item=>item.origin==='current'&&!footerOnly(item.clean)
          &&/(?:若|如果|如有|\bif\b|unless)/i.test(item.clean)&&action.test(item.clean));
        if(conditional&&!scope.current.some(item=>action.test(item.text))&&writtenRequests.some(item=>action.test(item.text)))mark(hard,'conditional-action-overstated');
      }
    }
    for(const item of source.facts){
      if(item.origin!=='current'||footerOnly(item.clean))continue;
      const thresholds=[...item.clean.matchAll(/(?:結帳|結账|消費|消费|訂單|订单|購買|购买|spend|order|checkout|purchase)[^。\n]{0,40}?(?:滿|满|至少|最低|minimum|at least)\s*(?:(?:[A-Z]{3}|新[臺台]幣|[臺台]幣)\s*)?(?:(?:NT|US|HK|S)?[$¥￥€£]\s*)?(\d[\d,]*(?:\.\d+)?)/gi)];
      if(thresholds.some(threshold=>!numberTokens(summary).has(String(Number(threshold[1].replaceAll(',',''))))))issues.add('condition-missing');
      if(thresholds.length)for(const [text,hard]of [[summary,summaryHard],[reason,reasonHard]])if(deniesMinimumSpend(text))mark(hard,'condition-missing');
      if(/(?:簡訊|短信|\bSMS\b)/i.test(item.clean)&&/(?:取件|取貨|pickup|pick up)/i.test(summary)&&/(?:後|后|after)/i.test(item.clean)
        &&!/(?:簡訊|短信|\bSMS\b)/i.test(summary))issues.add('condition-missing');
      if(/(?:若|如果|如有|\bif\b|unless)/i.test(item.clean)&&/(?:重設|重置|reset|申訴|申诉)/i.test(item.clean)
        &&/(?:重設|重置|reset|申訴|申诉)/i.test(generated)&&!/(?:若|如果|如有|\bif\b|unless)/i.test(generated))issues.add('condition-missing');
    }
    if(Array.isArray(analysis.evidence)&&analysis.evidence.length&&letters(summary).length>=12&&!analysis.evidence.some(quote=>overlap(summary,quote)))issues.add('evidence-unrelated');
    // Coverage is checked after classification. A newsletter summary need not
    // enumerate every advertised product. Missing source facts stay visible
    // even when no automatic coverage decision can be made.
    if(category&&category!=='promotion'){
      const mentioned=numberTokens(generated);
      const required=requiredCurrentValueFragments(source.thread.current);
      if(required.some(fragment=>[...numberTokens(fragment)].some(number=>!mentioned.has(number))))issues.add('missing-important-facts');
    }
  }
  const replaceSummary=summaryHard.size>0||inheritedExcerpt||limited;
  result.sourceFacts=source.facts.map(item=>item.text);
  if(replaceSummary){
    result.summary=excerptSummary(source.facts,source.thread,limited);
    if(source.facts.length)result.evidence=source.facts.slice(0,8).map(item=>item.text);
  }
  let priorityReview=replaceSummary||reasonHard.size>0||analysis.quality?.priorityReview===true;
  const current=source.thread.current;
  const outbound=sameAddress(input.senderEmail,recipient)&&Array.isArray(input.to)&&input.to.some(address=>!sameAddress(address,recipient))&&!input.to.some(address=>sameAddress(address,recipient));
  // These checks only withhold a doubtful grade. Neither the absence of a
  // request keyword, an outgoing address, nor a category proves that there is
  // no task: an outgoing mail can contain the author's own commitment, and a
  // receipt or promotion can include a new, already accepted obligation.
  const immediate=verifiableImmediate(current,input.date,referenceTime,identity);
  const deadlineDoubt=possibleDeadline(current,input.date,referenceTime,identity);
  const doubtful=result.priority===0&&(!immediate||outbound)
    ||result.priority===1&&(outbound||category==='promotion'||!requests.current.length||requests.unresolvedConditional.length>0)
    ||result.priority===2&&(immediate||deadlineDoubt||requests.unresolvedConditional.length>0)
    ||result.priority!==2&&/(?:無(?:需|須)|不(?:必|需|須)|未(?:要求|提及))[^。\n]{0,18}(?:行動|行动|待辦|待办|處理|处理|回覆|回复|本人責任)|\b(?:no action|no task|nothing to do)\b/i.test(String(analysis.reason||''));
  if(doubtful){priorityReview=true;issues.add('priority-unverified');}
  if(limited){priorityReview=true;result.reason=content.imageTextUnavailable===true?'圖片內文尚未辨識，無法確認其中的資訊與待辦。':'附件內容尚未讀取，無法確認其中的資訊與待辦。';}
  else if(priorityReview)result.reason=replaceSummary?'摘要或待辦仍有無法核對之處，請依下方原文重點確認。':'待辦分級仍有無法核對之處，請依下方原文重點確認。';
  result.quality={issues:[...issues],summaryMode:replaceSummary?'source-excerpts':'generated',priorityReview,sourceFactsTruncated:source.truncated,contentLimited:limited,imageTextUnavailable:content.imageTextUnavailable===true,attachmentTextUnavailable:attachments};
  return result;
}

module.exports={MAX_FACTS,criticalSourceText,sourceFacts,numberTokens,currentRequests,verifiableImmediate,applyMailQuality};

'use strict';

const URL_MARKER='【網址】';
const MAX_EVIDENCE_LENGTH=1000;
const MAX_EVIDENCE_COUNT=8;
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_MAIL_ANALYSIS'});
// Link wrappers such as <...> and decorative symbols are not textual evidence.
// In particular, Unicode class S includes < and >, so accepting symbols would
// accidentally turn <【網址】> back into an arbitrary tracking URL quotation.
const useful=text=>/[\p{L}\p{N}]/u.test(text);

function urlEnd(text,start,prefix){
  let end=start,round=0,square=0;
  // Non-ASCII prose and punctuation stay outside the URL. International URLs
  // encoded as punycode / percent escapes are handled like other URLs.
  while(end<text.length&&/[a-z\d\-._~:/?#@!$&()*+,;=%\[\]]/i.test(text[end])){
    const char=text[end];
    if(char==='(')round++;
    if(char===')'){if(!round)break;round--;}
    if(char==='[')square++;
    if(char===']'){if(!square)break;square--;}
    end++;
  }
  while(end>start&&/[.,;:!?]/.test(text[end-1]))end--;
  const candidate=text.slice(start,end);
  try{
    const parsed=new URL(prefix.toLowerCase()==='www.'?`https://${candidate}`:candidate);
    if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname)return start;
    if(prefix.toLowerCase()==='www.'&&(parsed.username||parsed.password||!/^www\.[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(parsed.hostname)))return start;
  }catch{return start;}
  return end;
}

function prepareField(raw){
  const starts=/(?<![a-z\d_@.-])(?:https?:\/\/|www\.)/gi;
  const pieces=[],segments=[];
  let rawCursor=0,cleanCursor=0,match;
  const append=(rawStart,rawEnd,generated)=>{
    if(rawEnd<=rawStart)return;
    const text=generated?URL_MARKER:raw.slice(rawStart,rawEnd);
    segments.push({rawStart,rawEnd,cleanStart:cleanCursor,cleanEnd:cleanCursor+text.length,generated});
    pieces.push(text);cleanCursor+=text.length;
  };
  while((match=starts.exec(raw))){
    const end=urlEnd(raw,match.index,match[0]);
    if(end===match.index)continue;
    append(rawCursor,match.index,false);append(match.index,end,true);
    rawCursor=end;starts.lastIndex=end;
  }
  append(rawCursor,raw.length,false);
  return{raw,clean:pieces.join(''),segments,changed:segments.some(segment=>segment.generated)};
}

function restoreMatch(field,start,end){
  let low=0,high=field.segments.length;
  while(low<high){const middle=(low+high)>>>1;if(field.segments[middle].cleanEnd<=start)low=middle+1;else high=middle;}
  const plain=[];
  let rawStart,rawEnd,generated=false;
  for(let i=low;i<field.segments.length;i++){
    const segment=field.segments[i];
    if(segment.cleanStart>=end)break;
    const from=Math.max(start,segment.cleanStart),to=Math.min(end,segment.cleanEnd);
    if(segment.generated){
      if(from!==segment.cleanStart||to!==segment.cleanEnd)throw invalid('模型引用只包含部分網址替代標記，無法核對原文。');
      generated=true;
      rawStart??=segment.rawStart;rawEnd=segment.rawEnd;
    }else{
      const first=segment.rawStart+from-segment.cleanStart,last=segment.rawStart+to-segment.cleanStart;
      rawStart??=first;rawEnd=last;plain.push(field.raw.slice(first,last));
    }
  }
  const textEvidence=plain.filter(useful);
  if(!generated)return{evidence:[field.raw.slice(rawStart,rawEnd)],textEvidence,generated};
  // A replacement alone cannot establish textual evidence about the email.
  if(!textEvidence.length)return{evidence:[],textEvidence,generated};
  if(rawEnd-rawStart<=MAX_EVIDENCE_LENGTH)return{evidence:[field.raw.slice(rawStart,rawEnd)],textEvidence,generated};
  // Each surviving piece is contiguous in the original. Never join the two
  // sides of a removed URL into a quotation that did not actually occur.
  return{evidence:textEvidence,textEvidence,generated};
}

function prepareMailAnalysisInput(rawInput){
  if(!rawInput||typeof rawInput!=='object'||Array.isArray(rawInput)||typeof rawInput.subject!=='string'||typeof rawInput.body!=='string')throw invalid('郵件分析輸入格式無效。');
  const fields=[prepareField(rawInput.subject),prepareField(rawInput.body)];
  const input={...structuredClone(rawInput),subject:fields[0].clean,body:fields[1].clean};
  return{
    input,
    changed:fields.some(field=>field.changed),
    restoreEvidence(fragments){
      if(!Array.isArray(fragments)||!fragments.length||fragments.length>MAX_EVIDENCE_COUNT||fragments.some(fragment=>typeof fragment!=='string'||!fragment.trim()||fragment.length>MAX_EVIDENCE_LENGTH))throw invalid('模型引用的證據格式或長度無效。');
      const restored=new Set();
      for(const fragment of fragments){
        let expected,expectedText,evidence,textEvidence,found=false,ambiguous=false,sharedText=true;
        for(const field of fields){
          for(let position=field.clean.indexOf(fragment);position!==-1;position=field.clean.indexOf(fragment,position+1)){
            const candidate=restoreMatch(field,position,position+fragment.length);
            const key=JSON.stringify(candidate.evidence),textKey=JSON.stringify(candidate.textEvidence);
            if(found){
              if(key!==expected)ambiguous=true;
              if(textKey!==expectedText)sharedText=false;
            }else{
              expected=key;expectedText=textKey;evidence=candidate.evidence;textEvidence=candidate.textEvidence;
            }
            if(!candidate.generated)sharedText=false;
            found=true;
            // Without replacements every occurrence has the same literal text.
            if(!field.changed)break;
          }
        }
        if(!found)throw invalid('模型引用的證據不在處理後的郵件中，結果未套用。');
        if(ambiguous){
          // Different links can collapse to the same model quotation. Keep
          // only the exact text pieces common to every generated-URL match;
          // never choose one uncertain URL or join text across its position.
          if(!sharedText||!textEvidence.length)throw invalid('模型引用對應到同一封郵件的不同原文位置，無法確認一致的文字證據。');
          evidence=textEvidence;
        }
        for(const fragment of evidence)restored.add(fragment);
        if(restored.size>MAX_EVIDENCE_COUNT)throw invalid('還原網址後的原文證據超過 8 段，結果未套用。');
      }
      const evidence=[...restored];
      if(!evidence.length)throw invalid('模型僅引用網址替代標記，沒有可核對的原文文字。');
      if(evidence.some(fragment=>!fragment.trim()||fragment.length>MAX_EVIDENCE_LENGTH||!fields.some(field=>field.raw.includes(fragment))))throw invalid('還原後的證據不在郵件原文中，結果未套用。');
      return evidence;
    }
  };
}

module.exports={prepareMailAnalysisInput};

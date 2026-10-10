'use strict';

const {Converter}=require('opencc-js/cn2t');
let scriptConverter,phraseConverter;
// Repeated UI snapshots reuse the same short summaries without rebuilding the
// dictionary or retaining an unbounded history of generated text.
const cache=new Map(),CACHE_LIMIT=256,CACHE_TEXT_LIMIT=8192;
// Chinese sentence punctuation delimits links and addresses; otherwise a link
// followed by a comma would also protect the rest of that sentence.
const protectedText=/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\r\n]*?\2|(?:https?:\/\/|www\.|mailto:)[^\s<>"`，。；：！？、（）【】「」『』《》〈〉…]+|[^\s<>()\[\]"'`@，。；：！？、（）【】「」『』《》〈〉…]+@[^\s<>()\[\]"'`@，。；：！？、（）【】「」『』《》〈〉…]+\.[^\s<>()\[\]"'`@，。；：！？、（）【】「」『』《》〈〉…]+/giu;
function protectedLength(token){
  if(!/^(?:https?:\/\/|www\.|mailto:)/iu.test(token))return token.length;
  // Keep balanced brackets inside URLs, but end at an outer Markdown/wrapper
  // closing bracket so the prose immediately following it can be converted.
  const stack=[],pairs={')':'(',']':'[','}':'{'};
  for(let index=0;index<token.length;index++){
    const char=token[index];
    if('([{'.includes(char))stack.push(char);
    else if(Object.hasOwn(pairs,char)){
      if(stack.pop()!==pairs[char])return index;
    }
  }
  return token.length;
}
const convert=text=>{
  if(!text)return text;
  scriptConverter??=Converter({from:'cn',to:'tw'});
  // Do not rewrite an already-Traditional summary just to change its wording.
  if(scriptConverter(text)===text)return text;
  phraseConverter??=Converter({from:'cn',to:'twp'});
  // OpenCC's bundled Taiwan dictionary retains 賬; use the Taiwan form 帳.
  return phraseConverter(text).replaceAll('賬','帳');
};

function traditionalMailText(text){
  if(typeof text!=='string'||!text)return text;
  if(cache.has(text))return cache.get(text);
  let result='',cursor=0,match;
  const matcher=new RegExp(protectedText);
  // Convert prose only. Links, addresses and code must remain usable verbatim.
  while((match=matcher.exec(text))){
    const token=match[0],length=protectedLength(token);
    result+=convert(text.slice(cursor,match.index))+token.slice(0,length);
    cursor=match.index+length;
    matcher.lastIndex=cursor;
  }
  result+=convert(text.slice(cursor));
  if(text.length<=CACHE_TEXT_LIMIT){
    if(cache.size>=CACHE_LIMIT)cache.delete(cache.keys().next().value);
    cache.set(text,result);
  }
  return result;
}

function traditionalMailAnalysis(analysis){
  if(!analysis||typeof analysis!=='object'||Array.isArray(analysis))return analysis;
  const changed={};
  for(const field of ['summary','reason']){
    if(typeof analysis[field]!=='string')continue;
    const text=traditionalMailText(analysis[field]);
    if(text!==analysis[field])changed[field]=text;
  }
  return Object.keys(changed).length?{...analysis,...changed}:analysis;
}

module.exports={traditionalMailText,traditionalMailAnalysis};

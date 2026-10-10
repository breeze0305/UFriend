'use strict';
const PROFILE_LIMITS=Object.freeze({name:120,phone:80,personalEmail:254,workEmail:254,company:120,jobTitle:120,notes:2000});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function emptyProfile(){return{enabled:true,...Object.fromEntries(Object.keys(PROFILE_LIMITS).map(key=>[key,'']))};}
function normalizeProfile(value){
  if(!object(value)||Object.keys(value).some(key=>key!=='enabled'&&!Object.hasOwn(PROFILE_LIMITS,key)))throw new Error('個人資訊欄位格式錯誤。');
  if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw new Error('請選擇是否提供個人背景給 LLM。');
  const result=emptyProfile();if(value.enabled!==undefined)result.enabled=value.enabled;
  for(const [key,limit]of Object.entries(PROFILE_LIMITS)){
    if(value[key]===undefined)continue;
    if(typeof value[key]!=='string'||value[key].length>limit||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value[key])||key!=='notes'&&/[\r\n\t]/.test(value[key]))throw new Error('個人資訊欄位過長或包含不支援的字元。');
    result[key]=value[key].trim();
  }
  for(const key of ['personalEmail','workEmail'])if(result[key]&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result[key]))throw new Error('請輸入有效的 Email 地址，或將該欄位留空。');
  if(JSON.stringify({profile:result}).length>4900)throw new Error('個人資訊總長度超過上限，請縮短補充背景。');
  return result;
}
function profileContext(value){
  const profile=normalizeProfile(value||{});if(!profile.enabled)return undefined;
  const fields=Object.fromEntries(Object.keys(PROFILE_LIMITS).filter(key=>profile[key]).map(key=>[key,profile[key]]));
  return Object.keys(fields).length?fields:undefined;
}
module.exports={emptyProfile,normalizeProfile,profileContext};

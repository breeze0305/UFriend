'use strict';
const PREFERRED_LANGUAGES=Object.freeze(['zh-TW','zh-CN','en','ja','ko','es','fr','de']);
function preferredLanguage(value){
  if(typeof value!=='string'||!PREFERRED_LANGUAGES.includes(value))throw new Error('請選擇支援的常用語言。');
  return value;
}
module.exports={preferredLanguage};

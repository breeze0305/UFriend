'use strict';

const DEFAULT_UI_LANGUAGE='zh-TW';
const UI_LANGUAGES=Object.freeze(['zh-TW','en']);

function normalizeUiLanguage(value){
  if(typeof value!=='string'||!UI_LANGUAGES.includes(value))throw new Error('請選擇支援的介面語言。');
  return value;
}

module.exports={DEFAULT_UI_LANGUAGE,UI_LANGUAGES,normalizeUiLanguage};

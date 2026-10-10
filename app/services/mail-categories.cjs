'use strict';

const MAIL_CATEGORY_LABELS=Object.freeze({
  work:'工作與協作',
  meeting:'會議與活動',
  finance:'帳務與交易',
  account:'帳號與服務',
  promotion:'行銷與電子報',
  personal:'個人往來',
  other:'其他',
});
const MAIL_CATEGORY_IDS=Object.freeze(Object.keys(MAIL_CATEGORY_LABELS));
const validMailCategory=value=>typeof value==='string'&&Object.hasOwn(MAIL_CATEGORY_LABELS,value);

module.exports={MAIL_CATEGORY_LABELS,MAIL_CATEGORY_IDS,validMailCategory};

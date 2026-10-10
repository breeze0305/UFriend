'use strict';

const fs=require('node:fs');
const own=(value,key) => Object.prototype.hasOwnProperty.call(value,key);
const object=value => value!==null&&typeof value==='object'&&!Array.isArray(value);

function configError(message,code='GOOGLE_OAUTH_INVALID_CONFIG') {
  const error=new Error(message);error.name='GoogleOAuthConfigError';error.code=code;return error;
}

/** Accept Google's downloaded Desktop JSON or the application's minimal config. */
function normalizeGoogleOAuthConfig(value) {
  if(!object(value)||own(value,'web')) throw configError('Google 登入設定格式錯誤，請使用「電腦應用程式」的 OAuth 設定檔。');
  const installed=own(value,'installed');
  if(installed&&(!object(value.installed)||own(value,'clientId')||own(value,'clientSecret'))) {
    throw configError('Google 登入設定格式不明確，請使用「電腦應用程式」的 OAuth 設定檔。');
  }
  const config=installed?value.installed:value;
  const idKey=installed?'client_id':'clientId',secretKey=installed?'client_secret':'clientSecret';
  if(!own(config,idKey)||typeof config[idKey]!=='string') throw configError('Google 登入設定缺少有效的 Client ID。');
  const clientId=config[idKey].trim();
  let clientSecret='';
  if(own(config,secretKey)) {
    if(typeof config[secretKey]!=='string'||/[\r\n]/.test(config[secretKey])) throw configError('Google 登入密鑰格式錯誤，請重新匯入設定檔。');
    clientSecret=config[secretKey].trim();
  }
  if(!installed&&!clientId) return null;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw configError('Google Client ID 格式錯誤，請確認使用電腦應用程式的 OAuth 用戶端。');
  }
  return {clientId,clientSecret};
}

function readGoogleOAuthConfig(file,{optional=false}={}) {
  let content;
  try {content=fs.readFileSync(file,'utf8');}
  catch(error) {
    if(optional&&error.code==='ENOENT') return null;
    throw configError('無法讀取 Google 登入設定檔，請確認檔案存在且可讀取。','GOOGLE_OAUTH_READ_FAILED');
  }
  let value;
  try {value=JSON.parse(content.replace(/^\uFEFF/,''));}
  catch {throw configError('Google 登入設定檔不是有效的 JSON，請重新下載或選擇正確檔案。','GOOGLE_OAUTH_INVALID_JSON');}
  return normalizeGoogleOAuthConfig(value);
}

/** Never read the manual vault unless a nonempty manual Client ID is selected. */
function resolveGoogleOAuthConfig({settings,bundled,getManualSecret}={}) {
  const manualId=settings?.gmailClientId;
  if(manualId!==undefined&&typeof manualId!=='string') throw configError('手動 Google Client ID 格式錯誤，請重新設定或清除覆寫。');
  if(manualId?.trim()) {
    // Validate the selected ID before touching potentially unavailable credentials.
    const manual=normalizeGoogleOAuthConfig({clientId:manualId});
    let secret='';
    if(getManualSecret!==undefined) {
      if(typeof getManualSecret!=='function') throw configError('無法讀取手動 Google 登入密鑰。','GOOGLE_OAUTH_SECRET_UNAVAILABLE');
      try {secret=getManualSecret();}
      catch {throw configError('無法讀取手動 Google 登入密鑰，請重新設定或清除覆寫。','GOOGLE_OAUTH_SECRET_UNAVAILABLE');}
      if(typeof secret!=='string') throw configError('手動 Google 登入密鑰格式錯誤，請重新設定。');
    }
    return {...normalizeGoogleOAuthConfig({...manual,clientSecret:secret}),source:'manual'};
  }
  if(bundled===undefined||bundled===null) return null;
  const config=normalizeGoogleOAuthConfig(bundled);
  return config?{...config,source:'bundled'}:null;
}

module.exports={normalizeGoogleOAuthConfig,readGoogleOAuthConfig,resolveGoogleOAuthConfig};

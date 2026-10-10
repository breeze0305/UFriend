'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const renameWait=new Int32Array(new SharedArrayBuffer(4));
function commitRename(source,target){
  for(let attempt=0;;attempt++){
    try{fs.renameSync(source,target);return;}
    catch(error){
      if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4)throw error;
      Atomics.wait(renameWait,0,0,10*2**attempt);
    }
  }
}
class Vault {
  constructor({dataDir,safeStorage}){this.path=path.join(dataDir,'credentials.bin');this.safeStorage=safeStorage;}
  available(){return this.safeStorage.isEncryptionAvailable();}
  read(){if(!fs.existsSync(this.path))return{};if(!this.available())throw new Error('系統憑證加密目前不可用。');try{const data=JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.path)));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid credential index');return data;}catch{throw new Error('無法解密本機憑證，請在原 Windows 帳戶中開啟，或重新設定憑證。');}}
  get(key){const data=this.read();return Object.hasOwn(data,key)?data[key]:null;}
  set(key,value){if(!this.available())throw new Error('系統憑證加密目前不可用，未保存金鑰。');const d=this.read();d[key]=value;this.write(d);}
  delete(key){const d=this.read();delete d[key];this.write(d);}
  status(){try{const d=this.read();return{available:this.available(),cloudKeySet:!!d['cloud-api'],gmailSecretSet:!!d['gmail-client']?.clientSecret,error:null};}catch(e){return{available:this.available(),cloudKeySet:false,gmailSecretSet:false,error:e.message};}}
  reset(){this.write({},{preserveOriginal:true});}
  write(data,{preserveOriginal=false}={}){
    if(!this.available())throw new Error('系統憑證加密目前不可用，未保存金鑰。');
    // Prepare the encrypted replacement before touching an existing credential file.
    // In particular, a failed reset must not make the next launch see an empty vault.
    const encrypted=this.safeStorage.encryptString(JSON.stringify(data)),tmp=this.path+'.'+randomUUID()+'.tmp';
    fs.mkdirSync(path.dirname(this.path),{recursive:true});
    let fd;
    try{
      fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,encrypted);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      if(preserveOriginal&&fs.existsSync(this.path)){
        const suffix=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
        fs.copyFileSync(this.path,this.path+'.unreadable-'+suffix,fs.constants.COPYFILE_EXCL);
      }
      commitRename(tmp,this.path);
    }finally{
      if(fd!==undefined)try{fs.closeSync(fd);}catch{}
      // Best-effort cleanup must never hide the write failure; rename consumes tmp.
      try{fs.unlinkSync(tmp);}catch{}
    }
  }
}
module.exports={Vault};

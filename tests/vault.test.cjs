'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Vault}=require('../app/services/vault.cjs');

function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ufriend-vault-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('ufriend-vault-'));fs.rmSync(dataDir,{recursive:true,force:true});});
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('synthetic:'+value),decryptString:buffer=>{const text=buffer.toString();if(!text.startsWith('synthetic:'))throw new Error('Unreadable fixture');return text.slice(10);}};
  return{dataDir,safeStorage,vault:new Vault({dataDir,safeStorage})};
}

test('vault stores a complete encrypted index and validates decrypted records before editing',t=>{
  const {dataDir,safeStorage,vault}=fixture(t);
  vault.set('cloud-api',{key:'synthetic-key'});vault.set('gmail-client',{clientSecret:'synthetic-secret'});
  assert.deepEqual(new Vault({dataDir,safeStorage}).get('cloud-api'),{key:'synthetic-key'});
  assert.equal(vault.get('toString'),null);
  vault.delete('cloud-api');assert.equal(vault.get('cloud-api'),null);assert.deepEqual(fs.readdirSync(dataDir),['credentials.bin']);
  for(const value of ['null','[]','42','"text"']){
    const original=Buffer.from('synthetic:'+value);fs.writeFileSync(vault.path,original);
    assert.throws(()=>vault.set('cloud-api',{key:'never'}),/無法解密/);assert.ok(fs.readFileSync(vault.path).equals(original));
  }
});

test('failed reset encryption leaves the original active credential file untouched',t=>{
  const {dataDir,safeStorage,vault}=fixture(t);vault.set('cloud-api',{key:'synthetic-key'});
  const original=fs.readFileSync(vault.path),encrypt=safeStorage.encryptString;
  safeStorage.encryptString=()=>{throw new Error('Synthetic encryption failure');};
  assert.throws(()=>vault.reset(),/Synthetic encryption failure/);assert.ok(fs.readFileSync(vault.path).equals(original));
  safeStorage.encryptString=encrypt;safeStorage.isEncryptionAvailable=()=>false;
  assert.throws(()=>vault.reset(),/加密目前不可用/);assert.ok(fs.readFileSync(vault.path).equals(original));
  safeStorage.isEncryptionAvailable=()=>true;
  assert.deepEqual(new Vault({dataDir,safeStorage}).get('cloud-api'),{key:'synthetic-key'});
  assert.deepEqual(fs.readdirSync(dataDir),['credentials.bin']);
});

test('failed reset persistence preserves credentials and cleans its own temporary file',t=>{
  for(const operation of ['fsyncSync','copyFileSync','renameSync']){
    const {dataDir,safeStorage,vault}=fixture(t);vault.set('cloud-api',{key:'synthetic-key'});
    const original=fs.readFileSync(vault.path),method=fs[operation],failure=Object.assign(new Error('Synthetic disk failure'),{code:'EIO'});
    fs[operation]=()=>{throw failure;};
    try{assert.throws(()=>vault.reset(),error=>error===failure);}finally{fs[operation]=method;}
    assert.ok(fs.readFileSync(vault.path).equals(original));assert.ok(fs.readdirSync(dataDir).every(name=>!name.endsWith('.tmp')));
    assert.deepEqual(new Vault({dataDir,safeStorage}).get('cloud-api'),{key:'synthetic-key'});
  }
});

test('reset can recover an unreadable index while retaining every original encrypted copy',t=>{
  const {dataDir,vault}=fixture(t),original=Buffer.from('unreadable synthetic ciphertext');
  fs.writeFileSync(vault.path,original);assert.throws(()=>vault.read(),/無法解密/);
  vault.reset();assert.deepEqual(vault.read(),{});
  vault.set('cloud-api',{key:'second-synthetic-key'});const second=fs.readFileSync(vault.path);vault.reset();
  assert.deepEqual(vault.read(),{});
  const backups=fs.readdirSync(dataDir).filter(name=>name.startsWith('credentials.bin.unreadable-')).map(name=>fs.readFileSync(path.join(dataDir,name)));
  assert.equal(backups.length,2);assert.ok(backups.some(bytes=>bytes.equals(original)));assert.ok(backups.some(bytes=>bytes.equals(second)));
  assert.ok(fs.readdirSync(dataDir).every(name=>!name.endsWith('.tmp')));
});

test('Windows credential replacement retries a transient sharing violation without removing the old file',{skip:process.platform!=='win32'},t=>{
  const {dataDir,vault}=fixture(t);vault.set('cloud-api',{key:'before'});
  const original=fs.readFileSync(vault.path),rename=fs.renameSync;let calls=0,temporary;
  fs.renameSync=(source,target)=>{
    if(target!==vault.path)return rename(source,target);
    calls++;temporary??=source;assert.equal(source,temporary);assert.ok(fs.readFileSync(vault.path).equals(original));
    if(calls<=2)throw Object.assign(new Error('Synthetic sharing violation'),{code:'EPERM'});
    return rename(source,target);
  };
  try{vault.set('cloud-api',{key:'after'});}finally{fs.renameSync=rename;}
  assert.equal(calls,3);assert.deepEqual(vault.get('cloud-api'),{key:'after'});assert.deepEqual(fs.readdirSync(dataDir),['credentials.bin']);
});

'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {normalizeGoogleOAuthConfig,readGoogleOAuthConfig,resolveGoogleOAuthConfig}=require('../app/services/google-oauth-config.cjs');

const manualId='123-manual.apps.googleusercontent.com';
const bundledId='456-bundled.apps.googleusercontent.com';

function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ufriend-oauth-config-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ufriend-oauth-config-'));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return dir;
}

test('Desktop download and app config normalize only the selected ID and optional secret',() => {
  assert.deepEqual(normalizeGoogleOAuthConfig({installed:{client_id:'  '+manualId+'  ',client_secret:' secret-value ',project_id:'ignored',auth_uri:'https://ignored.example.test'}}),{clientId:manualId,clientSecret:'secret-value'});
  assert.deepEqual(normalizeGoogleOAuthConfig({clientId:' '+manualId+' '}),{clientId:manualId,clientSecret:''});
  assert.deepEqual(normalizeGoogleOAuthConfig({installed:{client_id:manualId}}),{clientId:manualId,clientSecret:''});
  assert.equal(normalizeGoogleOAuthConfig({clientId:' \t '}),null);
});

test('web clients, mixed formats, incomplete data and malformed IDs fail without reflecting private input',() => {
  const marker='PRIVATE_INPUT_SENTINEL';
  const invalid=[null,[],{}, {web:{client_id:manualId}}, {installed:{client_id:manualId},web:{}},
    {installed:{client_id:manualId},clientId:bundledId}, {installed:[]}, {installed:{}}, {installed:{client_id:''}},
    {clientId:42},{clientId:marker},{clientId:'https://'+manualId},{clientId:'x@'+manualId},
    {clientId:manualId+'.evil.test'},{clientId:'.apps.googleusercontent.com'},{clientId:manualId+'\n'+marker}];
  for(const value of invalid) assert.throws(() => normalizeGoogleOAuthConfig(value),error => {
    assert.equal(error.code,'GOOGLE_OAUTH_INVALID_CONFIG');assert.match(error.message,/[\u3400-\u9FFF]/);assert.ok(!error.message.includes(marker));return true;
  });
});

test('secrets must be strings without CR or LF, including whitespace that would otherwise trim away',() => {
  for(const clientSecret of [null,17,{},'line1\nline2','secret\r','\nsecret']) {
    assert.throws(() => normalizeGoogleOAuthConfig({clientId:manualId,clientSecret}),{code:'GOOGLE_OAUTH_INVALID_CONFIG'});
  }
});

test('file reading supports Desktop JSON and UTF-8 BOM while optional suppresses only missing files',t => {
  const dir=temporary(t),file=path.join(dir,'client.json'),missing=path.join(dir,'missing.json');
  fs.writeFileSync(file,'\uFEFF'+JSON.stringify({installed:{client_id:manualId,client_secret:'from-file'}}));
  assert.deepEqual(readGoogleOAuthConfig(file),{clientId:manualId,clientSecret:'from-file'});
  assert.equal(readGoogleOAuthConfig(missing,{optional:true}),null);
  assert.throws(() => readGoogleOAuthConfig(missing),{code:'GOOGLE_OAUTH_READ_FAILED'});
  assert.throws(() => readGoogleOAuthConfig(dir,{optional:true}),{code:'GOOGLE_OAUTH_READ_FAILED'});
  fs.writeFileSync(file,'{"PRIVATE_SECRET_NOT_JSON":');
  assert.throws(() => readGoogleOAuthConfig(file,{optional:true}),error => error.code==='GOOGLE_OAUTH_INVALID_JSON'&&!error.message.includes('PRIVATE_SECRET_NOT_JSON'));
  fs.writeFileSync(file,JSON.stringify({web:{client_id:manualId}}));
  assert.throws(() => readGoogleOAuthConfig(file,{optional:true}),{code:'GOOGLE_OAUTH_INVALID_CONFIG'});
  fs.writeFileSync(file,JSON.stringify({clientId:''}));
  assert.equal(readGoogleOAuthConfig(file),null);
});

test('manual configuration takes priority, reads its secret once and ignores an invalid bundled configuration',() => {
  let reads=0;
  const resolved=resolveGoogleOAuthConfig({settings:{gmailClientId:' '+manualId+' '},bundled:{web:{}},getManualSecret:() => {reads++;return ' manual-secret ';}});
  assert.deepEqual(resolved,{clientId:manualId,clientSecret:'manual-secret',source:'manual'});
  assert.equal(reads,1);
});

test('blank manual settings use the bundle without touching a broken vault',() => {
  for(const settings of [undefined,{}, {gmailClientId:' \t '}]) {
    assert.deepEqual(resolveGoogleOAuthConfig({settings,bundled:{clientId:bundledId,clientSecret:'bundle-secret'},getManualSecret:() => {throw new Error('Broken vault');}}),{clientId:bundledId,clientSecret:'bundle-secret',source:'bundled'});
  }
  assert.equal(resolveGoogleOAuthConfig(),null);
  assert.equal(resolveGoogleOAuthConfig({settings:{gmailClientId:''},bundled:{clientId:''},getManualSecret:() => {throw new Error('Must remain lazy');}}),null);
});

test('a missing manual secret never falls back to the bundled secret and bundled config never borrows the manual secret',() => {
  const bundled={clientId:bundledId,clientSecret:'must-not-be-borrowed'};
  assert.deepEqual(resolveGoogleOAuthConfig({settings:{gmailClientId:manualId},bundled,getManualSecret:() => ''}),{clientId:manualId,clientSecret:'',source:'manual'});
  assert.deepEqual(resolveGoogleOAuthConfig({settings:{gmailClientId:manualId},bundled}),{clientId:manualId,clientSecret:'',source:'manual'});
  assert.deepEqual(resolveGoogleOAuthConfig({bundled:{clientId:bundledId},getManualSecret:() => 'must-not-be-borrowed'}),{clientId:bundledId,clientSecret:'',source:'bundled'});
});

test('invalid manual overrides and unavailable manual secrets fail without silently switching accounts or leaking errors',() => {
  let reads=0;
  assert.throws(() => resolveGoogleOAuthConfig({settings:{gmailClientId:'invalid'},bundled:{clientId:bundledId},getManualSecret:() => {reads++;return '';}}),{code:'GOOGLE_OAUTH_INVALID_CONFIG'});
  assert.equal(reads,0);
  assert.throws(() => resolveGoogleOAuthConfig({settings:{gmailClientId:manualId},bundled:{clientId:bundledId},getManualSecret:() => {throw new Error('PRIVATE_VAULT_VALUE');}}),error => error.code==='GOOGLE_OAUTH_SECRET_UNAVAILABLE'&&!error.message.includes('PRIVATE_VAULT_VALUE')&&error.cause===undefined);
  assert.throws(() => resolveGoogleOAuthConfig({settings:{gmailClientId:manualId},getManualSecret:() => ({clientSecret:'wrong return type'})}),{code:'GOOGLE_OAUTH_INVALID_CONFIG'});
});

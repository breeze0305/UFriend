'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create,collect}=require('../app/i18n.js');
const english={...require('../app/locales/en-common.js'),...require('../app/locales/en-settings.js'),...require('../app/locales/en-native.js'),...require('../app/locales/en-extra.js')};
const language=()=>create({catalogs:{en:english}});

test('default and unsupported interface locales preserve the original literal markup',()=>{
  const i18n=language(),source='<label title="設定">設定 &amp; <strong>一般</strong></label>';
  assert.equal(i18n.locale,'zh-TW');assert.equal(i18n.tr(source),source);
  i18n.setLocale('en');assert.equal(i18n.tr('設定'),'Settings');
  i18n.setLocale('unsupported');assert.equal(i18n.tr(source),source);
  assert.equal(i18n.tr('An unknown service error'),'An unknown service error');
});

test('English templates keep user data and HTML interpolation byte-for-byte unchanged',()=>{
  const i18n=language();i18n.setLocale('en');
  const value='設定 保存 新對話 <script>doNotRun()</script> & " {0} \uE0000\uE001';
  assert.equal(i18n.html`<section><h2>設定</h2><div>${value}</div></section>`,`<section><h2>Settings</h2><div>${value}</div></section>`);
  const escaped='&lt;img onerror=&quot;unsafe&quot;&gt;設定';
  assert.equal(i18n.html`<textarea placeholder="主旨">${escaped}</textarea>`,`<textarea placeholder="Subject">${escaped}</textarea>`);
  assert.equal(i18n.text`UFriend 版本 ${value}`,'UFriend version '+value);
});

test('translated template phrases may reorder values without translating or rescanning them',()=>{
  const i18n=create({locale:'en',catalogs:{en:{'從 {0} 到 {1}':'To {1} from {0}'}}});
  const first='{1} \uE0001\uE001',last='原文';
  assert.equal(i18n.text`從 ${first} 到 ${last}`,'To '+last+' from '+first);
  assert.equal(i18n.html`<p>從 ${first} 到 ${last}</p><p>從 ${last} 到 ${first}</p>`,'<p>To '+last+' from '+first+'</p><p>To '+first+' from '+last+'</p>');
});

test('partial HTML fragments retain start-tag delimiters and translate only visible labels',()=>{
  const i18n=language();i18n.setLocale('en');
  assert.equal(i18n.tr('>自動接收剪貼簿圖片</label>'),'>Automatically receive clipboard images</label>');
  assert.equal(i18n.tr(' aria-describedby="profile-use-help profile-optional-help">提供個人背景給 LLM</label>'),' aria-describedby="profile-use-help profile-optional-help">Share personal background with the LLM</label>');
  assert.equal(i18n.tr('<input value="設定" data-id="設定" title="設定"><span>設定</span>'),'<input value="設定" data-id="設定" title="Settings"><span>Settings</span>');
});

test('translated attribute and HTML text labels escape quotes and markup while leaving data slots alone',()=>{
  const i18n=create({locale:'en',catalogs:{en:{'標籤':'Say "hello" & <ready>'}}});
  assert.equal(i18n.html`<p title="標籤">標籤 ${'DATA'}</p>`,'<p title="Say &quot;hello&quot; &amp; &lt;ready&gt;">標籤 DATA</p>');
  assert.equal(i18n.html`<p>標籤</p>`,'<p>Say &quot;hello&quot; &amp; &lt;ready&gt;</p>');
  assert.equal(i18n.tr('標籤'),'Say "hello" & <ready>');
});

test('static label maps change locale lazily while data keys and the original maps stay stable',()=>{
  const i18n=language(),source={id:'personal-email',label:'設定',items:['一般','主旨']},labels=i18n.labels(source);
  assert.equal(labels.label,'設定');i18n.setLocale('en');assert.equal(labels.label,'Settings');
  assert.deepEqual([...labels.items],['General','Subject']);assert.equal(labels.id,'personal-email');
  assert.deepEqual(Object.keys(labels),['id','label','items']);assert.equal(source.label,'設定');
  i18n.setLocale('zh-TW');assert.deepEqual([...labels.items],['一般','主旨']);
});

test('English catalogs preserve parameter contracts and contain complete app-language labels',()=>{
  for(const [key,value]of Object.entries(english)){
    assert.equal(typeof value,'string',key);assert(value.trim(),key);
    assert.deepEqual((value.match(/\{\d+\}/g)||[]).sort(),(key.match(/\{\d+\}/g)||[]).sort(),key);
  }
  const i18n=language();i18n.setLocale('en');
  assert.equal(i18n.tr('軟體介面語言'),'App language');assert.equal(i18n.tr('LLM 常用語言'),'LLM preferred language');
  assert.equal(i18n.text`保存「${'LLM chat'}」Prompt`,'Save LLM chat prompt');
  assert.equal(i18n.text`確認刪除${'meeting audio'}？`,'Delete meeting audio?');
  assert.deepEqual(collect('<span>版本 \uE0007\uE001</span><input value="使用者原文" title="設定">'),['設定','版本 {0}']);
});

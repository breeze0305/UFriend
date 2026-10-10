'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {Store} = require('../app/services/store.cjs');
const {AppService} = require('../app/services/core.cjs');
const {ModelAdapters} = require('../app/models/adapters.cjs');
const {exportSrt, exportTxt, parseSrt} = require('../app/services/formats.cjs');

const testRoot = path.resolve(__dirname, '..', '.test-data', 'core-tests');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrS8AAAAASUVORK5CYII=', 'base64');
const srt = '1\r\n00:00:00,250 --> 00:00:01,750\r\n明天十點開會。\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,125\r\n請保留產品名稱 UFriend。\r\n';

async function fixture(t, models = new ModelAdapters()) {
  await fs.mkdir(testRoot, {recursive:true});
  const dataDir = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(async () => {
    // Delete only the exact directory created for this test, beneath its fixed root.
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), testRoot);
    assert.match(path.basename(resolved), /^case-/);
    await fs.rm(resolved, {recursive:true, force:true});
  });
  const store = new Store({dataDir});
  const core = new AppService({store, dataDir, models});
  const reopen = () => {
    const reopenedStore = new Store({dataDir});
    return {store:reopenedStore, core:new AppService({store:reopenedStore, dataDir, models:new ModelAdapters()})};
  };
  return {dataDir, store, core, models, reopen};
}

function deferredModel(kind) {
  let resolve, reject, request;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const models = new ModelAdapters();
  models.register(kind, {run(value) { request = value; return promise; }});
  return {models, resolve, reject, get request() { return request; }};
}

async function seedAsset(f, name, bytes = Buffer.from('owned test data')) {
  const id = randomUUID();
  const file = id + path.extname(name);
  await fs.mkdir(path.join(f.dataDir, 'files'), {recursive:true});
  await fs.writeFile(path.join(f.dataDir, 'files', file), bytes);
  const asset = {id, file, name, size:bytes.length, mimeType:'application/octet-stream', category:'test'};
  f.store.update(d => { d.assets.push(asset); });
  return asset;
}

async function seedRecording(f) {
  const asset = await seedAsset(f, 'meeting.wav');
  const recording = {id:randomUUID(), name:'meeting.wav', assetId:asset.id, type:'audio', lang:'zh-TW', size:asset.size, duration:10, progress:0, state:'waiting-model', segments:[], textOnly:null, transcriptSource:null, error:''};
  f.store.update(d => { d.recordings.push(recording); });
  return recording;
}

for (const kind of ['chat','translation','ocr','polish']) test(kind+' can retry after its initial state save fails without dispatching a model', async t => {
  let calls=0;
  const models={status:()=>({}),run:()=>{calls++;return{text:'Synthetic complete result'};}};
  const f=await fixture(t,models);
  if(kind==='chat')f.core.saveChatDraft('Synthetic question');
  if(kind==='translation')f.core.saveTranslation({input:'Synthetic original'});
  if(kind==='ocr')await f.core.setOcrImage(await seedAsset(f,'synthetic.png',png));
  if(kind==='polish')f.core.savePolish({input:'Synthetic original'});
  const run=()=>({chat:()=>f.core.sendChat('Synthetic question','cloud'),translation:()=>f.core.runTranslation('cloud'),ocr:()=>f.core.runOcr('cloud'),polish:()=>f.core.runPolish('cloud')})[kind]();
  const before=f.store.read(),update=f.store.update.bind(f.store),failure=new Error('Synthetic temporary store failure');
  let failedController;
  f.store.update=()=>{f.store.update=update;failedController=f.core.active.get(kind);throw failure;};
  await assert.rejects(run,error=>error===failure);
  assert.equal(calls,0);assert.equal(failedController.signal.aborted,true);assert.equal(f.core.active.has(kind),false);
  assert.deepEqual(f.store.read(),before);
  if(kind==='chat')assert.equal(f.core.chatStream,null);
  await run();
  assert.equal(calls,1);assert.equal(f.core.snapshot()[kind].status,'done');assert.equal(f.core.active.has(kind),false);
});

test('imported attachment bytes remain available after the source is removed and the app reopens', async t => {
  const f = await fixture(t);
  const original = path.join(f.dataDir, 'report.txt');
  const bytes = Buffer.from('附件內容：金額 1,250 元\r\n', 'utf8');
  await fs.writeFile(original, bytes);
  const imported = await f.core.ingestAsset(original, {category:'attachment'});
  await fs.unlink(original);
  const {core} = f.reopen();
  const asset = core.asset(imported.id);
  assert.equal(asset.name, 'report.txt');
  assert.equal(asset.size, bytes.length);
  assert.deepEqual(await fs.readFile(asset.path), bytes);
});

test('OCR buffer is stored in managed files and survives reopening without an inference result', async t => {
  const f = await fixture(t);
  const asset = await f.core.ingestBuffer(png, {name:'capture.png'});
  await f.core.setOcrImage(asset);
  const {core} = f.reopen();
  assert.deepEqual(await fs.readFile(core.asset(asset.id).path), png);
  assert.equal(core.snapshot().ocr.imageId, asset.id);
  assert.equal(core.snapshot().ocr.text, '');
  assert.equal(core.snapshot().ocr.status, 'waiting-model');
});

test('media import adds a resumable recording without fabricating text or completed progress', async t => {
  const f = await fixture(t);
  const source = path.join(f.dataDir, 'meeting.wav');
  const wave = Buffer.alloc(46);
  wave.write('RIFF'); wave.writeUInt32LE(38, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(2, 40);
  await fs.writeFile(source, wave);
  const result = await f.core.importMedia([source], 'zh-TW');
  assert.deepEqual(result.errors, []);
  assert.equal(result.imported.length, 1);
  const {core} = f.reopen();
  const recording = core.snapshot().recordings[0];
  assert.equal(recording.state, 'waiting-model');
  assert.equal(recording.progress, 0);
  assert.deepEqual(recording.segments, []);
  assert.equal(recording.transcriptSource, null);
  assert.deepEqual(await fs.readFile(core.asset(recording.assetId).path), wave);
});

test('local EML imports retain binary attachments across reopen and do not duplicate the mail', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 1, 2, 255, 13, 10, 128]);
  const message = [
    'From: Test <sender@example.invalid>', 'To: receiver@example.invalid',
    'Subject: Attachment fixture', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="ufriend-test-boundary"', '',
    '--ufriend-test-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Local fixture body.',
    '--ufriend-test-boundary', 'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="report.bin"', 'Content-Transfer-Encoding: base64', '',
    bytes.toString('base64'), '--ufriend-test-boundary--', ''
  ].join('\r\n');
  const source = path.join(f.dataDir, 'fixture.eml');
  await fs.writeFile(source, message, 'utf8');
  assert.deepEqual(await f.core.importMails([source]), {added:1, duplicate:0, errors:[]});
  assert.deepEqual(await f.core.importMails([source]), {added:0, duplicate:1, errors:[]});
  await fs.unlink(source);
  const {core} = f.reopen();
  const state = core.snapshot();
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].accountId, 'local');
  const attachment = state.messages[0].attachments[0];
  assert.equal(attachment.name, 'report.bin');
  assert.deepEqual(await fs.readFile(core.asset(attachment.assetId).path), bytes);
});

test('local HTML and CID images persist, and reimport upgrades a legacy copy without resetting mail state or duplicating assets', async t => {
  const f=await fixture(t),source=path.join(f.dataDir,'html-related.eml');
  const html='<table><tr><td><img src="cid:logo@example.test"></td></tr><tr><td><a href="https://example.test/account">Account details</a></td></tr></table>';
  const eml=['From: Sender <sender@example.test>','To: receiver@example.test','Subject: HTML fixture','MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="related"','','--related','Content-Type: text/html; charset=utf-8','',''+html,
    '--related','Content-Type: image/png','Content-Disposition: inline; filename="logo.png"','Content-ID: <logo@example.test>',
    'Content-Transfer-Encoding: base64','',png.toString('base64'),'--related--',''].join('\r\n');
  await fs.writeFile(source,eml);await f.core.importMails([source]);
  let state=f.reopen().core.snapshot(),mail=state.messages[0];
  assert.equal(mail.html,html);assert.equal(mail.htmlVersion,1);assert.equal(mail.attachments[0].contentId,'logo@example.test');
  assert.equal(mail.attachments[0].inline,true);assert.equal(mail.attachments[0].contentDisposition,'inline');assert.equal(mail.attachments[0].content,undefined);
  const assetId=mail.attachments[0].assetId;assert.deepEqual(await fs.readFile(f.core.asset(assetId).path),png);
  f.core.store.update(value=>{const item=value.messages[0];delete item.html;delete item.htmlVersion;delete item.attachments[0].contentId;delete item.attachments[0].inline;delete item.attachments[0].contentDisposition;item.read=true;item.star=true;item.done=true;item.level=0;item.analysis={summary:'Saved local analysis'};});
  const before=f.core.snapshot();assert.deepEqual(await f.core.importMails([source]),{added:0,duplicate:1,errors:[],updated:1});
  state=f.core.snapshot();mail=state.messages[0];assert.equal(state.messages.length,1);assert.equal(state.assets.length,before.assets.length);assert.equal(mail.attachments[0].assetId,assetId);
  for(const key of ['id','body','read','star','done','level','analysis'])assert.deepEqual(mail[key],before.messages[0][key]);
  assert.equal(mail.html,html);assert.equal(mail.attachments[0].contentId,'logo@example.test');
  assert.deepEqual(await f.core.importMails([source]),{added:0,duplicate:1,errors:[]});assert.equal(await fs.readFile(source,'utf8'),eml);
});

test('unconfigured OCR and ASR preserve their inputs and never report model completion', async t => {
  const f = await fixture(t);
  const asset = await seedAsset(f, 'capture.png', png);
  const recording = await seedRecording(f);
  await f.core.setOcrImage(asset);
  await f.core.runOcr();
  await f.core.runRecording(recording.id);
  const state = f.core.snapshot();
  assert.equal(state.ocr.imageId, asset.id);
  assert.equal(state.ocr.text, '');
  assert.equal(state.ocr.status, 'waiting-model');
  assert.equal(state.recordings[0].state, 'waiting-model');
  assert.equal(state.recordings[0].progress, 0);
  assert.deepEqual(state.recordings[0].segments, []);
  assert.equal(state.recordings[0].transcriptSource, null);
  assert.ok(!state.logs.some(log => /文字識別完成|語音轉錄完成/.test(log.text)));
  assert.ok(state.logs.filter(log => log.status === 'blocked').length >= 2);
});

test('unconfigured polish and mail analysis do not invent results or change manual priority', async t => {
  const f = await fixture(t);
  f.core.savePolish({input:'提醒老闆明天要開會', use:'email', tone:'polite'});
  await f.core.runPolish();
  f.store.update(d => { d.messages.push({id:'test-mail', folder:'inbox', done:false, level:2, prioritySource:'manual', analysis:null, subject:'請回覆', body:'人工測試內容'}); });
  await assert.rejects(f.core.analyzeMail(), {code:'MODEL_NOT_CONFIGURED'});
  const state = f.core.snapshot();
  assert.equal(state.polish.output, '');
  assert.equal(state.polish.status, 'waiting-model');
  assert.equal(state.messages[0].level, 2);
  assert.equal(state.messages[0].analysis, null);
  assert.ok(!state.logs.some(log => /文章潤句完成|郵件分析完成/.test(log.text)));
});

test('new OCR image clears prior text and ignores a late result for the old image', async t => {
  const model = deferredModel('ocr');
  const f = await fixture(t, model.models);
  const first = await seedAsset(f, 'first.png', png);
  const second = await seedAsset(f, 'second.png', png);
  await f.core.setOcrImage(first);
  f.core.saveOcrText('previous manual text');
  const pending = f.core.runOcr();
  await f.core.setOcrImage(second);
  assert.equal(model.request.signal.aborted, true);
  model.resolve({text:'stale result for first image'});
  await pending;
  const state = f.core.snapshot();
  assert.equal(state.ocr.imageId, second.id);
  assert.equal(state.ocr.imageName, 'second.png');
  assert.equal(state.ocr.text, '');
  assert.equal(state.ocr.status, 'waiting-model');
  assert.ok(!state.logs.some(log => log.text === '文字識別完成'));
});

test('editing OCR output cancels the old result and the manual correction persists', async t => {
  const model = deferredModel('ocr');
  const f = await fixture(t, model.models);
  await f.core.setOcrImage(await seedAsset(f, 'capture.png', png));
  const pending = f.core.runOcr();
  f.core.saveOcrText('手動校對：臺北 10:30');
  model.resolve({text:'wrong result'});
  await pending;
  const {core} = f.reopen();
  assert.equal(core.snapshot().ocr.text, '手動校對：臺北 10:30');
  assert.equal(core.snapshot().ocr.status, 'manual');
});

test('a true OCR correction clears a previous failure and model details while an unchanged save retains the model result', async t => {
  const models=new ModelAdapters();let fail=false;
  models.register('ocr',{run:()=>{if(fail)throw new Error('Synthetic OCR connection failure');return{text:'Recognized text',regions:[{text:'Recognized text'}],meta:{model:'fixture',backend:'test'}};}});
  const f=await fixture(t,models);await f.core.setOcrImage(await seedAsset(f,'synthetic.png',png));
  await f.core.runOcr();
  const recognized=f.core.snapshot().ocr;
  f.core.saveOcrText(recognized.text);assert.deepEqual(f.core.snapshot().ocr,recognized);
  fail=true;await f.core.runOcr();assert.equal(f.core.snapshot().ocr.error,'Synthetic OCR connection failure');
  f.core.saveOcrText('Manually corrected text');
  const corrected=f.reopen().core.snapshot().ocr;
  assert.equal(corrected.text,'Manually corrected text');assert.equal(corrected.status,'manual');assert.equal(corrected.error,'');
  assert.equal(corrected.meta,undefined);assert.equal(corrected.regions,undefined);
});

test('changing polish input invalidates an in-flight result', async t => {
  const model = deferredModel('llm');
  const f = await fixture(t, model.models);
  f.core.savePolish({input:'第一個需求'});
  const pending = f.core.runPolish();
  f.core.savePolish({input:'第二個需求', use:'message', tone:'casual'});
  model.resolve({text:'first result'});
  await pending;
  const p = f.core.snapshot().polish;
  assert.equal(p.input, '第二個需求');
  assert.equal(p.output, '');
  assert.equal(p.status, 'waiting-model');
});

test('PC LLM settings accept only loopback HTTP and preserve the PC backend default', async t => {
  const f = await fixture(t);
  assert.equal(f.core.snapshot().settings.localBackend, 'pc-api');
  assert.equal(f.core.snapshot().settings.compute, undefined);
  assert.deepEqual(f.core.snapshot().settings.devLlm, {endpoint:'http://127.0.0.1:8765'});
  for (const endpoint of ['http://127.0.0.1:8765/', 'http://localhost:9876/api/', 'http://[::1]:8765/']) {
    f.core.settings({localBackend:'pc-api', devLlm:{endpoint}});
    assert.equal(f.core.snapshot().settings.devLlm.endpoint, endpoint.replace(/\/+$/, ''));
    assert.equal(f.reopen().core.snapshot().settings.localBackend, 'pc-api');
  }
  const previous = f.core.snapshot().settings;
  for (const endpoint of ['', 'https://localhost:8765', 'file:///local/model', 'http://0.0.0.0:8765',
    'http://example.invalid', 'http://localhost.evil.invalid', 'http://127.0.0.1@evil.invalid',
    'http://secret@localhost:8765', 'http://localhost:8765?key=secret', 'http://localhost:8765#secret',
    'http://localhost:8765?', 'http://localhost:8765#', 123, null]) {
    assert.throws(() => f.core.settings({localBackend:'ugen300', devLlm:{endpoint}}));
    assert.deepEqual(f.core.snapshot().settings, previous);
  }
  assert.throws(() => f.core.settings({devLlm:[]}));
});

test('same-value polish autosaves and unrelated or equivalent settings do not cancel a running model', async t => {
  const model = deferredModel('llm');
  const f = await fixture(t, model.models);
  f.core.savePolish({input:'請確認時間',use:'email',tone:'polite'});
  const pending = f.core.runPolish();
  const revision = f.core.snapshot().polish.revision;
  f.core.savePolish({input:'請確認時間',use:'email',tone:'polite'});
  f.core.settings({theme:'dark',devLlm:{endpoint:'http://127.0.0.1:8765/'}});
  assert.throws(() => f.core.savePolish({input:'other text',tone:'invalid'}));
  assert.throws(() => f.core.settings({localBackend:'ugen300',devLlm:{endpoint:'http://remote.invalid'}}));
  assert.equal(model.request.signal.aborted, false);
  assert.equal(f.core.snapshot().polish.status, 'running');
  assert.equal(f.core.snapshot().polish.revision, revision);
  model.resolve({text:'請協助確認時間。',meta:{model:'fixture',backend:'pc-api',extra:'discard'}});
  await pending;
  assert.equal(f.core.snapshot().polish.output, '請協助確認時間。');
  assert.deepEqual(f.core.snapshot().polish.meta, {source:'local',model:'fixture',backend:'pc-api'});
  assert.equal(f.core.active.has('polish'), false);
});

test('explicit polish cancellation returns before an ignoring adapter and old completion cannot overwrite a new run', async t => {
  const old = deferredModel('llm');
  const f = await fixture(t, old.models);
  f.core.savePolish({input:'保留這段輸入'});
  const firstRun = f.core.runPolish();
  const cancelled = f.core.cancelPolish();
  assert.equal(cancelled.polish.status, 'cancelled');
  assert.equal(cancelled.polish.input, '保留這段輸入');
  assert.equal(old.request.signal.aborted, true);
  await firstRun;
  const next = deferredModel('llm');
  f.core.models = next.models;
  const nextRun = f.core.runPolish();
  old.resolve({text:'stale result'});
  await Promise.resolve();
  assert.equal(f.core.snapshot().polish.status, 'running');
  assert.equal(f.core.active.has('polish'), true);
  next.resolve({text:'新工作完成'});
  await nextRun;
  assert.equal(f.core.snapshot().polish.output, '新工作完成');
});

test('changing the selected model backend or endpoint cancels its LLM jobs and rejects late responses', async t => {
  for (const patch of [{localBackend:'ugen300'}, {devLlm:{endpoint:'http://localhost:9876'}}, {api:{endpoint:'https://example.invalid/v1',model:'fixture'}}]) {
    const requests = [], completions = [];
    const source=patch.api?'cloud':'local',models = new ModelAdapters();
    models.register('llm',{run(request) {
      requests.push(request);
      return new Promise(resolve => completions.push(resolve));
    }},{source});
    const f = await fixture(t, models);
    f.store.update(d => d.messages.push({id:'mail',folder:'inbox',done:false,subject:'請回覆',body:'明天下午前回覆',analysis:null,level:null}));
    f.core.savePolish({input:'請確認'});
    const polishRun = f.core.runPolish(source), mailRun = f.core.analyzeMail(source);
    f.core.settings(patch);
    assert.ok(requests.every(request => request.signal.aborted));
    await Promise.all([polishRun,mailRun]);
    const stopped = f.core.snapshot();
    assert.equal(stopped.polish.status, 'cancelled');
    assert.equal(stopped.mailAnalysis.status, 'cancelled');
    completions[0]({text:'late text'});
    completions[1]({analyses:[{id:'mail',summary:'late summary',priority:0,reason:'late reason',evidence:['明天下午前']}]});
    await Promise.resolve();
    assert.equal(f.core.snapshot().polish.output, '');
    assert.equal(f.core.snapshot().messages[0].analysis, null);
    assert.equal(f.core.active.size, 0);
  }
});

test('invalid polish output is never coerced into a fake result and manual output cancels an active run', async t => {
  for (const text of [null, {}, '', ' ', 'x'.repeat(200001)]) {
    const models = new ModelAdapters(); models.register('llm', {run:async () => ({text})});
    const f = await fixture(t, models); f.core.savePolish({input:'有效輸入'});
    await f.core.runPolish();
    assert.equal(f.core.snapshot().polish.status, 'error');
    assert.equal(f.core.snapshot().polish.output, '');
    assert.ok(!f.core.snapshot().logs.some(log => log.text === '文章潤句完成'));
  }
  const model = deferredModel('llm'); const f = await fixture(t, model.models);
  f.core.savePolish({input:'輸入'}); const pending = f.core.runPolish();
  f.core.savePolish({output:'人工修正文句'});
  await pending; model.resolve({text:'stale generated text'}); await Promise.resolve();
  assert.equal(f.reopen().core.snapshot().polish.output, '人工修正文句');
  assert.equal(f.core.snapshot().polish.status, 'manual');
});

test('manual SRT survives reopen and exports with its original cue text and timing', async t => {
  const f = await fixture(t);
  const recording = await seedRecording(f);
  f.core.saveTranscript(recording.id, {format:'srt', text:srt});
  const {core} = f.reopen();
  const saved = core.snapshot().recordings[0];
  assert.equal(saved.state, 'done');
  assert.equal(saved.transcriptSource, 'manual');
  assert.deepEqual(parseSrt(exportSrt(saved.segments)), parseSrt(srt));
  assert.equal(exportTxt(saved), '明天十點開會。\r\n請保留產品名稱 UFriend。');
});

test('manual TXT has no invented time points and invalid SRT does not replace saved content', async t => {
  const f = await fixture(t);
  const recording = await seedRecording(f);
  const text = '人工逐字稿\r\n請保留 09:30 與專有名稱。';
  f.core.saveTranscript(recording.id, {format:'txt', text});
  assert.throws(() => f.core.saveTranscript(recording.id, {format:'srt', text:'1\n00:99:00,000 --> 00:99:01,000\ninvalid'}));
  const {core} = f.reopen();
  const saved = core.snapshot().recordings[0];
  assert.equal(exportTxt(saved), text);
  assert.deepEqual(saved.segments, []);
  assert.equal(saved.transcriptSource, 'manual');
});

test('manual transcript saved during transcription cannot be overwritten by a late model result', async t => {
  const model = deferredModel('whisper');
  const f = await fixture(t, model.models);
  const recording = await seedRecording(f);
  const pending = f.core.runRecording(recording.id);
  f.core.saveTranscript(recording.id, {format:'txt', text:'人工確認的最新逐字稿'});
  model.resolve({segments:[{start:0, end:1, text:'stale automated transcript'}]});
  await pending;
  const saved = f.core.snapshot().recordings[0];
  assert.equal(saved.textOnly, '人工確認的最新逐字稿');
  assert.equal(saved.transcriptSource, 'manual');
  assert.equal(saved.state, 'done');
  assert.equal(saved.error, '');
  assert.ok(!f.core.snapshot().logs.some(log => log.text === '語音轉錄完成'));
});

test('unconfigured transcription rejection cannot downgrade a just-saved manual transcript', async t => {
  const f = await fixture(t);
  const recording = await seedRecording(f);
  const pending = f.core.runRecording(recording.id);
  f.core.saveTranscript(recording.id, {format:'srt', text:srt});
  await pending;
  const saved = f.core.snapshot().recordings[0];
  assert.equal(saved.state, 'done');
  assert.equal(saved.progress, 100);
  assert.equal(saved.transcriptSource, 'manual');
  assert.equal(saved.error, '');
});

test('paused or removed recordings do not accept late results', async t => {
  for (const action of ['pause', 'remove']) {
    const model = deferredModel('whisper');
    const f = await fixture(t, model.models);
    const recording = await seedRecording(f);
    const pending = f.core.runRecording(recording.id);
    if (action === 'pause') f.core.pauseRecording(recording.id);
    else f.core.removeRecording(recording.id);
    model.resolve({segments:[{start:0, end:1, text:'late result'}]});
    await pending;
    const saved = f.core.snapshot().recordings.find(r => r.id === recording.id);
    if (action === 'pause') {
      assert.equal(saved.state, 'paused');
      assert.deepEqual(saved.segments, []);
    } else assert.equal(saved, undefined);
    assert.ok(!f.core.snapshot().logs.some(log => log.text === '語音轉錄完成'));
  }
});

test('reopening recovers interrupted OCR, polish and recording states without losing saved inputs', async t => {
  const f = await fixture(t);
  const asset = await seedAsset(f, 'capture.png', png);
  const recording = await seedRecording(f);
  await f.core.setOcrImage(asset);
  f.core.savePolish({input:'重新開啟後應保留的需求'});
  f.store.update(d => {
    d.ocr.status = 'running'; d.ocr.text = '先前的人工校對';
    d.polish.status = 'running'; d.polish.output = '先前的人工版本';
    d.recordings.find(r => r.id === recording.id).state = 'running';
  });
  const {core} = f.reopen();
  const state = core.snapshot();
  for (const status of [state.ocr.status, state.polish.status, state.recordings[0].state]) {
    assert.ok(!['running', 'queued', 'loading'].includes(status), `orphaned state after restart: ${status}`);
  }
  assert.equal(state.ocr.imageId, asset.id);
  assert.equal(state.ocr.text, '先前的人工校對');
  assert.equal(state.polish.input, '重新開啟後應保留的需求');
  assert.equal(state.polish.output, '先前的人工版本');
});

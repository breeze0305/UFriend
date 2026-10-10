'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { CloudApiAdapter, normalizeCloudEndpoint, readCloudStream, transcription } = require('../app/models/cloud-api.cjs');
const { MAIL_CATEGORY_IDS, MAIL_CATEGORY_LABELS, validMailCategory } = require('../app/services/mail-categories.cjs');
const { withCloudAudio, retryCloudAudioCleanup, readChunks, SEGMENT_SECONDS, UPLOAD_BYTES } = require('../app/models/cloud-audio.cjs');
const projectRoot = path.resolve(__dirname, '..');
const ffmpeg = path.join(projectRoot, 'local', 'runtimes', 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
const configured = () => ({ api: { endpoint: 'https://provider.example/v1', model: 'chosen-text', ocrModel: 'chosen-vision', transcriptionModel: 'chosen-speech', temperature: null }, preferredLanguage: 'zh-TW', personalProfile: { enabled: false } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content, finish = 'stop', extra = {}) => json({ choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...extra } }] });
const chat = () => ({ task: 'chat', input: { messages: [{ role: 'user', content: 'Synthetic question' }] } });
const MAIL_CURRENT_MESSAGE_GUIDANCE = "summary只回答：這封信主要是哪一類內容、用途是什麼？用一個簡短繁體中文短語（通常4–15字），大致方向正確即可。略過稱呼、帳號導覽、客服、退訂、網址及品項清單，不照抄模糊主旨，不列日期金額或待辦。只看本次可讀正文，忽略引用歷史；取消、完成等狀態不可反轉，沒有足夠內容就寫內容不足。";
function fixture(options = {}) {
  const settings = configured(); let key = 'synthetic-key-only'; const requests = [];
  const adapter = new CloudApiAdapter({ getSettings: () => settings, getApiKey: () => key, fetchImpl: async (url, args) => { requests.push({ url, args }); return completion('Synthetic answer'); }, ...options });
  return { settings, requests, adapter, setKey: value => { key = value; } };
}
async function localFixture(t) {
  const parent = path.join(projectRoot, '.test-data', 'cloud-api'); await fs.mkdir(parent, { recursive: true });
  assert.equal((await fs.realpath(parent)).toLowerCase(), parent.toLowerCase());
  const directory = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { const real = await fs.realpath(directory); assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase()); await fs.rm(real, { recursive: true, force: true, maxRetries: 3 }); });
  return directory;
}
const event = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const delta = (content, finish = null) => ({ choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finish }] });
function sse(frames, { split = 0 } = {}) {
  const bytes = Buffer.from(frames.join(''));
  return new Response(new ReadableStream({ start(controller) { if (!split) controller.enqueue(bytes); else for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.subarray(i, i + split)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function fakeAudio(file, pieces, cleaned) {
  return async (_source, _options, use) => { try { return await use({ chunks: pieces.map((part, index) => ({ filePath: file, bytes: 6, ...part })), duration: pieces.at(-1).offset + pieces.at(-1).duration }); } finally { cleaned?.(); } };
}

test('mail categories form one immutable shared taxonomy', () => {
  assert(Object.isFrozen(MAIL_CATEGORY_LABELS));assert(Object.isFrozen(MAIL_CATEGORY_IDS));
  assert.deepEqual(MAIL_CATEGORY_IDS,['work','meeting','finance','account','promotion','personal','other']);
  for(const id of MAIL_CATEGORY_IDS)assert.equal(validMailCategory(id),true);
  for(const invalid of ['toString','Work','',null,{},[],5])assert.equal(validMailCategory(invalid),false);
});

test('mail classification uses only its summary and fixed instructions, keeping the public prompt catalog unchanged', async () => {
  const requests=[];let category;
  const f=fixture({fetchImpl:async(url,args)=>{requests.push({url,args});return completion(JSON.stringify({category}));}});
  f.settings.personalProfile={enabled:true,name:'PRIVATE PROFILE'};
  f.settings.llmPrompts={'mail-classify':{system:'PRIVATE CUSTOM PROMPT',user:'PRIVATE TEMPLATE'}};
  const input={summary:'Synthetic summary: the project owner requests a progress report.'};
  for(category of MAIL_CATEGORY_IDS){const result=await f.adapter.run({task:'mail-classify',input});assert.equal(result.category,category);assert.equal(result.text,undefined);assert.equal(result.meta.backend,'cloud-openai-compatible');}
  for(const {url,args} of requests){
    const body=JSON.parse(args.body);assert.equal(url,'https://provider.example/v1/chat/completions');assert.equal(body.messages.length,2);
    assert.deepEqual(JSON.parse(body.messages[1].content),input);assert.equal(args.body.includes('PRIVATE'),false);assert.equal(body.stream,false);assert.equal(body.store,false);
    for(const id of MAIL_CATEGORY_IDS)assert(body.messages[0].content.includes(id));
  }
  assert.deepEqual(Object.keys((await f.adapter.prompts()).tasks).sort(),['chat','mail','polish','translate']);
});

test('mail classification rejects invalid input before upload and rejects unknown or embellished category output', async () => {
  let calls=0,response={category:'other'};
  const f=fixture({fetchImpl:async()=>{calls++;return completion(JSON.stringify(response));}});
  for(const input of [null,[],{}, {summary:''},{summary:' '},{summary:7},{summary:'x'.repeat(2001)},{summary:'Synthetic summary',body:'PRIVATE ORIGINAL MAIL'}])await assert.rejects(f.adapter.run({task:'mail-classify',input}),{code:'MODEL_INVALID_REQUEST'});
  assert.equal(calls,0);
  assert.equal((await f.adapter.run({task:'mail-classify',input:{summary:'x'.repeat(2000)}})).category,'other');
  for(response of [{},{category:'billing'},{category:'Meeting'},{category:null},{category:[]},{category:'meeting',reason:'Synthetic extra explanation'},'meeting'])await assert.rejects(f.adapter.run({task:'mail-classify',input:{summary:'Synthetic meeting summary.'}}),{code:'MODEL_INVALID_OUTPUT'});
});

test('mail classification never succeeds on truncation, cancellation or a stalled response timeout', async () => {
  const request={task:'mail-classify',input:{summary:'Synthetic meeting summary.'}};
  await assert.rejects(fixture({fetchImpl:async()=>completion('{"category":"meeting"}','length')}).adapter.run(request),{code:'MODEL_OUTPUT_LIMIT'});
  let arrived;const started=new Promise(resolve=>{arrived=resolve;}),controller=new AbortController();
  const cancelled=fixture({fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{arrived();signal.addEventListener('abort',()=>reject(new Error('Synthetic cancellation')),{once:true});})});
  const running=cancelled.adapter.run({...request,signal:controller.signal}),rejected=assert.rejects(running,{code:'MODEL_CANCELLED'});
  await started;controller.abort();await rejected;assert.equal(cancelled.adapter.activeRuns.size,0);
  const timed=fixture({timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('{'));}}),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(timed.adapter.run(request),{code:'MODEL_API_TIMEOUT'});assert.equal(timed.adapter.activeRuns.size,0);
});

test('cloud configuration requires a safe endpoint, the selected capability model and a synchronous key', async () => {
  for (const kind of ['llm', 'ocr', 'whisper']) {
    const f = fixture({ kind }); assert.equal(f.adapter.isConfigured(), true);
    f.setKey(''); assert.equal(f.adapter.isConfigured(), false);
    await assert.rejects(f.adapter.run(chat()), { code: 'MODEL_NOT_CONFIGURED' }); assert.equal(f.requests.length, 0);
    f.setKey('synthetic-key-only'); f.settings.api[{ llm: 'model', ocr: 'ocrModel', whisper: 'transcriptionModel' }[kind]] = '';
    assert.equal(f.adapter.isConfigured(), false);
  }
  const unavailable = fixture({ getApiKey() { throw new Error('PRIVATE KEY IN VAULT ERROR'); } });
  assert.equal(unavailable.adapter.isConfigured(), false);
  await assert.rejects(unavailable.adapter.run(chat()), e => e.code === 'MODEL_NOT_CONFIGURED' && !String(e).includes('PRIVATE'));
});

test('cloud endpoint accepts HTTPS or loopback HTTP and rejects credentials, queries and unsafe protocols', () => {
  for (const endpoint of ['http://provider.example/v1', 'https://user:password@provider.example/v1', 'https://provider.example/v1?key=private', 'https://provider.example/v1#private', 'file:///private', 'ftp://provider.example', 'https://provider.example/v1?', 'https://provider.example/v1#', 'https://provider.example/\n', '']) assert.throws(() => normalizeCloudEndpoint(endpoint), { code: 'MODEL_INVALID_REQUEST' });
  assert.equal(normalizeCloudEndpoint('https://provider.example/openai/v1/'), 'https://provider.example/openai/v1');
  assert.equal(normalizeCloudEndpoint('http://127.0.0.1:9999/v1/'), 'http://127.0.0.1:9999/v1');
  assert.equal(normalizeCloudEndpoint('http://[::1]:9999/v1'), 'http://[::1]:9999/v1');
});

test('chat sends only explicit conversation context with caller-selected model and omits default temperature', async () => {
  const f = fixture(); f.settings.privateUnrelated = 'PRIVATE UNRELATED';
  const result = await f.adapter.run({ ...chat(), input: { ...chat().input, secret: 'PRIVATE EXTRA INPUT' } });
  const { url, args } = f.requests[0], body = JSON.parse(args.body);
  assert.equal(url, 'https://provider.example/v1/chat/completions'); assert.equal(args.redirect, 'error');
  assert.equal(args.headers.Authorization, 'Bearer synthetic-key-only'); assert.equal(body.model, 'chosen-text');
  assert.equal(Object.hasOwn(body, 'temperature'), false); assert.equal(body.max_completion_tokens, 4096); assert.equal(body.store, false);
  assert.equal(body.stream, false); assert.equal(body.messages.at(-1).content, '"Synthetic question"');
  assert.equal(args.body.includes('PRIVATE'), false); assert.deepEqual(result.meta, { model: 'chosen-text', backend: 'cloud-openai-compatible' });
  assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
});

test('temperature zero is retained and invalid numeric settings do not become configured', async () => {
  const f = fixture(); f.settings.api.temperature = 0; await f.adapter.run(chat());
  assert.equal(JSON.parse(f.requests[0].args.body).temperature, 0);
  for (const value of [-0.1, 2.1, NaN, '0.2']) { f.settings.api.temperature = value; assert.equal(f.adapter.isConfigured(), false); }
});

test('custom prompts render placeholders once and keep profile/language out of translation', async () => {
  const f = fixture(); f.settings.personalProfile = { enabled: true, name: 'Synthetic Name', notes: 'literal {{text}}' }; f.settings.preferredLanguage = 'en';
  f.settings.llmPrompts = { chat: { system: 'Custom system', user: 'Question={{text}}' } };
  await f.adapter.run(chat()); const first = JSON.parse(f.requests[0].args.body);
  assert.match(first.messages[0].content, /English/); assert.match(first.messages[0].content, /Synthetic Name/); assert.match(first.messages[0].content, /literal \{\{text\}\}/);
  assert.equal(first.messages.at(-1).content, 'Question="Synthetic question"');
  await f.adapter.run({ task: 'translate', input: { text: 'Original', sourceLanguage: 'auto', targetLanguage: 'ja' } });
  const translation = f.requests[1].args.body;
  assert.equal(translation.includes('Synthetic Name'), false); assert.equal(translation.includes('user_profile'), false); assert.match(translation, /日本語/);
});

test('invalid or excessive chat history fails before any network request', async () => {
  const f = fixture();
  for (const messages of [[], [{ role: 'system', content: 'not a user' }], [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], [{ role: 'user', content: 'x'.repeat(16001) }]]) await assert.rejects(f.adapter.run({ task: 'chat', input: { messages } }), { code: 'MODEL_INVALID_REQUEST' });
  assert.equal(f.requests.length, 0);
});

test('normal responses require a completed single answer and reject tool/refusal results', async () => {
  for (const [finish, code] of [['length', 'MODEL_OUTPUT_LIMIT'], ['tool_calls', 'MODEL_INVALID_OUTPUT'], [null, 'MODEL_INVALID_OUTPUT'], ['content_filter', 'MODEL_INVALID_OUTPUT']]) {
    const f = fixture({ fetchImpl: async () => completion('Partial answer', finish) }); await assert.rejects(f.adapter.run(chat()), { code });
  }
  for (const extra of [{ tool_calls: [{}] }, { refusal: 'private service refusal' }]) await assert.rejects(fixture({ fetchImpl: async () => completion('text', 'stop', extra) }).adapter.run(chat()), { code: 'MODEL_INVALID_OUTPUT' });
});

test('mail JSON must identify exactly the requested mail and cite literal source fragments', async () => {
  const mail = { id: 'synthetic-mail', subject: '今天請提供資料', body: '請於 15:00 前寄回報表。', date: '2026-09-12T01:00:00Z', sender: 'sender@example.test', to: ['reader@example.test'], cc: [] };
  const input = { messages: [mail], recipient: 'reader@example.test', referenceTime: '2026-09-12T02:00:00Z' };
  const valid = { analyses: [{ id: mail.id, summary: '今天需寄回報表。', priority: 0, reason: '15:00 前需寄回。', evidence: ['請於 15:00 前寄回報表。'] }] };
  let sent;
  const f = fixture({ fetchImpl: async (_url,args) => { sent=JSON.parse(args.body);return completion(JSON.stringify(valid)); } });
  assert.equal((await f.adapter.run({ task: 'mail', input })).analyses[0].id, mail.id);
  const catalog=(await f.adapter.prompts()).tasks.mail;
  assert(sent.messages[0].content.startsWith(catalog.system));
  assert(catalog.system.includes(MAIL_CURRENT_MESSAGE_GUIDANCE));assert.match(catalog.system,/不得創造待辦/);
  assert.doesNotMatch(catalog.system,/主旨與全文|依主要事項分點|保留原文明示且影響理解或行動的關鍵日期|summary用1–3句/);
  assert.match(sent.messages[0].content,/原文行每項為\[行號,來源,引用層級,原文\]/);
  assert.match(sent.messages[0].content,/0也可能是未加>的舊信，不表示本次正文/);
  assert.match(sent.messages[0].content,/從舊回覆引用或舊信標頭起忽略其後尾段/);
  assert.match(sent.messages[0].content,/寄件者、收件者與副本只用於判斷正文已明示的本人責任，不在summary敘述/);
  assert.equal(sent.max_completion_tokens,4096);
  assert.match(sent.messages[0].content,/"analyses"/);assert.match(sent.messages[1].content,/請於 15:00 前寄回報表/);
  for (const patch of [{ id: 'other-mail' }, { priority: 1.5 }, { evidence: ['invented evidence'] }, { reason: '' }, { command: 'delete-mail' }]) {
    const bad = { analyses: [{ ...valid.analyses[0], ...patch }] };
    await assert.rejects(fixture({ fetchImpl: async () => completion(JSON.stringify(bad)) }).adapter.run({ task: 'mail', input }), { code: 'MODEL_INVALID_OUTPUT' });
  }
});

test('mail compose shares the short purpose phrase guidance and preserves its private output contract', async () => {
  const input = {
    mail: { id: 'synthetic-reply', subject: 'Re: 請提供資料', date: '2026-09-19T01:00:00Z', sender: 'sender@example.test', to: ['reader@example.test'], cc: [] },
    recipient: 'reader@example.test', referenceTime: '2026-09-19T02:00:00Z',
    lines: [[0, 'Re: 請提供資料'], [1, '資料已收到，謝謝。'], [2, 'On September 18, sender@example.test wrote:'], [3, '> 請確認並寄回資料。']],
  };
  const valid = { summary: '收件確認', reason: '資料已收到，今天無待辦。', priority: 2, evidenceIds: [1] };
  let sent;
  const f = fixture({ fetchImpl: async (_url, args) => { sent = JSON.parse(args.body); return completion(JSON.stringify(valid)); } });
  const result = await f.adapter.run({ task: 'mail-compose', input });
  const system = sent.messages[0].content, catalog = (await f.adapter.prompts()).tasks.mail;
  assert(catalog.system.includes(MAIL_CURRENT_MESSAGE_GUIDANCE));
  assert.equal(system.split(MAIL_CURRENT_MESSAGE_GUIDANCE).length, 2);
  assert.match(system, /通常4–15字/); assert.match(system, /大致方向正確即可/);
  assert.match(system, /略過稱呼、帳號導覽、客服/);
  assert.doesNotMatch(system, /「已收到本次款項」|「平台推薦多個影片與直播節目」/);
  assert.doesNotMatch(system, /分段讀取完整郵件|請統一彙整|依主要事項分點|保留影響理解或本人行動的日期/);
  assert.match(system, /summary最多1000字元/); assert.match(system, /reason最多160字元/);
  assert.match(system, /priority=0為本人今天明確限時或立即處理，1為今天一般待辦，2為今天無待辦、已取消、其他人負責或未來才需處理/);
  assert.match(system, /evidenceIds選1至8個支持摘要與分級的原文行號/);
  assert(system.endsWith('只輸出 JSON {"summary":"摘要","reason":"理由","priority":0或1或2,"evidenceIds":[行號]}。'));
  assert.equal(sent.max_completion_tokens, 1536); assert.equal(sent.store, false); assert.equal(sent.stream, false);
  assert.deepEqual(JSON.parse(sent.messages[1].content), input);
  for (const key of Object.keys(valid)) assert.deepEqual(result[key], valid[key]);
});

test('polish preserves source numbers and placeholders and rejects invented details with new numbers', async () => {
  const request = { task: 'polish', input: { text: '[姓名] 15:00 前給我 12500 元報價', use: 'email', tone: 'polite' } };
  const valid = fixture({ fetchImpl: async () => completion(JSON.stringify({ text: '請 [姓名] 於 15:00 前提供 12500 元報價。' })) });
  assert.match((await valid.adapter.run(request)).text, /12500/);
  const bad = fixture({ fetchImpl: async () => completion(JSON.stringify({ text: '請於 16:00 前提供 15000 元報價。' })) });
  await assert.rejects(bad.adapter.run(request), { code: 'MODEL_INVALID_OUTPUT' });
});

test('SSE supports split UTF-8 and CRLF, then requires stop and DONE for a successful answer', async () => {
  const seen = [], frames = [event(delta('繁體')), event(delta('中文')), event(delta(undefined, 'stop')), event('[DONE]')].map(x => x.replaceAll('\n', '\r\n'));
  const f = fixture({ fetchImpl: async () => sse(frames, { split: 1 }) });
  const result = await f.adapter.run({ ...chat(), onDelta: text => seen.push(text) });
  assert.deepEqual(seen, ['繁體', '中文']); assert.equal(result.text, '繁體中文');
});

test('SSE rejects truncation, post-finish text, tool calls and length completion', async () => {
  const cases = [
    [[event(delta('partial'))], 'MODEL_STREAM_INTERRUPTED'],
    [[event(delta('partial')), event('[DONE]')], 'MODEL_STREAM_INTERRUPTED'],
    [[event(delta('partial')), event(delta(undefined, 'stop'))], 'MODEL_STREAM_INTERRUPTED'],
    [[event(delta('partial', 'length')), event('[DONE]')], 'MODEL_OUTPUT_LIMIT'],
    [[event(delta('answer', 'stop')), event(delta('unexpected')), event('[DONE]')], 'MODEL_INVALID_OUTPUT'],
    [[event({ choices: [{ index: 0, delta: { tool_calls: [{}] }, finish_reason: null }] })], 'MODEL_INVALID_OUTPUT'],
  ];
  for (const [frames, code] of cases) await assert.rejects(fixture({ fetchImpl: async () => sse(frames) }).adapter.run({ ...chat(), onDelta() {} }), { code });
});

test('SSE and JSON readers enforce output/body limits and reject malformed UTF-8', async () => {
  await assert.rejects(readCloudStream(sse([event(delta('x'.repeat(16001))), event(delta(undefined, 'stop')), event('[DONE]')])), { code: 'MODEL_INVALID_OUTPUT' });
  await assert.rejects(fixture({ fetchImpl: async () => json({ padding: 'x'.repeat(2 * 1024 * 1024) }) }).adapter.run(chat()), { code: 'MODEL_INVALID_OUTPUT' });
  const invalid = new Response(Buffer.from([0xff]), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(fixture({ fetchImpl: async () => invalid }).adapter.run(chat()), { code: 'MODEL_INVALID_OUTPUT' });
});

test('HTTP authentication errors and network failures never reveal provider content, keys or paths', async () => {
  for (const fetchImpl of [async () => json({ error: { message: 'PRIVATE CONTENT', key: 'synthetic-key-only' } }, 401), async () => { throw new Error('PRIVATE NETWORK synthetic-key-only /private/source'); }]) {
    const f = fixture({ fetchImpl });
    await assert.rejects(f.adapter.run(chat()), error => ['MODEL_CLOUD_AUTH_FAILED', 'MODEL_API_UNAVAILABLE'].includes(error.code) && !/PRIVATE|synthetic-key|\/private/.test(String(error)));
  }
});

test('caller cancellation aborts fetch, clears active runs and sanitizes cancellation reasons', async () => {
  let entered; const called = new Promise(resolve => { entered = resolve; }); let owned;
  const f = fixture({ fetchImpl: async (_url, args) => { owned = args.signal; entered(); return await new Promise((_resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('PRIVATE cancellation')), { once: true })); } });
  const controller = new AbortController(), running = f.adapter.run({ ...chat(), signal: controller.signal });
  await called; controller.abort(new Error('PRIVATE caller input'));
  await assert.rejects(running, error => error.code === 'MODEL_CANCELLED' && error.name === 'AbortError' && !String(error).includes('PRIVATE'));
  assert.equal(owned.aborted, true); assert.equal(f.adapter.activeRuns.size, 0);
  const already = new AbortController(); already.abort(); const other = fixture(); await assert.rejects(other.adapter.run({ ...chat(), signal: already.signal }), { code: 'MODEL_CANCELLED' }); assert.equal(other.requests.length, 0);
});

test('owned timeouts cancel stalled response bodies without aborting caller signal', async () => {
  let cancelled = false; const parent = new AbortController();
  const f = fixture({ timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('{')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(f.adapter.run({ ...chat(), signal: parent.signal }), { code: 'MODEL_API_TIMEOUT' });
  assert.equal(cancelled, true); assert.equal(parent.signal.aborted, false); assert.equal(f.adapter.activeRuns.size, 0);
});

test('wrong SSE content type disconnects immediately and does not wait for EOF', async () => {
  let cancelled = false;
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('private HTML')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(f.adapter.run({ ...chat(), onDelta() {} }), { code: 'MODEL_API_INCOMPATIBLE' }); assert.equal(cancelled, true);
});

test('health uses only GET models and prompts are a local cloned catalog', async () => {
  const requests = [];
  const f = fixture({ fetchImpl: async (url, args) => { requests.push({ url, args }); return json({ data: [{ id: 'chosen-text' }] }); } });
  const health = await f.adapter.health(); assert.equal(health.check, 'models'); assert.equal(health.model, 'chosen-text');
  assert.equal(requests[0].url, 'https://provider.example/v1/models'); assert.equal(requests[0].args.method, 'GET'); assert.equal(Object.hasOwn(requests[0].args, 'body'), false);
  const a = await f.adapter.prompts(); a.tasks.chat.system = 'changed'; assert.notEqual((await f.adapter.prompts()).tasks.chat.system, 'changed'); assert.equal(requests.length, 1);
  await assert.rejects(fixture({ fetchImpl: async () => json({ data: [{ id: 'different' }] }) }).adapter.health(), { code: 'MODEL_CLOUD_MODEL_UNAVAILABLE' });
});

test('OCR sends one selected local image as data URL without path or unrelated profile', async t => {
  const dir = await localFixture(t), file = path.join(dir, 'private-image.png');
  await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXeoAAAAASUVORK5CYII=', 'base64'));
  let captured;
  const f = fixture({ kind: 'ocr', fetchImpl: async (url, args) => { captured = { url, args }; return completion('可見文字'); } });
  f.settings.personalProfile = { enabled: true, name: 'Private Background' };
  const result = await f.adapter.run({ task: 'recognize', input: { filePath: file } });
  const body = JSON.parse(captured.args.body); assert.equal(body.model, 'chosen-vision'); assert.equal(body.messages.length, 1); assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(captured.args.body.includes('private-image'), false); assert.equal(captured.args.body.includes('Private Background'), false); assert.deepEqual(result.regions, []);
  const noText = fixture({ kind: 'ocr', fetchImpl: async () => completion('') }); assert.equal((await noText.adapter.run({ task: 'recognize', input: { filePath: file } })).text, '');
  await assert.rejects(f.adapter.run({ task: 'recognize', input: { filePath: 'https://private.example/image.png' } }), { code: 'MODEL_INVALID_REQUEST' });
});

test('transcription snapshots routing and sends each compressed segment with timestamp requirements', async t => {
  const dir = await localFixture(t), file = path.join(dir, 'fake-audio.mp3'); await fs.writeFile(file, 'audio!');
  let cleaned = false; const requests = [], pieces = [{ offset: 0, duration: 1200.024 }, { offset: 1200.024, duration: 10 }];
  const settings = configured(); let key = 'original-key';
  const adapter = new CloudApiAdapter({ kind: 'whisper', getSettings: () => settings, getApiKey: () => key,
    prepareAudio: fakeAudio(file, pieces, () => { cleaned = true; }), fetchImpl: async (url, args) => {
      const part = requests.length; requests.push({ url, args, model: args.body.get('model') });
      settings.api.endpoint = 'https://changed.example/v1'; settings.api.transcriptionModel = 'changed-model'; key = 'changed-key';
      return json({ text: '段落', language: 'chinese', duration: pieces[part].duration, segments: [{ start: 1, end: 2, text: '段落' }] });
    } });
  const progress = [], result = await adapter.run({ task: 'transcribe', input: { filePath: file, language: 'zh-TW' }, onProgress: (value, detail) => progress.push({ value, detail }) });
  assert.equal(requests.length, 2); assert.equal(cleaned, true); assert.equal(result.segments[1].start, 1201.024); assert.equal(result.duration, 1210.024);
  for (const { url, args, model } of requests) { assert.equal(url, 'https://provider.example/v1/audio/transcriptions'); assert.equal(model, 'chosen-speech'); assert.equal(args.headers.Authorization, 'Bearer original-key'); assert.equal(args.redirect, 'error'); assert.equal(Object.hasOwn(args.headers, 'Content-Type'), false); assert.equal(args.body.get('response_format'), 'verbose_json'); assert.equal(args.body.get('timestamp_granularities[]'), 'segment'); assert.equal(args.body.get('language'), 'zh'); assert.match(args.body.get('file').name, /^part-\d{5}\.mp3$/); }
  assert.equal(progress.at(-1).detail.processedSeconds, result.duration); assert.equal(result.meta.model, 'chosen-speech');
});

test('transcription rejects missing or invented timestamps and never fabricates them from plain text', () => {
  const chunk = { offset: 20, duration: 10 };
  for (const value of [{ text: 'plain only' }, { duration: 10, text: 'nonempty without segments', segments: [] }, { duration: 100, segments: [] }, { duration: 10, segments: [{ start: 4, end: 3, text: 'wrong' }] }, { duration: 10, segments: [{ start: 11, end: 12, text: 'outside' }] }]) assert.throws(() => transcription(value, chunk), { code: 'MODEL_TIMESTAMPS_UNAVAILABLE' });
  assert.deepEqual(transcription({ duration: 10, text: '', segments: [], language: 'und' }, chunk), { language: 'und', segments: [] });
});

test('a later transcription failure discards partial output but retains safe completed-seconds progress and cleanup', async t => {
  const dir = await localFixture(t), file = path.join(dir, 'fake.mp3'); await fs.writeFile(file, 'audio');
  let calls = 0, cleaned = false;
  const f = fixture({ kind: 'whisper', prepareAudio: fakeAudio(file, [{ offset: 0, duration: 10 }, { offset: 10, duration: 5 }], () => { cleaned = true; }), fetchImpl: async () => ++calls === 1 ? json({ duration: 10, language: 'en', segments: [{ start: 0, end: 2, text: 'private transcript' }] }) : json({ error: { message: 'PRIVATE KEY' } }, 503) });
  await assert.rejects(f.adapter.run({ task: 'transcribe', input: { filePath: file, language: 'auto' } }), e => e.code === 'MODEL_API_UNAVAILABLE' && e.processedSeconds === 10 && e.durationSeconds === 15 && !JSON.stringify(e).includes('private transcript'));
  assert.equal(cleaned, true);
});

test('cancelAll stops in-flight transcription and waits for the owned cleanup', async t => {
  const dir = await localFixture(t), file = path.join(dir, 'fake.mp3'); await fs.writeFile(file, 'audio');
  let entered; const pending = new Promise(resolve => { entered = resolve; }); let cleaned = false;
  const f = fixture({ kind: 'whisper', prepareAudio: fakeAudio(file, [{ offset: 0, duration: 10 }], () => { cleaned = true; }), fetchImpl: async (_url, args) => { entered(); return await new Promise((_r, reject) => args.signal.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true })); } });
  const work = f.adapter.run({ task: 'transcribe', input: { filePath: file } }); const observed = assert.rejects(work, { code: 'MODEL_CANCELLED' });
  await pending; await f.adapter.cancelAll(); await observed; assert.equal(cleaned, true); assert.equal(f.adapter.activeRuns.size, 0);
});

test('segment manifest rejects path traversal and non-contiguous audio', async t => {
  const dir = await localFixture(t);
  await fs.writeFile(path.join(dir, 'segments.csv'), '../outside.mp3,0,2\n'); await assert.rejects(readChunks(dir), { code: 'MODEL_PROCESSING_FAILED' });
  await fs.writeFile(path.join(dir, 'segments.csv'), 'part-00000.mp3,1,2\n'); await assert.rejects(readChunks(dir), { code: 'MODEL_PROCESSING_FAILED' });
});

test('FFmpeg cancellation kills only the owned child and removes its temporary directory', async t => {
  const dir = await localFixture(t), file = path.join(dir, 'source.mp3'); await fs.writeFile(file, 'synthetic');
  const controller = new AbortController(); let started, cwd, killed = false; const launched = new Promise(resolve => { started = resolve; });
  const operation = withCloudAudio(file, { resolveFfmpeg: () => process.execPath, signal: controller.signal, spawnImpl: (_exe, args, options) => {
    cwd = options.cwd; assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.ok(args.includes('file,pipe')); assert.ok(args.includes('1200'));
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { killed = true; setImmediate(() => child.emit('close', 1)); return true; }; started(); return child;
  } }, async () => { assert.fail('Cancelled extraction cannot upload'); });
  const observed = assert.rejects(operation, { code: 'MODEL_CANCELLED' }); await launched; controller.abort(); await observed;
  assert.equal(killed, true); assert.equal(fsSync.existsSync(cwd), false); assert.equal(await fs.readFile(file, 'utf8'), 'synthetic');
});

test('real bundled FFmpeg prepares audio, the adapter uploads only the generated MP3 and cleans on success', { skip: !fsSync.existsSync(ffmpeg), timeout: 30000 }, async t => {
  const dir = await localFixture(t), source = path.join(dir, 'synthetic.wav');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-c:a', 'pcm_s16le', source], { windowsHide: true, encoding: 'utf8' }); assert.equal(generated.status, 0);
  const before = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'); let prepared;
  const f = fixture({ kind: 'whisper', resolveFfmpeg: () => ffmpeg, prepareAudio: (file, options, use) => withCloudAudio(file, options, value => { prepared = value; return use(value); }), fetchImpl: async (_url, args) => { assert.equal(args.body.get('file').type, 'audio/mpeg'); assert.ok(args.body.get('file').size < UPLOAD_BYTES); return json({ duration: prepared.chunks[0].duration, language: 'english', text: 'synthetic', segments: [{ start: 0, end: 1, text: 'synthetic' }] }); } });
  const result = await f.adapter.run({ task: 'transcribe', input: { filePath: source, language: 'en' } });
  assert.equal(result.segments[0].text, 'synthetic'); assert.equal(fsSync.existsSync(path.dirname(prepared.chunks[0].filePath)), false);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'), before);
});

test('real FFmpeg divides a meeting beyond twenty minutes into bounded MP3 chunks with measured offsets', { skip: !fsSync.existsSync(ffmpeg), timeout: 60000 }, async t => {
  const dir = await localFixture(t), source = path.join(dir, 'long-synthetic.mp3');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1202', '-c:a', 'libmp3lame', '-b:a', '64k', source], { windowsHide: true, encoding: 'utf8' }); assert.equal(generated.status, 0);
  let temporary;
  await withCloudAudio(source, { resolveFfmpeg: () => ffmpeg }, async ({ chunks, duration }) => {
    temporary = path.dirname(chunks[0].filePath); assert.equal(chunks.length, 2); assert.equal(chunks[0].offset, 0);
    assert.ok(Math.abs(chunks[0].duration - SEGMENT_SECONDS) < 0.1); assert.equal(chunks[1].offset, chunks[0].duration); assert.ok(Math.abs(duration - 1202) < 0.2);
    for (const chunk of chunks) assert.ok(chunk.bytes > 0 && chunk.bytes < UPLOAD_BYTES);
  });
  assert.equal(fsSync.existsSync(temporary), false);
});

test('empty tool call lists remain text responses and malformed SSE UTF-8 is invalid output', async () => {
  const f = fixture({ fetchImpl: async () => completion('answer', 'stop', { tool_calls: [] }) });
  assert.equal((await f.adapter.run(chat())).text, 'answer');
  const bytes = Buffer.concat([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"'), Buffer.from([0xff]), Buffer.from('"},"finish_reason":null}]}\n\n')]);
  await assert.rejects(fixture({ fetchImpl: async () => new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } }) }).adapter.run({ ...chat(), onDelta() {} }), { code: 'MODEL_INVALID_OUTPUT' });
  await assert.rejects(fixture({ fetchImpl: async () => json({ choices: [{ index: 1, message: { content: 'wrong choice' }, finish_reason: 'stop' }] }) }).adapter.run(chat()), { code: 'MODEL_INVALID_OUTPUT' });
});

test('settings changes after an LLM request starts do not change its model attribution or prompt snapshot', async () => {
  const settings = configured(); let key = 'original-key', captured;
  const adapter = new CloudApiAdapter({ getSettings: () => settings, getApiKey: () => key, fetchImpl: async (url, args) => { captured = { url, args }; settings.api.endpoint = 'https://other.example/v1'; settings.api.model = 'new-model'; settings.preferredLanguage = 'ja'; key = 'new-key'; return completion('answer'); } });
  const result = await adapter.run(chat());
  assert.equal(result.meta.model, 'chosen-text'); assert.equal(captured.args.headers.Authorization, 'Bearer original-key'); assert.equal(JSON.parse(captured.args.body).model, 'chosen-text');
  const missing = fixture(); missing.settings.api.endpoint = ''; assert.equal(missing.adapter.isConfigured(), false); await assert.rejects(missing.adapter.run(chat()), { code: 'MODEL_NOT_CONFIGURED' });
});

test('SSE DONE commits a complete answer without waiting for the persistent connection to close', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(event(delta('complete answer', 'stop')) + event('[DONE]'))); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const f = fixture({ timeoutMs: 100, fetchImpl: async () => response });
  assert.equal((await f.adapter.run({ ...chat(), onDelta() {} })).text, 'complete answer'); assert.equal(cancelled, true);
  await assert.rejects(fixture({ fetchImpl: async () => sse([event(delta('answer', 'stop')), event('[DONE]'), event(delta('illegal trailing text'))]) }).adapter.run({ ...chat(), onDelta() {} }), { code: 'MODEL_INVALID_OUTPUT' });
});

test('compatible provider model identifiers may contain at signs or Unicode and preserve the configured name', async () => {
  for (const model of ['@cf/example/synthetic-model', 'model-模型', 'm'.repeat(250)]) {
    const f = fixture(); f.settings.api.model = model; assert.equal(f.adapter.isConfigured(), true);
    assert.equal((await f.adapter.run(chat())).meta.model, model); assert.equal(JSON.parse(f.requests[0].args.body).model, model);
  }
  for (const model of ['m'.repeat(251), 'bad\nmodel', null, 123]) { const f = fixture(); f.settings.api.model = model; assert.equal(f.adapter.isConfigured(), false); await assert.rejects(f.adapter.run(chat()), { code: 'MODEL_NOT_CONFIGURED' }); }
});

function syntheticAudioExtractor(record) {
  return (_executable, _args, options) => {
    record.directory = options.cwd;
    const child = new EventEmitter(); child.stdout = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('close', 1)); return true; };
    queueMicrotask(async () => {
      try {
        await fs.writeFile(path.join(options.cwd, 'part-00000.mp3'), 'synthetic-audio');
        await fs.writeFile(path.join(options.cwd, 'segments.csv'), 'part-00000.mp3,0,2\n');
        child.emit('close', 0);
      } catch { child.emit('error', new Error('Synthetic extraction failed')); }
    });
    return child;
  };
}

test('failed owned audio cleanup blocks exit and is retried on the next cancellation after the lock clears', async t => {
  const directory = await localFixture(t), source = path.join(directory, 'source.mp3'); await fs.writeFile(source, 'source audio');
  const record = {}, diagnostics = []; let locked = true;
  const originalRm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === record.directory && locked) throw Object.assign(new Error('PRIVATE locked file'), { code: 'EPERM' });
    return originalRm(target, options);
  });
  t.after(async () => { locked = false; await retryCloudAudioCleanup(); });
  const f = fixture({ kind: 'whisper', resolveFfmpeg: () => process.execPath,
    prepareAudio: (file, options, use) => withCloudAudio(file, { ...options, spawnImpl: syntheticAudioExtractor(record) }, use),
    onDiagnostic: value => diagnostics.push(value), fetchImpl: async () => json({ duration: 2, language: 'en', segments: [] }) });
  await assert.rejects(f.adapter.run({ task: 'transcribe', input: { filePath: source } }), { code: 'MODEL_TEMP_CLEANUP_FAILED' });
  assert.equal(f.adapter.activeRuns.size, 0); assert.equal(fsSync.existsSync(record.directory), true);
  await assert.rejects(f.adapter.cancelAll(), { code: 'MODEL_TEMP_CLEANUP_FAILED' });
  assert.equal(fsSync.existsSync(record.directory), true);
  locked = false;
  await f.adapter.cancelAll(); assert.equal(fsSync.existsSync(record.directory), false);
  await f.adapter.cancelAll();
  assert.ok(diagnostics.some(entry => entry.event === 'cloud.cleanup.failed' && entry.code === 'MODEL_TEMP_CLEANUP_FAILED'));
  assert.equal(JSON.stringify(diagnostics).includes(record.directory), false); assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
  assert.equal(await fs.readFile(source, 'utf8'), 'source audio');
});

test('cancelAll preserves cleanup errors from a custom preparer even when a cancelled core ignores the run rejection', async t => {
  const directory = await localFixture(t), source = path.join(directory, 'source.mp3'); await fs.writeFile(source, 'source audio');
  let entered; const started = new Promise(resolve => { entered = resolve; }); const diagnostics = [];
  const f = fixture({ kind: 'whisper', onDiagnostic: value => { diagnostics.push(value); return Promise.reject(new Error('Observer failure must be isolated')); },
    prepareAudio: async (_source, { signal }) => {
      entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('PRIVATE temporary path and key'), { code: 'MODEL_TEMP_CLEANUP_FAILED' });
    } });
  const running = f.adapter.run({ task: 'transcribe', input: { filePath: source } });
  const observed = assert.rejects(running, error => error.code === 'MODEL_TEMP_CLEANUP_FAILED' && !String(error).includes('PRIVATE'));
  await started;
  await assert.rejects(f.adapter.cancelAll(), { code: 'MODEL_TEMP_CLEANUP_FAILED' }); await observed;
  assert.equal(f.adapter.activeRuns.size, 0);
  await assert.rejects(f.adapter.cancelAll(), { code: 'MODEL_TEMP_CLEANUP_FAILED' });
  assert.ok(diagnostics.length >= 1); assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
  assert.equal(f.requests.length, 0);
});

test('audio cleanup retries are serialized and remove only a remembered failed directory', async t => {
  const directory = await localFixture(t), source = path.join(directory, 'source.mp3'); await fs.writeFile(source, 'source audio');
  const record = {}; let mode = 'locked', retryCalls = 0, concurrent = 0, maximum = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const originalRm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target !== record.directory) return originalRm(target, options);
    if (mode === 'locked') throw Object.assign(new Error('Synthetic lock'), { code: 'EPERM' });
    if (mode === 'retry') {
      retryCalls++; concurrent++; maximum = Math.max(maximum, concurrent); enter();
      try { await gate; return await originalRm(target, options); } finally { concurrent--; }
    }
    return originalRm(target, options);
  });
  t.after(async () => { mode = 'normal'; release(); await retryCloudAudioCleanup(); });
  await assert.rejects(withCloudAudio(source, { resolveFfmpeg: () => process.execPath, spawnImpl: syntheticAudioExtractor(record) }, async () => ({})), { code: 'MODEL_TEMP_CLEANUP_FAILED' });
  const untouched = path.join(directory, 'ufriend-cloud-UNRELATED'); await fs.mkdir(untouched); await fs.writeFile(path.join(untouched, 'keep.txt'), 'unrelated data');
  mode = 'retry';
  const first = retryCloudAudioCleanup(), second = retryCloudAudioCleanup();
  await entered; assert.equal(retryCalls, 1); release();
  const results = await Promise.all([first, second]);
  assert.equal(maximum, 1); assert.equal(retryCalls, 1); assert.equal(results[0].cleaned, 1); assert.equal(results[1].cleaned, 0);
  assert.equal(fsSync.existsSync(record.directory), false); assert.equal(await fs.readFile(path.join(untouched, 'keep.txt'), 'utf8'), 'unrelated data');
});

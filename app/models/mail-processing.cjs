'use strict';

// Bounded, extractive fallback shared by local and cloud transports. Every
// intermediate result is an ID into the original source, never a new summary.
const PRIVATE_MAIL_TASKS = new Set(['mail-select', 'mail-compose']);
const {criticalSourceText,sourceFacts}=require('../services/mail-quality.cjs');
const LIMITS = Object.freeze({ chunkCharacters: 2200, chunkLines: 40, finalCharacters: 24000, finalLines: 64, maxChunks: 128, maxCalls: 192, maxPasses: 6, timeoutMs: 10 * 60 * 1000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message || ({ MODEL_INVALID_REQUEST: '郵件分段資料格式不正確，原始內容已保留。', MODEL_INVALID_OUTPUT: '郵件分段結果或原文引用無效，未保存不完整摘要。', MODEL_INPUT_TOO_LONG: '這封郵件超過分段處理的容量，原始內容已保留。', MODEL_OUTPUT_LIMIT: '模型仍未能完成精簡摘要，原始內容已保留。', MODEL_API_TIMEOUT: '郵件分段處理逾時，未保存不完整摘要。' }[code] || '郵件處理未完成。')), { code });
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const string = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || !!value.trim());
function validateProcessingInput(input) {
  if (!exactKeys(input, ['mail', 'referenceTime', 'recipient', 'lines']) || !exactKeys(input.mail, ['id', 'subject', 'date', 'sender', 'to', 'cc'])) throw fail('MODEL_INVALID_REQUEST');
  const mail = input.mail;
  if (!string(mail.id, 300) || !string(mail.subject, 4000, true) || !string(mail.date, 100, true) || !string(mail.sender, 1000, true)
    || !string(input.referenceTime, 100) || !Number.isFinite(Date.parse(input.referenceTime)) || !string(input.recipient, 300, true)) throw fail('MODEL_INVALID_REQUEST');
  if (input.recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient)) throw fail('MODEL_INVALID_REQUEST');
  for (const field of ['to', 'cc']) if (!Array.isArray(mail[field]) || mail[field].length > 100 || mail[field].some(item => !string(item, 300) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))) throw fail('MODEL_INVALID_REQUEST');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 64) throw fail('MODEL_INVALID_REQUEST');
  const ids = new Set(); let characters = 0;
  for (const line of input.lines) {
    if (!Array.isArray(line) || line.length !== 2 || !Number.isSafeInteger(line[0]) || line[0] < 0 || line[0] > 200000 || ids.has(line[0]) || !string(line[1], 1000)) throw fail('MODEL_INVALID_REQUEST');
    ids.add(line[0]); characters += line[1].length;
  }
  if (characters > 24000) throw fail('MODEL_INVALID_REQUEST');
  return structuredClone(input);
}
function validateProcessingOutput(task, value, input) {
  const allowed = task === 'mail-select' ? ['apiVersion', 'evidenceIds', 'meta'] : ['apiVersion', 'summary', 'reason', 'priority', 'evidenceIds', 'meta'];
  if (!PRIVATE_MAIL_TASKS.has(task) || !exactKeys(value, allowed) || value.apiVersion !== undefined && value.apiVersion !== '1') throw fail('MODEL_INVALID_OUTPUT');
  const available = new Set(input.lines.map(line => line[0]));
  const selection=task==='mail-select';
  if (!Array.isArray(value.evidenceIds) || !selection&&!value.evidenceIds.length || value.evidenceIds.length > (selection?64:8) || new Set(value.evidenceIds).size !== value.evidenceIds.length || value.evidenceIds.some(id => !Number.isSafeInteger(id) || !available.has(id))) throw fail('MODEL_INVALID_OUTPUT');
  if (task === 'mail-compose') {
    if (!string(value.summary, 2000) || !string(value.reason, 2000) || ![0, 1, 2].includes(value.priority) || !Number.isInteger(value.priority)) throw fail('MODEL_INVALID_OUTPUT');
    if (value.summary.length >= 1000 || value.reason.length >= 160 || repeatedSummary(value.summary)) throw fail('MODEL_OUTPUT_LIMIT');
  }
  return { ...value, evidenceIds: [...new Set(value.evidenceIds)] };
}
function repeatedSummary(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (normalized.length < 96) return false;
  const windows = new Map();
  for (let i = 0; i <= normalized.length - 32; i++) {
    const fragment = normalized.slice(i, i + 32), seen = windows.get(fragment);
    if (!seen) windows.set(fragment, { last: i, count: 1 });
    else if (i - seen.last >= 32) { seen.last = i; if (++seen.count >= 3) return true; }
  }
  return false;
}
function sourceLines(mail) {
  const lines = [];
  for (const field of ['subject', 'body']) {
    // Keep wrapped paragraphs and adjacent table cells together. Splitting each
    // physical line can separate a date, negation, or amount from its subject.
    // A quote never bridges a removed URL: this keeps each chosen excerpt
    // contiguous when the desktop later verifies it against the original mail.
    for (const part of mail[field].split(/【網址】|\r?\n[\t \u00a0\r]*\n/)) {
      const text = part.trim();
      // Empty link/image placeholders and decorative separators carry no prose.
      // No original mail is modified; every retained span is still literal.
      if (!/[\p{L}\p{N}]/u.test(text.replaceAll('【網址】', ''))) continue;
      const characters = Array.from(text);
      for (let start = 0; start < characters.length; start += 240) {
        const span = characters.slice(start, start + 240).join('').trim();
        if (span) lines.push([lines.length, span]);
      }
    }
  }
  return lines;
}
function packs(lines, characters, count) {
  const result = []; let pack = [], size = 0;
  for (const line of lines) {
    if (pack.length && (pack.length >= count || size + line[1].length > characters)) { result.push(pack); pack = []; size = 0; }
    pack.push(line); size += line[1].length;
  }
  if (pack.length) result.push(pack);
  return result;
}
const sizeOf = lines => lines.reduce((size, line) => size + line[1].length, 0);
function abortCheck(signal) { if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError'); }

function capacityFallback(mail, code, completed) {
  const facts=sourceFacts(mail).facts.map(item=>item.text),kept=[];let length=0;
  for(const quote of facts){if(length+quote.length+2>1900)continue;kept.push(quote);length+=quote.length+2;}
  if(!kept.length)throw fail(code);
  // A visibly degraded result, not a completed model summary. Core reconstructs
  // its source excerpts and withholds the model grade before saving it.
  return{apiVersion:'1',analyses:[{id:mail.id,summary:kept.join('\n\n'),reason:'模型容量不足，請核對原文摘錄。',priority:2,evidence:kept.slice(0,8)}],
    meta:{processingMode:'source-excerpts',processingFailure:code,chunkCount:completed}};
}

async function runMailPipeline({ input, run, signal, onProgress, limits = LIMITS }) {
  // Each adapter supplies a transport bound to one settings/credential snapshot.
  // The original call retains its established protocol and model diagnostics.
  abortCheck(signal);
  let trigger;
  try {
    const result = await run('mail', structuredClone(input), signal);
    abortCheck(signal);
    if (!result?.analyses?.some(item => repeatedSummary(item.summary))) return result;
    trigger = 'repeated';
  } catch (error) {
    abortCheck(signal);
    if (!['MODEL_INPUT_TOO_LONG', 'MODEL_OUTPUT_LIMIT'].includes(error?.code)) throw error;
    trigger = error.code;
  }
  const mail = input?.messages?.[0];
  if (!mail || typeof mail.body !== 'string' || mail.body.length > 200000 || typeof mail.subject !== 'string') throw fail('MODEL_INPUT_TOO_LONG');
  const metadata = { id: mail.id, subject: mail.subject, date: mail.date, sender: mail.sender, to: mail.to || [], cc: mail.cc || [] };
  const originals = sourceLines(mail), source = new Map(originals);
  if (!originals.length) throw fail('MODEL_INVALID_OUTPUT');
  // Model selection is advisory. Literal dates, amounts, state changes and
  // conditional actions cannot disappear merely because a small model chose
  // the first IDs (or marked every row false). Keep adjacent table/context
  // rows as well; no generated text becomes a source fact.
  const protectedIds=new Set([originals[0][0]]);
  for(let i=0;i<originals.length;i++)if(criticalSourceText(originals[i][1])){
    protectedIds.add(originals[i][0]);
    if(i>0)protectedIds.add(originals[i-1][0]);
    if(i+1<originals.length)protectedIds.add(originals[i+1][0]);
  }
  const pending = packs(originals, limits.chunkCharacters, limits.chunkLines);
  if (pending.length > limits.maxChunks) throw fail('MODEL_INPUT_TOO_LONG');
  let chunkTotal = pending.length, completed = 0, calls = 0;
  const controller = new AbortController(), cancel = () => controller.abort(signal.reason || new DOMException('Cancelled', 'AbortError'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(fail('MODEL_API_TIMEOUT')), limits.timeoutMs); timer.unref?.();
  const emit = stage => { abortCheck(controller.signal); try { onProgress?.(undefined, { stage, chunkIndex: completed, chunkTotal }); } catch {} };
  const payload = lines => validateProcessingInput({ mail: metadata, referenceTime: input.referenceTime, recipient: input.recipient || '', lines });
  const request = async (task, lines) => {
    abortCheck(controller.signal);
    if (++calls > limits.maxCalls) throw fail('MODEL_INPUT_TOO_LONG', '這封郵件需要過多分段處理，未保存不完整摘要。');
    const data = payload(lines), value = await run(task, data, controller.signal);
    abortCheck(controller.signal);
    return validateProcessingOutput(task, value, data);
  };
  const select = async (lines, extraction) => {
    try {
      const value = await request('mail-select', lines);
      const chosen=new Set(value.evidenceIds);
      return lines.filter(([id])=>chosen.has(id)||protectedIds.has(id));
    } catch (error) {
      abortCheck(controller.signal);
      if (!['MODEL_INPUT_TOO_LONG', 'MODEL_OUTPUT_LIMIT'].includes(error?.code) || lines.length < 2) throw error;
      if (extraction && ++chunkTotal > limits.maxChunks) throw fail('MODEL_INPUT_TOO_LONG');
      const middle = Math.ceil(lines.length / 2), first = await select(lines.slice(0, middle), extraction);
      if (extraction) { completed++; emit('mail-chunks'); }
      return first.concat(await select(lines.slice(middle), extraction));
    }
  };
  try {
    emit('mail-chunks');
    let selected = [];
    for (const pack of pending) {
      selected.push(...await select(pack, true)); completed++; emit('mail-chunks');
    }
    const ordered = lines => [...new Map(lines)].sort((a, b) => a[0] - b[0]);
    selected = ordered(selected); emit('mail-merge');
    let forceReduction = false;
    for (let pass = 0; pass <= limits.maxPasses; pass++) {
      abortCheck(controller.signal);
      if (!forceReduction && selected.length <= limits.finalLines && sizeOf(selected) <= limits.finalCharacters) {
        try {
          const value = await request('mail-compose', selected);
          return { apiVersion: '1', analyses: [{ id: mail.id, summary: value.summary, reason: value.reason, priority: value.priority, evidence: value.evidenceIds.map(id => source.get(id)) }],
            meta: { ...value.meta, processingMode: 'segmented', chunkCount: completed } };
        } catch (error) {
          abortCheck(controller.signal);
          // A generation limit is not evidence that source material is too long.
          // Dropping more facts in that case can erase a cancellation or date.
          if (error?.code !== 'MODEL_INPUT_TOO_LONG') throw error;
          forceReduction = true;
        }
      }
      if (pass === limits.maxPasses) break;
      const reduced = [];
      for (const group of packs(selected, 5000, 64)) reduced.push(...await select(group, false));
      const next = ordered(reduced);
      // A model that keeps every candidate cannot silently turn an incomplete
      // merge into success or keep consuming inference indefinitely.
      if (next.length >= selected.length) throw fail(trigger === 'MODEL_INPUT_TOO_LONG' ? 'MODEL_INPUT_TOO_LONG' : 'MODEL_OUTPUT_LIMIT', '模型無法將這封郵件彙整到可處理的範圍，原始內容已保留。');
      selected = next; forceReduction = false; emit('mail-merge');
    }
    throw fail('MODEL_INPUT_TOO_LONG');
  } catch(error) {
    abortCheck(controller.signal);
    if(!['MODEL_INPUT_TOO_LONG','MODEL_OUTPUT_LIMIT'].includes(error?.code))throw error;
    return capacityFallback(mail,error.code,completed);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

module.exports = { PRIVATE_MAIL_TASKS, LIMITS, validateProcessingInput, validateProcessingOutput, repeatedSummary, sourceLines, runMailPipeline };

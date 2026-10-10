'use strict';

// Only creates and removes this request's own temporary directory. Source media
// stays read-only. FFmpeg must be resolved by the application, never from PATH.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const SEGMENT_SECONDS = 20 * 60;
const UPLOAD_BYTES = 25 * 1000 * 1000;
const MAX_SECONDS = 12 * 60 * 60;
const pendingCleanup = new Map();
const activeDirectories = new Set();
let cleanupRetry = Promise.resolve();
const messages = {
  MODEL_CANCELLED: '雲端模型工作已取消。',
  MODEL_INPUT_TOO_LONG: '影音超過雲端轉錄的本機處理上限，請分割原始檔案後重試。',
  MODEL_PROCESSING_FAILED: '無法準備轉錄音訊，請確認檔案含有可解碼的聲音且暫存磁碟空間足夠。',
  MODEL_CLOUD_FFMPEG_MISSING: '雲端影音轉錄需要 UFriend 隨附的 FFmpeg，請完成影音工具安裝後重試。',
  MODEL_API_TIMEOUT: '雲端模型處理逾時，原始內容已保留。',
  MODEL_TEMP_CLEANUP_FAILED: '雲端轉錄暫存檔案尚未清理完成，請關閉占用檔案的程式後重試。',
};
function fail(code) { const e = Object.assign(new Error(messages[code] || messages.MODEL_PROCESSING_FAILED), { code }); if (code === 'MODEL_CANCELLED') e.name = 'AbortError'; return e; }
function active(signal) { if (signal?.aborted) throw fail('MODEL_CANCELLED'); }
function same(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

async function runFfmpeg(executable, source, directory, { signal, onProgress, timeoutMs = 30 * 60 * 1000, spawnImpl = spawn } = {}) {
  active(signal);
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'aac,asf,avi,flac,matroska,webm,mov,mp3,ogg,wav', '-i', source,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS),
    '-segment_list', 'segments.csv', '-segment_list_type', 'csv', '-reset_timestamps', '1',
    '-progress', 'pipe:1', '-nostats', 'part-%05d.mp3'];
  await new Promise((resolve, reject) => {
    let child, completed = false, reason, pending = '', seconds = 0;
    const kill = error => { reason ||= error; try { child?.kill(); } catch {} };
    const abort = () => kill(fail('MODEL_CANCELLED'));
    const timer = setTimeout(() => kill(fail('MODEL_API_TIMEOUT')), timeoutMs);
    const finish = error => {
      if (completed) return; completed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    try { child = spawnImpl(executable, args, { cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { finish(fail('MODEL_PROCESSING_FAILED')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => finish(reason || fail('MODEL_PROCESSING_FAILED')));
    child.on('close', code => finish(reason || (code === 0 ? null : fail('MODEL_PROCESSING_FAILED'))));
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 65536) { kill(fail('MODEL_PROCESSING_FAILED')); return; }
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) seconds = Math.max(seconds, Number(match[1]) / 1e6);
        if (seconds > MAX_SECONDS) { kill(fail('MODEL_INPUT_TOO_LONG')); return; }
        if (line.startsWith('progress=')) { try { onProgress?.(1, { stage: 'preparing', processedSeconds: 0 }); } catch { kill(fail('MODEL_PROCESSING_FAILED')); } }
      }
    });
  });
  active(signal);
}

async function readChunks(directory, { signal } = {}) {
  const manifestPath = path.join(directory, 'segments.csv');
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw fail('MODEL_PROCESSING_FAILED');
  const lines = (await fs.readFile(manifestPath, 'utf8')).trim().split(/\r?\n/);
  if (!lines.length || lines.length > Math.ceil(MAX_SECONDS / SEGMENT_SECONDS)) throw fail('MODEL_INPUT_TOO_LONG');
  let previous = 0;
  const chunks = [];
  for (const [index, line] of lines.entries()) {
    active(signal);
    const match = /^(part-\d{5}\.mp3),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(line);
    if (!match || match[1] !== `part-${String(index).padStart(5, '0')}.mp3`) throw fail('MODEL_PROCESSING_FAILED');
    const start = Number(match[2]), end = Number(match[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || Math.abs(start - previous) > 0.1 || end <= start
      || end - start > SEGMENT_SECONDS + 1 || end > MAX_SECONDS + 1) throw fail('MODEL_PROCESSING_FAILED');
    const filePath = path.join(directory, match[1]), stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size >= UPLOAD_BYTES) throw fail('MODEL_INPUT_TOO_LONG');
    if (!same(await fs.realpath(filePath), filePath)) throw fail('MODEL_PROCESSING_FAILED');
    // The segment muxer cuts at audio packet boundaries. Use its measured start
    // instead of index * 1200, which would accumulate timestamp drift.
    chunks.push({ filePath, offset: start, duration: end - start, bytes: stat.size });
    previous = end;
  }
  return { chunks, duration: previous };
}

async function cleanup(directory, parent) {
  if (!path.isAbsolute(directory) || !same(path.dirname(directory), parent) || !/^ufriend-cloud-[a-zA-Z0-9]+$/.test(path.basename(directory))) throw fail('MODEL_TEMP_CLEANUP_FAILED');
  let resolved;
  try { resolved = await fs.realpath(directory); }
  catch (error) {
    if (error.code === 'ENOENT') {
      // A previously failed directory may already have been removed. A dangling
      // symlink is still present, so it must not be mistaken for successful cleanup.
      try { await fs.lstat(directory); } catch (missing) { if (missing.code === 'ENOENT') return; }
    }
    throw fail('MODEL_TEMP_CLEANUP_FAILED');
  }
  if (!same(resolved, directory) || !same(path.dirname(resolved), parent)) throw fail('MODEL_TEMP_CLEANUP_FAILED');
  // rm does not follow child symlinks; the containing directory is verified.
  await fs.rm(resolved, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

function retryCloudAudioCleanup() {
  const attempt = cleanupRetry.then(async () => {
    let cleaned = 0;
    for (const [directory, parent] of [...pendingCleanup]) {
      if (activeDirectories.has(directory)) continue;
      try { await cleanup(directory, parent); pendingCleanup.delete(directory); cleaned++; } catch {}
    }
    if (pendingCleanup.size) throw fail('MODEL_TEMP_CLEANUP_FAILED');
    return { cleaned, pending: 0 };
  });
  // Retain a fulfilled queue tail so a failed exit can retry on the next attempt.
  cleanupRetry = attempt.catch(() => {});
  return attempt;
}

async function withCloudAudio(source, { resolveFfmpeg, signal, onProgress, spawnImpl, timeoutMs } = {}, use) {
  active(signal);
  let executable;
  try {
    executable = await resolveFfmpeg?.();
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || /^[\\/]{2}/.test(executable)) throw new Error();
    const stat = await fs.stat(executable); if (!stat.isFile()) throw new Error();
  } catch { throw fail('MODEL_CLOUD_FFMPEG_MISSING'); }
  const parent = await fs.realpath(os.tmpdir());
  active(signal);
  const directory = await fs.mkdtemp(path.join(parent, 'ufriend-cloud-'));
  activeDirectories.add(directory);
  let result, primary;
  try {
    if (!same(await fs.realpath(directory), directory) || !same(path.dirname(directory), parent)) throw fail('MODEL_PROCESSING_FAILED');
    await runFfmpeg(executable, source, directory, { signal, onProgress, spawnImpl, timeoutMs });
    const prepared = await readChunks(directory, { signal });
    active(signal);
    result = await use(prepared);
  } catch (error) { primary = error; }
  finally {
    try { await cleanup(directory, parent); pendingCleanup.delete(directory); }
    catch {
      pendingCleanup.set(directory, parent);
      primary = fail('MODEL_TEMP_CLEANUP_FAILED');
      primary.cloudAudioCleanup = true;
    } finally { activeDirectories.delete(directory); }
  }
  if (primary) throw primary;
  return result;
}

module.exports = { withCloudAudio, retryCloudAudioCleanup, readChunks, SEGMENT_SECONDS, UPLOAD_BYTES };

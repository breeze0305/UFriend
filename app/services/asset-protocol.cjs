'use strict';

const {open} = require('node:fs/promises');
const {Readable} = require('node:stream');

function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  // Unsupported or malformed ranges may be ignored and served in full.
  if (!match || (!match[1] && !match[2])) return null;
  const length = BigInt(size);
  if (!length) return {unsatisfiable:true};
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    return suffix ? {start:Number(suffix >= length ? 0n : length - suffix), end:size - 1} : {unsatisfiable:true};
  }
  const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) return {unsatisfiable:true};
  return {start:Number(start), end:Number(end >= length ? length - 1n : end)};
}

async function assetResponse(request, getAsset) {
  let file, stream;
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'ufriend-asset:' || url.hostname !== 'file') return new Response(null, {status:404});
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status:405, headers:{Allow:'GET, HEAD'}});
    // The application resolves registered IDs to managed files; URL paths are never filenames.
    const asset = getAsset(url.pathname.slice(1));
    file = await open(asset.path, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return new Response(null, {status:404});
    const headers = new Headers({
      'Content-Type':asset.mimeType || 'application/octet-stream',
      'Content-Length':String(stat.size),
      'Accept-Ranges':'bytes',
    });
    const range = request.method === 'GET' ? byteRange(request.headers.get('range'), stat.size) : null;
    if (range?.unsatisfiable) {
      headers.set('Content-Range', `bytes */${stat.size}`);
      headers.set('Content-Length', '0');
      return new Response(null, {status:416, headers});
    }
    const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
    if (range) {
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      headers.set('Content-Length', String(end - start + 1));
    }
    const options = {status:range ? 206 : 200, headers};
    if (request.method === 'HEAD' || !stat.size) return new Response(null, options);
    // file:// fetch returns ranged bytes with status 200 and no range/length headers.
    // Serve a bounded stream with explicit metadata so Chromium can seek local media.
    stream = file.createReadStream({start, end, signal:request.signal});
    return new Response(Readable.toWeb(stream, {
      strategy:{highWaterMark:64 * 1024, size:chunk => chunk.byteLength},
    }), options);
  } catch {
    stream?.destroy();
    return new Response(null, {status:404});
  } finally {
    // ReadStream owns the handle from creation, including end/error/body cancellation.
    if (!stream) await file?.close();
  }
}

module.exports = {assetResponse};

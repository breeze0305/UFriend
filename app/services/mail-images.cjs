'use strict';

const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const {isIP} = require('node:net');

const MAX_BYTES = 8 * 1024 * 1024;
const ERROR_MESSAGES = {
  URL:'Invalid mail image URL.', BLOCKED:'Mail image destination is not public.',
  FORMAT:'Unsupported mail image format.', TOO_LARGE:'Mail image exceeds the size limit.',
  TIMEOUT:'Mail image request timed out.', ABORTED:'Mail image request cancelled.',
  HTTP:'Mail image server returned an invalid response.', NETWORK:'Mail image request failed.',
};
const MIME_ALIASES = new Map([
  ['image/png', 'image/png'], ['image/x-png', 'image/png'],
  ['image/jpeg', 'image/jpeg'], ['image/jpg', 'image/jpeg'], ['image/pjpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'], ['image/webp', 'image/webp'],
  ['image/bmp', 'image/bmp'], ['image/x-ms-bmp', 'image/bmp'],
  ['image/x-icon', 'image/x-icon'], ['image/vnd.microsoft.icon', 'image/x-icon'],
]);

function imageError(kind) {
  return Object.assign(new Error(ERROR_MESSAGES[kind]), {code:`MAIL_IMAGE_${kind}`});
}

function declaredMime(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw imageError('FORMAT');
  const declared = value.split(';', 1)[0].trim().toLowerCase();
  if (['application/octet-stream', 'binary/octet-stream'].includes(declared)) return null;
  const mime = MIME_ALIASES.get(declared);
  if (!mime) throw imageError('FORMAT');
  return mime;
}

function sniffMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[3] !== 0 && bytes[3] !== 0xff) return 'image/jpeg';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0) return 'image/x-icon';
  throw imageError('FORMAT');
}

// Shared by downloaded images and decoded CID/data: attachments. SVG is never accepted.
function imageDataUrl(buffer, mimeType) {
  if (!(buffer instanceof Uint8Array)) throw imageError('FORMAT');
  if (buffer.byteLength > MAX_BYTES) throw imageError('TOO_LARGE');
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const expected = declaredMime(mimeType), detected = sniffMime(bytes);
  if (expected && expected !== detected) throw imageError('FORMAT');
  return {dataUrl:`data:${detected};base64,${bytes.toString('base64')}`, mimeType:detected, bytes:bytes.length};
}

function publicIpv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113));
}

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6 || address.includes('%')) return false;
  let normalized = address.toLowerCase();
  // Expand dotted IPv4 tails before checking mapped addresses and IPv6 prefixes.
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const parts = normalized.slice(lastColon + 1).split('.').map(Number);
    normalized = `${normalized.slice(0, lastColon)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(value => parseInt(value, 16));
  if (words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff) {
    return publicIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Only global unicast; exclude special-purpose, documentation and 6to4 ranges.
  // This also blocks loopback, ULA, link-local, multicast and NAT64 embeddings.
  return words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) &&
    words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1] <= 0x0fff);
}

function imageUrl(source, base) {
  let url;
  try {
    if (typeof source !== 'string' || source.length > 16384) throw imageError('URL');
    url = new URL(source, base);
  } catch { throw imageError('URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw imageError('URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/.test(hostname) ||
      (isIP(hostname) && !publicAddress(hostname))) throw imageError('BLOCKED');
  url.hash = '';
  return {url, hostname};
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, {once:true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function nativeRequest(url, options, callback) {
  return (url.protocol === 'https:' ? https : http).request(url, options, callback);
}

// Injection keeps unit tests entirely offline; production uses only Node's direct HTTP client.
function createMailImageLoader({lookup = dns.lookup, request = nativeRequest, timeoutMs = 12000} = {}) {
  async function loadRemoteImage(source, {signal:externalSignal} = {}) {
    if (externalSignal?.aborted) throw imageError('ABORTED');
    const controller = new AbortController(), signal = controller.signal;
    const onAbort = () => controller.abort(imageError('ABORTED'));
    externalSignal?.addEventListener('abort', onAbort, {once:true});
    const timer = setTimeout(() => controller.abort(imageError('TIMEOUT')), timeoutMs);
    try {
      let target = imageUrl(source);
      for (let redirects = 0; ; redirects += 1) {
        if (signal.aborted) throw signal.reason;
        const {url, hostname} = target;
        const addresses = isIP(hostname) ? [{address:hostname, family:isIP(hostname)}] :
          await abortable(Promise.resolve().then(() => lookup(hostname, {all:true, verbatim:true})), signal);
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry =>
          !entry || !publicAddress(entry.address) || isIP(entry.address) !== entry.family)) throw imageError('BLOCKED');
        if (signal.aborted) throw signal.reason;
        // The socket receives only this checked DNS snapshot, never a second DNS lookup.
        const pinnedLookup = (name, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          if (name.replace(/\.$/, '').toLowerCase() !== hostname) return callback(imageError('BLOCKED'));
          if (signal.aborted) return callback(signal.reason);
          const candidates = options?.family ? addresses.filter(entry => entry.family === options.family) : addresses;
          if (!candidates.length) return callback(imageError('NETWORK'));
          if (options?.all) callback(null, candidates.map(entry => ({...entry})));
          else callback(null, candidates[0].address, candidates[0].family);
        };
        const result = await new Promise((resolve, reject) => {
          let outgoing, incoming, settled = false, ended = false, size = 0;
          const chunks = [];
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', cancel);
            if (error) { incoming?.destroy(); outgoing?.destroy(); reject(error); }
            else resolve(value);
          };
          const cancel = () => finish(signal.reason);
          signal.addEventListener('abort', cancel, {once:true});
          if (signal.aborted) return cancel();
          try {
            outgoing = request(url, {
              method:'GET', agent:false, proxyEnv:{}, lookup:pinnedLookup, autoSelectFamily:true,
              maxHeaderSize:16 * 1024,
              headers:{Accept:'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/x-icon', 'Accept-Encoding':'identity'},
            }, response => {
              incoming = response;
              if (settled) { response.destroy(); return; }
              response.on('error', () => finish(imageError('NETWORK')));
              response.on('aborted', () => finish(imageError('NETWORK')));
              response.on('close', () => { if (!ended) finish(imageError('NETWORK')); });
              const status = response.statusCode;
              if ([301, 302, 303, 307, 308].includes(status)) {
                const location = response.headers.location;
                if (typeof location !== 'string' || redirects >= 4) { finish(imageError('HTTP')); return; }
                finish(null, {location});
                response.destroy();
                return;
              }
              if (status !== 200) { finish(imageError('HTTP')); return; }
              let mime;
              try {
                mime = declaredMime(response.headers['content-type']);
                if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') throw imageError('FORMAT');
                const length = response.headers['content-length'];
                if (length != null && !/^\d+$/.test(String(length))) throw imageError('HTTP');
                if (length != null && BigInt(length) > BigInt(MAX_BYTES)) throw imageError('TOO_LARGE');
              } catch (error) { finish(error); return; }
              response.on('data', chunk => {
                if (settled) return;
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.length;
                if (size > MAX_BYTES) { finish(imageError('TOO_LARGE')); return; }
                chunks.push(bytes);
              });
              response.on('end', () => {
                ended = true;
                if (settled) return;
                try { finish(null, imageDataUrl(Buffer.concat(chunks, size), mime)); }
                catch (error) { finish(error); }
              });
            });
            outgoing.on('error', () => finish(imageError('NETWORK')));
            outgoing.on('upgrade', (_response, socket) => { socket.destroy(); finish(imageError('HTTP')); });
            outgoing.end();
          } catch { finish(imageError('NETWORK')); }
        });
        if (!Object.hasOwn(result, 'location')) return result;
        target = imageUrl(result.location, url);
      }
    } catch (error) {
      // Request/DNS errors may contain recipient-specific URLs. Expose only fixed messages.
      const kind = String(error?.code || '').replace(/^MAIL_IMAGE_/, '');
      throw imageError(Object.hasOwn(ERROR_MESSAGES, kind) ? kind : 'NETWORK');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }
  return {loadRemoteImage};
}

module.exports = {loadRemoteImage:createMailImageLoader().loadRemoteImage, imageDataUrl, createMailImageLoader};

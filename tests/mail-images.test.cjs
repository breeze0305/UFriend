'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {imageDataUrl, createMailImageLoader} = require('../app/services/mail-images.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mS8AAAAASUVORK5CYII=', 'base64');
const PUBLIC = [{address:'93.184.215.14', family:4}];
const MAX_BYTES = 8 * 1024 * 1024;
const errorCode = code => error => {
  assert.equal(error.code, `MAIL_IMAGE_${code}`);
  assert.doesNotMatch(error.message, /recipient|secret|example|127\.0\.0\.1/);
  return true;
};

// Fake streams exercise the real loader and its socket lookup contract, without any network.
function fixture(plans = [{}], options = {}) {
  const calls = [], resolutions = [], sockets = [];
  const lookup = options.lookup || (async hostname => {
    resolutions.push(hostname);
    return PUBLIC;
  });
  const request = (url, settings, callback) => {
    const plan = plans[Math.min(calls.length, plans.length - 1)];
    const req = new EventEmitter();
    const res = new PassThrough();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; res.destroy(); return req; };
    req.end = () => queueMicrotask(() => {
      if (req.destroyed) return;
      settings.lookup(url.hostname.replace(/^\[|\]$/g, ''), {all:true}, (error, addresses) => {
        if (error) { req.emit('error', error); return; }
        sockets.push(addresses);
        if (plan.error) { req.emit('error', new Error('failed https://recipient.example/secret')); return; }
        if (plan.noResponse) return;
        res.statusCode = plan.status ?? 200;
        res.headers = plan.headers ?? {'content-type':'image/png'};
        callback(res);
        plan.onResponse?.(res, req);
        if (res.destroyed || plan.holdOpen) return;
        for (const chunk of plan.chunks ?? [PNG]) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        if (plan.aborted) { res.emit('aborted'); res.destroy(); }
        else if (plan.closeEarly) res.destroy();
        else res.end();
      });
    });
    calls.push({url, settings, req, res});
    return req;
  };
  const loader = createMailImageLoader({lookup, request, timeoutMs:options.timeoutMs ?? 1000});
  return {...loader, calls, resolutions, sockets};
}

test('imageDataUrl recognizes all six allowed raster formats and normalizes MIME aliases', () => {
  const bmp = Buffer.alloc(26); bmp.write('BM');
  const ico = Buffer.alloc(22); ico.writeUInt32LE(0x00010000); ico.writeUInt16LE(1, 4);
  for (const [buffer, supplied, mime] of [
    [PNG, 'IMAGE/PNG; charset=binary', 'image/png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpg', 'image/jpeg'],
    [Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'binary'), null, 'image/gif'],
    [Buffer.from('RIFF\u0010\u0000\u0000\u0000WEBPVP8L', 'binary'), null, 'image/webp'],
    [bmp, 'image/x-ms-bmp', 'image/bmp'],
    [ico, 'image/vnd.microsoft.icon', 'image/x-icon'],
  ]) {
    const result = imageDataUrl(new Uint8Array(buffer), supplied);
    assert.equal(result.mimeType, mime);
    assert.equal(result.bytes, buffer.length);
    assert.equal(result.dataUrl, `data:${mime};base64,${buffer.toString('base64')}`);
  }
});

test('embedded SVG, HTML, unsupported MIME, spoofed formats and oversized bytes are rejected', () => {
  for (const [buffer, mime] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
    [PNG, 'text/html'], [PNG, 'image/svg+xml'], [PNG, 'application/pdf'],
    [PNG, 'image/jpeg'], [Buffer.alloc(0), null], [Buffer.from('BM'), 'image/bmp'],
    [Buffer.from('not a picture'), null], ['not binary bytes', null],
    [Buffer.from('<html>not an image</html>'), 'application/octet-stream'],
    [Buffer.from('<svg/>'), 'binary/octet-stream'],
  ]) assert.throws(() => imageDataUrl(buffer, mime), errorCode('FORMAT'));
  assert.throws(() => imageDataUrl(Buffer.alloc(MAX_BYTES + 1), 'image/png'), errorCode('TOO_LARGE'));
  const atLimit = Buffer.alloc(MAX_BYTES); PNG.copy(atLimit);
  assert.equal(imageDataUrl(atLimit).bytes, MAX_BYTES);
});

test('public image GET uses only pinned DNS answers and carries no credentials or referrer', async () => {
  const f = fixture([{}], {lookup:async (hostname, options) => {
    assert.equal(hostname, 'images.example');
    assert.equal(options.all, true);
    return PUBLIC;
  }});
  const result = await f.loadRemoteImage('https://images.example/picture?recipient=secret#fragment');
  assert.deepEqual(result, imageDataUrl(PNG));
  assert.equal(f.calls[0].url.hash, '');
  const settings = f.calls[0].settings;
  assert.equal(settings.method, 'GET');
  assert.equal(settings.agent, false);
  assert.deepEqual(settings.proxyEnv, {});
  assert.deepEqual(Object.keys(settings.headers).sort(), ['Accept', 'Accept-Encoding']);
  assert.equal(settings.headers['Accept-Encoding'], 'identity');
  assert.equal(settings.auth, undefined);
  assert.deepEqual(f.sockets, [PUBLIC]);
  await new Promise((resolve, reject) => settings.lookup('images.example', {}, (error, address, family) => {
    if (error) return reject(error);
    assert.equal(address, PUBLIC[0].address); assert.equal(family, 4); resolve();
  }));
});

test('missing content-type can be inferred from bytes but declared types must match', async () => {
  assert.deepEqual(await fixture([{headers:{}}]).loadRemoteImage('http://images.example/a'), imageDataUrl(PNG));
  for (const mime of ['application/octet-stream', 'binary/octet-stream', 'Application/Octet-Stream; charset=binary']) {
    assert.deepEqual(imageDataUrl(PNG, mime), imageDataUrl(PNG));
    assert.deepEqual(await fixture([{headers:{'content-type':mime}}]).loadRemoteImage('https://images.example/a'), imageDataUrl(PNG));
    await assert.rejects(fixture([{headers:{'content-type':mime}, chunks:[Buffer.from('<html>not an image</html>')]}]).loadRemoteImage('https://images.example/a'), errorCode('FORMAT'));
  }
  for (const headers of [
    {'content-type':'text/html'}, {'content-type':'image/svg+xml'}, {'content-type':'image/jpeg'},
    {'content-type':'image/png', 'content-encoding':'gzip'}, {'content-type':'application/pdf'},
  ]) await assert.rejects(fixture([{headers}]).loadRemoteImage('https://images.example/a'), errorCode('FORMAT'));
  await assert.rejects(fixture([{chunks:[Buffer.from('<html>not an image</html>')]}]).loadRemoteImage('https://images.example/a'), errorCode('FORMAT'));
});

test('invalid protocols, credentials and nonpublic literals fail before DNS or HTTP', async () => {
  const f = fixture();
  for (const source of [
    'file:///C:/secret', 'data:image/png;base64,aGVsbG8=', 'javascript:alert(1)',
    'https://user:secret@images.example/a', 'https://user@images.example/a', '', 'not-a-url',
  ]) await assert.rejects(f.loadRemoteImage(source), errorCode('URL'));
  for (const hostname of [
    'localhost', 'LOCALHOST.', 'sub.localhost', 'printer.local', 'mail.internal',
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.1.2.3', '240.0.0.1', '255.255.255.255',
    '2130706433', '0177.0.0.1', '0x7f000001', '127.1',
    '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:a00:1]', '[::ffff:192.168.0.1]',
    '[fc00::1]', '[fd00::1]', '[fe80::1]', '[ff02::1]', '[2001:db8::1]', '[2001:2::1]',
    '[2002:7f00:1::1]', '[64:ff9b::7f00:1]', '[3fff::1]', '[4000::1]',
  ]) await assert.rejects(f.loadRemoteImage(`http://${hostname}/secret`), errorCode('BLOCKED'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.resolutions.length, 0);
});

test('every DNS answer must be public, including IPv4-mapped IPv6 answers', async () => {
  for (const addresses of [
    [], [{address:'127.0.0.1', family:4}], [...PUBLIC, {address:'192.168.1.2', family:4}],
    [{address:'::ffff:169.254.169.254', family:6}], [{address:'fe80::42', family:6}],
    [{address:'2001:db8::1', family:6}], [{address:'fc00::1', family:6}],
    [{address:'93.184.215.14', family:6}], [{address:'invalid', family:4}],
  ]) {
    const f = fixture([{}], {lookup:async () => addresses});
    await assert.rejects(f.loadRemoteImage('https://recipient.example/secret'), errorCode('BLOCKED'));
    assert.equal(f.calls.length, 0);
  }
});

test('public IPv6 and public mapped IPv4 addresses are accepted without DNS rebinding', async () => {
  for (const address of ['2606:4700:4700::1111', '::ffff:93.184.215.14']) {
    let lookups = 0;
    const answers = [{address, family:6}];
    const f = fixture([{}], {lookup:async () => { lookups += 1; return lookups === 1 ? answers : [{address:'::1', family:6}]; }});
    assert.equal((await f.loadRemoteImage('https://images.example/a')).mimeType, 'image/png');
    assert.equal(lookups, 1);
    assert.deepEqual(f.sockets, [answers]);
  }
  const literal = fixture();
  await literal.loadRemoteImage('https://[2606:4700:4700::1111]/a');
  assert.equal(literal.resolutions.length, 0);
});

test('relative and cross-host redirects revalidate DNS with the same private request headers', async () => {
  const f = fixture([
    {status:302, headers:{location:'../next', 'set-cookie':'secret=value'}},
    {status:307, headers:{location:'https://other.example/final'}}, {},
  ]);
  assert.deepEqual(await f.loadRemoteImage('http://images.example/folder/start'), imageDataUrl(PNG));
  assert.deepEqual(f.calls.map(call => call.url.href), ['http://images.example/folder/start', 'http://images.example/next', 'https://other.example/final']);
  assert.deepEqual(f.resolutions, ['images.example', 'images.example', 'other.example']);
  assert.ok(f.calls[0].res.destroyed);
  assert.ok(f.calls[1].res.destroyed);
  for (const call of f.calls) assert.deepEqual(Object.keys(call.settings.headers).sort(), ['Accept', 'Accept-Encoding']);
});

test('redirects cannot reach literal or DNS-resolved private destinations or credentials', async () => {
  for (const [location, code] of [
    ['http://127.0.0.1/secret', 'BLOCKED'], ['http://[::ffff:127.0.0.1]/secret', 'BLOCKED'],
    ['http://localhost/secret', 'BLOCKED'], ['file:///secret', 'URL'],
    ['https://user:secret@images.example/a', 'URL'], ['http://internal.example/secret', 'BLOCKED'],
  ]) {
    const f = fixture([{status:302, headers:{location}}], {lookup:async hostname => hostname === 'internal.example' ? [{address:'10.0.0.1', family:4}] : PUBLIC});
    await assert.rejects(f.loadRemoteImage('https://images.example/start'), errorCode(code));
    assert.equal(f.calls.length, 1);
  }
  let lookups = 0;
  const rebound = fixture([{status:302, headers:{location:'/next'}}], {lookup:async () => ++lookups === 1 ? PUBLIC : [{address:'127.0.0.1', family:4}]});
  await assert.rejects(rebound.loadRemoteImage('https://images.example/start'), errorCode('BLOCKED'));
  assert.equal(rebound.calls.length, 1);
});

test('redirect count is limited to four and malformed/failed HTTP responses are rejected', async () => {
  const four = fixture([...Array.from({length:4}, () => ({status:302, headers:{location:'/next'}})), {}]);
  assert.equal((await four.loadRemoteImage('https://images.example/start')).mimeType, 'image/png');
  assert.equal(four.calls.length, 5);
  for (const location of ['/forever', '']) {
    const loop = fixture([{status:302, headers:{location}}]);
    await assert.rejects(loop.loadRemoteImage('https://images.example/start'), errorCode('HTTP'));
    assert.equal(loop.calls.length, 5);
  }
  for (const plan of [{status:404}, {status:206}, {status:302, headers:{}}, {headers:{'content-length':'invalid'}}]) {
    await assert.rejects(fixture([plan]).loadRemoteImage('https://images.example/a'), errorCode('HTTP'));
  }
});

test('byte limits reject advertised, absent and deliberately understated content lengths', async () => {
  const largeChunk = Buffer.alloc(MAX_BYTES); PNG.copy(largeChunk);
  for (const plan of [
    {headers:{'content-type':'image/png', 'content-length':String(MAX_BYTES + 1)}},
    {headers:{'content-type':'image/png', 'content-length':'999999999999999999999999999999999999'}},
    {headers:{'content-type':'image/png'}, chunks:[largeChunk, Buffer.from([0])]},
    {headers:{'content-type':'image/png', 'content-length':'1'}, chunks:[largeChunk, Buffer.from([0])]},
  ]) {
    const f = fixture([plan]);
    await assert.rejects(f.loadRemoteImage('https://images.example/a'), errorCode('TOO_LARGE'));
    assert.equal(f.calls[0].req.destroyed, true);
    assert.equal(f.calls[0].res.destroyed, true);
  }
});

test('abort before starting, during DNS and during body streaming closes owned requests', async () => {
  const cancelled = new AbortController(); cancelled.abort(new Error('private reason'));
  const idle = fixture();
  await assert.rejects(idle.loadRemoteImage('https://images.example/a', {signal:cancelled.signal}), errorCode('ABORTED'));
  assert.equal(idle.calls.length, 0);
  const resolving = new AbortController();
  const dns = fixture([{}], {lookup:() => { queueMicrotask(() => resolving.abort()); return new Promise(() => {}); }});
  await assert.rejects(dns.loadRemoteImage('https://images.example/a', {signal:resolving.signal}), errorCode('ABORTED'));
  assert.equal(dns.calls.length, 0);
  const streaming = new AbortController();
  const body = fixture([{holdOpen:true, onResponse:res => { res.write(PNG); streaming.abort(); }}]);
  await assert.rejects(body.loadRemoteImage('https://images.example/a', {signal:streaming.signal}), errorCode('ABORTED'));
  assert.equal(body.calls[0].req.destroyed, true);
  assert.equal(body.calls[0].res.destroyed, true);
});

test('one total deadline covers DNS, response wait and incomplete bodies', async () => {
  const dns = fixture([{}], {lookup:() => new Promise(() => {}), timeoutMs:20});
  await assert.rejects(dns.loadRemoteImage('https://images.example/a'), errorCode('TIMEOUT'));
  assert.equal(dns.calls.length, 0);
  for (const plan of [{noResponse:true}, {holdOpen:true, onResponse:res => res.write(PNG)}]) {
    const f = fixture([plan], {timeoutMs:20});
    await assert.rejects(f.loadRemoteImage('https://images.example/a'), errorCode('TIMEOUT'));
    assert.equal(f.calls[0].req.destroyed, true);
  }
});

test('redirects share the original deadline instead of resetting the timeout', async () => {
  const f = fixture([{status:302, headers:{location:'/next'}}], {
    lookup:() => new Promise(resolve => setTimeout(() => resolve(PUBLIC), 25)), timeoutMs:40,
  });
  await assert.rejects(f.loadRemoteImage('https://images.example/start'), errorCode('TIMEOUT'));
  assert.ok(f.calls.length < 5);
});

test('DNS errors, network errors and truncated streams return URL-free errors', async () => {
  const dns = fixture([{}], {lookup:async () => { throw new Error('DNS failure for recipient.example secret'); }});
  await assert.rejects(dns.loadRemoteImage('https://recipient.example/secret'), errorCode('NETWORK'));
  for (const plan of [{error:true}, {aborted:true}, {closeEarly:true}]) {
    await assert.rejects(fixture([plan]).loadRemoteImage('https://recipient.example/secret'), errorCode('NETWORK'));
  }
});

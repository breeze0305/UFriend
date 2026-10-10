'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {assetResponse} = require('../app/services/asset-protocol.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ufriend-asset-protocol-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ufriend-asset-protocol-'));
    await fs.rm(directory, {recursive:true, force:true});
  });
  const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const file = path.join(directory, 'fixture.mp3');
  await fs.writeFile(file, bytes);
  const getAsset = id => {
    if (id !== 'registered-id') throw new Error('Unknown asset');
    return {path:file, mimeType:'audio/mpeg', size:1}; // The response must use the actual file size.
  };
  const request = (range, method = 'GET', url = 'ufriend-asset://file/registered-id') => assetResponse(new Request(url, {
    method, headers:range ? {Range:range} : {},
  }), getAsset);
  return {directory, file, bytes, request, getAsset};
}

test('managed asset GET/HEAD advertise the real length, MIME and byte seeking', async t => {
  const f = await fixture(t);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  const head = await f.request('bytes=10-15', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal(head.body, null);
});

test('range responses return only the requested bytes with accurate 206 metadata', async t => {
  const f = await fixture(t);
  for (const [range, start, end] of [
    ['bytes=0-3', 0, 3], ['bytes=10-15', 10, 15], ['bytes=35-35', 35, 35],
    ['bytes=10-', 10, 35], ['bytes=-4', 32, 35], ['bytes=0-999', 0, 35],
    ['bytes=-999999999999999999999999', 0, 35], ['bytes=10-999999999999999999999999', 10, 35],
  ]) {
    const response = await f.request(range);
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/36`, range);
    assert.equal(response.headers.get('content-length'), String(end - start + 1), range);
    assert.equal(response.headers.get('accept-ranges'), 'bytes', range);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(start, end + 1), range);
  }
});

test('unsatisfiable ranges return 416 with the total size and no body', async t => {
  const f = await fixture(t);
  for (const range of ['bytes=36-', 'bytes=99999999999999999999999-', 'bytes=8-2', 'bytes=-0']) {
    const response = await f.request(range);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */36');
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(response.body, null);
  }
});

test('unsupported and malformed ranges fall back to a correct complete response', async t => {
  const f = await fixture(t);
  for (const range of ['items=1-2', 'bytes=0-1,4-5', 'bytes=abc-def', 'bytes=-']) {
    const response = await f.request(range);
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get('content-range'), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes, range);
  }
});

test('asset requests cannot turn URL paths into arbitrary filesystem access', async t => {
  const f = await fixture(t);
  for (const url of ['ufriend-asset://other/registered-id', 'ufriend-asset://file/unknown', 'ufriend-asset://file/../fixture.mp3']) {
    assert.equal((await f.request(null, 'GET', url)).status, 404);
  }
  const post = await f.request(null, 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  await fs.unlink(f.file);
  assert.equal((await f.request()).status, 404);
});

test('zero-length files and directories never create invalid file streams', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, '');
  const empty = await f.request();
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(empty.body, null);
  const range = await f.request('bytes=0-');
  assert.equal(range.status, 416);
  assert.equal(range.headers.get('content-range'), 'bytes */0');
  await fs.unlink(f.file);
  await fs.mkdir(f.file);
  assert.equal((await f.request()).status, 404);
});

test('cancelling a partially read asset closes its file stream', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, Buffer.alloc(4 * 1024 * 1024));
  const response = await f.request();
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.byteLength < 4 * 1024 * 1024);
  await reader.cancel();
  // The owned temporary file can be removed after cancellation (including on Windows).
  await fs.unlink(f.file);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MediaRuntimeSetup } = require('../app/services/media-runtime-setup.cjs');
const { resolveVideoFfmpegPath } = require('../app/services/video-runtime.cjs');
const { portableExecutable, relaunchOptions } = require('../app/services/portable-launch.cjs');

function fixture(t, { packaged = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ufriend-media-setup-'));
  const resourcesPath = path.join(root, 'temporary-resources'), userDataPath = path.join(root, 'persistent-data');
  const setup = path.join(resourcesPath, 'media-runtime-setup');
  fs.mkdirSync(setup, { recursive: true });
  fs.writeFileSync(path.join(setup, 'install-media-runtime.ps1'), '# Synthetic installer; never executed.\n');
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [], children = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    calls.push({ file, args, options }); children.push(child); return child;
  };
  let changes = 0;
  const options = { resourcesPath, userDataPath, isPackaged: packaged, projectRoot: root };
  const service = new MediaRuntimeSetup({ ...options, resolveFfmpeg: () => resolveVideoFfmpegPath(options), spawnProcess, onChange: () => changes++ });
  const binary = path.join(userDataPath, 'media-runtime', 'ffmpeg', 'ffmpeg.exe');
  const installBinary = () => { fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'Synthetic binary; never executed.'); };
  return { root, options, service, binary, installBinary, calls, children, changes: () => changes };
}

test('media setup is explicit, invokes fixed installer with separate path arguments and keeps output persistent', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0); assert.equal(f.service.snapshot().installed, false);
  const from = path.join(f.root, 'official package with spaces');
  const installing = f.service.install({ from });
  assert.equal(f.service.snapshot().installing, true);
  assert.equal(f.calls[0].options.shell, false); assert.equal(f.calls[0].options.windowsHide, true);
  assert.deepEqual(f.calls[0].args.slice(-4), ['-DestinationRoot', path.dirname(path.dirname(f.binary)), '-From', from]);
  assert(!f.calls[0].args.includes('http://untrusted.invalid'));
  await assert.rejects(f.service.install(), { code: 'MEDIA_SETUP_BUSY' });
  f.installBinary(); f.children[0].emit('close', 0);
  assert.deepEqual(await installing, { installed: true });
  assert.equal(f.service.snapshot().installed, true); assert.equal(f.service.snapshot().installing, false);
  assert.equal(f.changes(), 2);
  assert.equal(resolveVideoFfmpegPath({ ...f.options, resourcesPath: path.join(f.root, 'new-launch-temp') }), f.binary);
});

test('development and invalid source paths never start a runtime installer', async t => {
  const development = fixture(t, { packaged: false });
  await assert.rejects(development.service.install(), { code: 'MEDIA_SETUP_UNAVAILABLE' });
  assert.equal(development.calls.length, 0);
  const f = fixture(t); await assert.rejects(f.service.install({ from: 'relative' }), { code: 'MEDIA_SETUP_FAILED' });
  assert.equal(f.calls.length, 0);
});

test('missing extraction tool gives actionable feedback without exposing process output or paths', async t => {
  const f = fixture(t), installing = f.service.install();
  f.children[0].stderr.write('C:\\private\\data: 7-Zip is required. Synthetic raw output.');
  f.children[0].emit('close', 1);
  await assert.rejects(installing, { code: 'MEDIA_SETUP_EXTRACTOR' });
  assert.match(f.service.snapshot().error, /7-Zip/); assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /private|Synthetic/);
});

test('successful process exit without the persistent binary is not reported as installed', async t => {
  const f = fixture(t), installing = f.service.install(); f.children[0].emit('close', 0);
  await assert.rejects(installing, { code: 'MEDIA_SETUP_FAILED' }); assert.equal(f.service.snapshot().installed, false);
});

test('shutdown targets only the owned installer tree and waits for it to close', async t => {
  const f = fixture(t), installing = f.service.install();
  const rejected = assert.rejects(installing, { code: 'MEDIA_SETUP_CANCELLED' });
  let stopped = false; const shutdown = f.service.shutdown().then(() => { stopped = true; });
  assert.equal(f.calls[1].file, 'taskkill.exe'); assert.deepEqual(f.calls[1].args, ['/PID', '12345', '/T', '/F']);
  f.children[1].emit('close', 0); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  f.children[0].emit('close', 1); await shutdown; await rejected; assert.equal(f.service.snapshot().installing, false);
});

test('failed owned-process shutdown blocks exit and remains retryable', async t => {
  const f = fixture(t), installing = f.service.install(); const rejected = assert.rejects(installing, { code: 'MEDIA_SETUP_CANCELLED' });
  const first = f.service.shutdown(); f.children[1].emit('close', 1); await assert.rejects(first, { code: 'MEDIA_SETUP_SHUTDOWN' });
  assert.equal(f.service.snapshot().installing, true);
  const second = f.service.shutdown(); f.children[2].emit('close', 0); f.children[0].emit('close', 1); await second; await rejected;
});

test('a persistent media runtime survives changing extraction paths in packages without a bundled runtime', t => {
  const f = fixture(t);
  assert.equal(resolveVideoFfmpegPath(f.options), path.join(f.options.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
  f.installBinary(); assert.equal(resolveVideoFfmpegPath(f.options), f.binary);
  assert.throws(() => resolveVideoFfmpegPath({ ...f.options, userDataPath: 'relative' }), /absolute userDataPath/);
});

test('a bundled runtime is ready on first launch and takes precedence over an older persistent installation', t => {
  const f = fixture(t), bundled = path.join(f.options.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, 'Synthetic bundled binary; never executed.');
  assert.equal(resolveVideoFfmpegPath(f.options), bundled);
  assert.equal(f.service.snapshot().installed, true);
  assert.equal(f.service.snapshot().bundled, true);
  assert.equal(f.calls.length, 0);
  f.installBinary();
  assert.equal(resolveVideoFfmpegPath(f.options), bundled);
  const laterResources = path.join(f.root, 'another-extraction');
  assert.equal(resolveVideoFfmpegPath({ ...f.options, resourcesPath: laterResources }), f.binary);
  assert.throws(() => resolveVideoFfmpegPath({ ...f.options, userDataPath: 'relative' }), /absolute userDataPath/);
});

test('portable restart uses the original launcher and preserves arguments instead of relaunching temporary files', () => {
  const launcher = path.resolve('UFriend-Portable.exe');
  assert.equal(portableExecutable({}), null); assert.equal(relaunchOptions({ env: {}, argv: ['runtime'] }), undefined);
  assert.deepEqual(relaunchOptions({ env: { PORTABLE_EXECUTABLE_FILE: launcher }, argv: ['temp/UFriend.exe', '--some-flag'] }), { execPath: launcher, args: ['--some-flag'] });
  assert.throws(() => portableExecutable({ PORTABLE_EXECUTABLE_FILE: 'relative.exe' }), /invalid/);
  assert.throws(() => portableExecutable({ PORTABLE_EXECUTABLE_FILE: path.resolve('not-an-exe.cmd') }), /invalid/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveVideoFfmpegPath } = require('../app/services/video-runtime.cjs');
const { pinnedRuntime, inspectFfmpegRuntime, verifyCapabilities } = require('../scripts/ffmpeg-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..');

function fixture(t, { changedBinary = false } = {}) {
  const parent = path.join(projectRoot, '.test-data', 'video-runtime');
  fs.mkdirSync(parent, { recursive: true });
  assert.equal(fs.realpathSync(parent).toLowerCase(), parent.toLowerCase());
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const manifest = {
    version: 'test-pinned-build', license: 'GPL-3.0', sourceRevision: 'fixture',
    configuration: '--enable-gpl --enable-version3 --enable-static --enable-libass --enable-libx264',
    sha256: {},
  };
  for (const name of ['ffmpeg.exe', 'COPYING.GPLv3.txt', 'UPSTREAM-README.txt', 'SOURCES.md']) {
    const content = `Synthetic ${name} fixture; never executed.\n`;
    // Write the mismatched executable once: Windows scanners can briefly lock
    // a newly created .exe against a second write during the full test suite.
    fs.writeFileSync(path.join(root, name), name === 'ffmpeg.exe' && changedBinary ? content + 'changed' : content);
    manifest.sha256[name] = crypto.createHash('sha256').update(content).digest('hex');
  }
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(manifest));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.equal(fs.realpathSync(root).toLowerCase(), root.toLowerCase());
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const calls = [];
  const outputs = {
    version: `ffmpeg version ${manifest.version} Copyright (c) FFmpeg\nconfiguration: ${manifest.configuration}\n`,
    filters: ' .. ass V->V Render ASS\n .. subtitles V->V Render text\n',
    encoders: ' V....D libx264 H.264\n A....D aac AAC\n',
  };
  function run(executable, args, options) {
    calls.push({ executable, args, options });
    const stdout = args.includes('-version') ? outputs.version : args.includes('-filters') ? outputs.filters : outputs.encoders;
    return { status: 0, stdout, stderr: '' };
  }
  return { root, manifest, calls, outputs, run };
}

test('video runtime resolves only the development cache or packaged resources', () => {
  const resourcesPath = path.join(projectRoot, '.test-data', 'resources');
  assert.equal(resolveVideoFfmpegPath({ projectRoot }), path.join(projectRoot, 'local', 'runtimes', 'ffmpeg', 'win32-x64', 'ffmpeg.exe'));
  assert.equal(resolveVideoFfmpegPath({ projectRoot, resourcesPath, isPackaged: true }), path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
  assert.throws(() => resolveVideoFfmpegPath({ projectRoot, isPackaged: true }), /resourcesPath/);
  assert.throws(() => resolveVideoFfmpegPath({ resourcesPath }), /projectRoot/);
  assert.throws(() => resolveVideoFfmpegPath({ projectRoot: 'relative' }), /absolute/);
  assert.throws(() => resolveVideoFfmpegPath({ resourcesPath: 'relative', isPackaged: true }), /absolute/);
});

test('runtime inspection verifies all hashes and probes subtitle, H.264 and AAC support without a shell', t => {
  const f = fixture(t);
  const runtime = inspectFfmpegRuntime(f.root, f);
  assert.equal(runtime.executable, path.join(f.root, 'ffmpeg.exe'));
  assert.equal(runtime.sha256, f.manifest.sha256['ffmpeg.exe']);
  assert.deepEqual(runtime.filters, ['ass', 'subtitles']);
  assert.deepEqual(runtime.encoders, ['libx264', 'aac']);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    assert.equal(call.executable, runtime.executable);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 15000);
  }
});

test('changed binary is rejected before it can execute', t => {
  const f = fixture(t, { changedBinary: true });
  assert.throws(() => inspectFfmpegRuntime(f.root, f), /SHA-256 mismatch: ffmpeg.exe/);
  assert.equal(f.calls.length, 0);
});

test('missing license or altered provenance prevents a package being accepted', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'COPYING.GPLv3.txt'));
  assert.throws(() => inspectFfmpegRuntime(f.root, f), /missing or redirected/);
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(path.join(f.root, 'runtime.json'), JSON.stringify({ ...f.manifest, version: 'wrong' }));
  assert.throws(() => inspectFfmpegRuntime(f.root, f), /provenance/);
});

test('unsupported build, missing filters and missing encoders fail verification', t => {
  const f = fixture(t);
  const executable = path.join(f.root, 'ffmpeg.exe');
  const originalVersion = f.outputs.version;
  f.outputs.version = originalVersion.replace(f.manifest.version, 'wrong-build');
  assert.throws(() => verifyCapabilities(executable, f), /version/);
  f.outputs.version = originalVersion.replace('--enable-libass', '--enable-nonfree');
  assert.throws(() => verifyCapabilities(executable, f), /configuration/);
  f.outputs.version = originalVersion;
  const originalFilters = f.outputs.filters;
  f.outputs.filters = ' .. scale V->V Scale\n';
  assert.throws(() => verifyCapabilities(executable, f), /subtitle filters/);
  f.outputs.filters = originalFilters;
  f.outputs.encoders = ' V....D h264_nvenc H.264\n A....D aac AAC\n';
  assert.throws(() => verifyCapabilities(executable, f), /H.264 or AAC/);
});

test('runtime probe failure never counts as successful capability verification', t => {
  const f = fixture(t);
  assert.throws(() => verifyCapabilities(path.join(f.root, 'ffmpeg.exe'), {
    manifest: f.manifest, run: () => ({ status: null, error: new Error('timed out') }),
  }), /timed out/);
});

test('tracked upstream notices and source inventory match the pinned hashes', () => {
  const metadataRoot = path.join(projectRoot, 'scripts', 'runtime', 'ffmpeg');
  for (const name of ['COPYING.GPLv3.txt', 'UPSTREAM-README.txt', 'SOURCES.md']) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(metadataRoot, name))).digest('hex');
    assert.equal(hash, pinnedRuntime.sha256[name], name);
  }
  assert.equal(pinnedRuntime.license, 'GPL-3.0');
  assert.match(pinnedRuntime.configuration, /--enable-libass/);
  assert.match(pinnedRuntime.configuration, /--enable-libx264/);
  assert.doesNotMatch(pinnedRuntime.configuration, /--enable-nonfree/);
});

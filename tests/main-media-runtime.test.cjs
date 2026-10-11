'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Load the real main-process actions without starting Electron, touching user
// data, spawning an installer, or invoking the application's model services.
function harness({ selection = { canceled: true, filePaths: [] }, busy = false,
  videoCleanup = Promise.resolve(), mediaCleanup = Promise.resolve(),
  installError, uiLanguage = 'en' } = {}) {
  const file = path.resolve(__dirname, '../app/main.cjs');
  const moduleRequire = createRequire(file), module = { exports: {} };
  const calls = [], dialogs = [], installations = [], errors = [];
  const app = {
    setName() {}, getPath() { return path.resolve(__dirname, '../.test-data/inert-media-actions'); },
    whenReady() { return new Promise(() => {}); }, on() {},
    requestSingleInstanceLock() { return true; },
    relaunch() { calls.push('relaunch'); }, quit() { calls.push('quit'); },
  };
  const electron = {
    app, protocol: { registerSchemesAsPrivileged() {} },
    dialog: {
      showOpenDialog(parent, options) { dialogs.push({ parent, options }); return Promise.resolve(selection); },
      showErrorBox(title, message) { errors.push({ title, message }); },
    },
  };
  const source = fs.readFileSync(file, 'utf8') + `
module.exports = { actions, requestQuit, setContext(value) {
  win = value.win; store = value.store; core = value.core;
  mediaRuntime = value.mediaRuntime; videoExports = value.videoExports;
  diagnostics = value.diagnostics;
} };
`;
  vm.runInNewContext(source, {
    require: name => name === 'electron' ? electron : moduleRequire(name),
    module, __dirname: path.dirname(file), __filename: file,
    process: { argv: ['test'], env: {} }, Buffer, URL, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const core = { active: new Map(),
    stopRecordingScheduler() { calls.push('scheduler.stop'); },
    startRecordingScheduler() { calls.push('scheduler.start'); },
  };
  for (const name of ['cancelMailAnalysis', 'cancelPolish', 'cancelChat', 'cancelTranslation', 'cancelOcr']) core[name] = () => {};
  const win = { isDestroyed: () => false, show() {}, webContents: {
    isDestroyed: () => false, executeJavaScript() { calls.push('save'); return Promise.resolve(); },
  } };
  module.exports.setContext({
    win, core, store: { read: () => ({ settings: { uiLanguage } }) },
    mediaRuntime: {
      snapshot: () => ({ available: true, installed: false, installing: busy, error: '' }),
      async install(args) { installations.push({ ...args }); if (installError) throw installError; return { installed: true }; },
      shutdown() { calls.push('media.shutdown'); return mediaCleanup; },
    },
    videoExports: {
      setClosing(value) { calls.push(value ? 'video.block' : 'video.resume'); },
      shutdown() { calls.push('video.shutdown'); return videoCleanup; },
    },
    diagnostics: { async write(entry) { calls.push(entry.event); }, async flush() {} },
  });
  return { ...module.exports, calls, dialogs, installations, errors, win };
}

test('folder installation accepts only the native directory selection and ignores caller-supplied paths', async () => {
  const selected = path.resolve('synthetic official package');
  const h = harness({ selection: { canceled: false, filePaths: [selected] } });
  const result = await h.actions['mediaRuntime.install']({
    mode: 'folder', from: path.resolve('untrusted input.exe'),
    executable: path.resolve('untrusted installer.exe'), destinationRoot: path.resolve('untrusted destination'),
  });
  assert.deepEqual(result, { installed: true });
  assert.equal(h.dialogs.length, 1); assert.equal(h.dialogs[0].parent, h.win);
  assert.deepEqual(Array.from(h.dialogs[0].options.properties), ['openDirectory']);
  assert.equal(h.dialogs[0].options.title, 'Select the extracted official FFmpeg package');
  assert.deepEqual(h.installations, [{ from: selected }]);
});

test('download installation cannot be redirected by a source path or executable in the IPC arguments', async () => {
  const h = harness();
  await h.actions['mediaRuntime.install']({
    mode: 'download', from: path.resolve('untrusted input'),
    executable: path.resolve('untrusted installer.exe'), destinationRoot: path.resolve('untrusted destination'),
  });
  assert.equal(h.dialogs.length, 0); assert.deepEqual(h.installations, [{ from: undefined }]);
});

test('cancelled or empty native selections do not invoke an installer', async () => {
  for (const selection of [{ canceled: true, filePaths: [path.resolve('ignored')] }, { canceled: false, filePaths: [] }]) {
    const h = harness({ selection });
    assert.equal((await h.actions['mediaRuntime.install']({ mode: 'folder' })).cancelled, true);
    assert.equal(h.installations.length, 0);
  }
});

test('invalid modes and an active installer reject before opening another picker or starting work', async () => {
  const invalid = harness();
  await assert.rejects(invalid.actions['mediaRuntime.install']({ mode: 'execute', from: path.resolve('untrusted.exe') }), /Invalid operation format\./);
  assert.equal(invalid.dialogs.length, 0); assert.equal(invalid.installations.length, 0);
  const busy = harness({ busy: true });
  for (const mode of ['download', 'folder']) {
    await assert.rejects(busy.actions['mediaRuntime.install']({ mode }), /The media runtime is being installed\. Please wait\./);
  }
  assert.equal(busy.dialogs.length, 0); assert.equal(busy.installations.length, 0);
});

for (const restart of [false, true]) test(`a pending folder picker cannot start an installer after ${restart ? 'restart' : 'quit'} cleanup has passed it`, async () => {
  const selection = deferred(), videoCleanup = deferred();
  const h = harness({ selection: selection.promise, videoCleanup: videoCleanup.promise });
  const pending = h.actions['mediaRuntime.install']({ mode: 'folder' });
  assert.equal(h.dialogs.length, 1);
  const rejected = assert.rejects(pending, /UFriend is closing\. Try again after reopening it\./);
  const closing = h.requestQuit({ restart });
  await new Promise(resolve => setImmediate(resolve));
  assert(h.calls.includes('media.shutdown')); assert(h.calls.includes('video.shutdown'));
  assert(!h.calls.includes('quit')); assert(!h.calls.includes('relaunch'));
  selection.resolve({ canceled: false, filePaths: [path.resolve('synthetic selected package')] });
  await rejected; assert.equal(h.installations.length, 0);
  await assert.rejects(h.actions['mediaRuntime.install']({ mode: 'download' }), /UFriend is closing\./);
  videoCleanup.resolve(); await closing;
  assert.equal(h.calls.includes('relaunch'), restart); assert.equal(h.calls.at(-1), 'quit');
  assert.equal(h.installations.length, 0);
});

test('installer errors retain their error code and use the selected native UI language', async () => {
  const error = Object.assign(new Error('影音元件安裝失敗。請使用已解壓的官方套件重試，或查看安裝說明。'), { code: 'MEDIA_SETUP_FAILED' });
  const h = harness({ installError: error });
  await assert.rejects(h.actions['mediaRuntime.install']({ mode: 'download' }), {
    code: 'MEDIA_SETUP_FAILED',
    message: 'Media runtime installation failed. Retry with the extracted official package, or see the installation instructions.',
  });
});

test('failed installer shutdown displays translated feedback and permits a later installation attempt', async () => {
  const cleanup = deferred(), h = harness({ mediaCleanup: cleanup.promise });
  const closing = h.requestQuit({ restart: true });
  cleanup.reject(Object.assign(new Error('影音元件安裝尚未停止，請稍後再試。'), { code: 'MEDIA_SETUP_SHUTDOWN' }));
  await closing;
  assert(!h.calls.includes('quit')); assert(!h.calls.includes('relaunch'));
  assert.deepEqual(h.errors, [{
    title: 'UFriend has not restarted',
    message: 'Media runtime installation has not stopped yet. Try again shortly.',
  }]);
  await h.actions['mediaRuntime.install']({ mode: 'download' });
  assert.equal(h.installations.length, 1);
});

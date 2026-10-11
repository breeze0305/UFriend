'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedUiUrl, isTrustedUiSender } = require('../app/services/ui-origin.cjs');

const uiFile = path.resolve('synthetic BREEZE~1', '中文 app', 'index.html');
const uiUrl = pathToFileURL(uiFile).href;
const chromiumUrl = uiUrl.replace(/%7e/ig, '~');

function fixture(url = chromiumUrl) {
  const frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const win = { webContents: contents, isDestroyed: () => false };
  return { win, contents, frame, event: { sender: contents, senderFrame: frame } };
}

test('the same UI document accepts both Node and Chromium tilde encodings', () => {
  const encoded = chromiumUrl.replace('~', '%7E');
  assert.equal(isTrustedUiUrl(chromiumUrl, encoded), true);
  assert.equal(isTrustedUiUrl(encoded, chromiumUrl), true);
  assert.equal(isTrustedUiUrl(encoded.replace('%7E', '%7e'), encoded), true);
  assert.equal(isTrustedUiSender(fixture().event, fixture().win, uiUrl), false);
  const h = fixture();
  assert.equal(isTrustedUiSender(h.event, h.win, encoded), true);
});

test('Windows file path case differences do not reject the same local UI', { skip: process.platform !== 'win32' }, () => {
  const lowerDrive = uiUrl.replace(/^file:\/\/\/[A-Z]:/, value => value.toLowerCase());
  assert.equal(isTrustedUiUrl(lowerDrive, uiUrl), true);
  assert.equal(isTrustedUiUrl(uiUrl.toUpperCase(), uiUrl), true);
});

test('only the exact local UI path is accepted', () => {
  for (const url of [
    pathToFileURL(path.join(path.dirname(uiFile), 'other.html')).href,
    uiUrl + '.evil', uiUrl.replace('/index.html', '/child/index.html'),
    uiUrl.replace('/index.html', '/child/../../index.html'),
    uiUrl.replace(/%7e/ig, '%257E'),
    uiUrl.replace('/index.html', '%2Findex.html'),
    uiUrl.replace('/index.html', '%5Cindex.html'),
    uiUrl.replace('/index.html', '/%ZZindex.html'),
    uiUrl.replace('/index.html', '/%E0%A4index.html'),
    'https://example.invalid/index.html', 'data:text/html,UI',
    'about:blank', 'about:srcdoc', 'file://remote-host/share/index.html',
    '', null, undefined, { href: uiUrl },
  ]) assert.equal(isTrustedUiUrl(url, uiUrl), false, String(url));
  for (const suffix of ['?x=1', '#translation', '?', '#']) {
    assert.equal(isTrustedUiUrl(uiUrl + suffix, uiUrl), false, suffix);
  }
});

test('reserved characters in actual filenames remain distinct from URL state', () => {
  const name = pathToFileURL(path.resolve('app #1', '100% ready', 'index.html')).href;
  assert.equal(isTrustedUiUrl(name, name), true);
  assert.equal(isTrustedUiUrl(name + '#', name), false);
});

test('same-URL subframes and other windows never receive privileged actions', () => {
  const h = fixture();
  assert.equal(isTrustedUiSender(h.event, h.win, uiUrl), true);
  assert.equal(isTrustedUiSender({ ...h.event, senderFrame: { url: chromiumUrl, parent: h.frame } }, h.win, uiUrl), false);
  assert.equal(isTrustedUiSender({ ...h.event, sender: fixture().contents }, h.win, uiUrl), false);
  for (const senderFrame of [null, undefined]) {
    assert.equal(isTrustedUiSender({ ...h.event, senderFrame }, h.win, uiUrl), false);
  }
  h.frame.url = 'about:srcdoc';
  assert.equal(isTrustedUiSender(h.event, h.win, uiUrl), false);
});

test('closed windows and disposed frame metadata fail closed', () => {
  const h = fixture();
  assert.equal(isTrustedUiSender(h.event, null, uiUrl), false);
  assert.equal(isTrustedUiSender(null, h.win, uiUrl), false);
  h.win.isDestroyed = () => true;
  assert.equal(isTrustedUiSender(h.event, h.win, uiUrl), false);
  h.win.isDestroyed = () => false;
  h.contents.isDestroyed = () => true;
  assert.equal(isTrustedUiSender(h.event, h.win, uiUrl), false);
  h.contents.isDestroyed = () => false;
  Object.defineProperty(h.frame, 'url', { get() { throw new Error('Frame was disposed'); } });
  assert.equal(isTrustedUiSender(h.event, h.win, uiUrl), false);
});

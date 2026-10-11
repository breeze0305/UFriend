'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

function localDocumentPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const url = new URL(value);
  // A file URL has no useful unique web origin. Authorize only the expected
  // local document, not other files, remote hosts, or URL-supplied state.
  if (url.protocol !== 'file:' || url.hostname || url.username || url.password
      || url.href.includes('?') || url.href.includes('#')) return null;
  const file = path.normalize(fileURLToPath(url));
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function isTrustedUiUrl(value, expectedUrl) {
  try {
    const expected = localDocumentPath(expectedUrl);
    return expected !== null && localDocumentPath(value) === expected;
  } catch { return false; }
}

function isTrustedUiSender(event, win, expectedUrl) {
  try {
    if (!win || win.isDestroyed()) return false;
    const contents = win.webContents;
    return !!contents && !contents.isDestroyed()
      && event?.sender === contents && !!event.senderFrame
      && event.senderFrame === contents.mainFrame
      && isTrustedUiUrl(event.senderFrame.url, expectedUrl);
  } catch { return false; }
}

module.exports = { isTrustedUiUrl, isTrustedUiSender };

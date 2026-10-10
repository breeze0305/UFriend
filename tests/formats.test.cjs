'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {exportSrt, exportTxt, parseSrt, validateSegments} = require('../app/services/formats.cjs');

test('SRT BOM, CRLF, multilingual text and millisecond boundaries round-trip', () => {
  const source = '\uFEFF1\r\n00:00:59,999 --> 00:01:00,001\r\n繁體中文 UFriend\r\n第二行\r\n\r\n2\r\n01:00:00,010 --> 01:00:02,500\r\nKeep 10:30 and 1,250.\r\n';
  const segments = parseSrt(source);
  assert.deepEqual(segments, [
    {start:59.999, end:60.001, text:'繁體中文 UFriend\n第二行'},
    {start:3600.01, end:3602.5, text:'Keep 10:30 and 1,250.'}
  ]);
  assert.deepEqual(parseSrt(exportSrt(segments)), segments);
});

test('malformed, negative and backward subtitle timings are rejected', () => {
  for (const source of [
    '1\n00:60:00,000 --> 00:60:01,000\n文字',
    '1\n00:00:02,000 --> 00:00:01,000\n文字',
    '1\n-00:00:01,000 --> 00:00:01,000\n文字',
    '1\n00:00:00,000 --> 00:00:01,000\n'
  ]) assert.throws(() => parseSrt(source));
  assert.throws(() => validateSegments([{start:NaN, end:1, text:'invalid'}]));
  assert.throws(() => validateSegments([{start:-1, end:1, text:'invalid'}]));
});

test('SRT export never silently creates an unreadable cue containing a blank line', () => {
  const cue = [{start:0, end:1, text:'first\n\nsecond'}];
  let output;
  try { output = exportSrt(cue); }
  catch { return; } // Rejecting an unrepresentable cue is valid; silent corruption is not.
  const decoded = parseSrt(output);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].text.replace(/\s+/g, ' '), 'first second');
  assert.equal(decoded[0].start, 0);
  assert.equal(decoded[0].end, 1);
});

test('TXT export preserves manual text and does not invent timestamps', () => {
  const manual = '第一行\r\n\r\n第三行 09:30';
  assert.equal(exportTxt({textOnly:manual, segments:[]}), manual);
  assert.equal(exportTxt({textOnly:null, segments:[{start:0, end:1, text:'有時間的文字'}]}), '有時間的文字');
  assert.deepEqual(parseSrt(' \r\n\t'), []);
});

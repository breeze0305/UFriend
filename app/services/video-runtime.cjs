'use strict';

const path = require('node:path');

// Only the application's pinned, portable runtime is used. In particular, an
// unrelated FFmpeg on PATH or a PC model service is never a fallback.
function resolveVideoFfmpegPath({ resourcesPath, projectRoot, isPackaged = false } = {}) {
  if (isPackaged) {
    if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) {
      throw new Error('A packaged video export requires an absolute resourcesPath.');
    }
    return path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  }
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('A development video export requires an absolute projectRoot.');
  }
  return path.join(projectRoot, 'local', 'runtimes', 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
}

module.exports = { resolveVideoFfmpegPath };

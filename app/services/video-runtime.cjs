'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Only the application's pinned, portable runtime is used. In particular, an
// unrelated FFmpeg on PATH or a PC model service is never a fallback.
function resolveVideoFfmpegPath({ resourcesPath, projectRoot, userDataPath, isPackaged = false } = {}) {
  if (isPackaged) {
    if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) {
      throw new Error('A packaged video export requires an absolute resourcesPath.');
    }
    if (userDataPath !== undefined) {
      if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
        throw new Error('A persistent media runtime requires an absolute userDataPath.');
      }
      const persistent = path.join(userDataPath, 'media-runtime', 'ffmpeg', 'ffmpeg.exe');
      if (fs.existsSync(persistent)) return persistent;
    }
    return path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  }
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('A development video export requires an absolute projectRoot.');
  }
  return path.join(projectRoot, 'local', 'runtimes', 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
}

module.exports = { resolveVideoFfmpegPath };

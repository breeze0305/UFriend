'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveVideoFfmpegPath } = require('../app/services/video-runtime.cjs');
const pinnedRuntime = require('./runtime/ffmpeg/runtime.json');

const projectRoot = path.resolve(__dirname, '..');
const metadataRoot = path.join(__dirname, 'runtime', 'ffmpeg');
const metadataFiles = ['COPYING.GPLv3.txt', 'UPSTREAM-README.txt', 'SOURCES.md', 'runtime.json'];

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function requireRealFile(file) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()
      || !samePath(fs.realpathSync(file), file)) {
    throw new Error(`FFmpeg runtime file is missing or redirected: ${file}`);
  }
}

function hashFile(file) {
  requireRealFile(file);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyHash(file, expected) {
  const actual = hashFile(file);
  if (actual !== expected) throw new Error(`FFmpeg runtime SHA-256 mismatch: ${path.basename(file)}`);
  return actual;
}

function runCheck(executable, args, run) {
  const result = run(executable, args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`FFmpeg runtime verification failed (${args.join(' ')}): ${result.error?.message || result.status}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function verifyCapabilities(executable, { manifest = pinnedRuntime, run = spawnSync } = {}) {
  const version = runCheck(executable, ['-version'], run);
  if (!version.startsWith(`ffmpeg version ${manifest.version} Copyright`)) {
    throw new Error('FFmpeg runtime version does not match the pinned build.');
  }
  const configuration = version.split(/\r?\n/).find(line => line.startsWith('configuration: '));
  if (!configuration || configuration.slice('configuration: '.length) !== manifest.configuration
      || /(?:^|\s)--enable-nonfree(?:\s|$)/.test(configuration)) {
    throw new Error('FFmpeg runtime build configuration does not match the pinned build.');
  }
  const filters = runCheck(executable, ['-hide_banner', '-filters'], run);
  if (!/^\s*\S+\s+ass\s+V->V\s/m.test(filters)
      || !/^\s*\S+\s+subtitles\s+V->V\s/m.test(filters)) {
    throw new Error('FFmpeg runtime is missing the libass subtitle filters.');
  }
  const encoders = runCheck(executable, ['-hide_banner', '-encoders'], run);
  if (!/^\s*V\S*\s+libx264\s/m.test(encoders) || !/^\s*A\S*\s+aac\s/m.test(encoders)) {
    throw new Error('FFmpeg runtime is missing the H.264 or AAC encoder.');
  }
  return { filters: ['ass', 'subtitles'], encoders: ['libx264', 'aac'] };
}

function inspectFfmpegRuntime(directory, { manifest = pinnedRuntime, run = spawnSync } = {}) {
  const root = path.resolve(directory);
  const manifestFile = path.join(root, 'runtime.json');
  requireRealFile(manifestFile);
  const installed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (JSON.stringify(installed) !== JSON.stringify(manifest)) {
    throw new Error('FFmpeg runtime provenance does not match the pinned build.');
  }
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    if (path.basename(name) !== name || name === '.' || name === '..') {
      throw new Error('FFmpeg runtime manifest contains an invalid file name.');
    }
    verifyHash(path.join(root, name), expected);
  }
  const executable = path.join(root, 'ffmpeg.exe');
  const capabilities = verifyCapabilities(executable, { manifest, run });
  return {
    executable,
    version: manifest.version,
    sha256: manifest.sha256['ffmpeg.exe'],
    license: manifest.license,
    sourceRevision: manifest.sourceRevision,
    ...capabilities,
  };
}

function copyFfmpegRuntime(sourceRoot, destinationRoot) {
  inspectFfmpegRuntime(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) throw new Error('The FFmpeg runtime output already exists; preserving it.');
  fs.mkdirSync(destination);
  if (!samePath(fs.realpathSync(destination), destination)) {
    throw new Error('The FFmpeg runtime output resolves outside its expected directory.');
  }
  for (const name of ['ffmpeg.exe', ...metadataFiles]) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
  // This verifies the actual distributable copy before BUILD-INFO can mark the
  // package successful and package retention can remove an older build.
  return inspectFfmpegRuntime(destination);
}

function prepareFfmpegRuntime(sourceDirectory) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The pinned FFmpeg runtime requires Windows x64.');
  }
  const destination = path.dirname(resolveVideoFfmpegPath({ projectRoot }));
  if (fs.existsSync(destination)) return inspectFfmpegRuntime(destination);
  if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim()) {
    throw new Error('Specify an extracted pinned FFmpeg package: node scripts/prepare-ffmpeg.cjs --from <directory>');
  }
  const source = path.resolve(sourceDirectory);
  const sourceFiles = {
    'ffmpeg.exe': path.join(source, 'bin', 'ffmpeg.exe'),
    'COPYING.GPLv3.txt': path.join(source, 'LICENSE'),
    'UPSTREAM-README.txt': path.join(source, 'README.txt'),
    'SOURCES.md': path.join(metadataRoot, 'SOURCES.md'),
  };
  for (const [name, file] of Object.entries(sourceFiles)) verifyHash(file, pinnedRuntime.sha256[name]);
  verifyCapabilities(sourceFiles['ffmpeg.exe']);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!samePath(fs.realpathSync(path.dirname(destination)), path.dirname(destination))) {
    throw new Error('The local FFmpeg cache resolves outside its expected directory.');
  }
  fs.mkdirSync(destination);
  for (const [name, file] of Object.entries(sourceFiles)) {
    fs.copyFileSync(file, path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
  fs.copyFileSync(path.join(metadataRoot, 'runtime.json'), path.join(destination, 'runtime.json'), fs.constants.COPYFILE_EXCL);
  return inspectFfmpegRuntime(destination);
}

module.exports = {
  pinnedRuntime, inspectFfmpegRuntime, copyFfmpegRuntime, prepareFfmpegRuntime, verifyCapabilities,
};

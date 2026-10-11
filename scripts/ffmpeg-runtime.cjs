'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveVideoFfmpegPath } = require('../app/services/video-runtime.cjs');
const optionalRuntime = require('./runtime/ffmpeg/runtime.json');

const projectRoot = path.resolve(__dirname, '..');
const metadataRoot = path.join(__dirname, 'runtime', 'ffmpeg-bundled');
const metadataFiles = ['COPYING.GPLv3.txt', 'UPSTREAM-README.txt', 'SOURCES.md', 'THIRD_PARTY_LICENSES.txt'];
const sourceLayout = {
  'ffmpeg.exe': 'bin/ffmpeg.exe',
  'COPYING.GPLv3.txt': 'COPYING.GPLv3.txt',
  'UPSTREAM-README.txt': 'UPSTREAM-README.txt',
  'SOURCES.md': 'SOURCES.md',
  'THIRD_PARTY_LICENSES.txt': 'THIRD_PARTY_LICENSES.txt',
};

// An unbundled build uses only optionalRuntime. Never fall back to that Gyan
// binary when the separately built, source-complete runtime has no pin yet.
function getPinnedRuntime() {
  const file = path.join(metadataRoot, 'runtime.json');
  if (!fs.existsSync(file)) throw new Error('The bundled FFmpeg pin is missing: scripts/runtime/ffmpeg-bundled/runtime.json. Prepare the verified bundled build metadata first.');
  requireRealFile(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runtimeFiles(manifest) {
  for (const name of ['ffmpeg.exe', ...metadataFiles]) {
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256?.[name] || '')) {
      throw new Error('Bundled FFmpeg manifest is missing a SHA-256 pin for ' + name);
    }
  }
  const names = Object.keys(manifest.sha256);
  for (const name of names) {
    if (path.basename(name) !== name || name === '.' || name === '..' || name === 'runtime.json'
        || !/^[a-f0-9]{64}$/.test(manifest.sha256[name])) {
      throw new Error('FFmpeg runtime manifest contains an invalid file name or hash.');
    }
  }
  return names;
}

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

function verifyCapabilities(executable, { manifest = getPinnedRuntime(), run = spawnSync } = {}) {
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
  if (!/^\s*V\S*\s+libx264\s/m.test(encoders) || !/^\s*A\S*\s+aac\s/m.test(encoders)
      || !/^\s*A\S*\s+libmp3lame\s/m.test(encoders)) {
    throw new Error('FFmpeg runtime is missing the H.264, AAC or MP3 encoder.');
  }
  return { filters: ['ass', 'subtitles'], encoders: ['libx264', 'aac', 'libmp3lame'] };
}

function inspectFfmpegRuntime(directory, { manifest = getPinnedRuntime(), run = spawnSync } = {}) {
  const root = path.resolve(directory);
  const manifestFile = path.join(root, 'runtime.json');
  requireRealFile(manifestFile);
  const installed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (JSON.stringify(installed) !== JSON.stringify(manifest)) {
    throw new Error('FFmpeg runtime provenance does not match the pinned build.');
  }
  for (const name of runtimeFiles(manifest)) {
    verifyHash(path.join(root, name), manifest.sha256[name]);
  }
  const executable = path.join(root, 'ffmpeg.exe');
  const capabilities = verifyCapabilities(executable, { manifest, run });
  return {
    executable,
    version: manifest.version,
    sha256: manifest.sha256['ffmpeg.exe'],
    license: manifest.license,
    sourceRevision: manifest.sourceRevision,
    ...(manifest.sourceArchive ? { sourceArchive: { ...manifest.sourceArchive } } : {}),
    ...capabilities,
  };
}

function copyFfmpegRuntime(sourceRoot, destinationRoot, { manifest = getPinnedRuntime(), run = spawnSync } = {}) {
  inspectFfmpegRuntime(sourceRoot, { manifest, run });
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) throw new Error('The FFmpeg runtime output already exists; preserving it.');
  fs.mkdirSync(destination);
  if (!samePath(fs.realpathSync(destination), destination)) {
    throw new Error('The FFmpeg runtime output resolves outside its expected directory.');
  }
  for (const name of [...runtimeFiles(manifest), 'runtime.json']) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
  // This verifies the actual distributable copy before BUILD-INFO can mark the
  // package successful and package retention can remove an older build.
  return inspectFfmpegRuntime(destination, { manifest, run });
}

function prepareFfmpegRuntime(sourceDirectory, {
  manifest = getPinnedRuntime(), run = spawnSync,
  destination = path.dirname(resolveVideoFfmpegPath({ projectRoot })),
} = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The pinned FFmpeg runtime requires Windows x64.');
  }
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('The FFmpeg cache destination must be an absolute directory.');
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) {
    try { return inspectFfmpegRuntime(destination, { manifest, run }); }
    catch (error) {
      throw new Error('The existing FFmpeg cache does not match the bundled pin and was preserved. Move it to a separate backup location before preparing this build: ' + destination + '. ' + error.message);
    }
  }
  if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim()) {
    throw new Error('Specify an extracted pinned FFmpeg package: node scripts/prepare-ffmpeg.cjs --from <directory>');
  }
  const source = path.resolve(sourceDirectory);
  const sourceFiles = {};
  for (const name of runtimeFiles(manifest)) {
    if (!sourceLayout[name]) throw new Error('The bundled FFmpeg source layout has no mapping for ' + name);
    sourceFiles[name] = path.join(source, ...sourceLayout[name].split('/'));
    verifyHash(sourceFiles[name], manifest.sha256[name]);
  }
  verifyCapabilities(sourceFiles['ffmpeg.exe'], { manifest, run });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!samePath(fs.realpathSync(path.dirname(destination)), path.dirname(destination))) {
    throw new Error('The local FFmpeg cache resolves outside its expected directory.');
  }
  fs.mkdirSync(destination);
  for (const [name, file] of Object.entries(sourceFiles)) {
    fs.copyFileSync(file, path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(destination, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return inspectFfmpegRuntime(destination, { manifest, run });
}

module.exports = {
  get pinnedRuntime() { return getPinnedRuntime(); },
  optionalRuntime, getPinnedRuntime, inspectFfmpegRuntime, copyFfmpegRuntime, prepareFfmpegRuntime, verifyCapabilities,
};

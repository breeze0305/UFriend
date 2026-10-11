'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { packageApp } = require('./package.cjs');
const { inspectFfmpegRuntime, pinnedRuntime } = require('./ffmpeg-runtime.cjs');
const { inspectPackages, latestPackage, prunePackages, withDistLock, printReport } = require('./package-retention.cjs');
const builderConfig = require('./electron-builder-portable.json');

const projectRoot = path.resolve(__dirname, '..');
const builderVersion = '26.17.0';
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function portableOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--with-ffmpeg' && options.withFfmpeg === undefined) {
      options.withFfmpeg = true;
    } else if (args[index] === '--prepackaged' && options.prepackaged === undefined
        && typeof args[index + 1] === 'string' && args[index + 1].trim() && !args[index + 1].startsWith('--')) {
      options.prepackaged = path.resolve(args[++index]);
    } else {
      throw new Error('Usage: node scripts/package-portable.cjs [--with-ffmpeg] [--prepackaged dist/UFriend-X.Y.Z]');
    }
  }
  return options;
}

function realDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()
      || !samePath(fs.realpathSync(directory), directory)) {
    throw new Error('Packaging directories must be real directories without links: ' + directory);
  }
}

function realFile(file) {
  if (!fs.lstatSync(file).isFile() || !samePath(fs.realpathSync(file), file)) {
    throw new Error('Packaging files must be regular files without links: ' + file);
  }
  return file;
}

function hashFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(realFile(file), 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function inspectTree(directory) {
  const files = [];
  const walk = current => {
    realDirectory(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        realFile(file);
        files.push({ path: path.relative(directory, file).split(path.sep).join('/'), bytes: fs.statSync(file).size, sha256: hashFile(file) });
      }
    }
  };
  walk(directory);
  return {
    files,
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

function validatePrepackaged(root, input, manifest, { withFfmpeg = false, inspectRuntime = inspectFfmpegRuntime } = {}) {
  if (typeof withFfmpeg !== 'boolean') throw new Error('withFfmpeg must be an explicit boolean.');
  const dist = path.join(root, 'dist');
  const latest = latestPackage(inspectPackages(dist).packages);
  if (!latest || !samePath(latest.path, input) || latest.version !== manifest.version) {
    throw new Error('Use the latest verified dist folder matching package.json; older packages were preserved.');
  }
  const build = JSON.parse(fs.readFileSync(realFile(path.join(input, 'BUILD-INFO.json')), 'utf8'));
  if (build.platform !== 'win32' || build.architecture !== 'x64' || build.signed !== false
      || build.gmailConfigured !== false) {
    throw new Error('The portable input must be an unsigned Windows x64 package without bundled OAuth.');
  }
  if (build.videoRuntime?.bundled !== withFfmpeg) throw new Error('FFmpeg bundle metadata does not match the selected mode; use --with-ffmpeg only for a bundled input.');
  const config = JSON.parse(fs.readFileSync(realFile(path.join(input, 'resources', 'app', 'app', 'config', 'google-oauth.json')), 'utf8'));
  if (config.clientId || config.clientSecret) throw new Error('The portable input contains OAuth settings; no public EXE was built.');
  const sourceTree = inspectTree(input);
  const binaries = sourceTree.files.filter(file => path.basename(file.path).toLowerCase() === 'ffmpeg.exe');
  let videoRuntime;
  if (withFfmpeg) {
    const relative = 'resources/ffmpeg/ffmpeg.exe';
    if (binaries.length !== 1 || binaries[0].path !== relative || build.videoRuntime.path !== relative) {
      throw new Error('A bundled portable input must contain exactly one FFmpeg executable at resources/ffmpeg/ffmpeg.exe.');
    }
    // The default inspector verifies the pinned manifest, every binary/notice
    // hash, exact version/configuration, libass filters and H.264/AAC encoders.
    const { executable, ...verified } = inspectRuntime(path.join(input, 'resources', 'ffmpeg'));
    if (!samePath(executable, path.join(input, ...relative.split('/')))) throw new Error('The verified FFmpeg executable does not match the bundled runtime path.');
    for (const name of ['version', 'sha256', 'license', 'sourceRevision', 'filters', 'encoders']) {
      if (JSON.stringify(verified[name]) !== JSON.stringify(build.videoRuntime[name])) {
        throw new Error('Bundled FFmpeg metadata differs from the verified runtime: ' + name);
      }
    }
    videoRuntime = {
      bundled: true, path: relative, ...verified,
      publisher: pinnedRuntime.publisher, publisherUrl: pinnedRuntime.publisherUrl,
      upstreamArchive: { ...pinnedRuntime.archive },
    };
  } else {
    if (binaries.length) throw new Error('The public portable input unexpectedly contains ffmpeg.exe.');
    videoRuntime = { ...build.videoRuntime };
  }
  for (const notice of ['LICENSE', 'LICENSES.chromium.html', 'LICENSE.UFriend.txt', 'THIRD_PARTY_NOTICES.md']) {
    realFile(path.join(input, notice));
  }
  return { build, sourceTree, videoRuntime };
}

function assertPortableExecutable(file) {
  const size = fs.statSync(realFile(file)).size;
  if (size < 1024) throw new Error('The portable executable is empty or incomplete.');
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('The portable output is not a Windows executable.');
    const offset = header.readUInt32LE(0x3c);
    if (offset < 64 || offset > Math.min(size - 4, 1024 * 1024)) throw new Error('The portable executable has an invalid PE header.');
    const signature = Buffer.alloc(4);
    fs.readSync(fd, signature, 0, 4, offset);
    if (!signature.equals(Buffer.from([0x50, 0x45, 0, 0]))) throw new Error('The portable executable has no PE signature.');
  } finally { fs.closeSync(fd); }
  return { bytes: size, sha256: hashFile(file) };
}

function builderEnvironment() {
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  // This command deliberately has neither a signing nor publishing phase.
  for (const key of Object.keys(env)) {
    if (/^(?:WIN_)?CSC_/i.test(key) && key !== 'CSC_IDENTITY_AUTO_DISCOVERY') delete env[key];
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|GITHUB_RELEASE_TOKEN|BITBUCKET_TOKEN|KEYGEN_TOKEN)$/i.test(key)) delete env[key];
  }
  return env;
}

function buildPortable({ prepackaged, withFfmpeg = false, root = projectRoot, runBuilder = spawnSync, buildFolder = packageApp, prune = prunePackages, inspectRuntime = inspectFfmpegRuntime } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the portable EXE on Windows x64.');
  if (typeof withFfmpeg !== 'boolean') throw new Error('withFfmpeg must be an explicit boolean.');
  root = path.resolve(root);
  realDirectory(root);
  const manifest = JSON.parse(fs.readFileSync(realFile(path.join(root, 'package.json')), 'utf8'));
  const installedBuilder = JSON.parse(fs.readFileSync(realFile(path.join(root, 'node_modules', 'electron-builder', 'package.json')), 'utf8'));
  if (manifest.devDependencies?.['electron-builder'] !== builderVersion || installedBuilder.version !== builderVersion) {
    throw new Error('Install the exact electron-builder ' + builderVersion + ' development dependency before portable packaging.');
  }
  const cli = realFile(path.join(root, 'node_modules', 'electron-builder', 'cli.js'));
  const configFile = realFile(path.join(root, 'scripts', 'electron-builder-portable.json'));
  // In 26.17.0, true leaves UNPACK_DIR_NAME undefined and uses the unique NSIS
  // $PLUGINSDIR/app for each launch. false creates one build-specific TEMP path.
  // See NsisTarget.ts and templates/nsis/portable.nsi in the official repository
  // at tag electron-builder@26.17.0 (the option documentation says the reverse).
  // useZip embeds File /r directly. The default 7z path adds elevate.exe to the
  // supplied prepackaged input; direct embedding keeps that verified tree intact.
  if (builderConfig.portable.unpackDirName !== true || builderConfig.portable.useZip !== true) {
    throw new Error('Portable launch isolation and immutable prepackaged input must remain enabled.');
  }
  const input = prepackaged ? path.resolve(prepackaged) : buildFolder({ withoutFfmpeg: !withFfmpeg, prune: false }).outputRoot;
  const { build, sourceTree, videoRuntime } = validatePrepackaged(root, input, manifest, { withFfmpeg, inspectRuntime });
  const releases = path.join(root, 'local', 'releases');
  for (const directory of [path.join(root, 'local'), releases]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    realDirectory(directory);
  }
  // Fresh output is a sibling of every previous release, never inside the input.
  // Failed staging directories are retained for diagnosis and have no receipt.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
  const buildName = `UFriend-${manifest.version}-portable${withFfmpeg ? '-with-ffmpeg' : ''}-${stamp}-${randomUUID().slice(0, 8)}`;
  const staging = path.join(releases, '.' + buildName + '.building');
  const output = path.join(releases, buildName);
  fs.mkdirSync(staging);
  const artifactName = `UFriend-${manifest.version}-Portable${withFfmpeg ? '-WithFFmpeg' : ''}.exe`;
  const args = [cli, '--win', 'portable', '--x64', '--prepackaged', input,
    '--config', configFile, '--config.directories.output=' + staging,
    '--config.artifactName=' + artifactName, '--publish', 'never'];
  const result = runBuilder(process.execPath, args, {
    cwd: root, env: builderEnvironment(), windowsHide: true, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) throw new Error('Portable builder failed; existing releases were preserved: ' + (result.error?.message || result.status));
  if (inspectTree(input).sha256 !== sourceTree.sha256) throw new Error('The builder changed its verified input; this output is not a verified release.');
  const artifact = assertPortableExecutable(path.join(staging, artifactName));
  const receipt = {
    product: 'UFriend', version: manifest.version, format: 'windows-portable-exe',
    builtAt: new Date().toISOString(), electronBuilder: builderVersion,
    electron: build.electron, architecture: 'x64', signed: false,
    artifact: { name: artifactName, ...artifact },
    source: { directory: path.relative(root, input).split(path.sep).join('/'), fileCount: sourceTree.fileCount, bytes: sourceTree.bytes, sha256: sourceTree.sha256 },
    unpackDirectory: 'unique-per-launch', bundledOAuth: false, bundledFfmpeg: withFfmpeg, videoRuntime,
  };
  fs.writeFileSync(path.join(staging, 'PORTABLE-BUILD-INFO.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  realDirectory(releases);
  realDirectory(staging);
  fs.renameSync(staging, output);
  console.log('Portable EXE: ' + path.join(output, artifactName));
  console.log('SHA-256: ' + artifact.sha256);
  // Neither a failed folder build nor a failed single-file build gets here.
  printReport(prune(path.join(root, 'dist')));
  return { outputRoot: output, executable: path.join(output, artifactName), receipt };
}

module.exports = { portableOptions, inspectTree, validatePrepackaged, assertPortableExecutable, builderEnvironment, buildPortable };
if (require.main === module) {
  try {
    const options = portableOptions(process.argv.slice(2));
    withDistLock(path.join(projectRoot, 'dist'), () => buildPortable(options));
  } catch (error) {
    console.error('Portable packaging failed: ' + error.message);
    process.exitCode = 1;
  }
}

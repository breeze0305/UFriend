'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { readGoogleOAuthConfig } = require('../app/services/google-oauth-config.cjs');
const { resolveVideoFfmpegPath } = require('../app/services/video-runtime.cjs');
const { inspectFfmpegRuntime, copyFfmpegRuntime, pinnedRuntime } = require('./ffmpeg-runtime.cjs');
const { inspectPackages, latestPackage, compareVersions, prunePackages, withDistLock, printReport } = require('./package-retention.cjs');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.resolve(projectRoot, 'dist');
const ownershipFile = '.ufriend-package-output';

function packagingOptions(args) {
  if (args.some(arg => arg !== '--without-ffmpeg') || new Set(args).size !== args.length) {
    throw new Error('Usage: node scripts/package.cjs [--without-ffmpeg]');
  }
  return { withoutFfmpeg: args.includes('--without-ffmpeg') };
}

function copyMediaRuntimeSetup(outputRoot) {
  const metadataRoot = path.join(__dirname, 'runtime', 'ffmpeg');
  const setupRoot = path.join(outputRoot, 'resources', 'media-runtime-setup');
  const metadataFiles = ['runtime.json', 'COPYING.GPLv3.txt', 'UPSTREAM-README.txt', 'SOURCES.md'];
  // Copy only the installer and pinned provenance; never a cached executable.
  for (const name of metadataFiles) {
    const bytes = fs.readFileSync(path.join(metadataRoot, name));
    if (name === 'runtime.json') {
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(pinnedRuntime)) throw new Error('Media runtime manifest changed.');
    } else if (createHash('sha256').update(bytes).digest('hex') !== pinnedRuntime.sha256[name]) {
      throw new Error('Media runtime notice hash mismatch: ' + name);
    }
  }
  fs.mkdirSync(setupRoot, { recursive: true });
  for (const name of metadataFiles) fs.copyFileSync(path.join(metadataRoot, name), path.join(setupRoot, name), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(__dirname, 'install-media-runtime.ps1'), path.join(setupRoot, 'install-media-runtime.ps1'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(__dirname, 'install-media-runtime.cmd'), path.join(outputRoot, 'Install media runtime.cmd'), fs.constants.COPYFILE_EXCL);
  return {
    bundled: false, optional: true, path: 'resources/ffmpeg/ffmpeg.exe',
    expectedVersion: pinnedRuntime.version, expectedSha256: pinnedRuntime.sha256['ffmpeg.exe'],
    license: pinnedRuntime.license, installer: 'Install media runtime.cmd',
  };
}

function requireFile(file, explanation) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(explanation);
}

function outputDirectoryForVersion(version) {
  if (typeof version !== 'string' || version.length > 32
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('package.json version must use the numeric major.minor.patch format.');
  }
  const folderName = `UFriend-${version}`;
  const versionDirectory = path.resolve(distRoot, folderName);
  if (!fs.existsSync(versionDirectory)) return { outputRoot: versionDirectory, folderName };
  // Rebuild into a fresh sibling. Cleanup happens only after successful validation.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
  return { outputRoot: path.resolve(distRoot, `${folderName}-build-${stamp}`), folderName };
}

function assertOutputDirectory(outputRoot, folderName) {
  // Validate the final absolute target before creating a fresh build.
  const name = path.basename(outputRoot);
  const buildPrefix = folderName + '-build-';
  const expectedName = name === folderName
    || (name.startsWith(buildPrefix) && /^\d{8}-\d{6}-\d{3}$/.test(name.slice(buildPrefix.length)));
  if (path.dirname(outputRoot) !== distRoot || !expectedName
      || path.dirname(distRoot) !== projectRoot) {
    throw new Error('Refusing to write outside the expected versioned project dist directory.');
  }
  for (const directory of [distRoot, outputRoot]) {
    if (!fs.existsSync(directory)) continue;
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
      throw new Error(`Output path must be a real directory: ${directory}`);
    }
    const resolved = fs.realpathSync(directory);
    if (resolved.toLowerCase() !== directory.toLowerCase()) {
      throw new Error(`Output path resolves outside its expected directory: ${directory}`);
    }
  }
  if (fs.existsSync(outputRoot)) {
    if (!fs.existsSync(path.join(outputRoot, ownershipFile))) {
      throw new Error('The output folder exists without the packaging ownership marker; preserving it.');
    }
    throw new Error('This generated output folder already exists; preserving it. Run packaging again to choose a new build timestamp.');
  }
}

function productionPackages(lock) {
  if (!lock.packages || lock.lockfileVersion < 2) {
    throw new Error('Packaging requires the installed npm package-lock v2 or v3.');
  }
  return Object.entries(lock.packages)
    .filter(([relative, metadata]) => relative && !metadata.dev)
    .map(([relative, metadata]) => {
      const parts = relative.split('/');
      if (parts[0] !== 'node_modules' || parts.includes('..') || path.isAbsolute(relative)) {
        throw new Error(`Unsupported production package location: ${relative}`);
      }
      if (metadata.link) throw new Error(`Linked production packages must be installed locally: ${relative}`);
      if (parts.some(part => part === 'electron' || part === '@electron' || part === '@electron-internal')) {
        throw new Error(`Electron development tooling was marked as a production dependency: ${relative}`);
      }
      const source = path.resolve(projectRoot, ...parts);
      const expectedRoot = path.resolve(projectRoot, 'node_modules') + path.sep;
      if (!source.startsWith(expectedRoot)) throw new Error(`Package escapes node_modules: ${relative}`);
      if (!fs.existsSync(source)) {
        if (metadata.optional) return null;
        throw new Error(`Missing installed production package ${relative}; run npm install first.`);
      }
      if (fs.lstatSync(source).isSymbolicLink()) {
        throw new Error(`Symlinked production package is not portable: ${relative}`);
      }
      requireFile(path.join(source, 'package.json'), `Missing package metadata: ${relative}`);
      const installed = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      if (metadata.version && installed.version !== metadata.version) {
        throw new Error(`Installed version differs from lockfile for ${relative}; run npm install first.`);
      }
      return { relative, source, name: installed.name, version: installed.version };
    })
    .filter(Boolean)
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

function copyPackage(item, runtimeRoot) {
  const destination = path.join(runtimeRoot, ...item.relative.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(item.source, destination, {
    recursive: true,
    // Every production package, including nested versions, is copied separately.
    // This prevents a dependency's nested development modules from leaking in.
    filter: source => source === item.source || path.basename(source) !== 'node_modules',
  });
}

function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(file);
    else if (entry.isFile()) bytes += fs.statSync(file).size;
  }
  return bytes;
}

function packageApp({ withoutFfmpeg = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Build this portable Windows package on Windows.');
  if (process.arch !== 'x64') throw new Error('The portable FFmpeg runtime requires a Windows x64 build.');
  // OAuth input is validated before any package output is created.
  // A developer's downloaded JSON never overwrites the source placeholder.
  const externalGoogleOAuthFile = process.env.UFRIEND_GOOGLE_OAUTH_FILE;
  const hasExternalGoogleOAuthFile = externalGoogleOAuthFile !== undefined;
  if (hasExternalGoogleOAuthFile && !externalGoogleOAuthFile.trim()) {
    throw new Error('UFRIEND_GOOGLE_OAUTH_FILE must point to a Google Desktop OAuth JSON file; preserving the existing package.');
  }
  const googleOAuthFile = hasExternalGoogleOAuthFile
    ? path.resolve(externalGoogleOAuthFile.trim())
    : path.join(projectRoot, 'app', 'config', 'google-oauth.json');
  const googleOAuthConfig = readGoogleOAuthConfig(googleOAuthFile);
  if (hasExternalGoogleOAuthFile && !googleOAuthConfig) {
    throw new Error('The specified Google OAuth file has no configured Desktop Client ID; preserving the existing package.');
  }
  let googleOAuthSourcePath;
  try { googleOAuthSourcePath = fs.realpathSync(googleOAuthFile).toLowerCase(); }
  catch { throw new Error('The Google OAuth source file is unavailable; preserving the existing package.'); }
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const { outputRoot, folderName } = outputDirectoryForVersion(manifest.version);
  const latest = latestPackage(inspectPackages(distRoot).packages);
  if (latest && compareVersions(latest.version, manifest.version) > 0) {
    throw new Error('dist already contains a newer successful version; the latest package was preserved.');
  }
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const lockedDependencies = lock.packages?.['']?.dependencies || {};
  if (JSON.stringify(Object.entries(manifest.dependencies || {}).sort())
      !== JSON.stringify(Object.entries(lockedDependencies).sort())) {
    throw new Error('package.json production dependencies differ from package-lock.json; run npm install first.');
  }
  const packages = productionPackages(lock);
  const electronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist');
  requireFile(path.join(electronDist, 'electron.exe'), 'Electron runtime is missing. Finish npm install before packaging.');
  requireFile(path.join(electronDist, 'LICENSE'), 'Electron LICENSE is missing; reinstall Electron before packaging.');
  requireFile(path.join(projectRoot, manifest.main || 'app/main.cjs'), 'Application main entry is missing.');
  requireFile(path.join(projectRoot, 'app', 'native', 'ClipboardListener.exe'), 'Native helper is missing. Run npm run build:native first.');
  const ffmpegSourceRoot = path.dirname(resolveVideoFfmpegPath({ projectRoot }));
  // Validate the pinned binary, notices and encoders before creating output.
  if (!withoutFfmpeg) inspectFfmpegRuntime(ffmpegSourceRoot);
  if (withoutFfmpeg) {
    requireFile(path.join(__dirname, 'install-media-runtime.ps1'), 'Optional media installer is missing.');
    requireFile(path.join(__dirname, 'install-media-runtime.cmd'), 'Optional media installer launcher is missing.');
  }

  const iconScript = path.join(__dirname, 'create-icon.ps1');
  const embedIconScript = path.join(__dirname, 'set-exe-icon.ps1');
  const iconArtwork = path.join(projectRoot, 'design', 'logo-options', 'ufriend-logo-b-leaf-companion.png');
  requireFile(iconScript, 'Icon generation script is missing.');
  requireFile(embedIconScript, 'EXE icon embedding script is missing.');
  requireFile(iconArtwork, 'The selected leaf companion logo artwork is missing.');
  const iconSourceModified = Math.max(fs.statSync(iconScript).mtimeMs, fs.statSync(iconArtwork).mtimeMs);
  const requiredIcons = ['ufriend.png', 'ufriend.ico'].map(name => path.join(projectRoot, 'app', 'assets', name));
  if (requiredIcons.some(file => !fs.existsSync(file) || fs.statSync(file).mtimeMs < iconSourceModified)) {
    const iconBuild = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', iconScript], {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (iconBuild.error || iconBuild.status !== 0) throw new Error('Icon generation failed: ' + (iconBuild.error?.message || iconBuild.status));
  }
  for (const icon of requiredIcons) requireFile(icon, 'Required generated icon is missing.');

  assertOutputDirectory(outputRoot, folderName);
  fs.mkdirSync(distRoot, { recursive: true });
  // No recursive option for the leaf: a simultaneous build cannot overwrite it.
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(path.join(outputRoot, ownershipFile), 'Generated by scripts/package.cjs\n', { flag: 'wx' });

  // Keep the runtime DLLs, resources, locales, LICENSE and Chromium licenses intact.
  fs.cpSync(electronDist, outputRoot, { recursive: true });
  // Keep Electron's LICENSE and Chromium notices; our documents have distinct names.
  for (const [source, destination] of [['LICENSE', 'LICENSE.UFriend.txt'], ['README.md', 'README.UFriend.md'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md']]) {
    if (fs.existsSync(path.join(projectRoot, source))) fs.copyFileSync(path.join(projectRoot, source), path.join(outputRoot, destination), fs.constants.COPYFILE_EXCL);
  }
  const executable = path.join(outputRoot, 'UFriend.exe');
  fs.renameSync(path.join(outputRoot, 'electron.exe'), executable);
  // Only this newly created copy is changed during the build.
  const embeddedIcon = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', embedIconScript,
    '-ExecutablePath', executable, '-IconPath', path.join(projectRoot, 'app', 'assets', 'ufriend.ico')], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (embeddedIcon.error || embeddedIcon.status !== 0) throw new Error('EXE icon embedding failed: ' + (embeddedIcon.error?.message || embeddedIcon.status));
  const runtimeRoot = path.join(outputRoot, 'resources', 'app');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const runtimeManifest = { ...manifest };
  delete runtimeManifest.devDependencies;
  delete runtimeManifest.scripts;
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
  const nativeBuildFiles = new Set(['ClipboardListener.cs', 'build.ps1']
    .map(name => path.join(projectRoot, 'app', 'native', name).toLowerCase()));
  fs.cpSync(path.join(projectRoot, 'app'), path.join(runtimeRoot, 'app'), {
    recursive: true,
    // Native source and its build script stay in the development workspace.
    // A downloaded file placed under app/ must not be copied with extra fields.
    filter: source => !nativeBuildFiles.has(source.toLowerCase())
      && fs.realpathSync(source).toLowerCase() !== googleOAuthSourcePath,
  });
  const runtimeGoogleOAuthFile = path.join(runtimeRoot, 'app', 'config', 'google-oauth.json');
  fs.mkdirSync(path.dirname(runtimeGoogleOAuthFile), { recursive: true });
  fs.writeFileSync(runtimeGoogleOAuthFile, JSON.stringify({
    clientId: googleOAuthConfig?.clientId || '',
    clientSecret: googleOAuthConfig?.clientSecret || '',
  }, null, 2) + '\n');
  for (const item of packages) copyPackage(item, runtimeRoot);
  let videoRuntime;
  if (withoutFfmpeg) {
    videoRuntime = copyMediaRuntimeSetup(outputRoot);
  } else {
    const { executable: ffmpegExecutable, ...runtime } = copyFfmpegRuntime(
      ffmpegSourceRoot, path.join(outputRoot, 'resources', 'ffmpeg'),
    );
    videoRuntime = { bundled: true, path: path.relative(outputRoot, ffmpegExecutable).split(path.sep).join('/'), ...runtime };
  }

  // Resolve every declared production edge from its packaged location, not the
  // development workspace, so nested dependency versions cannot be omitted.
  for (const relative of ['', ...packages.map(item => item.relative)]) {
    const packageFile = path.join(runtimeRoot, relative, 'package.json');
    const packageManifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const resolver = createRequire(packageFile);
    for (const dependency of Object.keys(packageManifest.dependencies || {})) {
      if (packageManifest.optionalDependencies?.[dependency]) continue;
      const resolved = resolver.resolve(dependency);
      if (!resolved.startsWith(runtimeRoot + path.sep)) {
        throw new Error(`Packaged dependency resolved outside the portable app: ${relative || manifest.name} -> ${dependency}`);
      }
    }
  }

  const electronPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(outputRoot, 'BUILD-INFO.json'), JSON.stringify({
    product: 'UFriend',
    version: manifest.version,
    builtAt: new Date().toISOString(),
    electron: electronPackage.version,
    platform: process.platform,
    architecture: process.arch,
    gmailConfigured: Boolean(googleOAuthConfig),
    videoRuntime,
    productionPackages: packages.map(({ relative, name, version }) => ({ path: relative, name, version })),
    signed: false,
  }, null, 2) + '\n');
  console.log(`Portable app: ${executable}`);
  console.log(`Executable: ${fs.statSync(executable).size.toLocaleString('en-US')} bytes`);
  console.log(`Complete folder: ${directoryBytes(outputRoot).toLocaleString('en-US')} bytes; ${packages.length} production packages.`);
  console.log(`Distribute the entire ${path.relative(projectRoot, outputRoot)} folder; UFriend.exe needs the adjacent runtime and resources.`);
  if (withoutFfmpeg) console.log('FFmpeg is not bundled. Install media runtime.cmd offers an optional, verified download from Gyan for captioned-video export.');
  if (!googleOAuthConfig) {
    console.log('Gmail sign-in is not configured in this development package. Set UFRIEND_GOOGLE_OAUTH_FILE to a Google Desktop OAuth JSON file when building a release for users.');
  }
  // BUILD-INFO is written after icon/dependency/FFmpeg verification, so a failed build
  // never becomes the retained version or triggers removal of a working one.
  const retained = latestPackage(inspectPackages(distRoot).packages);
  if (!retained || retained.path.toLowerCase() !== outputRoot.toLowerCase()) {
    throw new Error('The completed output could not be confirmed as the latest package; older packages were preserved.');
  }
  printReport(prunePackages(distRoot));
}

module.exports = { packagingOptions, copyMediaRuntimeSetup };
if (require.main === module) {
  try {
    const options = packagingOptions(process.argv.slice(2));
    withDistLock(distRoot, () => packageApp(options));
  } catch (error) {
    console.error('Packaging failed: ' + error.message);
    process.exitCode = 1;
  }
}

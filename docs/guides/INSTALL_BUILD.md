# UFriend Installation, Development, and Packaging Guide

[English](INSTALL_BUILD.md) | [繁體中文](INSTALL_BUILD.zh-TW.md)

This guide covers the current Windows x64 desktop application. End users can run the complete portable build; developers can follow the steps below to install dependencies, prepare media tools, test, and package the source. For feature instructions, see the [user guide](APP_README.md).

## Use a packaged application

Download the **UFriend Windows EXE attachment** (Windows x64) from [GitHub Releases](https://github.com/breeze0305/UFriend/releases). You do not need the source-code attachments or the standalone FFmpeg development package; neither replaces the desktop application.

1. Save the EXE where you intend to keep using it.
2. If an older version is running, choose **Quit UFriend** from the Windows system tray first. Closing the window may only hide it in the tray.
3. Double-click the downloaded UFriend EXE. No installation wizard, manual extraction, Node.js, or npm is required.

On each launch, the launcher extracts the application into a separate Windows temporary directory, then opens UFriend. The first window may take a little time to appear while extraction finishes. Workspace data and credentials are stored outside this temporary directory; **Restart UFriend** in the system tray opens the original EXE again. Keep the original file while the application is running. To update, fully quit the older version before using the new EXE.

The Windows clipboard notification component uses the .NET Framework 4.x runtime. The current Windows release includes the desktop runtime and FFmpeg, so no separate media component or 7-Zip installation is needed. AI models, model services, and a Google OAuth client still require separate configuration.

### Builds without FFmpeg

Older and custom builds that omit FFmpeg can still install the pinned Gyan runtime from **Settings → General → Media runtime**. Bundled builds show that the components are ready and do not need the following steps:

- **Download and install media runtime** downloads the pinned FFmpeg package from Gyan's official site and verifies its hash. 7-Zip must already be installed on the computer.
- **Select extracted package** uses the native folder picker to select an official package, without downloading anything or requiring 7-Zip. The package must contain `bin/ffmpeg.exe`, `LICENSE`, and `README.txt`.
- **Media runtime instructions** opens the [FFmpeg runtime guide](../development/FFMPEG_RUNTIME.md).

By default, a runtime installed through Settings is stored in `%APPDATA%\UFriend\media-runtime\ffmpeg` and persists across restarts and EXE updates. If installation fails, the application displays the reason so you can correct the problem and retry. Quitting or restarting UFriend from the system tray stops installer processes it started. Audio preprocessing for local Whisper is provided by its independent service and does not use this desktop installer.

### Folder or ZIP builds

For a UFriend folder or ZIP build, extract the entire package and open `UFriend.exe`. Keep the adjacent DLLs, `resources/`, `locales/`, and license files; do not copy only the internal EXE. UFriend packages without FFmpeg can install media components from Settings and also provide **Install media runtime.cmd** for command-line installation; see the runtime guide for details. The standalone FFmpeg development ZIP is not the UFriend desktop application.

### Local data and backups

Workspace data is stored in `%APPDATA%\UFriend\workspace` by default. Open **Settings → General → Open data folder** to view it. Gmail authorization and API keys are stored in the encrypted credential store inside the workspace; authorization must be repeated after switching Windows accounts or computers.

Fully quit UFriend before backing up the entire workspace. A single EXE being portable does not mean its workspace is stored beside the EXE, or that moving the EXE also moves accounts and data. If `UFRIEND_DATA_DIR` is set, both the workspace and media components installed through Settings use that user-data directory as their base.

AI features still need a compatible local service or cloud API. See [Connect model services](#connect-model-services) below.

## Development environment

The following are the current development requirements. Pinned dependency versions are defined in `package-lock.json` and the runtime manifests.

| Item | Version or requirement | Purpose |
| --- | --- | --- |
| Operating system | Windows x64 | Current native components and portable packaging target |
| Node.js | 24.x | Run npm, build scripts, and tests |
| npm | A compatible version installed with Node.js 24 | Install packages according to `package-lock.json` |
| Git | A version of Git that supports the current Windows environment | Obtain and manage source code |
| Windows PowerShell | 5.1, available as `powershell.exe` | Compile the clipboard component, generate icons, and package the application |
| .NET Framework | 4.x, with `csc.exe` available | Compile the C# clipboard notification component |
| Electron | 44.3.0, pinned by the project | Desktop application runtime; no global installation required |
| electron-builder | 26.17.0, pinned as a development dependency | Generate a single EXE with the NSIS portable target; the first build needs network access to obtain tools |
| FFmpeg | The project's pinned `8.1.2-ufriend1` Windows x64 build | Media features during development, complete media tests, and builds with a bundled runtime |
| 7z extraction tool | Required only by the optional Gyan installer | Automatically extract Gyan `.7z` packages for builds without bundled components |

You can enter ordinary commands in PowerShell 7, but the build scripts invoke Windows PowerShell 5.1. The native build searches for the compiler in this order:

```text
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
```

The main application currently does not require a separate Visual Studio, Python, or CUDA installation. The three model services define their own environment requirements in their respective documentation.

## Run from source

After obtaining the source code, open PowerShell in the project root containing `package.json` and `package-lock.json`. Run all commands below from that directory; they do not depend on a particular folder name or user-specific path.

### 1. Install dependencies

```powershell
node --version
npm --version
npm ci
```

`npm ci` installs production and development dependencies from the lockfile. The first installation needs network access to download npm packages and Electron. Keep `package-lock.json` and do not omit development dependencies, because Electron is a development dependency.

If `node_modules/electron/dist/electron.exe` is still missing after installation, run Electron's installer script from the same directory:

```powershell
node node_modules/electron/install.js
```

This uses the Electron version specified by the installed package. If PowerShell's execution policy blocks `npm.ps1`, use `npm.cmd` in place of `npm` in this guide.

### 2. Compile the Windows native component

```powershell
npm run build:native
```

A successful build creates `app/native/ClipboardListener.exe`. This file is built from source and is not committed to Git; the packager requires it to exist. If the C# compiler cannot be found, confirm that one of the .NET Framework 4.x `csc.exe` paths listed above is available, then run the command again.

### 3. Prepare the pinned FFmpeg build and test tools

Follow the [FFmpeg runtime guide](../development/FFMPEG_RUNTIME.md) to obtain the project's custom **8.1.2-ufriend1** package. Verify the archive's SHA-256 against `scripts/runtime/ffmpeg-bundled/runtime.json`, then extract it. Do not substitute Gyan or an arbitrary newer version: the bundled runtime and optional installer use separate manifests.

Set `$ffmpegSource` below to the actual extracted package folder. That folder must contain `bin/ffmpeg.exe`, `bin/ffprobe.exe`, and the root-level files `COPYING.GPLv3.txt`, `UPSTREAM-README.txt`, `THIRD_PARTY_LICENSES.txt`, and `SOURCES.md`:

```powershell
$ffmpegSource = Read-Host 'Folder containing the extracted FFmpeg package'
node scripts/prepare-ffmpeg.cjs --from $ffmpegSource
```

After preparation succeeds, the desktop application's FFmpeg is placed in `local/runtimes/ffmpeg/win32-x64/`. Neither this cache nor downloaded packages are committed to Git. If a valid cache already exists, run `node scripts/prepare-ffmpeg.cjs` by itself to verify it again.

Complete media tests also need `ffprobe.exe` beside FFmpeg. Keep the extracted pinned package, and point the test path in the current PowerShell session to its `bin/ffmpeg.exe`:

```powershell
$env:UFRIEND_TEST_FFMPEG = (Resolve-Path -LiteralPath (Join-Path $ffmpegSource 'bin/ffmpeg.exe')).Path
```

`UFRIEND_TEST_FFMPEG` is used to generate and inspect synthetic media during tests, using the adjacent `ffmpeg.exe` and `ffprobe.exe` in the extracted package. Actual exports in the desktop development build use the pinned cache. A packaged build with bundled FFmpeg prioritizes the verified runtime in its own `resources/ffmpeg/`; a build without it uses `media-runtime/ffmpeg/` under the user-data directory. The packager does not include ffprobe in the output. Set this environment variable again before testing after opening a new PowerShell session.

### 4. Start the application

```powershell
npm start
```

Development and packaged builds use the same user-data location by default. To isolate development data, use the Git-ignored `.test-data/dev` directory:

```powershell
try {
  $env:UFRIEND_DATA_DIR = Join-Path $PWD.Path '.test-data/dev'
  New-Item -ItemType Directory -Path $env:UFRIEND_DATA_DIR -Force | Out-Null
  npm start
} finally {
  Remove-Item Env:UFRIEND_DATA_DIR -ErrorAction SilentlyContinue
}
```

Quit other UFriend instances normally before starting. The desktop application can open without running model services; tasks that need a model will report that it is unconfigured or not ready.

## Validation and tests

Run the following after preparing the native component and FFmpeg and setting `UFRIEND_TEST_FFMPEG`. Before the first UI test, create its isolated data directory:

```powershell
npm run check
npm test
New-Item -ItemType Directory -Path '.test-data/smoke' -Force | Out-Null
npm run smoke
```

| Command | Coverage and prerequisites |
| --- | --- |
| `npm run check` | Check JavaScript syntax in `app/`, `scripts/`, and `tests/` |
| `npm test` | Run Node tests, including local persistence, simulated mail, cancellation flows, and subtitle burn-in on synthetic videos; actual video tests require FFmpeg and ffprobe in the same directory |
| `npm run smoke` | Exercise UI and media flows in a hidden Electron window, using isolated data and model substitutes; no real Gmail account or model service is required |

Review both failures and skipped tests. Without FFmpeg or ffprobe, some media unit tests are skipped. Media checks in `smoke` require a working FFmpeg; passing other tests alone does not establish that subtitle export has been verified.

UI test data is stored in `.test-data/smoke/`, and reports and screenshots are written to `.test-results/`. Neither directory is committed to Git. The regular `smoke` test does not read the system clipboard or operate real accounts.

Validation with real models uses separate integration tests.

Before their first run, also create the isolated data directories for these tests:

```powershell
New-Item -ItemType Directory -Path '.test-data/llm-features-smoke', '.test-data/clipboard-smoke', '.test-data/model-smoke' -Force | Out-Null
```

| Command | Additional requirements |
| --- | --- |
| `npm run smoke:llm` | The LLM service must be ready and idle; the test uses synthetic text |
| `npm run smoke:clipboard` | The OCR service must be ready and idle; the test puts a synthetic image on the real Windows clipboard and conditionally restores its original contents |
| `npm run smoke:models` | All three services must be ready and idle; you must also supply the local test audio file specified by the script, which is not included in the source repository |

For integration-test preparation and output locations, see the [PC model guide](PC_MODELS.md) and the [LLM features and debugging guide](LLM_FEATURES.md). These tests do not install, download, or start model services for you.

## Build a portable release

Complete dependency installation, native compilation, and appropriate testing first. To build a single Windows x64 EXE, run:

```powershell
npm run package:portable
```

This command first creates a folder package without FFmpeg, then builds a single EXE using the pinned **electron-builder 26.17.0** and NSIS portable target. The first build needs network access to download NSIS and other build tools; cached tools can be reused. The command does not run `npm ci`, `build:native`, or the full test suite for you, and does not upload or publish a Release.

All single-EXE packaging inputs must use the blank OAuth template. The default mode must not contain an FFmpeg executable; bundling FFmpeg requires an explicit `--with-ffmpeg`. The build stops if the input contains Google client configuration or fails these requirements. Regular workspace data, credentials, model weights, and the three PC model services are excluded from the package.

Successful builds are written to:

```text
local/releases/UFriend-<version>-portable-<timestamp>-<id>/
  UFriend-<version>.exe
  PORTABLE-BUILD-INFO.json
```

The version comes from `package.json`. Future builds consistently use `UFriend-<version>.exe`, with the Release title `UFriend <version>`, without suffixes describing packaging or media components. Already published attachments keep their original filenames. The command prints the actual output location and the EXE's SHA-256. The build receipt records input-file checksums, tool versions, and output details. Each single-EXE launch uses its own temporary directory; the active workspace and persistent media components remain in the user-data directory.

### A single EXE with bundled FFmpeg

Prepare and verify the pinned FFmpeg cache first, then run:

```powershell
npm run package:portable -- --with-ffmpeg
```

The output is also named `UFriend-<version>.exe` and is placed in a separate build directory under `local/releases/`. The build receipt records whether FFmpeg is included. This build contains the verified FFmpeg, the original GPL text, the third-party license list, and source information. It can export subtitled videos and prepare audio for cloud transcription on first launch, without a separate FFmpeg or 7-Zip installation. Settings indicates that the media components are bundled and need no separate installation. AI models and Gmail authorization still require their own configuration.

The bundled tool is extracted into the temporary directory on each launch and takes priority over an optional installation in the existing user-data directory. That older optional installation is preserved. Public releases must also provide the complete corresponding source code and build-material attachments specified by the manifest; see the [runtime licensing and source records](../development/FFMPEG_RUNTIME.md#license-and-source-records).

### Folder packages and ZIP files

To create only a folder package suitable for distribution as a complete ZIP, run:

```powershell
npm run package -- --without-ffmpeg
```

This mode does not need the development FFmpeg cache. It includes the media component installer in Settings and `Install media runtime.cmd`. The command creates a folder, not a ZIP. If you compress it, preserve all files and their relative structure. Complete media tests still need the FFmpeg and ffprobe preparation described above.

To create a local folder package containing the prepared FFmpeg, verify the pinned runtime first, then run `npm run package`. Converting this package to a single EXE requires `--with-ffmpeg`.

Folder packages are placed in `dist/UFriend-<version>/`. If a folder for the same version already exists, a new directory containing the build time is used; the command output gives the actual location. The package contains `UFriend.exe` and `BUILD-INFO.json`, which records the version, Electron, platform, production dependencies, and media runtime information.

If the latest successfully validated folder package for the same version already exists, use its actual output path to skip rebuilding it:

```powershell
npm run package:portable -- --prepackaged 'dist/UFriend-0.1.41'
# Add --with-ffmpeg if that folder package already contains FFmpeg.
```

`--prepackaged` accepts only the latest successful package in `dist/` matching the version in `package.json`. It rechecks the blank OAuth template, selected FFmpeg mode, and file integrity. Replace the example path with the actual output location.

### Validation and artifact cleanup

Packaging verifies required files and preserves existing usable builds if it fails. Older versions in `dist/` are cleaned up only after the single EXE is complete. An older version that is still running or locked is preserved and is not forcibly stopped. After quitting normally from the system tray, run:

```powershell
npm run clean:dist
```

This cleanup only handles recognizable UFriend folder builds in `dist/`. It does not remove `local/releases/`, user workspace data, or independent model services. Before sharing a build, test startup, normal exit, restart, subtitle export, and audio processing with the new EXE. A bundled runtime should work on first launch; an optional installation must be verified to remain usable across restarts after installation. A build receipt does not establish that all these workflows have been tested.

Builds without FFmpeg provide only the optional installer. EXE or folder builds containing FFmpeg must include the complete corresponding source and notices as described in the [FFmpeg licensing and source records](../development/FFMPEG_RUNTIME.md#license-and-source-records).

### Optional: Google sign-in configuration

Google sign-in configuration does not affect an ordinary desktop build. The source file `app/config/google-oauth.json` must remain a blank template. **Do not put real Client IDs, Client Secrets, or tokens into tracked files.**

During development, import a Google Desktop OAuth JSON file through **Settings → Email accounts → Advanced settings (developers)**. See the [Gmail setup guide](GMAIL_SETUP_GUIDE.md) for creation and import instructions. Store the downloaded file in the Git-ignored `local/credentials/google-oauth-client.json`, or elsewhere outside the repository.

Public releases use the blank OAuth template, and users import their own settings locally. To create a private deployment package with your own Desktop client preconfigured, provide an external file at packaging time:

```powershell
try {
  $env:UFRIEND_GOOGLE_OAUTH_FILE = (Resolve-Path -LiteralPath 'local/credentials/google-oauth-client.json').Path
  npm run package -- --without-ffmpeg
} finally {
  Remove-Item Env:UFRIEND_GOOGLE_OAUTH_FILE -ErrorAction SilentlyContinue
}
```

The packager validates the configuration first and writes only the required Desktop client fields into the new package, without changing the source template. Those fields are distributed with the package; user authorization tokens are stored separately in each user's local encrypted credential store. Packaging still works without external configuration, but the application will report that Google sign-in has not been configured.

## Connect model services

The main repository provides only the desktop application and HTTP adapters. `PC-LLM-API`, `PC-OCR-API`, and `PC-Whisper-API` are independently maintained projects. They are not obtained through `git clone`, `npm ci`, or the desktop package; Python, CUDA, model weights, and service runtimes are also absent from the main repository.

Obtain the compatible services you need separately from their maintainer, then install and start them according to each service's README. The main application does not install services or manage their lifecycle.

| Service | Default desktop endpoint |
| --- | --- |
| LLM | `http://127.0.0.1:8765` |
| OCR | `http://127.0.0.1:8767` |
| Whisper | `http://127.0.0.1:8768` |

Once the services are ready, open **Settings → Models and compute → Local models** in UFriend, select **PC local services** under **Local backend**, save the endpoints, and test the connections. Select **Local** for each task. Cloud mode supports a separately configured OpenAI-compatible API; meeting transcription also uses the FFmpeg described above to prepare audio for upload. Physical UGen300 devices are not yet integrated. See the [model source guide](MODEL_SOURCES.md) for source configuration and the [model interface contract](../../app/models/README.md) for local API v1 and health checks.

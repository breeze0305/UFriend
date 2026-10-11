# FFmpeg media runtime

[English](FFMPEG_RUNTIME.md) | [繁體中文](FFMPEG_RUNTIME.zh-TW.md)

UFriend uses a separate FFmpeg process to export videos with subtitles and to extract and segment audio before cloud transcription. Tools are downloaded only when the user explicitly starts installation. Media tasks do not search the system `PATH` or start or stop independent PC model services.

The bundled version uses the project's own **8.1.2-ufriend1** Windows x64 build. The [bundled runtime manifest](../../scripts/runtime/ffmpeg-bundled/runtime.json) records the version, SHA-256 hashes of the executable and license files, source archive and build revision. Complete source is provided as an asset in the same GitHub Release; ordinary users need only download the UFriend EXE.

Builds without FFmpeg retain a separate optional installation path that obtains Gyan **8.1.2-essentials_build-www.gyan.dev** directly. Its [separate manifest](../../scripts/runtime/ffmpeg/runtime.json) is not interchangeable with the bundled version.

## Versions with FFmpeg bundled

The current UFriend Windows release can use FFmpeg as soon as it opens, without downloading components or installing 7-Zip. **Settings → General → Media runtime** displays that the media runtime is bundled and no separate installation is needed. AI transcription, OCR, LLM and Gmail still require their respective settings.

## Install from UFriend Settings

The following applies to older or custom **builds without FFmpeg**. Open **Settings → General → Media runtime**:

| Button | Behavior |
| --- | --- |
| Download and install media runtime | Downloads the pinned package from Gyan's official site, verifies SHA-256, then extracts and installs it; requires 7-Zip to be installed on the computer. |
| Select extracted package | Opens the native folder picker to read an official package you prepared yourself; does not download anything or require 7-Zip. |
| Media runtime instructions | Opens this guide in a browser. |

Automatic download looks for `7z.exe` or `7za.exe`, including the usual 7-Zip installation locations. If the tool is missing, it reports an error and does not install 7-Zip automatically. Install an extraction tool first, or select an already extracted package. The source package must contain `bin/ffmpeg.exe`, `LICENSE` and `README.txt`.

Installation progress is displayed while the task runs; completion displays that the media runtime is ready. If it fails, correct the cause shown onscreen and retry. Exiting UFriend from the system tray or restarting it stops the installation process it launched. Closing only the window while leaving the app in the system tray keeps it running.

Installation does not require administrator privileges, but the selected user-data directory must be writable. Source-code development uses the development-cache preparation procedure below; the Settings installer is for packaged versions.

## Storage location and app updates

A runtime installed from Settings is stored in `media-runtime/ffmpeg/` under Electron's user-data directory. The default location is:

```text
%APPDATA%\UFriend\media-runtime\ffmpeg\
  ffmpeg.exe
  COPYING.GPLv3.txt
  UPSTREAM-README.txt
  SOURCES.md
  runtime.json
```

This is separate from workspace data in `%APPDATA%\UFriend\workspace` and is not placed in the temporary extraction directory created each time the single EXE starts. It remains available after restarting or replacing the EXE when the same Windows account and data directory are used. If `UFRIEND_DATA_DIR` is set, the media runtime is stored in `media-runtime/ffmpeg/` under that directory.

Versions that include the component prefer the verified runtime in the app's `resources/ffmpeg/`; versions without it use this persistent runtime. Exiting the app does not remove successfully installed media components, and workspace data cleanup does not include them.

The installer verifies the complete set of pinned files before making the installation directory available. An existing valid installation can be verified and accepted; an existing directory with mismatched contents produces an error and is not overwritten automatically. A failed download, verification or extraction cannot turn an incomplete installation into a successful one. Once installation completes, retry the original media task.

LLM, OCR and local Whisper still require their respective configurations in the [model guide](../guides/PC_MODELS.md). Local Whisper has its own audio-processing runtime; installing desktop FFmpeg does not install a speech model.

## Download and extract manually

Use the [pinned upstream package](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z). Its archive SHA-256 must be:

```text
e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6
```

Verify it in PowerShell with `Get-FileHash -Algorithm SHA256 -LiteralPath <file-path>`, or consult the [publisher's checksum file](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z.sha256).

After extracting the archive with a compatible tool of your choice, return to Settings, click **Select extracted package**, and choose the folder containing `bin/ffmpeg.exe`, `LICENSE` and `README.txt`. The installer still checks the pinned SHA-256 hashes of the executable and upstream documents. Do not substitute a different version or an arbitrarily rebuilt executable.

## Command-line installation for a ZIP folder package

This method applies only to **UFriend folder/ZIP builds without FFmpeg**, not to bundled builds or the separate FFmpeg development ZIP. After extracting the entire package, use **Install media runtime.cmd** in its root directory. Run the following in PowerShell from that folder to download the pinned package automatically:

```powershell
& '.\Install media runtime.cmd'
```

Automatic download also requires an installed copy of 7-Zip. Alternatively, use an already extracted official package:

```powershell
$ffmpegSource = Read-Host 'Folder containing the extracted FFmpeg package'
& '.\Install media runtime.cmd' -From $ffmpegSource
```

You can also run the PowerShell installer inside the folder package directly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\resources\media-runtime-setup\install-media-runtime.ps1' -From $ffmpegSource
```

`-From` does not download anything or require 7-Zip. By default, these commands install into `resources/ffmpeg/` inside **that folder package**, so the installation stays with that particular build. Prefer installation through Settings if it should persist across app updates.

Advanced callers can use `-DestinationRoot` to specify an absolute directory, under which the installer creates `ffmpeg/`. Settings already supplies the correct user-data path, so normal use does not require this parameter. Choosing some other directory does not change where UFriend searches for its runtime.

Do not manually install tools into the single EXE's temporary extraction directory. Use Settings to save them in the persistent location.

## Source-code development environment

Development and bundled packaging use the project's own runtime, separately from the Gyan optional installer described above. Download the package from `archive.url` in the [bundled manifest](../../scripts/runtime/ffmpeg-bundled/runtime.json), verify `archive.sha256`, then extract it. You can also follow the [build procedure](MEDIA_RUNTIME_BUILD.md) to produce and verify a new runtime.

From the project root, point the source to the project-built package containing `bin/ffmpeg.exe`, `bin/ffprobe.exe` and the license documents in its root:

```powershell
$ffmpegSource = Read-Host 'Folder containing the extracted FFmpeg package'
node scripts/prepare-ffmpeg.cjs --from $ffmpegSource
```

Preparation checks the pinned SHA-256 hashes, version, build configuration, ASS/subtitles filters and libx264/AAC/MP3 encoders before placing the runtime in `local/runtimes/ffmpeg/win32-x64/`. With a valid cache already present, run `node scripts/prepare-ffmpeg.cjs` to verify it again. Failure preserves existing files and does not automatically switch to another version. If this location still contains an old Gyan cache, first close programs using it normally, move the entire cache to a separate backup location under `local/`, then prepare the new version. Do not mix files from the two runtimes.

Complete media tests also need `ffprobe.exe` from the same upstream package. Set the following in the PowerShell session used to run tests:

```powershell
$env:UFRIEND_TEST_FFMPEG = (Resolve-Path -LiteralPath (Join-Path $ffmpegSource 'bin/ffmpeg.exe')).Path
```

Keep `ffprobe.exe` in the same directory, then run the checks in the [installation guide](../guides/INSTALL_BUILD.md#validation-and-tests). This variable is only for testing; the desktop development version uses the fixed cache. Downloads, caches and test outputs are not committed to Git.

## Packaging modes

| Command | Output and FFmpeg handling |
| --- | --- |
| `npm run package:portable` | A single Windows EXE named `UFriend-<version>.exe`. Uses a folder package without bundled FFmpeg or OAuth settings as input and wraps it with electron-builder's NSIS portable target; users can install the runtime from Settings. |
| `npm run package:portable -- --with-ffmpeg` | A single EXE, also named `UFriend-<version>.exe`. Includes the project-built FFmpeg and its license/source documents, checking hashes, version, subtitle filters and encoders before wrapping. Media components need no installation on first use. |
| `npm run package -- --without-ffmpeg` | A folder package suitable for ZIP distribution. Includes the Settings installer, CMD entry point, version information and upstream notices, but no FFmpeg executable; packaging does not require the development FFmpeg cache. |
| `npm run package` | A folder package that copies the runtime from the verified development cache, suitable for local use. Verification and capability probes run before packaging and after copying. |

None of these include the independent PC model services. The folder package's `BUILD-INFO.json` records whether the runtime was bundled at build time; later user installation does not rewrite it to claim that it was originally bundled. The single EXE also has a `PORTABLE-BUILD-INFO.json` build receipt. See the [installation guide](../guides/INSTALL_BUILD.md#build-a-portable-release) for output locations and the complete process.

## License and source records

UFriend uses the [MIT License](../../LICENSE) and executes FFmpeg as a separate process. Bundled FFmpeg enables GPL, version3, libass and libx264 and is provided under its **GPLv3** license; UFriend's MIT license does not replace those terms.

The [bundled source record](../../scripts/runtime/ffmpeg-bundled/SOURCES.md), original GPL text, full third-party license texts and build description reside in `scripts/runtime/ffmpeg-bundled/` and are stored alongside `ffmpeg.exe` in the package. The Release's complete corresponding-source asset includes FFmpeg, the source code of the external libraries actually used, pinned source checksums and build scripts. Both `runtime.json` and the artifact receipt record this source asset's SHA-256; consistency must be checked and a download provided before public release. GitHub's automatically generated UFriend Source code ZIP does not contain these third-party sources and cannot replace this asset.

The Gyan optional installer's [source record](../../scripts/runtime/ffmpeg/SOURCES.md) and upstream documents remain in `scripts/runtime/ffmpeg/`. Packages without the component provide only an installer, through which users obtain the executable directly from Gyan. This list of upstream URLs cannot replace the complete source asset for the project's own build.

References: [Gyan build information](https://www.gyan.dev/ffmpeg/builds/) · [FFmpeg licensing information](https://ffmpeg.org/legal.html) · [Third-party notices](../../THIRD_PARTY_NOTICES.md)

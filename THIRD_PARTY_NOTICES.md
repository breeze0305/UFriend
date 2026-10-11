# Third-party software

The [MIT license](LICENSE) covers UFriend's own code. Third-party components retain their own copyrights and licenses.

- **Electron and Chromium**: folder packages retain Electron's `LICENSE` and `LICENSES.chromium.html` beside the application executable. The single-file portable EXE contains that application payload and expands it, including the notices, into its temporary run directory.
- **npm dependencies**: exact versions and declared licenses are recorded in `package-lock.json`. Production dependency license files are retained under `resources/app/node_modules` in the application payload.
- **Portable build tooling**: the single-file EXE is generated using the pinned electron-builder 26.17.0 NSIS portable target. Build dependencies are identified in the lockfile and retain their own licenses; they are separate from UFriend's project license.
- **FFmpeg**: the public portable EXE and the ZIP built with `--without-ffmpeg` do not include an FFmpeg binary. The optional installer downloads the pinned Gyan build directly from its publisher, or accepts an extracted official package selected by the user. That build is GPLv3. Its license, upstream notices, and provenance are provided in `scripts/runtime/ffmpeg` and retained beside the installed executable. An installation through Settings is stored in the Windows user data directory and survives application restarts and updates. See [FFmpeg runtime documentation](docs/development/FFMPEG_RUNTIME.md).

Redistribution of third-party binaries must comply with their own terms. The UFriend license does not replace or relicense those components.

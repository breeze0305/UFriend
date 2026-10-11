# Third-party software

The [MIT license](LICENSE) covers UFriend's own code. Third-party components retain their own copyrights and licenses.

- **Electron and Chromium**: folder packages retain Electron's `LICENSE` and `LICENSES.chromium.html` beside the application executable. The single-file EXE contains that application payload and expands it, including the notices, into its temporary run directory.
- **npm dependencies**: exact versions and declared licenses are recorded in `package-lock.json`. Production dependency license files are retained under `resources/app/node_modules` in the application payload.
- **Build tooling**: the single-file EXE is generated using the pinned electron-builder 26.17.0 NSIS portable target. Build dependencies are identified in the lockfile and retain their own licenses; they are separate from UFriend's project license.
- **Bundled FFmpeg**: the UFriend Windows release embeds a UFriend build of FFmpeg as a separate executable. It enables GPL components, including x264, and is provided under GPLv3. The executable is accompanied by the GPL text, `THIRD_PARTY_LICENSES.txt`, and source/build information from `scripts/runtime/ffmpeg-bundled`. The matching complete source archive, including the linked dependency sources and build scripts, is distributed beside the EXE on its GitHub Release. Its exact hash is recorded in the bundled runtime manifest. These terms do not relicense UFriend's independent MIT code.
- **Optional FFmpeg**: builds made without FFmpeg retain the optional installer, which downloads the pinned Gyan GPLv3 build directly from its publisher or accepts the user's extracted official package. Its distinct notices and manifest remain in `scripts/runtime/ffmpeg`. This path does not redistribute the Gyan executable. Installations through Settings remain in the Windows user data directory across app updates. See [FFmpeg runtime documentation](docs/development/FFMPEG_RUNTIME.md).

Redistribution of third-party binaries must comply with their own terms. The UFriend license does not replace or relicense those components.

# Third-party software

The MIT license in `LICENSE` covers UFriend. Third-party components retain
their own copyrights and licenses.

- **Electron and Chromium**: portable packages preserve Electron's `LICENSE`
  and `LICENSES.chromium.html` beside the executable.
- **npm dependencies**: exact versions and declared licenses are recorded in
  `package-lock.json`. Production dependency license files are retained under
  `resources/app/node_modules` in portable packages.
- **FFmpeg**: the public portable package does not include an FFmpeg binary.
  The optional media installer obtains the pinned Gyan build directly from its
  publisher. That build is GPLv3; its license, upstream notices and provenance
  are provided in `scripts/runtime/ffmpeg` and retained when installed. See
  [FFmpeg runtime documentation](docs/development/FFMPEG_RUNTIME.md).

Redistribution of third-party binaries must comply with their own terms. The
UFriend license does not replace or relicense those components.

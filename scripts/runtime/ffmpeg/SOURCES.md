# FFmpeg runtime provenance

UFriend runs this unmodified FFmpeg executable as a separate local process to
render subtitles and encode video. This document describes FFmpeg only; it does
not change the license of UFriend or its other dependencies.

- Distributor: Gyan Doshi, https://www.gyan.dev/ffmpeg/builds/
- Build: `8.1.2-essentials_build-www.gyan.dev`, Windows x64, static.
- License: GNU GPL version 3; the complete upstream license is in
  `COPYING.GPLv3.txt` beside this document.
- Original package:
  https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z
- Publisher SHA-256:
  https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z.sha256
- Original archive SHA-256:
  `e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6`
- Publisher release mirror:
  https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2
- FFmpeg source revision identified by the publisher's README:
  https://github.com/FFmpeg/FFmpeg/commit/38b88335f9
- FFmpeg source archive for that revision:
  https://github.com/FFmpeg/FFmpeg/archive/38b88335f9.tar.gz
- FFmpeg licensing information: https://ffmpeg.org/legal.html

`UPSTREAM-README.txt` is the complete, unmodified README from the same package.
It preserves the publisher's component inventory and external-library versions.
`runtime.json` records the expected executable hash, upstream-file hashes and
the complete configure line reported by the executable. The build includes
libass and libx264, with `--enable-gpl` and `--enable-version3`; it is not an
LGPL-only build. It is not configured with `--enable-nonfree`.

The source links and inventory above are provenance information, **not a
complete corresponding-source distribution**. The present UFriend build is a
local development deliverable. Before distributing a release to others, retain
and provide the exact corresponding source for FFmpeg and the included external
libraries, required build scripts and configuration, notices and applicable
licenses using a GPL-permitted distribution method. The FFmpeg archive alone
does not include all of those external libraries. Do not remove these notices
from a redistributed executable. No public source hosting or source-code offer
is created by this document.

This binary is provided without warranty as described in its GPL license.

# UFriend's Windows FFmpeg build

This recipe builds FFmpeg 8.1.2 with the `ufriend1` suffix from seven pinned
source archives. It includes x264, LAME, libass, FreeType, FriBidi and HarfBuzz.
The native FFmpeg codecs, formats and filters are kept where their prerequisites
are available. libass discovers installed Windows fonts through DirectWrite/GDI.
Network access, fontconfig, extra codec libraries and hardware SDKs are disabled.

The GitHub Actions workflow builds on Ubuntu 24.04, rejects any PE imports outside
Windows system DLLs, then runs both executables on Windows. The Windows job encodes
and decodes H.264/AAC, burns UTF-8 subtitles using DirectWrite, inspects metadata
with ffprobe, and prepares an MP3 segment plus CSV in the same format the app uses.
A compiled payload is not a verified release until that Windows job passes.

Install the generic build tools on Ubuntu 24.04:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential curl ca-certificates \
  xz-utils python3 meson ninja-build pkg-config nasm autoconf automake libtool \
  gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
  binutils-mingw-w64-x86-64 mingw-w64-tools
bash recipe/build.sh "$PWD/new-work" "$PWD/new-output" "$PWD/sources"
```

For a repository checkout, use `scripts/runtime/build/build.sh` in place of
`recipe/build.sh` and omit the final argument to download the pinned inputs. The
work and output directories must not already exist. The source package contains
all seven original input archives and can rebuild without fetching those inputs.
Build tools still need to be installed. Their exact versions and copyright files
are retained in `configuration/toolchain.txt` and `licenses/toolchain/`.

No upstream source patch is applied. Generated build files and compiler flags
are retained in `configuration/`. `build.sh` regenerates prefix-dependent files
for the chosen work directory. The runtime and source package include their
shared source inventory and build information; `build-receipt.json` binds both
archives by SHA-256. `windows-verification.json` records actual execution results.

The executables are GPL-3.0-or-later. The source package accompanies the binary
under GPL section 6(d). Unmodified general-purpose tools and Windows system
libraries are not part of the application source archive. Their applicable
notices, including compiler runtime exceptions, are preserved. FreeType is used
under the FreeType License. The build does not relicense UFriend's separate app.

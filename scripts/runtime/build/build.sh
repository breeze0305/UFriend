#!/usr/bin/env bash
# Build only in new directories. The optional third argument is an offline
# directory containing the exact source archives from sources.lock.json.
set -euo pipefail
RECIPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_ROOT="$(realpath -m -- "${1:?Pass a new build directory}")"
OUTPUT_ROOT="$(realpath -m -- "${2:?Pass a new output directory}")"
SOURCE_CACHE="${3:-}"
if [[ -e "$WORK_ROOT" || -e "$OUTPUT_ROOT" ]]; then
    echo 'Build and output directories must not already exist.' >&2
    exit 1
fi
mkdir -p "$WORK_ROOT" "$OUTPUT_ROOT"
exec > >(tee "$OUTPUT_ROOT/build.log") 2>&1
export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=1782568800
export CROSS=x86_64-w64-mingw32
export CC="$CROSS-gcc-posix" CXX="$CROSS-g++-posix"
export AR="$CROSS-ar" RANLIB="$CROSS-ranlib" STRIP="$CROSS-strip"
export CFLAGS='-O2 -pipe -fno-ident' CXXFLAGS='-O2 -pipe -fno-ident'
export LDFLAGS='-static -static-libgcc -static-libstdc++ -Wl,--no-insert-timestamp'
PREFIX="$WORK_ROOT/prefix"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH='' PKG_CONFIG_SYSROOT_DIR=''
JOBS="${JOBS:-$(nproc)}"
mkdir -p "$PREFIX" "$WORK_ROOT/configuration" "$WORK_ROOT/toolchain-licenses"
python3 "$RECIPE_DIR/package.py" fetch "$WORK_ROOT" "$SOURCE_CACHE"

cat > "$WORK_ROOT/cross.ini" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
windres = '$CROSS-windres'
nasm = 'nasm'
pkg-config = 'pkg-config'
[properties]
needs_exe_wrapper = true
pkg_config_libdir = ['$PKG_CONFIG_LIBDIR']
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
cp "$WORK_ROOT/cross.ini" "$WORK_ROOT/configuration/cross.ini"
{
    "$CC" --version
    "$CXX" --version
    "$CROSS-ld" --version
    meson --version
    ninja --version
    nasm -v
    python3 --version
    dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' \
        gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
        mingw-w64-common mingw-w64-x86-64-dev
} > "$WORK_ROOT/configuration/toolchain.txt"
for package in gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix mingw-w64-common mingw-w64-x86-64-dev; do
    cp -L "/usr/share/doc/$package/copyright" "$WORK_ROOT/toolchain-licenses/$package.txt"
done

meson_build() {
    local name="$1"; shift
    meson setup "$WORK_ROOT/build-$name" "$WORK_ROOT/src/$name" \
        --cross-file "$WORK_ROOT/cross.ini" --prefix "$PREFIX" --libdir lib \
        --buildtype release --default-library static --wrap-mode nofallback \
        -Dauto_features=disabled "$@"
    ninja -C "$WORK_ROOT/build-$name" -j "$JOBS"
    ninja -C "$WORK_ROOT/build-$name" install
    cp "$WORK_ROOT/build-$name/meson-info/intro-buildoptions.json" \
        "$WORK_ROOT/configuration/$name-buildoptions.json"
}
meson_build freetype -Dharfbuzz=disabled -Dbrotli=disabled -Dbzip2=disabled -Dpng=disabled -Dzlib=none -Dtests=disabled
meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
meson_build harfbuzz -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled \
    -Dfreetype=disabled -Dgraphite2=disabled -Dtests=disabled -Dutilities=disabled \
    -Ddocs=disabled -Dintrospection=disabled -Dwith_libstdcxx=false
meson_build libass -Ddirectwrite=enabled -Dfontconfig=disabled -Dcoretext=disabled \
    -Dlibunibreak=disabled -Dtest=disabled -Dcompare=disabled -Dprofile=disabled \
    -Dfuzz=disabled -Dcheckasm=disabled -Dasm=enabled

(
    cd "$WORK_ROOT/src/x264"
    ./configure --prefix="$PREFIX" --host="$CROSS" --cross-prefix="$CROSS-" \
        --enable-static --disable-cli --disable-opencl --disable-lavf --disable-swscale
    make -j "$JOBS"
    make install
    cp config.mak "$WORK_ROOT/configuration/x264-config.mak"
)
(
    cd "$WORK_ROOT/src/lame"
    ./configure --prefix="$PREFIX" --host="$CROSS" \
        --enable-static --disable-shared --disable-frontend --disable-decoder --disable-cpml
    make -j "$JOBS"
    make install
    cp config.log "$WORK_ROOT/configuration/lame-config.log"
)
(
    cd "$WORK_ROOT/src/ffmpeg"
    ./configure --prefix="$PREFIX" --target-os=mingw32 --arch=x86_64 \
        --cross-prefix="$CROSS-" --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" \
        --pkg-config=pkg-config --pkg-config-flags=--static \
        --extra-cflags="$CFLAGS -I$PREFIX/include" --extra-cxxflags="$CXXFLAGS -I$PREFIX/include" \
        --extra-ldflags="$LDFLAGS -L$PREFIX/lib" \
        --extra-version=ufriend1 --enable-gpl --enable-version3 \
        --enable-static --disable-shared --disable-autodetect --disable-doc --disable-debug \
        --disable-ffplay --disable-network --disable-pthreads --enable-w32threads \
        --enable-libass --enable-libx264 --enable-libmp3lame
    make -j "$JOBS"
    make install
    cp ffbuild/config.mak ffbuild/config.log config.h "$WORK_ROOT/configuration/"
)
python3 "$RECIPE_DIR/package.py" package "$WORK_ROOT" "$OUTPUT_ROOT"

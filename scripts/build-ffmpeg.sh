#!/usr/bin/env bash
set -euo pipefail

script=$(realpath "${BASH_SOURCE[0]}")
project=$(dirname "$(dirname "$script")")
destination="$project/src-tauri/media-tools/ffmpeg/dist"
ffmpeg_version=9.0.2
lame_version=3.100

if [[ -f "$destination/SHA256SUMS" ]] &&
    cmp -s "$script" "$destination/source/build-ffmpeg.sh" &&
    (cd "$destination" && sha256sum --check --status SHA256SUMS); then
    exit 0
fi

for tool in gcc make nasm diff curl; do
    if ! command -v "$tool" >/dev/null; then
        echo "Missing $tool. Install the MSYS2 UCRT64 build tools listed in README.md." >&2
        exit 1
    fi
done

build_root="$project/src-tauri/target/ffmpeg"
mkdir -p "$build_root"
build_root=$(realpath "$build_root")
work=$(mktemp -d "$build_root/build.XXXXXXXX")
trap '[[ "$(realpath "$work")" == "$build_root"/build.* ]] && rm -rf -- "$work"' EXIT
cd "$work"

ffmpeg_archive="ffmpeg-$ffmpeg_version.tar.xz"
lame_archive="lame_$lame_version.orig.tar.gz"
curl --fail --location --silent --show-error --retry 2 --output "$ffmpeg_archive" \
    "https://ffmpeg.org/releases/$ffmpeg_archive"
curl --fail --location --silent --show-error --retry 2 --output "$lame_archive" \
    "https://deb.debian.org/debian/pool/main/l/lame/$lame_archive"
sha256sum --check <<EOF
8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  $ffmpeg_archive
ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  $lame_archive
EOF
tar -xf "$ffmpeg_archive"
tar -xf "$lame_archive"

prefix="$work/install"
jobs=$(nproc)
(
    cd "lame-$lame_version"
    # Let MinGW export the symbols present in the library with the decoder disabled.
    sed -i '/^[[:space:]]*-export-symbols .*libmp3lame[.]sym /d' libmp3lame/Makefile.in
    ./configure --prefix="$prefix" --enable-shared --disable-static \
        --disable-frontend --disable-decoder --disable-dependency-tracking LDFLAGS=-static-libgcc
    make -j"$jobs"
    make install
)
(
    cd "ffmpeg-$ffmpeg_version"
    ./configure --prefix="$prefix" --enable-shared --disable-static \
        --disable-autodetect --enable-libmp3lame --enable-schannel \
        --disable-doc --disable-ffplay --disable-avdevice --disable-debug \
        --disable-encoders --enable-encoder=libmp3lame,pcm_s16le,wrapped_avframe \
        --extra-cflags=-I../install/include --extra-ldflags="-L../install/lib -static-libgcc"
    make -j"$jobs"
    make install
)

stage="$work/dist"
mkdir -p "$stage/bin" "$stage/source"
cp "$prefix/bin/ffmpeg.exe" "$prefix/bin/ffprobe.exe" "$prefix/bin/"*.dll "$stage/bin/"
cp /ucrt64/bin/libwinpthread-1.dll "$stage/bin/"
cp "$ffmpeg_archive" "$lame_archive" "$script" "$stage/source/"
cp "ffmpeg-$ffmpeg_version/COPYING.LGPLv2.1" "$stage/source/FFmpeg-LGPL-2.1.txt"
cp "lame-$lame_version/COPYING" "$stage/source/LAME-LGPL-2.1.txt"
cp /ucrt64/share/licenses/libwinpthread/COPYING "$stage/source/winpthreads-LICENSE.txt"
(cd "$stage" && sha256sum bin/* source/* > SHA256SUMS)

if [[ -e "$destination" ]]; then
    [[ "$(realpath "$destination")" == "$project/src-tauri/media-tools/ffmpeg/dist" ]]
    rm -rf -- "$destination"
fi
mv -T -- "$stage" "$destination"

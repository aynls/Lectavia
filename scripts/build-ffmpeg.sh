#!/usr/bin/env bash
set -euo pipefail

script=$(realpath "${BASH_SOURCE[0]}")
project=$(dirname "$(dirname "$script")")
destination="$project/src-tauri/media-tools/ffmpeg/dist"
ffmpeg_version=9.0.2
lame_version=3.100
exe_suffix=

case "$(uname -s)" in
    MSYS*|MINGW*|CYGWIN*)
        platform=windows
        exe_suffix=.exe
        jobs=$(nproc)
        checksum=(sha256sum)
        build_tools=(gcc make nasm diff curl)
        ;;
    Linux)
        platform=linux
        jobs=$(nproc)
        checksum=(sha256sum)
        build_tools=(gcc make nasm curl xz)
        ;;
    Darwin)
        platform=macos
        jobs=$(sysctl -n hw.logicalcpu)
        checksum=(shasum -a 256)
        build_tools=(clang make curl)
        export MACOSX_DEPLOYMENT_TARGET=11.0
        ;;
    *) echo 'Unsupported FFmpeg build platform.' >&2; exit 1 ;;
esac

if [[ -x "$destination/bin/ffmpeg$exe_suffix" && -f "$destination/SHA256SUMS" ]] &&
    cmp -s "$script" "$destination/source/build-ffmpeg.sh" &&
    (cd "$destination" && "${checksum[@]}" --check --status SHA256SUMS); then
    exit 0
fi

for tool in "${build_tools[@]}"; do
    if ! command -v "$tool" >/dev/null; then
        echo "Missing $tool. See the build dependencies in README.md." >&2
        exit 1
    fi
done

build_root=$(cd "${TMPDIR:-/tmp}" && pwd -P)
work=$(mktemp -d "$build_root/lectavia-ffmpeg.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
cd "$work"

ffmpeg_archive="ffmpeg-$ffmpeg_version.tar.xz"
lame_archive="lame_$lame_version.orig.tar.gz"
download_source() {
    local file=$1 url=$2
    if [[ -f "$destination/source/$file" ]]; then
        cp "$destination/source/$file" "$file"
    else
        curl --fail --location --silent --show-error --retry 2 --max-time 180 --output "$file" "$url"
    fi
}
download_source "$ffmpeg_archive" "https://ffmpeg.org/releases/$ffmpeg_archive"
download_source "$lame_archive" "https://deb.debian.org/debian/pool/main/l/lame/$lame_archive"
"${checksum[@]}" --check <<EOF
8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  $ffmpeg_archive
ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  $lame_archive
EOF
tar -xf "$ffmpeg_archive"
tar -xf "$lame_archive"

prefix="$work/install"
linkage=(--enable-static --disable-shared)
ffmpeg_flags=()
if [[ "$platform" == windows ]]; then
    linkage=(--enable-shared --disable-static)
    ffmpeg_flags=(--enable-schannel --extra-ldflags="-L../install/lib -static-libgcc")
else
    ffmpeg_flags=(--extra-ldflags=-L../install/lib)
    if [[ "$platform" == macos ]]; then
        # Apple SDK libraries handle TLS without adding a bundled library dependency.
        ffmpeg_flags+=(--enable-securetransport)
    fi
fi
(
    cd "lame-$lame_version"
    lame_flags=()
    if [[ "$platform" == windows ]]; then
        # Let MinGW export the symbols present in the library with the decoder disabled.
        sed -i '/^[[:space:]]*-export-symbols .*libmp3lame[.]sym /d' libmp3lame/Makefile.in
        export LDFLAGS=-static-libgcc
    elif [[ "$platform" == macos ]]; then
        # LAME 3.100 predates Apple Silicon and its config.guess emits arm-apple-darwin.
        lame_flags+=(--build=aarch64-apple-darwin)
        export CFLAGS='-O2 -std=gnu17 -Wno-implicit-function-declaration'
    fi
    ./configure --prefix="$prefix" "${linkage[@]}" "${lame_flags[@]}" \
        --disable-frontend --disable-decoder --disable-dependency-tracking
    make -j"$jobs"
    make install
)
(
    cd "ffmpeg-$ffmpeg_version"
    ./configure --prefix="$prefix" "${linkage[@]}" \
        --disable-autodetect --enable-libmp3lame \
        --disable-doc --disable-ffplay --disable-avdevice --disable-debug \
        --disable-encoders --enable-encoder=libmp3lame,pcm_s16le,wrapped_avframe \
        --extra-cflags=-I../install/include "${ffmpeg_flags[@]}"
    make -j"$jobs"
    make install
)

stage="$work/dist"
mkdir -p "$stage/bin" "$stage/source"
if [[ "$platform" == windows ]]; then
    cp "$prefix/bin/ffmpeg.exe" "$prefix/bin/ffprobe.exe" "$prefix/bin/"*.dll "$stage/bin/"
    cp /ucrt64/bin/libwinpthread-1.dll "$stage/bin/"
    cp /ucrt64/share/licenses/libwinpthread/COPYING "$stage/source/winpthreads-LICENSE.txt"
else
    install -m 755 "$prefix/bin/ffmpeg" "$prefix/bin/ffprobe" "$stage/bin/"
fi
cp "$ffmpeg_archive" "$lame_archive" "$script" "$stage/source/"
cp "ffmpeg-$ffmpeg_version/COPYING.LGPLv2.1" "$stage/source/FFmpeg-LGPL-2.1.txt"
cp "lame-$lame_version/COPYING" "$stage/source/LAME-LGPL-2.1.txt"
(cd "$stage" && "${checksum[@]}" bin/* source/* > SHA256SUMS)

if [[ -e "$destination" ]]; then
    [[ "$(realpath "$destination")" == "$project/src-tauri/media-tools/ffmpeg/dist" ]]
    rm -rf -- "$destination"
fi
mv -- "$stage" "$destination"

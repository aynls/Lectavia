#!/usr/bin/env bash
set -euo pipefail

project=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
destination="$project/src-tauri/media-tools/online/dist"
yt_dlp_version=2026.10.26
quickjs_version=0.18.0
python_version=3.14.10
python_release=20261110

case "$(uname -s):$(uname -m)" in
    Linux:x86_64)
        checksum=(sha256sum)
        python_target=x86_64-unknown-linux-gnu
        python_sha=c2ff2e97422f5d3896a16e0317fd212ba977bbf2688d93a6f7a03d817506bd30
        quickjs_asset=qjs-linux-x86_64
        quickjs_sha=85ded23b9fabe8c1644fc40a8d2bbdd71157affcbd807359c618cc717ee24d7d
        ;;
    Darwin:arm64)
        checksum=(shasum -a 256)
        python_target=aarch64-apple-darwin
        python_sha=f15ec3d15460dd66c2eb88639b152cd9040e7d1ece11e38bf89e8f53f0171e02
        quickjs_asset=qjs-darwin-arm64
        quickjs_sha=91fe89916d3b0a6c01c4dc8382a99c3c1fd91ecfc214aa81ca051902bcce590d
        ;;
    *) echo 'Bundled online media tools require Linux x64 or Apple Silicon macOS.' >&2; exit 1 ;;
esac

build_root=$(cd "${TMPDIR:-/tmp}" && pwd -P)
work=$(mktemp -d "$build_root/lectavia-online.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
cd "$work"
mkdir dist

download() {
    local file=$1 url=$2 sha=$3
    curl --fail --location --silent --show-error --retry 2 --retry-all-errors \
        --connect-timeout 15 --max-time 180 --output "$file" "$url"
    printf '%s  %s\n' "$sha" "$file" | "${checksum[@]}" --check
}

python_archive="cpython-$python_version%2B$python_release-$python_target-install_only_stripped.tar.gz"
download python.tar.gz \
    "https://github.com/astral-sh/python-build-standalone/releases/download/$python_release/$python_archive" \
    "$python_sha"
# The zip application contains yt-dlp's YouTube challenge scripts.
download dist/yt-dlp.pyz \
    "https://github.com/yt-dlp/yt-dlp/releases/download/$yt_dlp_version/yt-dlp" \
    e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3
download dist/qjs \
    "https://github.com/quickjs-ng/quickjs/releases/download/v$quickjs_version/$quickjs_asset" \
    "$quickjs_sha"
chmod 755 dist/qjs
download dist/yt-dlp-LICENSE.txt \
    "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$yt_dlp_version/LICENSE" \
    7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c
download dist/QuickJS-NG-LICENSE.txt \
    "https://raw.githubusercontent.com/quickjs-ng/quickjs/v$quickjs_version/LICENSE" \
    96f73f9d2a16c21a36b418f06073be26e7d6d5e7c1bc99756b21a4f2c74ef171

tar -xzf python.tar.gz -C dist
dist/qjs -e 'if (6 * 7 !== 42) throw new Error("QuickJS failed");'
dist/python/bin/python3.14 -I -B -c 'import ssl; ssl.create_default_context()'
dist/python/bin/python3.14 -I -B dist/yt-dlp.pyz --version

if [[ -e "$destination" ]]; then
    [[ "$(realpath "$destination")" == "$project/src-tauri/media-tools/online/dist" ]]
    rm -rf -- "$destination"
fi
mv -- dist "$destination"

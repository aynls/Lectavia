#!/usr/bin/env bash
set -euo pipefail

identity=${APPLE_SIGNING_IDENTITY:--}
if [[ "$identity" == '-' ]]; then
    exit 0
fi

project=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
media="$project/src-tauri/media-tools"
# Tauri signs the app bundle, but its opaque resources need to be signed first.
find "$media/ffmpeg/dist/bin" "$media/online/dist" -type f \( \
    -name ffmpeg -o -name ffprobe -o -name qjs -o -name python3.14 -o \
    -name '*.dylib' -o -name '*.so' \) -print0 |
    while IFS= read -r -d '' binary; do
        codesign --force --sign "$identity" --timestamp --options runtime "$binary"
    done

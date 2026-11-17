$ErrorActionPreference = 'Stop'

if ($env:TAURI_ENV_ARCH -and $env:TAURI_ENV_ARCH -ne 'x86_64') {
    throw 'The bundled FFmpeg build currently supports Windows x64.'
}

$msysRoot = $env:MSYS2_ROOT
if (-not $msysRoot) {
    $msysRoot = 'C:\msys64'
}
$bash = Join-Path $msysRoot 'usr\bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) {
    throw 'Install MSYS2 for the Windows build and set MSYS2_ROOT if it is outside C:\msys64. See README.md.'
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    & $bash -c 'MSYSTEM=UCRT64 PATH="/ucrt64/bin:/usr/bin:$PATH" bash scripts/build-ffmpeg.sh'
    if ($LASTEXITCODE -ne 0) {
        throw "Could not prepare bundled FFmpeg (exit $LASTEXITCODE)."
    }
} finally {
    Pop-Location
}

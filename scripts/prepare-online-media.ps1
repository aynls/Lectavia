$ErrorActionPreference = 'Stop'

# Use the modules from this PowerShell when a build inherits another version's module path.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1')

if ($env:TAURI_ENV_ARCH -and $env:TAURI_ENV_ARCH -ne 'x86_64') {
    throw 'The bundled online media tools currently support Windows x64.'
}

$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $project 'src-tauri/target/online-media'
$destination = Join-Path $project 'src-tauri/media-tools/online/dist'
$downloads = (New-Item -ItemType Directory -Path (Join-Path $buildRoot 'downloads') -Force).FullName
$work = (New-Item -ItemType Directory -Path (Join-Path $buildRoot ([guid]::NewGuid().ToString()))).FullName
$stage = Join-Path $work 'dist'

function Get-ReleaseAsset($Name, $Url, $Sha256) {
    $cached = Join-Path $downloads $Name
    if ((Test-Path -LiteralPath $cached -PathType Leaf) -and
        (Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash -eq $Sha256) {
        return $cached
    }

    $download = Join-Path $work $Name
    & curl.exe --fail --location --silent --show-error --retry 2 --max-time 120 --output $download $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Could not download $Name (exit $LASTEXITCODE)."
    }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $Sha256) {
        throw "SHA-256 mismatch for $Name."
    }
    [IO.File]::Copy($download, $cached, $true)
    return $download
}

function Assert-GeneratedDirectory($Path) {
    $directory = Get-Item -LiteralPath $Path
    if (-not $directory.PSIsContainer -or $directory.FullName -ne $Path -or
        ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected generated directory path: $Path"
    }
}

function Get-DistChecksums($Path) {
    $files = Get-ChildItem -LiteralPath $Path -File -Recurse | Sort-Object FullName
    $checksums = foreach ($file in $files) {
        $relativePath = $file.FullName.Substring($Path.Length + 1)
        "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) $relativePath"
    }
    return ($checksums -join "`n")
}

try {
    $ytDlpVersion = '2026.10.26'
    $pythonVersion = '3.14.10'
    $quickJsVersion = '0.18.0'
    $pythonArchive = "python-$pythonVersion-embed-amd64.zip"
    # The official ZIP application includes the YouTube challenge scripts.
    $ytDlp = Get-ReleaseAsset "yt-dlp-$ytDlpVersion" `
        "https://github.com/yt-dlp/yt-dlp/releases/download/$ytDlpVersion/yt-dlp" `
        'e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3'
    $python = Get-ReleaseAsset $pythonArchive `
        "https://www.python.org/ftp/python/$pythonVersion/$pythonArchive" `
        '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
    $quickJs = Get-ReleaseAsset "qjs-v$quickJsVersion-windows-x86_64.exe" `
        "https://github.com/quickjs-ng/quickjs/releases/download/v$quickJsVersion/qjs-windows-x86_64.exe" `
        'ff03398d74ea6e6bd3a8e58058f7003225abcac229d7d57775b7aaae812a49c7'
    $ytDlpLicense = Get-ReleaseAsset "yt-dlp-$ytDlpVersion-LICENSE.txt" `
        "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$ytDlpVersion/LICENSE" `
        '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c'
    $quickJsLicense = Get-ReleaseAsset "quickjs-ng-v$quickJsVersion-LICENSE.txt" `
        "https://raw.githubusercontent.com/quickjs-ng/quickjs/v$quickJsVersion/LICENSE" `
        '96f73f9d2a16c21a36b418f06073be26e7d6d5e7c1bc99756b21a4f2c74ef171'

    Expand-Archive -LiteralPath $python -DestinationPath (Join-Path $stage 'python')
    Copy-Item -LiteralPath $ytDlp -Destination (Join-Path $stage 'yt-dlp.pyz')
    Copy-Item -LiteralPath $quickJs -Destination (Join-Path $stage 'qjs.exe')
    Copy-Item -LiteralPath $ytDlpLicense -Destination (Join-Path $stage 'yt-dlp-LICENSE.txt')
    Copy-Item -LiteralPath $quickJsLicense -Destination (Join-Path $stage 'QuickJS-NG-LICENSE.txt')

    Assert-GeneratedDirectory $stage
    $previous = Join-Path $work 'previous-dist'
    if (Test-Path -LiteralPath $destination) {
        Assert-GeneratedDirectory $destination
        if ((Get-DistChecksums $destination) -eq (Get-DistChecksums $stage)) {
            return
        }
        [IO.Directory]::Move($destination, $previous)
    }
    try {
        [IO.Directory]::Move($stage, $destination)
    } catch {
        if (Test-Path -LiteralPath $previous) {
            [IO.Directory]::Move($previous, $destination)
        }
        throw
    }
} finally {
    Assert-GeneratedDirectory $work
    Remove-Item -LiteralPath $work -Recurse
}

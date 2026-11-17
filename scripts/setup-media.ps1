$ErrorActionPreference = 'Stop'

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'WinGet is required. Install App Installer or put yt-dlp, FFmpeg, and Deno on PATH manually.'
}

$tools = @(
    @{ Command = 'ffmpeg.exe'; Package = 'Gyan.FFmpeg' }
    @{ Command = 'yt-dlp.exe'; Package = 'yt-dlp.yt-dlp' }
)

$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
$hasSupportedNode = $false
if ($node) {
    $nodeVersion = & $node.Source --version
    $hasSupportedNode = $LASTEXITCODE -eq 0 -and $nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22
}
if (-not $hasSupportedNode) {
    $tools += @{ Command = 'deno.exe'; Package = 'DenoLand.Deno' }
}

foreach ($tool in $tools) {
    if (Get-Command $tool.Command -ErrorAction SilentlyContinue) { continue }
    & winget.exe install --exact --id $tool.Package --source winget
    if ($LASTEXITCODE -ne 0) {
        throw "Could not install $($tool.Package) with WinGet (exit $LASTEXITCODE)."
    }
}

Write-Host 'Open a new terminal or restart Lectavia to pick up the installed tools.'

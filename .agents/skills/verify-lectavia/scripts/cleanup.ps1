$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$runDir = Join-Path $PSScriptRoot "..\run"
$instancePath = Join-Path $runDir "instance.json"
$targetPath = Join-Path $runDir "target.json"
$drive = Join-Path $PSScriptRoot "drive.js"
if (-not (Test-Path -LiteralPath $runDir)) { return }

# Keep the window and its identity available for a retry if either restore fails.
$failures = @()
if (Test-Path -LiteralPath (Join-Path $runDir "language-backup.json")) {
    try {
        & node $drive restore-language
        if ($LASTEXITCODE -ne 0) { throw "Language restore failed." }
    }
    catch { $failures += $_.Exception.Message }
}
if (Test-Path -LiteralPath (Join-Path $runDir "audio-chunk-backup.json")) {
    try {
        & node $drive restore-audio
        if ($LASTEXITCODE -ne 0) { throw "Audio chunk restore failed." }
    }
    catch { $failures += $_.Exception.Message }
}
if ($failures.Count) { throw ($failures -join [Environment]::NewLine) }

if (Test-Path -LiteralPath $instancePath) {
    $instance = Get-Content -Raw -LiteralPath $instancePath | ConvertFrom-Json
    $processes = @($instance.processes)
    if (Test-Path -LiteralPath $targetPath) {
        $binding = Get-Content -Raw -LiteralPath $targetPath | ConvertFrom-Json
        $processes += $binding.browser
    }
    foreach ($item in $processes) {
        if (-not $item.created -or [int]$item.pid -le 0) { throw "Invalid process record." }
        $live = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$item.pid)"
        if (-not $live -or $live.CreationDate.ToUniversalTime().Ticks.ToString() -ne $item.created) { continue }
        & taskkill.exe /PID $item.pid /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$item.pid)"
            if ($remaining -and $remaining.CreationDate -eq $live.CreationDate) {
                throw "Could not stop recorded process $($item.pid). Kept $instancePath."
            }
        }
    }
    Remove-Item -LiteralPath $instancePath
}
if (Test-Path -LiteralPath $targetPath) { Remove-Item -LiteralPath $targetPath }
[IO.Directory]::Delete($runDir, $false)
Write-Output "cleanup complete"

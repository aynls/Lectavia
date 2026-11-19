$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$SkillRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RepoRoot = Resolve-Path (Join-Path $SkillRoot "..\..\..")
$RunDir = Join-Path $SkillRoot "run"
$InstancePath = Join-Path $RunDir "instance.json"
$Drive = Join-Path $PSScriptRoot "drive.js"

function Write-JsonFile([string] $Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 6
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $temp = Join-Path $RunDir ([IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($temp, $json + "`n", $utf8)
        if ([IO.File]::Exists($Path)) {
            # Replace can fail transiently when another reader holds the file.
            for ($attempt = 0; $attempt -lt 5; $attempt++) {
                try {
                    [IO.File]::Replace($temp, $Path, [NullString]::Value)
                    break
                }
                catch [IO.IOException] {
                    if ($attempt -eq 4) { throw }
                    Start-Sleep -Milliseconds 300
                }
            }
        }
        else { [IO.File]::Move($temp, $Path) }
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
    }
}

function Format-Created($Date) {
    return $Date.ToUniversalTime().Ticks.ToString()
}

function Test-Listening([int] $Port) {
    return $Port -in [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
}

function Get-ProcessTree([int] $RootPid) {
    $all = Get-CimInstance Win32_Process
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($RootPid)
    $seen = @{}
    $found = @()
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        $proc = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
        if ($proc) { $found += $proc }
        foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $id })) {
            $queue.Enqueue([int] $child.ProcessId)
        }
    }
    return $found
}

if (Test-Path -LiteralPath $RunDir) {
    throw "A verification run or backup exists. Finish cleanup before launching another."
}
if (Get-Process -Name "lectavia" -ErrorAction SilentlyContinue) {
    throw "lectavia.exe is already running. Refusing to open a second window on the shared WebView profile."
}
foreach ($port in 1420, 9222) {
    if (Test-Listening $port) {
        throw "Port $port is already in use."
    }
}
if ($env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -match "remote-debugging-port") {
    throw "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS already sets a remote debugging port."
}

New-Item -ItemType Directory -Path $RunDir | Out-Null
$runId = [guid]::NewGuid().ToString("N")
$browserArgs = "--remote-debugging-port=9222 --lectavia-verify-run=$runId"
if ($env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
    $browserArgs = "$($env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) $browserArgs"
}

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = "cmd.exe"
$start.Arguments = "/d /c pnpm tauri dev"
$start.WorkingDirectory = $RepoRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.EnvironmentVariables["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = $browserArgs
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $start
$launched = $false
try {
    $launched = $process.Start()
    if (-not $launched) {
        throw "Could not start pnpm tauri dev."
    }

    $rootLive = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    $startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss")
    Write-JsonFile $InstancePath @{
        runId     = $runId
        pid       = $process.Id
        startedAt = $startedAt
        cdp       = "http://127.0.0.1:9222"
        url       = "http://127.0.0.1:1420/"
        root      = "$RepoRoot"
        processes = @(@{
                pid     = [int] $process.Id
                name    = "cmd.exe"
                created = Format-Created $rootLive.CreationDate
            })
    }

    $deadline = (Get-Date).AddMinutes(10)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) {
            throw "pnpm tauri dev exited before Lectavia was ready (code $($process.ExitCode))."
        }
        & node $Drive doctor --bind
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        if ($LASTEXITCODE -ne 2) { throw "Verification window identity check failed." }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        throw "Lectavia did not become ready within 10 minutes."
    }

    $tree = Get-ProcessTree $process.Id
    $recorded = foreach ($item in $tree) {
        @{
            pid     = [int] $item.ProcessId
            name    = [string] $item.Name
            created = Format-Created $item.CreationDate
        }
    }
    Write-JsonFile $InstancePath @{
        runId     = $runId
        pid       = $process.Id
        startedAt = $startedAt
        cdp       = "http://127.0.0.1:9222"
        url       = "http://127.0.0.1:1420/"
        root      = "$RepoRoot"
        processes = @($recorded)
    }
}
catch {
    if (-not (Test-Path -LiteralPath $InstancePath) -and $launched -and -not $process.HasExited) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
    }
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "cleanup.ps1")
    throw
}

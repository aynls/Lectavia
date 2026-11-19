param(
    [Parameter(Mandatory)][int] $RootPid,
    [Parameter(Mandatory)][string] $RootCreated,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string] $RunId
)

$ErrorActionPreference = "Stop"
$listeners = @(Get-NetTCPConnection -LocalPort 9222 -State Listen |
    Select-Object -ExpandProperty OwningProcess -Unique)
if ($listeners.Count -ne 1) { throw "Expected one WebView debugging listener." }
$root = Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid"
if (-not $root -or $root.CreationDate.ToUniversalTime().Ticks.ToString() -ne $RootCreated) {
    throw "The recorded launch process is no longer running."
}
$browser = Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0])"
if (-not $browser -or $browser.CreationDate -lt $root.CreationDate) { throw "Debug listener predates this run." }
$record = @{ pid = [int]$browser.ProcessId; created = $browser.CreationDate.ToUniversalTime().Ticks.ToString() }
# Chromium may relaunch through a short-lived parent. The launch-specific switch
# still identifies the listener when that intermediate process has disappeared.
if ($browser.CommandLine -match "(?:^|\s)--lectavia-verify-run=$RunId(?:\s|$)") {
    $record | ConvertTo-Json -Compress
    return
}

$processId = $listeners[0]
$seen = @{}
$appSeen = $false
$childCreated = [long]::MaxValue
while ($processId -gt 0 -and -not $seen.ContainsKey($processId)) {
    $seen[$processId] = $true
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $process) { break }
    $created = $process.CreationDate.ToUniversalTime().Ticks
    if ($created -gt $childCreated) { break }
    if ($process.Name -eq "lectavia.exe") { $appSeen = $true }
    if ($processId -eq $RootPid) {
        if ($appSeen -and $created.ToString() -eq $RootCreated) {
            $record | ConvertTo-Json -Compress
            return
        }
        break
    }
    $childCreated = $created
    $processId = $process.ParentProcessId
}
throw "Port 9222 does not belong to the recorded Lectavia launch."

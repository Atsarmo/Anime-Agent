param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [ValidateSet('codex', 'openai')][string]$Mode = 'codex',
    [ValidateRange(0, 60)][int]$DelaySeconds = 0
)

$ErrorActionPreference = 'Stop'
$petRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$logDir = Join-Path $runtimeRoot '.local\autostart'
[void][IO.Directory]::CreateDirectory($logDir)
$logFile = Join-Path $logDir 'startup.log'
function Write-StartupLog([string]$Message) {
    Add-Content -LiteralPath $logFile -Value ('{0:o} {1}' -f [DateTimeOffset]::Now, $Message)
}
function Get-PetMain {
    $mainPath = Join-Path $petRoot 'desktop\electron\main.mjs'
    @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($mainPath) -and
        $_.CommandLine -notmatch '--type[= ]|--preview|--smoke-test'
    })
}

$hash = [Security.Cryptography.SHA256]::Create()
$key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($petRoot))).Replace('-', '')
$hash.Dispose()
$mutex = New-Object Threading.Mutex($false, ('Local\AnimeAgentStartup-' + $key))
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    if (@(Get-PetMain).Count -gt 0) { Write-StartupLog 'Already running; skipped duplicate launch.'; exit 0 }
    $launcher = Join-Path $PSScriptRoot $(if ($Mode -eq 'codex') { 'start-codex-chat.mjs' } else { 'start-openai.mjs' })
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not ((Test-Path -LiteralPath $NodePath -PathType Leaf) -and (Test-Path -LiteralPath $launcher -PathType Leaf))) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Startup paths unavailable.' }
        Start-Sleep -Seconds 2
    }
    Write-StartupLog ('Launching in ' + $Mode + ' mode.')
    Push-Location $petRoot
    try {
        # The Node launcher detaches Electron and the selected voice service.
        & $NodePath $launcher 1>$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Launcher failed.' }
    } finally { Pop-Location }
    $backendPath = Join-Path $petRoot 'app\openai-backend.mjs'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $main = @(Get-PetMain)
        $backend = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($backendPath) -and
            $_.ParentProcessId -in $main.ProcessId
        })
        foreach ($process in $backend) {
            $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $process.ProcessId -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' })
            foreach ($port in $ports) {
                try {
                    $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $port.LocalPort + '/') -TimeoutSec 3
                    if ($response.StatusCode -eq 200) {
                        Write-StartupLog ('Ready: desktop PID {0}; backend PID {1}.' -f $main[0].ProcessId, $process.ProcessId)
                        exit 0
                    }
                } catch { }
            }
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Desktop or backend did not become ready.'
} catch {
    # Keep credentials, environment and command output out of the startup log.
    Write-StartupLog ('Failed: ' + $_.Exception.GetType().Name)
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

param(
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [ValidateSet('codex', 'openai')][string]$Mode = 'codex'
)
$ErrorActionPreference = 'Stop'
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$runner = Join-Path $PSScriptRoot 'start-at-logon.ps1'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskName = 'Anime-Agent-DesktopPet-' + $identity.User.Value
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}" -Mode {2}' -f $runner, $NodePath, $Mode
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$trigger.Delay = 'PT20S'
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Anime-Agent Desktop Pet.lnk'
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start Anime-Agent desktop pet 20 seconds after this user signs in.' -Force -ErrorAction Stop | Select-Object TaskName, State
    if (Test-Path -LiteralPath $startupLink) { Remove-Item -LiteralPath $startupLink }
} catch {
    # A per-user Startup shortcut also works without task registration rights.
    # Do not install a second entry if an existing task could not be updated.
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLink)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = $arguments + ' -DelaySeconds 20'
    $shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Start Anime-Agent desktop pet after signing in.'
    $shortcut.Save()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
    [pscustomobject]@{ StartupShortcut = $startupLink; Mode = $Mode; DelaySeconds = 20 }
}

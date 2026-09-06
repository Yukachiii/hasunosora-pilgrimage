[CmdletBinding()]
param(
    [ValidateRange(1, 60)]
    [int]$IntervalMinutes = 1
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdministrator) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $PSCommandPath),
        "-IntervalMinutes", [string]$IntervalMinutes
    )
    $process = Start-Process `
        -FilePath "powershell.exe" `
        -Verb RunAs `
        -ArgumentList $arguments `
        -Wait `
        -PassThru
    exit $process.ExitCode
}

$ProjectDir = [IO.Path]::GetFullPath($PSScriptRoot)
$UpdaterFile = [IO.Path]::GetFullPath((Join-Path $ProjectDir "update-community.ps1"))
$ServerFile = [IO.Path]::GetFullPath((Join-Path $ProjectDir "community-server.mjs"))
$ReceiverTaskName = "Hasunosora Community Receiver"
$UpdaterTaskName = "Hasunosora Community Auto Update"

if (-not (Test-Path -LiteralPath $UpdaterFile -PathType Leaf)) {
    throw "update-community.ps1 was not found."
}

$receiverTask = Get-ScheduledTask -TaskName $ReceiverTaskName -ErrorAction Stop
$receiverActions = @($receiverTask.Actions)
if ($receiverActions.Count -ne 1) {
    throw "The receiver task must have exactly one action."
}
$receiverExecutable = [Environment]::ExpandEnvironmentVariables(
    ([string]$receiverActions[0].Execute).Trim()
).Trim('"')
$receiverArguments = [Environment]::ExpandEnvironmentVariables(
    ([string]$receiverActions[0].Arguments).Trim()
).Trim('"')
$receiverWorkingDirectory = [Environment]::ExpandEnvironmentVariables(
    ([string]$receiverActions[0].WorkingDirectory).Trim()
)
if (([IO.Path]::GetFileName($receiverExecutable) -ine "node.exe") -or
    ([IO.Path]::GetFullPath($receiverArguments) -ne $ServerFile) -or
    ([IO.Path]::GetFullPath($receiverWorkingDirectory) -ne $ProjectDir)) {
    throw "The receiver task does not point to this project."
}

$PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$GitExe = (Get-Command git.exe -ErrorAction Stop).Source
$NpmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
$UpdaterArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
    ('-File "{0}" -GitExe "{1}" -NpmExe "{2}" -ReceiverTaskName "{3}"' -f `
        $UpdaterFile, $GitExe, $NpmExe, $ReceiverTaskName)

$action = New-ScheduledTaskAction `
    -Execute $PowerShellExe `
    -Argument $UpdaterArguments `
    -WorkingDirectory $ProjectDir
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$recurringTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

$parameters = @{
    TaskName = $UpdaterTaskName
    Action = $action
    Trigger = @($startupTrigger, $recurringTrigger)
    Settings = $settings
    Principal = $taskPrincipal
    Description = "Pull trusted main updates and restart the Hasunosora community receiver."
    Force = $true
}
Register-ScheduledTask @parameters | Out-Null
Start-ScheduledTask -TaskName $UpdaterTaskName

for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Seconds 1
    $state = (Get-ScheduledTask -TaskName $UpdaterTaskName).State
    if (($state -ne "Running") -and ($state -ne "Queued")) {
        break
    }
}
$taskInfo = Get-ScheduledTaskInfo -TaskName $UpdaterTaskName
if (($state -ne "Running") -and
    ($state -ne "Queued") -and
    ($taskInfo.LastTaskResult -ne 0)) {
    throw "The initial automatic update check failed. Review the private update log."
}

Write-Host "Automatic community updates are enabled." -ForegroundColor Green
Write-Host "Task: $UpdaterTaskName"
Write-Host "Interval: every $IntervalMinutes minute(s), plus system startup"
Write-Host "Log: $(Join-Path $ProjectDir 'private\community-update\update.log')"

[CmdletBinding()]
param(
    [string]$StartupDirectory = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ProjectDir = [IO.Path]::GetFullPath($PSScriptRoot)
$ServerBatch = [IO.Path]::GetFullPath((Join-Path $ProjectDir "start-admin-server.bat"))
if (-not $StartupDirectory) {
    $StartupDirectory = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::Startup,
        [Environment+SpecialFolderOption]::DoNotVerify
    )
}
if (-not (Test-Path -LiteralPath $ServerBatch -PathType Leaf)) {
    throw "start-admin-server.bat was not found in the project directory."
}
if (-not $StartupDirectory) {
    throw "The Windows Startup folder could not be resolved."
}
$StartupDirectory = [IO.Path]::GetFullPath($StartupDirectory)
New-Item -ItemType Directory -Path $StartupDirectory -Force | Out-Null

$LauncherFile = Join-Path $StartupDirectory "Hasunosora Admin Server.lnk"
$LegacyLauncherFile = Join-Path $StartupDirectory "Hasunosora Admin Server.cmd"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($LauncherFile)
$shortcut.TargetPath = $ServerBatch
$shortcut.WorkingDirectory = $ProjectDir
$shortcut.WindowStyle = 1
$shortcut.Description = "Start the Hasunosora admin server in a visible window."
$shortcut.Save()

if (Test-Path -LiteralPath $LegacyLauncherFile -PathType Leaf) {
    Remove-Item -LiteralPath $LegacyLauncherFile -Force
}

Write-Host "Admin server startup was enabled." -ForegroundColor Green
Write-Host "Startup entry: $LauncherFile"
Write-Host "Server launcher: $ServerBatch"
Write-Host "It will open in a visible window after this Windows user logs on."
Write-Host "To start it now, double-click start-admin-server.bat."

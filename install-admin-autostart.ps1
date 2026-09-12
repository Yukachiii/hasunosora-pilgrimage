[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ProjectDir = [IO.Path]::GetFullPath($PSScriptRoot)
$ServerBatch = [IO.Path]::GetFullPath((Join-Path $ProjectDir "start-admin-server.bat"))
$StartupDirectory = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Startup
)
if (-not (Test-Path -LiteralPath $ServerBatch -PathType Leaf)) {
    throw "start-admin-server.bat was not found in the project directory."
}
if (-not $StartupDirectory) {
    throw "The Windows Startup folder could not be resolved."
}

$LauncherFile = Join-Path $StartupDirectory "Hasunosora Admin Server.cmd"
$launcherLines = @(
    "@echo off",
    ('call "{0}"' -f $ServerBatch)
)
Set-Content `
    -LiteralPath $LauncherFile `
    -Value $launcherLines `
    -Encoding ASCII

Write-Host "Admin server startup was enabled." -ForegroundColor Green
Write-Host "Startup entry: $LauncherFile"
Write-Host "Server launcher: $ServerBatch"
Write-Host "It will open in a visible window after this Windows user logs on."
Write-Host "To start it now, double-click start-admin-server.bat."


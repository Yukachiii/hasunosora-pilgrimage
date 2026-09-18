[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8766
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProjectDir = [IO.Path]::GetFullPath($PSScriptRoot)
$StateDirectory = Join-Path $ProjectDir "private\community-update"
$DependencyLockFile = Join-Path $StateDirectory "dependencies.lock"
$DependencyPendingFile = Join-Path $StateDirectory "dependencies-pending.txt"
$DependencyLock = $null

function Test-AdminRunning {
    try {
        $identity = Invoke-RestMethod -Uri "http://127.0.0.1:${Port}/api/admin/identity" -TimeoutSec 2
        return $identity.application -eq "hasunosora-pilgrimage-admin" -and $identity.schemaVersion -eq 1
    }
    catch { return $false }
}

try {
    Set-Location -LiteralPath $ProjectDir
    $Host.UI.RawUI.WindowTitle = "Hasunosora Admin Server - 127.0.0.1:$Port"
    $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $NpmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null

    # A shared OS handle covers both Vite and the full lifetime of node.exe.
    # The updater needs an exclusive handle before it may replace node_modules.
    $waitingMessageShown = $false
    while ($null -eq $DependencyLock) {
        try {
            $DependencyLock = [IO.File]::Open($DependencyLockFile,
                [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
        }
        catch [IO.IOException] {}
        if (($null -ne $DependencyLock) -and (Test-Path -LiteralPath $DependencyPendingFile)) {
            $DependencyLock.Dispose()
            $DependencyLock = $null
        }
        if ($null -eq $DependencyLock) {
            if (-not $waitingMessageShown) {
                Write-Host "Waiting for the community updater to finish installing dependencies..."
                $waitingMessageShown = $true
            }
            Start-Sleep -Seconds 1
        }
    }

    while ($true) {
        if (Test-AdminRunning) {
            Write-Host "The Hasunosora admin server is already running."
            Write-Host "http://127.0.0.1:$Port/admin/"
            $DependencyLock.Dispose()
            $DependencyLock = $null
            Read-Host "Press Enter to close" | Out-Null
            exit 0
        }
        Write-Host "Hasunosora Admin Server"
        Write-Host "Building the admin page..."
        $ErrorActionPreference = "Continue"
        & $NpmExe run build:admin
        $buildExitCode = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        if ($buildExitCode -ne 0) {
            Write-Host "The admin build failed. Retrying in 15 seconds."
            Start-Sleep -Seconds 15
            continue
        }

        Write-Host ""
        Write-Host "STATUS : RUNNING"
        Write-Host "ADMIN  : http://127.0.0.1:$Port/admin/"
        Write-Host "ACCESS : SSH tunnel only"
        Write-Host "Keep this window open. Closing it stops the admin server."
        $ErrorActionPreference = "Continue"
        & $NodeExe (Join-Path $ProjectDir "server.mjs") --bind 127.0.0.1 --port $Port
        $adminExitCode = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        if ($adminExitCode -eq 0) {
            Write-Host "The admin server stopped normally."
            Start-Sleep -Seconds 3
            exit 0
        }
        Write-Host "The admin server stopped with exit code $adminExitCode. Retrying in 5 seconds."
        Start-Sleep -Seconds 5
    }
}
catch {
    Write-Host "Admin startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Install Node.js 22.18 or later if Node.js or npm was not found."
    exit 1
}
finally {
    if ($null -ne $DependencyLock) { $DependencyLock.Dispose() }
}

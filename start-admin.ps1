param(
    [ValidateSet("admin", "no-open", "local", "local-no-open")]
    [string]$Mode = "admin"
)

$BindHost = "0.0.0.0"
$HostName = "127.0.0.1"
$Port = 8766
$AdminApplication = "hasunosora-pilgrimage-admin"
$SshTarget = "yuimarine@192.168.0.4"
$UseSshTunnel = $Mode -eq "admin" -or $Mode -eq "no-open"
$OpenBrowser = $Mode -ne "no-open" -and $Mode -ne "local-no-open"

$AdminUrl = "http://${HostName}:${Port}/admin/"
Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Hasunosora Pilgrimage Admin"

function Test-PortInUse([int]$CandidatePort) {
    $listener = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $CandidatePort } |
        Select-Object -First 1
    return $null -ne $listener
}

function Test-AdminServer([int]$CandidatePort) {
    try {
        $identity = Invoke-RestMethod `
            -Uri "http://${HostName}:${CandidatePort}/api/admin/identity" `
            -TimeoutSec 1
        return $identity.application -eq $AdminApplication -and
            $identity.schemaVersion -eq 1
    }
    catch {
        return $false
    }
}

function Start-VerifiedAdminBrowser([int]$TimeoutSeconds) {
    if (-not $OpenBrowser) {
        return
    }

    $IdentityUrl = "http://${HostName}:${Port}/api/admin/identity"
    $browserCommand = @"
`$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt `$deadline) {
    try {
        `$identity = Invoke-RestMethod -Uri '$IdentityUrl' -TimeoutSec 1
        if (`$identity.application -eq '$AdminApplication' -and `$identity.schemaVersion -eq 1) {
            Start-Process '$AdminUrl'
            exit 0
        }
    }
    catch {}
    Start-Sleep -Milliseconds 250
}
"@
    $encodedBrowserCommand = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($browserCommand)
    )
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-EncodedCommand", $encodedBrowserCommand
    )
}

if ((Test-PortInUse $Port) -and (Test-AdminServer $Port)) {
    Write-Host "The admin page is already available: $AdminUrl"
    if ($OpenBrowser) {
        Start-Process $AdminUrl
    }
    exit 0
}

if (Test-PortInUse $Port) {
    Write-Host "Port $Port is used by another application." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

if ($UseSshTunnel) {
    $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if (-not $ssh) {
        Write-Host "OpenSSH client was not found. Enable it in Windows Optional Features." -ForegroundColor Red
        Read-Host "Press Enter to close"
        exit 1
    }

    Write-Host "Connecting to the admin server through SSH..."
    Write-Host "Tunnel: 127.0.0.1:${Port} -> ${SshTarget}:127.0.0.1:${Port}"
    Write-Host "The remote admin server must already be running on port ${Port}."
    Write-Host "Enter the SSH password if prompted. Press Ctrl+C to close the tunnel."
    Write-Host ""

    Start-VerifiedAdminBrowser 120
    & $ssh.Source `
        "-N" `
        "-L" "${Port}:127.0.0.1:${Port}" `
        "-o" "ExitOnForwardFailure=yes" `
        "-o" "ServerAliveInterval=30" `
        "-o" "ServerAliveCountMax=3" `
        $SshTarget
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host "The SSH tunnel ended or could not be started." -ForegroundColor Red
        Read-Host "Press Enter to close"
    }
    exit $exitCode
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "Node.js was not found. Please install Node.js first." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Preparing the local admin page..."
& $npm.Source run build:admin
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to prepare the local admin page." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Admin page (PC): $AdminUrl"
Write-Host "Press Ctrl+C or close this window to stop the server."
Write-Host ""

Start-VerifiedAdminBrowser 10

& node.exe "server.mjs" "--bind" $BindHost "--port" $Port
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "Failed to start the local admin server." -ForegroundColor Red
    Read-Host "Press Enter to close"
}
exit $exitCode

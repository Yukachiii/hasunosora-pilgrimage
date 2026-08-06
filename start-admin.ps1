param(
    [ValidateSet("admin", "no-open")]
    [string]$Mode = "admin"
)

$BindHost = "0.0.0.0"
$HostName = "127.0.0.1"
$Port = 8765
$AdminUrl = "http://${HostName}:${Port}/admin/"
$OpenBrowser = $Mode -ne "no-open"

$LanAddress = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.NetAdapter.Status -eq "Up" -and $_.IPv4DefaultGateway } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } |
    Select-Object -First 1
$LanUrl = if ($LanAddress) { "http://${LanAddress}:${Port}/admin/" } else { $null }

Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Hasunosora Pilgrimage Local Admin"

function Test-AdminServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $AdminUrl -TimeoutSec 1
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

if (Test-AdminServer) {
    Write-Host "The local admin server is already running: $AdminUrl"
    if ($OpenBrowser) {
        Start-Process $AdminUrl
    }
    exit 0
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
if ($LanUrl) {
    Write-Host "Admin page (same Wi-Fi): $LanUrl" -ForegroundColor Cyan
    Write-Host "Use only on a trusted private Wi-Fi network."
}
Write-Host "Press Ctrl+C or close this window to stop the server."
Write-Host ""

if ($OpenBrowser) {
    $browserCommand = "Start-Sleep -Milliseconds 800; Start-Process '$AdminUrl'"
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-Command", $browserCommand
    )
}

& node.exe "server.mjs" "--bind" $BindHost "--port" $Port
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "Failed to start the local admin server." -ForegroundColor Red
    Read-Host "Press Enter to close"
}
exit $exitCode

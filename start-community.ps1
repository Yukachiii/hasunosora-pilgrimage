Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Hasunosora Community Submission Receiver"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "Node.js 22.18 or later was not found." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Starting the private community submission receiver..."
Write-Host "The receiver listens only on 127.0.0.1 (default port: 8790)." -ForegroundColor Cyan
Write-Host "Expose this port only through an HTTPS reverse proxy or Cloudflare Tunnel."
Write-Host "Never expose the admin port (8765) to the Internet." -ForegroundColor Yellow
Write-Host "Press Ctrl+C or close this window to stop the receiver."
Write-Host ""

& $npm.Source run community
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "The community submission receiver stopped with an error." -ForegroundColor Red
    Read-Host "Press Enter to close"
}
exit $exitCode

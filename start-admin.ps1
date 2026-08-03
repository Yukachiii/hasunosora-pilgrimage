param(
    [ValidateSet("admin", "no-open")]
    [string]$Mode = "admin"
)

$HostName = "127.0.0.1"
$Port = 8765
$AdminUrl = "http://${HostName}:${Port}/admin/"
$OpenBrowser = $Mode -ne "no-open"

Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Hasunosora Pilgrimage Local Admin"

function Test-AdminServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $AdminUrl -TimeoutSec 1
        return $response.StatusCode -eq 200 -and $response.Content -match "蓮ノ旅 管理室"
    }
    catch {
        return $false
    }
}

if (Test-AdminServer) {
    Write-Host "管理サーバーは既に起動しています: $AdminUrl"
    if ($OpenBrowser) {
        Start-Process $AdminUrl
    }
    exit 0
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "Node.jsが見つかりません。" -ForegroundColor Red
    Read-Host "Enterキーで閉じる"
    exit 1
}

Write-Host "ローカル管理画面を準備しています…"
& $npm.Source run build:admin
if ($LASTEXITCODE -ne 0) {
    Write-Host "管理画面の準備に失敗しました。" -ForegroundColor Red
    Read-Host "Enterキーで閉じる"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "管理画面: $AdminUrl"
Write-Host "終了するときは Ctrl+C を押すか、このウィンドウを閉じてください。"
Write-Host ""

if ($OpenBrowser) {
    $escapedUrl = $AdminUrl.Replace("'", "''")
    $browserCommand = "Start-Sleep -Milliseconds 800; Start-Process '$escapedUrl'"
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-Command", $browserCommand
    )
}

& node.exe "server.mjs" "--bind" $HostName "--port" $Port
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "管理サーバーを起動できませんでした。" -ForegroundColor Red
    Read-Host "Enterキーで閉じる"
}
exit $exitCode

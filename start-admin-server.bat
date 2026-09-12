@echo off
setlocal
title Hasunosora Admin Server - 127.0.0.1:8766
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 22.18 or later, then try again.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm.cmd was not found.
  echo Install Node.js 22.18 or later, then try again.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { $identity = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/api/admin/identity' -TimeoutSec 2; if ($identity.application -eq 'hasunosora-pilgrimage-admin' -and $identity.schemaVersion -eq 1) { exit 0 }; exit 1 } catch { exit 1 }"
if not errorlevel 1 (
  echo The Hasunosora admin server is already running.
  echo http://127.0.0.1:8766/admin/
  pause
  exit /b 0
)

:build
cls
echo Hasunosora Admin Server
echo ========================
echo.
echo Building the admin page...
call npm.cmd run build:admin
if errorlevel 1 (
  echo.
  echo The admin build failed. Retrying in 15 seconds.
  timeout /t 15 /nobreak >nul
  goto build
)

echo.
echo STATUS : RUNNING
echo ADMIN  : http://127.0.0.1:8766/admin/
echo ACCESS : SSH tunnel only
echo.
echo Keep this window open. Closing it stops the admin server.
echo.
node.exe "server.mjs" --bind 127.0.0.1 --port 8766
set "AdminExitCode=%errorlevel%"

if "%AdminExitCode%"=="0" (
  echo.
  echo The admin server stopped normally.
  timeout /t 3 /nobreak >nul
  exit /b 0
)

echo.
echo The admin server stopped with exit code %AdminExitCode%.
echo Retrying in 5 seconds. Close this window if you do not want to restart it.
timeout /t 5 /nobreak >nul
goto build


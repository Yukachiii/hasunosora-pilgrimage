@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-community-auto-update.ps1" %*
if errorlevel 1 (
  echo.
  echo Failed to enable automatic community updates.
  pause
)

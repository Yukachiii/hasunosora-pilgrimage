@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-admin-autostart.ps1" %*
if errorlevel 1 (
  echo.
  echo Failed to enable automatic admin startup.
  pause
)

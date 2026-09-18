@echo off
setlocal
title Hasunosora Admin Server - 127.0.0.1:8766
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-admin-server.ps1"
if errorlevel 1 (
  echo.
  echo The admin launcher failed.
  pause
)

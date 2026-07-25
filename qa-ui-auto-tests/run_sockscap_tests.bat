@echo off
title Taomni SocksCap Test Launcher (unified)
cd /d "%~dp0.."
echo =========================================================================
echo  Taomni SocksCap Windows Real-Machine Test Launcher
echo  Configure upstream/SSH/curl (env vars), then pick a test to run.
echo  Driver / multi-profile tests will trigger a Windows UAC prompt.
echo =========================================================================
echo.
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\run-sockscap-tests.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\run-sockscap-tests.ps1"
)
echo.
pause

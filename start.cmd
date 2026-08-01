@echo off
REM The Circle - double-click me. Start before OBS; leave this window open.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed - it's the only thing The Circle needs.
  echo.
  echo   Get the LTS installer from   https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM Releases ship node_modules, so this only runs for a git clone.
if not exist node_modules call npm install --omit=dev

node server\index.js
echo.
echo   The Circle has stopped.
pause

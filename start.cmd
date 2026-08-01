@echo off
REM Double-clickable launcher. Start this before OBS - it serves the overlay.
cd /d "%~dp0"
if not exist node_modules call npm install
node server\index.js
pause

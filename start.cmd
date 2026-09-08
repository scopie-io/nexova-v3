@echo off
REM Nexova - build everything and serve the app + generated stores on http://localhost:4000
REM Double-click this file, or run it from a terminal.

setlocal
chcp 65001 >nul
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install it with:  winget install OpenJS.NodeJS.LTS
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies, this happens once...
  call npm install --no-audit --no-fund || goto :failed
)

echo Building Nexova...
call npm run build || goto :failed

echo.
echo Checking Claude access...
call node packages/engine/dist/cli.js doctor

REM To preview stores from your phone on the same Wi-Fi, uncomment the next line
REM and browse to http://<this-pc-ip>:4000  (find the IP with: ipconfig)
REM set "NEXOVA_HOST=0.0.0.0"

echo.
echo ============================================================
echo   Nexova is starting on http://localhost:4000
echo   Your published stores live at http://localhost:4000/s/^<slug^>/
echo   Press Ctrl+C in this window to stop it.
echo ============================================================
echo.

start "" http://localhost:4000
call npm start
goto :eof

:failed
echo.
echo Build failed. Scroll up for the error.
pause
exit /b 1

@echo off
REM Stop Nexova from starting automatically when you log in.

setlocal
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Nexova.lnk"

if exist "%LINK%" (
  del "%LINK%"
  echo Removed. Nexova will no longer start on login.
) else (
  echo Nexova was not set to start on login. Nothing to do.
)
echo.
pause

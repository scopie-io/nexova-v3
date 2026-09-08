@echo off
REM Optional: make Nexova start automatically when you log in to Windows.
REM Run this once. To undo, run uninstall-autostart.cmd (or delete the shortcut it creates).

setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0start.cmd"
set "LINK=%STARTUP%\Nexova.lnk"

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%');" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.WindowStyle=7;" ^
  "$s.Description='Start Nexova on login';" ^
  "$s.Save()"

if exist "%LINK%" (
  echo.
  echo Done. Nexova will start automatically when you log in.
  echo Shortcut: %LINK%
  echo Remove it any time with uninstall-autostart.cmd
) else (
  echo.
  echo Could not create the startup shortcut.
)
echo.
pause

@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\media-runtime-setup\install-media-runtime.ps1" %*
set "UFRIEND_INSTALL_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %UFRIEND_INSTALL_EXIT%

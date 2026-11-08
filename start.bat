@echo off
cd /d "%~dp0"
echo ========================================================
echo   OnePass Server
echo   Open browser: http://localhost:3000
echo ========================================================
echo.

node server.js
if %errorlevel% neq 0 (
    echo.
    echo Server stopped or failed to start!
    pause
)
pause

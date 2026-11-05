@echo off
title OnePass Web Server & Online Tunnel
cd /d %~dp0
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo Starting Cloudflare Online Tunnel for Mobile 4G/5G...
if exist "..\cloudflared.exe" (
    start "OnePass Cloudflare Tunnel" /min "..\cloudflared.exe" tunnel --url http://localhost:3000
) else if exist "cloudflared.exe" (
    start "OnePass Cloudflare Tunnel" /min "cloudflared.exe" tunnel --url http://localhost:3000
)

echo Starting Web Server at http://localhost:3000 ...
node server.js
pause

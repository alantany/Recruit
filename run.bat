@echo off
cd /d "%~dp0"

echo [1/3] Pulling latest code...
git pull origin main
if errorlevel 1 echo [WARN] git pull failed, using local code.

echo [2/3] Installing dependencies...
npm install
echo [OK] dependencies ready.

echo [3/3] Starting daemon...
npm run agent:daemon

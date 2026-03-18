@echo off
cd /d "%~dp0"

echo [FIX] Disable git CRLF conversion...
git config core.autocrlf false
git checkout -- package.json config/recruit-agent.json 2>nul
echo [OK] Line endings fixed.

echo [1/3] Pulling latest code...
git pull origin main
if errorlevel 1 echo [WARN] git pull failed, using local code.

echo [2/3] Installing dependencies...
call npm install
echo [OK] dependencies ready.

echo [3/3] Starting daemon...
call npm run agent:daemon

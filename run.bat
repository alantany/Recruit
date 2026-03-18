@echo off
cd /d "%~dp0"

echo [1/3] Pulling latest code...
git pull origin main
if errorlevel 1 (
  echo [WARN] git pull failed, using local code.
)

echo [2/3] Installing dependencies...
npm install --prefer-offline
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo [3/3] Starting daemon...
npm run agent:daemon

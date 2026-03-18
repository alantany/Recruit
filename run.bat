@echo off
cd /d "%~dp0"

echo [1/3] Pulling latest code...
git pull origin main
if errorlevel 1 echo [WARN] git pull failed, using local code.

echo [2/3] Installing dependencies...
call npm install
echo [OK] dependencies ready.

echo [FIX] Normalizing JSON files...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$files = @('package.json','config\recruit-agent.json','data\recruit-agent-state.json'); foreach ($f in $files) { if (Test-Path $f) { $c = [System.IO.File]::ReadAllText($f); [System.IO.File]::WriteAllText($f, ($c -replace \"`r`n\",\"`n\"), [System.Text.Encoding]::UTF8) } }"
echo [OK] done.

echo [3/3] Starting daemon...
call npm run agent:daemon

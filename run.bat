@echo off
cd /d "%~dp0"

echo [1/3] Pulling latest code...
git pull origin main
if errorlevel 1 echo [WARN] git pull failed, using local code.

echo [2/3] Installing dependencies...
call npm install
echo [OK] dependencies ready.

echo [FIX] Converting JSON files to LF line endings...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -Path '.' -Recurse -Include '*.json' -Exclude 'node_modules' | Where-Object { $_.FullName -notmatch 'node_modules' } | ForEach-Object { $c = [System.IO.File]::ReadAllText($_.FullName); $c2 = $c -replace \"`r`n\", \"`n\"; [System.IO.File]::WriteAllText($_.FullName, $c2, [System.Text.Encoding]::UTF8) }"
echo [OK] JSON files normalized.

echo [3/3] Starting daemon...
call npm run agent:daemon

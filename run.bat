@echo off
REM 日常启动：拉代码、装依赖、跑主线 A（搜索↔互动循环，Ctrl+C 结束）
REM 与 deploy-windows.bat 区别：本脚本不负责装机/首次部署，见仓库说明或 docs/招聘Agent使用手册.md
cd /d "%~dp0"

echo [FIX] Disable git CRLF conversion...
git config core.autocrlf false
REM 以下会还原 package.json 与 config 为当前分支版本；若你长期改本地配置，请注释此行或先提交/备份
git checkout -- package.json config/recruit-agent.json 2>nul
echo [OK] Line endings fixed.

echo [1/3] Pulling latest code...
git pull origin main
if errorlevel 1 echo [WARN] git pull failed, using local code.

echo [2/3] Installing dependencies...
call npm install
echo [OK] dependencies ready.

echo [3/3] Starting main line A (search-interaction loop, Ctrl+C to stop)...
call npm run agent:search-interaction-loop

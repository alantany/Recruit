#!/usr/bin/env bash
# 日常启动：装依赖、跑主线 A（搜索↔互动循环，Ctrl+C 结束）
# 开发机默认以本地代码为准，不执行 git pull，避免被远程覆盖。
# Windows 另一台机器请用 run.bat（含 git pull 同步远程）。
# 首次使用：chmod +x run.sh   然后 ./run.sh

set -e
cd "$(dirname "$0")"

echo "[FIX] git autocrlf (与 Windows 协作时可减少换行问题)..."
git config core.autocrlf false 2>/dev/null || true
# 以下会还原 package.json 与 config 为当前分支版本；若你长期改本地配置，请注释掉或先提交/备份
git checkout -- package.json config/recruit-agent.json 2>/dev/null || true
echo "[OK] done."

echo "[1/2] Installing dependencies..."
npm install
echo "[OK] dependencies ready."

echo "[2/2] Starting main line A (search-interaction loop, Ctrl+C to stop)..."
exec npm run agent:search-interaction-loop

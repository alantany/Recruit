@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

echo ============================================
echo   智联招聘 Agent - Windows 全资源一键部署
echo ============================================
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo [STEP 0/7] 检查 Node.js / npm / Git ...
call :ensure_node_npm
if errorlevel 1 goto :fail
call :ensure_git
if errorlevel 1 goto :fail

for /f "delims=" %%i in ('node -v') do set "NODE_VER=%%i"
for /f "delims=" %%i in ('git --version') do set "GIT_VER=%%i"
echo [INFO] Node.js 版本: !NODE_VER!
echo [INFO] Git 版本: !GIT_VER!
echo [INFO] 项目目录: %ROOT%
echo.

echo [STEP 1/7] 安装 npm 依赖...
call npm install
if errorlevel 1 goto :step_fail
echo [OK] npm 依赖安装完成
echo.

echo [STEP 2/7] 安装 Playwright Chromium...
call npm run playwright:install
if errorlevel 1 goto :step_fail
echo [OK] Playwright 安装完成
echo.

echo [STEP 3/7] 构建 TypeScript...
call npm run build
if errorlevel 1 goto :step_fail
echo [OK] 构建完成
echo.

echo [STEP 4/7] 初始化数据目录与状态文件...
call npm run agent:init
if errorlevel 1 goto :step_fail
echo [OK] 初始化完成
echo.

echo [STEP 5/7] 依赖与资源部署完成
echo.

echo [STEP 6/7] Git 客户端已就绪（可直接拉取升级）
echo.

echo [STEP 7/7] 一键部署完成
echo --------------------------------------------
echo 下一步建议：
echo 1) 先手动登录智联账号（首次需要）
echo 2) 单次联调：npm run agent:interaction
echo 3) 全流程：  npm run agent:workflow
echo 4) 常驻模式：npm run agent:daemon
echo --------------------------------------------
echo.

choice /M "是否现在启动常驻模式（agent:daemon）"
if errorlevel 2 goto :done

echo [INFO] 正在启动守护进程...
call npm run agent:daemon
goto :done

:ensure_node_npm
call :check_cmd node
if errorlevel 1 (
  echo [WARN] 未检测到 Node.js，尝试自动安装（winget）...
  call :install_node_by_winget
  if errorlevel 1 exit /b 1
)

call :check_cmd npm
if errorlevel 1 (
  echo [WARN] npm 不可用，尝试刷新 PATH 后重试...
  call :refresh_path
  call :check_cmd npm
  if errorlevel 1 (
    echo [ERROR] npm 仍不可用，请重开终端后重新运行本脚本。
    exit /b 1
  )
)
exit /b 0

:install_node_by_winget
call :check_cmd winget
if errorlevel 1 (
  echo [ERROR] 未检测到 winget，无法自动安装 Node.js。
  echo [HINT] 请手动安装 Node.js LTS: https://nodejs.org/
  exit /b 1
)

winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo [ERROR] winget 安装 Node.js 失败。
  echo [HINT] 请手动安装 Node.js LTS 后重试。
  exit /b 1
)

call :refresh_path
call :check_cmd node
if errorlevel 1 (
  echo [ERROR] Node.js 安装完成但当前会话未生效，请重开终端后重试。
  exit /b 1
)
exit /b 0

:ensure_git
call :check_cmd git
if errorlevel 1 (
  echo [WARN] 未检测到 Git，尝试自动安装（winget）...
  call :install_git_by_winget
  if errorlevel 1 exit /b 1
)
exit /b 0

:install_git_by_winget
call :check_cmd winget
if errorlevel 1 (
  echo [ERROR] 未检测到 winget，无法自动安装 Git。
  echo [HINT] 请手动安装 Git for Windows: https://git-scm.com/download/win
  exit /b 1
)

winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo [ERROR] winget 安装 Git 失败。
  echo [HINT] 请手动安装 Git for Windows 后重试。
  exit /b 1
)

call :refresh_path
if exist "C:\Program Files\Git\cmd" set "PATH=C:\Program Files\Git\cmd;%PATH%"
call :check_cmd git
if errorlevel 1 (
  echo [ERROR] Git 安装完成但当前会话未生效，请重开终端后重试。
  exit /b 1
)
exit /b 0

:refresh_path
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "C:\Program Files (x86)\nodejs" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
if exist "C:\Program Files\Git\cmd" set "PATH=C:\Program Files\Git\cmd;%PATH%"
exit /b 0

:check_cmd
where %1 >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:step_fail
echo.
echo [ERROR] 部署失败，请查看上面的报错信息。
goto :fail

:fail
echo.
echo [EXIT] 脚本结束（失败）。
pause
exit /b 1

:done
echo.
echo [EXIT] 脚本结束（成功）。
pause
exit /b 0

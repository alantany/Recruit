@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo ==========================================================
echo   Recruit Agent - Windows One-Click Deploy (ASCII Safe)
echo ==========================================================
echo.

set "USE_CN_MIRROR=1"
set "NPM_REGISTRY_CN=https://registry.npmmirror.com"
set "REPO_URL=https://github.com/alantany/Recruit.git"
set "PROJECT_DIR_NAME=Recruit"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "WORKDIR=%ROOT%"

echo [STEP 0/7] Check Node.js, npm, Git
call :ensure_node_npm
if errorlevel 1 goto :fail
call :ensure_git
if errorlevel 1 goto :fail

call :ensure_project_dir
if errorlevel 1 goto :fail

cd /d "%WORKDIR%"
echo [INFO] Project root: %WORKDIR%
echo.

echo [STEP 0.5/7] Setup mirrors
call :setup_mirrors
if errorlevel 1 goto :fail

for /f "delims=" %%i in ('node -v') do set "NODE_VER=%%i"
for /f "delims=" %%i in ('git --version') do set "GIT_VER=%%i"
echo [INFO] Node: !NODE_VER!
echo [INFO] Git : !GIT_VER!
echo.

echo [STEP 1/7] npm install
call :run_npm install
if errorlevel 1 goto :step_fail
echo [OK] npm install done
echo.

echo [STEP 2/7] Playwright browser install
call :run_playwright_install
if errorlevel 1 goto :step_fail
echo [OK] playwright install done
echo.

echo [STEP 3/7] Build TypeScript
call :run_npm run build
if errorlevel 1 goto :step_fail
echo [OK] build done
echo.

echo [STEP 4/7] Initialize runtime files
call :run_npm run agent:init
if errorlevel 1 goto :step_fail
echo [OK] init done
echo.

echo [STEP 5/7] Enable daemon mode in config
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "(Get-Content '%WORKDIR%\config\recruit-agent.json') -replace '\"enabled\": false', '\"enabled\": true' | Set-Content '%WORKDIR%\config\recruit-agent.json'"
echo [OK] daemon.enabled set to true
echo.

echo [STEP 6/7] Dependencies ready
echo [STEP 7/7] Deployment completed
echo ----------------------------------------------------------
echo Next:
echo 1) Login once in browser profile
echo 2) Test:   npm run agent:interaction
echo 3) Full:   npm run agent:workflow
echo 4) Daemon: npm run agent:daemon
echo ----------------------------------------------------------
echo.

choice /M "Start daemon now (agent:daemon)?"
if errorlevel 2 goto :done

echo [INFO] Starting daemon...
call :run_npm run agent:daemon
goto :done

:ensure_project_dir
if exist "%WORKDIR%\package.json" exit /b 0

echo [WARN] package.json not found in script directory.
echo [INFO] Trying to locate project folder...

if exist "%ROOT%\%PROJECT_DIR_NAME%\package.json" (
  set "WORKDIR=%ROOT%\%PROJECT_DIR_NAME%"
  echo [INFO] Found project at: %WORKDIR%
  exit /b 0
)

echo [INFO] Project not found. Cloning from GitHub...
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git not available yet. It is required before clone.
  echo [HINT] Keep this script inside the repo root, or install Git first then rerun.
  exit /b 1
)

git clone "%REPO_URL%" "%ROOT%\%PROJECT_DIR_NAME%"
if errorlevel 1 (
  echo [ERROR] git clone failed.
  exit /b 1
)

if not exist "%ROOT%\%PROJECT_DIR_NAME%\package.json" (
  echo [ERROR] Cloned folder does not contain package.json.
  exit /b 1
)

set "WORKDIR=%ROOT%\%PROJECT_DIR_NAME%"
echo [INFO] Clone success. Project at: %WORKDIR%
exit /b 0

:run_npm
set "RUN_PREFIX=%WORKDIR%"
if "%RUN_PREFIX:~-1%"=="\" set "RUN_PREFIX=%RUN_PREFIX:~0,-1%"
call npm --prefix "%RUN_PREFIX%" %*
if not "%ERRORLEVEL%"=="0" (
  echo [ERROR] npm command failed: npm --prefix "%RUN_PREFIX%" %*
  exit /b 1
)
exit /b 0

:run_playwright_install
set "RUN_PREFIX=%WORKDIR%"
if "%RUN_PREFIX:~-1%"=="\" set "RUN_PREFIX=%RUN_PREFIX:~0,-1%"
call npm --prefix "%RUN_PREFIX%" run playwright:install
if "%ERRORLEVEL%"=="0" exit /b 0

echo [WARN] playwright mirror/source may be unavailable, retrying with official source...
set "PLAYWRIGHT_DOWNLOAD_HOST="
call npm --prefix "%RUN_PREFIX%" run playwright:install
if not "%ERRORLEVEL%"=="0" (
  echo [ERROR] playwright install failed on both mirror and official source.
  exit /b 1
)
exit /b 0

:ensure_node_npm
where node >nul 2>nul
if errorlevel 1 (
  echo [WARN] Node.js not found, trying winget install...
  call :install_node_by_winget
  if errorlevel 1 exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [WARN] npm not found, refreshing PATH...
  call :refresh_path
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] npm still not available. Re-open terminal and retry.
    exit /b 1
  )
)
exit /b 0

:install_node_by_winget
where winget >nul 2>nul
if errorlevel 1 (
  echo [WARN] winget not found. Trying PowerShell download installer...
  call :install_node_by_download
  exit /b !ERRORLEVEL!
)

winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo [WARN] winget failed. Trying PowerShell download installer...
  call :install_node_by_download
  exit /b !ERRORLEVEL!
)

call :refresh_path
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node installed but not active in this shell.
  echo [HINT] Re-open terminal and rerun this script.
  exit /b 1
)
exit /b 0

:install_node_by_download
set "NODE_FILE=node-v20.19.0-x64.msi"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_FILE=node-v20.19.0-arm64.msi"
if /I "%PROCESSOR_ARCHITECTURE%"=="x86" set "NODE_FILE=node-v20.19.0-x86.msi"
set "TMP_NODE_MSI=%TEMP%\%NODE_FILE%"
set "NODE_URL_1=https://nodejs.org/dist/v20.19.0/%NODE_FILE%"
set "NODE_URL_2=https://npmmirror.com/mirrors/node/v20.19.0/%NODE_FILE%"
echo [INFO] Downloading Node.js installer: %TMP_NODE_MSI%
echo [INFO] Try URL 1: %NODE_URL_1%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '%NODE_URL_1%' -OutFile '%TMP_NODE_MSI%' -UseBasicParsing; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo [WARN] URL 1 failed. Try URL 2...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '%NODE_URL_2%' -OutFile '%TMP_NODE_MSI%' -UseBasicParsing; exit 0 } catch { exit 1 }"
)
if not exist "%TMP_NODE_MSI%" (
  echo [ERROR] Failed to download Node.js installer.
  echo [HINT] Download manually: https://nodejs.org/dist/v20.19.0/%NODE_FILE%
  exit /b 1
)
echo [INFO] Installing Node.js silently...
msiexec /i "%TMP_NODE_MSI%" /qn /norestart
if errorlevel 1 (
  echo [ERROR] Node.js installer failed.
  echo [HINT] Run manually: %TMP_NODE_MSI%
  exit /b 1
)
call :refresh_path
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js installed but not active. Re-open terminal and rerun.
  exit /b 1
)
echo [OK] Node.js installed by downloaded installer
exit /b 0

:ensure_git
where git >nul 2>nul
if errorlevel 1 (
  echo [WARN] Git not found, trying winget install...
  call :install_git_by_winget
  if errorlevel 1 exit /b 1
)
exit /b 0

:install_git_by_winget
where winget >nul 2>nul
if errorlevel 1 (
  echo [WARN] winget not found. Trying PowerShell download installer...
  set "GIT_FILE=Git-64-bit.exe"
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "GIT_FILE=Git-ARM64.exe"
  if /I "%PROCESSOR_ARCHITECTURE%"=="x86" set "GIT_FILE=Git-32-bit.exe"
  set "TMP_GIT_EXE=%TEMP%\!GIT_FILE!"
  set "GIT_URL_1=https://github.com/git-for-windows/git/releases/latest/download/!GIT_FILE!"
  set "GIT_URL_2=https://npmmirror.com/mirrors/git-for-windows/v2.49.0.windows.1/!GIT_FILE!"
  echo [INFO] Download Git installer: !TMP_GIT_EXE!
  echo [INFO] Try URL 1: !GIT_URL_1!
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '!GIT_URL_1!' -OutFile '!TMP_GIT_EXE!' -UseBasicParsing; exit 0 } catch { exit 1 }"
  if errorlevel 1 (
    echo [WARN] URL 1 failed. Try URL 2...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '!GIT_URL_2!' -OutFile '!TMP_GIT_EXE!' -UseBasicParsing; exit 0 } catch { exit 1 }"
  )
  if errorlevel 1 (
    where curl >nul 2>nul
    if not errorlevel 1 (
      echo [WARN] PowerShell download failed. Try curl...
      curl -L --retry 3 --connect-timeout 20 -o "!TMP_GIT_EXE!" "!GIT_URL_1!"
    )
  )
  if not exist "!TMP_GIT_EXE!" (
    echo [ERROR] Failed to download Git installer.
    echo [HINT] Download manually: https://git-scm.com/download/win
    exit /b 1
  )
  for %%A in ("!TMP_GIT_EXE!") do set "GIT_EXE_SIZE=%%~zA"
  if not defined GIT_EXE_SIZE (
    echo [ERROR] Downloaded file is invalid.
    exit /b 1
  )
  if !GIT_EXE_SIZE! LSS 5000000 (
    echo [ERROR] Downloaded file is too small: !GIT_EXE_SIZE! bytes
    echo [HINT] It is likely an HTML error page, not installer.
    echo [HINT] Please open this URL in browser and download manually:
    echo        !GIT_URL_1!
    exit /b 1
  )
  echo [INFO] Run Git installer silently...
  "!TMP_GIT_EXE!" /VERYSILENT /NORESTART
  if errorlevel 1 (
    echo [ERROR] Silent Git install failed.
    echo [HINT] Please run installer manually: !TMP_GIT_EXE!
    exit /b 1
  )
  call :refresh_path
  if exist "C:\Program Files\Git\cmd" set "PATH=C:\Program Files\Git\cmd;%PATH%"
  where git >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Git installed but not active in this shell.
    echo [HINT] Re-open terminal and rerun this script.
    exit /b 1
  )
  echo [OK] Git installed by downloaded installer
  exit /b 0
)

winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo [ERROR] winget failed to install Git
  echo [HINT] Install Git manually and rerun this script.
  exit /b 1
)

call :refresh_path
if exist "C:\Program Files\Git\cmd" set "PATH=C:\Program Files\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git installed but not active in this shell.
  echo [HINT] Re-open terminal and rerun this script.
  exit /b 1
)
echo [OK] Git installed by winget
exit /b 0

:refresh_path
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "C:\Program Files (x86)\nodejs" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
if exist "C:\Program Files\Git\cmd" set "PATH=C:\Program Files\Git\cmd;%PATH%"
exit /b 0

:setup_mirrors
if not "%USE_CN_MIRROR%"=="1" (
  echo [INFO] Mirror mode disabled.
  exit /b 0
)
set "NPM_CONFIG_REGISTRY=%NPM_REGISTRY_CN%"
echo [INFO] npm registry: %NPM_CONFIG_REGISTRY%
echo [INFO] playwright host: official default (auto fallback enabled)
exit /b 0

:check_cmd
where %1 >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:step_fail
echo.
echo [ERROR] Deployment step failed. Check logs above.
goto :fail

:fail
echo.
echo [EXIT] Failed.
pause
exit /b 1

:done
echo.
echo [EXIT] Success.
pause
exit /b 0

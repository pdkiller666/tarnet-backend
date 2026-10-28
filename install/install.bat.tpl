@echo off
rem ============================================================
rem  TarNet Worker - one-click installer (Windows)
rem  Worker address and API URL are injected by the server.
rem  No arguments needed: just double-click this file.
rem
rem  THIS FILE MUST STAY PURE ASCII AND CRLF.
rem  1) Windows CMD splits batch files on CRLF. With LF-only line
rem     endings the parser misses labels and runs following lines
rem     together, producing errors like
rem     "'$s.WorkingDirectory' is not recognized". That is a
rem     line-ending bug, not a PowerShell quoting bug.
rem  2) Cyrillic in UTF-8 is read by the console as OEM/CP866 and
rem     turns into garbage. So every message here is English.
rem  server.js normalizes this file to CRLF on the way out, and
rem  tests check both invariants.
rem ============================================================
setlocal EnableDelayedExpansion
title TarNet Worker

set "ADDR=__TARNET_ADDR__"
set "API=__TARNET_API__"
set "MODEL=__TARNET_MODEL__"
set "NODEV=v22.11.0"
set "TARNET_DIR=%LOCALAPPDATA%\TarNet"
set "SKIP_MODEL=0"

rem ---------- validate worker address ----------
rem The server injects the address at download time and answers HTTP 400
rem when it is missing or malformed, so a downloaded file always carries a
rem real address. An empty value here means the file was edited or truncated.
rem Such a worker would generate its OWN wallet and the work would go to a
rem different balance, so refuse to run.
rem
rem NEVER compare ADDR against the server placeholder token. The server
rem replaces EVERY occurrence of that token, including the copy inside the
rem guard, so the guard ends up comparing the address with itself: it is
rem always true and the installer dies on start for every user. The empty
rem and length checks below are enough, because the server already rejects
rem a bad address before anyone can download the file.
if "%ADDR%"=="" goto fail_addr
if not "%ADDR:~0,2%"=="0x" goto fail_addr
rem 0x + 40 hex chars = 42 characters total.
if not "%ADDR:~42,1%"=="" goto fail_addr
if "%ADDR:~41,1%"=="" goto fail_addr

echo ============================================
echo   TarNet Worker - installation
echo ============================================
echo   wallet: %ADDR%
echo   server: %API%
echo   folder: %TARNET_DIR%
echo ============================================
echo.

if not exist "%TARNET_DIR%" mkdir "%TARNET_DIR%" 2>nul
if not exist "%TARNET_DIR%" goto fail_dir

rem ---------- 1/4 Node.js ----------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto have_node

echo [1/4] Node.js not found - downloading portable build (34 MB)...
set "ARCH=win-x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=win-arm64"
set "NODE_NAME=node-%NODEV%-%ARCH%"
set "NODE_ZIP=%TARNET_DIR%\node-%ARCH%.zip"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODEV%/%NODE_NAME%.zip' -OutFile '%NODE_ZIP%'"
if not exist "%NODE_ZIP%" goto fail_node

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%TARNET_DIR%' -Force"
set "NODE_EXE=%TARNET_DIR%\%NODE_NAME%\node.exe"
if not exist "%NODE_EXE%" goto fail_node
del "%NODE_ZIP%" >nul 2>nul

:have_node
echo [1/4] Node.js: ok
echo       %NODE_EXE%

rem ---------- 2/4 Ollama ----------
set "OLLAMA_EXE="
for /f "delims=" %%i in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%i"
if defined OLLAMA_EXE goto have_ollama

echo [2/4] Ollama not found - downloading and installing silently...
set "OLLAMA_SETUP=%TARNET_DIR%\OllamaSetup.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%OLLAMA_SETUP%'"
if not exist "%OLLAMA_SETUP%" goto no_ollama

start /wait "" "%OLLAMA_SETUP%" /S
del "%OLLAMA_SETUP%" >nul 2>nul

if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not defined OLLAMA_EXE goto no_ollama

:have_ollama
echo [2/4] Ollama: ok
echo       %OLLAMA_EXE%

rem wait for the local Ollama server to come up (its installer starts it)
set /a WAIT=0
:wait_ollama
curl.exe -s -f --max-time 2 -o NUL "http://127.0.0.1:11434/api/tags" >nul 2>nul
if not errorlevel 1 goto ollama_ready
set /a WAIT+=1
if !WAIT! geq 20 goto no_ollama
timeout /t 2 /nobreak >nul
goto wait_ollama

:ollama_ready
echo [2/4] Ollama server responds
goto model

:no_ollama
echo.
echo   WARNING: Ollama is not installed.
echo   The worker will start but answer with a stub template.
echo   This is visible honestly in /health: llm_mode = deterministic_fallback.
echo   Install manually: https://ollama.com/download
echo.
set "SKIP_MODEL=1"

rem ---------- 3/4 model ----------
:model
if "%SKIP_MODEL%"=="1" (
  echo [3/4] model step skipped
  goto step4
)
echo [3/4] Model %MODEL% (about 1 GB, this is the slow part)...
"%OLLAMA_EXE%" pull %MODEL%
if errorlevel 1 (
  echo       model download failed - worker will run without a model
  set "SKIP_MODEL=1"
)

rem ---------- 4/4 worker ----------
:step4
echo [4/4] Downloading worker...
set "WORKER_JS=%TARNET_DIR%\tarnet-worker.js"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%API%/download/worker.js' -OutFile '%WORKER_JS%'"
if not exist "%WORKER_JS%" goto fail_worker

rem Launcher for later: after a reboot the worker can be started
rem again without repeating the whole installation.
(
  echo @echo off
  echo setlocal
  echo set "WORKER_ADDRESS=%ADDR%"
  echo set "TARNET_API_URL=%API%"
  echo set "TARNET_MODEL=%MODEL%"
  echo start /min "" "%NODE_EXE%" "%WORKER_JS%"
) > "%TARNET_DIR%\start.cmd"

rem ---------- desktop shortcut ----------
rem Files land in %LOCALAPPDATA%\TarNet, a folder nobody browses.
rem Without a shortcut, restarting the worker means finding that
rem folder and start.cmd by hand - in practice people just give up.
rem
rem The shortcut points at start.cmd, NOT at cmd.exe with worker.js:
rem cmd cannot execute .js files, so such a shortcut would open a
rem window with an error.
rem
rem The name is plain ASCII (TarNet.lnk). A Cyrillic name would have
rem to travel through the console code page, which is exactly the
rem class of bug this rewrite removes.
rem
rem Desktop is resolved via GetFolderPath, not %USERPROFILE%\Desktop:
rem with OneDrive enabled that folder is redirected elsewhere.
rem
rem If the shortcut cannot be created (policy blocks COM objects,
rem no rights, antivirus), it falls back to the TarNet folder and
rem the path is printed. Claiming a shortcut always appears would
rem be a lie.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=Join-Path $d 'TarNet.lnk'; try { $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut($p); $s.TargetPath='%TARNET_DIR%\start.cmd'; $s.WorkingDirectory='%TARNET_DIR%'; $s.Description='Start TarNet worker'; $s.Save(); exit 0 } catch { exit 1 }"

if errorlevel 1 goto shortcut_fallback
echo   Shortcut created on Desktop: TarNet
goto shortcut_done

:shortcut_fallback
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path '%TARNET_DIR%' 'TarNet.lnk'; try { $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut($p); $s.TargetPath='%TARNET_DIR%\start.cmd'; $s.WorkingDirectory='%TARNET_DIR%'; $s.Save(); exit 0 } catch { exit 1 }"
echo   Could not create a Desktop shortcut.
echo   Run manually: "%TARNET_DIR%\start.cmd"

:shortcut_done
echo [4/4] Starting worker in background...
start /min "" "%TARNET_DIR%\start.cmd"

echo.
echo ============================================
echo   Done. The worker is running minimized.
echo ============================================
echo   Check it in the PWA, tab "My devices".
echo   Logs appear in the worker window.
echo   Start again later: "%TARNET_DIR%\start.cmd"
echo   Or use the TarNet shortcut on your Desktop.
echo.
pause
exit /b 0

rem ---------- errors ----------
:fail_addr
echo.
echo   ERROR: worker address is missing or corrupted.
echo.
echo   got:      "%ADDR%"
echo   expected: 0x followed by exactly 40 hex characters.
echo.
echo   Do not run this file: the worker would create a NEW wallet
echo   and your work would go to somebody else's balance.
echo.
echo   Fix: open the TarNet PWA on your phone, go to the
echo   "My devices" tab and download the installer again.
echo.
pause
exit /b 2

:fail_dir
echo   ERROR: cannot create folder %TARNET_DIR%
pause
exit /b 1

:fail_node
echo   ERROR: Node.js download failed.
echo   Check your connection or install Node manually: https://nodejs.org
pause
exit /b 1

:fail_worker
echo   ERROR: worker download failed from %API%/download/worker.js
pause
exit /b 1

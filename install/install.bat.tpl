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

rem ---------- worker address (optional since 2.21.4) ----------
rem The installer MUST NOT carry the browser wallet any more. A PC with the
rem owner's address answers SAME_ADDRESS when the 6-digit code is claimed,
rem because the server refuses owner == device. So the normal case is an
rem EMPTY address here: the worker creates its own wallet on first run and
rem the owner links that wallet with a 6-digit code from the PWA.
rem
rem An address is still accepted when present (old links, manual use), and
rem then it must be valid: a typo would silently send work to a different
rem balance. That is why the format checks below stay.
rem
rem NEVER compare ADDR against the server placeholder token. The server
rem replaces EVERY occurrence of that token, including the copy inside the
rem guard, so the guard ends up comparing the address with itself: it is
rem always true and the installer dies on start for every user.
if "%ADDR%"=="" goto addr_ok
if not "%ADDR:~0,2%"=="0x" goto fail_addr
rem 0x + 40 hex chars = 42 characters total.
if not "%ADDR:~42,1%"=="" goto fail_addr
if "%ADDR:~41,1%"=="" goto fail_addr
:addr_ok

echo ============================================
echo   TarNet Worker - installation
echo ============================================
echo   wallet: %ADDR%
if "%ADDR%"=="" echo   wallet: will be created on first run, then link it by code
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
rem npm lives next to node.exe in both cases: portable archive ships it, and
rem a system Node has its own. Resolving the FOLDER (not a hardcoded path)
rem keeps the p2p dependency install working for both.
for %%p in ("%NODE_EXE%") do set "NODE_DIR=%%~dp"
set "NPM_EXE="
if exist "%NODE_DIR%npm.cmd" set "NPM_EXE=%NODE_DIR%npm.cmd"
rem npm.cmd spawns node by name, so the folder has to be on PATH.
set "PATH=%NODE_DIR%;%PATH%"
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

rem ---------- 4b. p2p-node, the libp2p transport (2.22.7) ----------
rem Until this step the installer shipped ONE file. `--p2p` then searched
rem for p2p-node/p2p-worker.js next to the worker, found nothing, and the
rem worker silently stayed on WS: same symptom as "forgot the second
rem window", so nobody could tell a missing transport from an idle one.
rem The archive carries SOURCES only; dependencies come from package-lock
rem via npm, because 105 MB of node_modules has no business in a download.
set "P2P_DIR=%TARNET_DIR%\p2p-node"
set "P2P_ZIP=%TARNET_DIR%\p2p-node.zip"
set "P2P_OK=0"
echo       p2p transport...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%API%/download/p2p-node.zip' -OutFile '%P2P_ZIP%'"
if not exist "%P2P_ZIP%" goto p2p_skip

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%P2P_ZIP%' -DestinationPath '%TARNET_DIR%' -Force"
if not exist "%P2P_DIR%\p2p-worker.js" goto p2p_skip
del "%P2P_ZIP%" >nul 2>nul

if not defined NPM_EXE goto p2p_no_npm
rem `ci` and not `install`: the lockfile is in the archive, and `ci` refuses
rem to invent versions. `--omit=dev` keeps test-only packages out.
rem Installed INTO the p2p folder: that is where node resolves `libp2p`
rem from, so no NODE_PATH tricks are needed.
pushd "%P2P_DIR%"
call "%NPM_EXE%" ci --omit=dev --no-audit --no-fund >"%TARNET_DIR%\p2p-install.log" 2>&1
set "NPM_RC=%errorlevel%"
popd
if not "%NPM_RC%"=="0" goto p2p_npm_failed

rem Prove the transport actually loads HERE, not on the user's first run.
rem An import failure would otherwise surface as a silent WS fallback, which
rem is exactly the failure this step exists to remove.
pushd "%P2P_DIR%"
"%NODE_EXE%" -e "import('libp2p').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
set "IMPORT_RC=%errorlevel%"
popd
if not "%IMPORT_RC%"=="0" goto p2p_import_failed

set "P2P_OK=1"
echo       p2p transport: ok
goto p2p_done

:p2p_no_npm
echo       WARNING: npm not found next to node.exe - p2p transport skipped.
goto p2p_done

:p2p_npm_failed
echo       WARNING: npm ci failed - p2p transport skipped.
echo       Log: %TARNET_DIR%\p2p-install.log
goto p2p_done

:p2p_import_failed
echo       WARNING: libp2p does not load after npm ci - p2p transport skipped.
goto p2p_done

:p2p_skip
echo       WARNING: p2p archive not downloaded - p2p transport skipped.
goto p2p_done

:p2p_done
rem Step numbering is kept as 4/4: the p2p transport is part of "4/4", not
rem a fifth manual step. A skipped transport is REPORTED below, never
rem hidden: the worker will still start, but on WS only.

rem Verify the downloaded worker ACTUALLY launches here, in the folder it
rem will run from. Until 2.21.3 the installer shipped a worker that died
rem with `Cannot find module './worker-box'`: the file was present, the
rem install looked successful, and the failure surfaced only to the user.
rem `--self-check` loads the worker modules without touching the network
rem and exits 0/1, so a bad download stops the install instead of a person.
rem
rem This check is meaningful only because the server now sends a bundled
rem single-file worker. An unbundled worker would need worker-box.js next
rem to it, and this line would fail exactly where real users used to fail.
"%NODE_EXE%" "%WORKER_JS%" --self-check >nul 2>nul
if errorlevel 1 goto fail_selfcheck

rem Launcher for later: after a reboot the worker can be started
rem again without repeating the whole installation.
rem
rem The window must stay VISIBLE and node must run in it directly.
rem Until 2.21.2 this line was `start /min`: the worker ran minimized,
rem so the link-code prompt existed but nobody could see it or type
rem into it. `start` also detaches into another process, so the child's
rem stdin is not the console the user is looking at.
rem
rem So no `start` here at all: node IS the interactive program.
rem `pause` keeps the window open after a crash so the error text stays
rem readable instead of the window vanishing instantly.
rem
rem `--p2p` is added only when the transport really installed. Passing it
rem with no p2p-node leaves a working WS worker plus a warning line, which
rem is honest but makes every user's log start with an avoidable error.
(
  echo @echo off
  echo title TarNet Worker
  echo setlocal
  echo set "WORKER_ADDRESS=%ADDR%"
  echo set "TARNET_API_URL=%API%"
  echo set "TARNET_MODEL=%MODEL%"
  if "%P2P_OK%"=="1" echo "%NODE_EXE%" "%WORKER_JS%" --p2p
  if not "%P2P_OK%"=="1" echo "%NODE_EXE%" "%WORKER_JS%"
  echo pause
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
echo [4/4] Starting worker...
rem Visible window, not minimized: the worker prints the link-code prompt
rem and reads the code from this very console (2.21.2). A minimized window
rem made the prompt unreachable - the feature existed but was unusable.
start "TarNet Worker" "%TARNET_DIR%\start.cmd"

echo.
echo ============================================
echo   Done. The worker window is open.
echo ============================================
echo   Bind this PC: open the PWA, press the code button
echo   and type the 6 digits into the worker window, then Enter.
echo.
echo   Check the device list in the PWA, tab "My devices".
echo   Keep the worker window open while it works.
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

:fail_selfcheck
echo   ERROR: the downloaded worker did not start on this machine.
echo   Run this for details: "%NODE_EXE%" "%WORKER_JS%" --self-check
pause
exit /b 1

@echo off
rem ============================================================
rem  TarNet Stage 10 manual gate - one file, two runs.
rem
rem  RUN 1 (before reboot):   stage10-test.bat
rem      -> writes health + worker.json to the log, prints what to do.
rem  RUN 2 (after reboot):    stage10-test.bat --post-reboot
rem      -> autostart check, external signalling check, browser recipe.
rem
rem  WHY TWO RUNS AND NOT ONE SCRIPT. Autostart can only be proven by a
rem  reboot that happened between two observations. A single script that
rem  reboots itself and continues cannot survive its own reboot, and a script
rem  that starts the worker by hand proves nothing about autostart. Two runs
rem  keep the cause (reboot) and the effect (node is in the network) apart.
rem
rem  WHY EVERY RETURN CODE IS LOGGED, INCLUDING NON-ZERO. These codes are
rem  EXPECTED outcomes, not crashes:
rem     check-autostart.js  0 = node visible in window; 1 = not seen;
rem                         2 = bad argument; 3 = old build, address check
rem                         impossible.
rem     check-webrtc.js     0 = answer received; 1 = server refused; 2 = bridge
rem                         down; 3 = no worker in DHT; 4 = server unreachable.
rem  A script that dies on rc != 0 hides exactly the information the owner
rem  needs to tell "not tested" from "broken".
rem
rem  THIS FILE MUST STAY PURE ASCII AND CRLF.
rem  CMD reads batch files in the OEM code page: Cyrillic in UTF-8 becomes
rem  garbage, and LF-only endings break label parsing. Same rule as
rem  install/install.bat.tpl, same reason.
rem ============================================================
setlocal EnableDelayedExpansion

set "BASE=https://v1107336.hosted-by-vdsina.com"
set "LOG=%~dp0stage10-test.log"
set "MODE=%~1"

rem Repo root: the node scripts live in <repo>\scripts\. Prefer the current
rem directory (owner usually runs from the repo), fall back to the parent of
rem this file, and report honestly when neither works instead of running
rem `node scripts\...` into a void.
set "REPO="
if exist "%CD%\scripts\check-autostart.js" set "REPO=%CD%"
if not defined REPO if exist "%~dp0..\scripts\check-autostart.js" for %%p in ("%~dp0..") do set "REPO=%%~fp"

if /i "%MODE%"=="--post-reboot" goto POST_REBOOT

rem ============================================================
rem  RUN 1 - pre-reboot snapshot
rem ============================================================
>"%LOG%" echo === STAGE 10 TEST ===
>>"%LOG%" echo Started: %DATE% %TIME%
>>"%LOG%" echo Mode: PRE-REBOOT
>>"%LOG%" echo Base: %BASE%
>>"%LOG%" echo Repo: %REPO%

>>"%LOG%" echo.
>>"%LOG%" echo === STEP 0: PRE-REBOOT SNAPSHOT ===
>>"%LOG%" echo --- GET /health ---
curl -s --max-time 20 "%BASE%/health" >>"%LOG%" 2>&1
>>"%LOG%" echo.
>>"%LOG%" echo --- worker.json ---
if exist "%USERPROFILE%\.tarnet\worker.json" (
  type "%USERPROFILE%\.tarnet\worker.json" >>"%LOG%" 2>&1
) else (
  >>"%LOG%" echo NOT FOUND: %USERPROFILE%\.tarnet\worker.json
)
>>"%LOG%" echo.
>>"%LOG%" echo --- node / ollama on PATH ---
where node >>"%LOG%" 2>&1
where ollama >>"%LOG%" 2>&1

echo.
echo ============================================================
echo   PRE-REBOOT SNAPSHOT WRITTEN
echo   %LOG%
echo ============================================================
echo.
echo   ACTION REQUIRED - in this order, nothing skipped:
echo.
echo   1. Close the worker window by hand if it is open.
echo      (A worker started by hand makes the autostart test meaningless.)
echo   2. Reboot Windows: Start - Power - Restart.
echo      NOT "Shut down": Fast Startup skips the Startup folder and the
echo      autostart test would fail for a reason that is not the worker.
echo   3. Sign in and wait 2-3 minutes. Do NOT start the worker by hand.
echo      The window must open by itself.
echo   4. Run this file again with the flag:
echo.
echo         stage10-test.bat --post-reboot
echo.
echo   Then send stage10-test.log to chat.
echo ============================================================
endlocal
exit /b 0

rem ============================================================
rem  RUN 2 - after the reboot
rem ============================================================
:POST_REBOOT
>>"%LOG%" echo.
>>"%LOG%" echo ============================================================
>>"%LOG%" echo === POST-REBOOT RUN ===
>>"%LOG%" echo Time: %DATE% %TIME%
>>"%LOG%" echo ============================================================

if not defined REPO goto NO_REPO

rem --- STEP 1: autostart (the only proof that the node lives on its own) ---
>>"%LOG%" echo.
>>"%LOG%" echo === STEP 1: AUTOSTART (check-autostart.js --p2p) ===
rem --p2p because the worker is launched with --test-p2p / --p2p: such a node
rem is counted in active_p2p_workers and is NOT in the WS registry. Without
rem the flag the check reads 0 workers and reports a failure of a node that
rem is actually in the network.
pushd "%REPO%"
node scripts\check-autostart.js --window 600 --interval 10 --p2p >>"%LOG%" 2>&1
set "AUTOSTART_RC=%ERRORLEVEL%"
popd
>>"%LOG%" echo AUTOSTART_RC=%AUTOSTART_RC%

if not "%AUTOSTART_RC%"=="0" goto AUTOSTART_RED
>>"%LOG%" echo AUTOSTART: PASS (node visible without manual start)
goto STEP2

:AUTOSTART_RED
>>"%LOG%" echo.
>>"%LOG%" echo AUTOSTART: NOT PROVEN (rc=%AUTOSTART_RC%)
>>"%LOG%" echo rc=0 pass / 1 not seen within window / 2 bad argument / 3 old build
>>"%LOG%" echo Check in this order:
>>"%LOG%" echo   a. shortcut in shell:startup (Win+R - shell:startup)
>>"%LOG%" echo   b. %LOCALAPPDATA%\TarNet\start.cmd runs and stays open
>>"%LOG%" echo   c. firewall allows node.exe outbound
>>"%LOG%" echo   d. worker.json address matches the one in /health
>>"%LOG%" echo WebRTC test still runs: a missing autostart is a different defect.

:STEP2
rem --- STEP 2: external signalling path (synthetic SDP, not a browser) ---
>>"%LOG%" echo.
>>"%LOG%" echo === STEP 2: WEBRTC SIGNALLING FROM OUTSIDE ===
>>"%LOG%" echo WHAT THIS PROVES: the server accepts an offer, finds the
>>"%LOG%" echo addressee in the DHT and returns an answer. WHAT IT DOES NOT
>>"%LOG%" echo PROVE: that a real RTCPeerConnection opens (that is STEP 3).
pushd "%REPO%"
node scripts\check-webrtc.js --base %BASE% --verbose >>"%LOG%" 2>&1
set "WEBRTC_RC=%ERRORLEVEL%"
popd
>>"%LOG%" echo WEBRTC_RC=%WEBRTC_RC%

if "%WEBRTC_RC%"=="0" (
  >>"%LOG%" echo WEBRTC SIGNALLING: PASS - answer received
) else if "%WEBRTC_RC%"=="1" (
  >>"%LOG%" echo WEBRTC SIGNALLING: server refused - read error/detail above
) else if "%WEBRTC_RC%"=="2" (
  >>"%LOG%" echo WEBRTC SIGNALLING: bridge/libp2p down - nothing to test right now
) else if "%WEBRTC_RC%"=="3" (
  >>"%LOG%" echo WEBRTC SIGNALLING: no worker in DHT - start worker with --p2p and repeat
) else (
  >>"%LOG%" echo WEBRTC SIGNALLING: server unreachable - network/DNS/TLS
)

rem --- STEP 3: browser, the only real DataChannel proof ---
>>"%LOG%" echo.
>>"%LOG%" echo === STEP 3: BROWSER (MANUAL - the real proof) ===
>>"%LOG%" echo 1. Open %BASE%/app/
>>"%LOG%" echo 2. Ctrl+Shift+R  - hard reload; an old service worker can serve
>>"%LOG%" echo    a cached bundle from before v43 and the test would fail on
>>"%LOG%" echo    code that is no longer on the server.
>>"%LOG%" echo 3. F12 - Console
>>"%LOG%" echo 4. Check the runtime first:
>>"%LOG%" echo      TarNetWebRTC.isSupported()
>>"%LOG%" echo    Expected: true. If false, stop here and say so.
>>"%LOG%" echo 5. Run this and wait for the state lines:
>>"%LOG%" echo.
>>"%LOG%" echo    const r = await TarNetWebRTC.connect({
>>"%LOG%" echo      model: 'qwen2.5-coder:1.5b',
>>"%LOG%" echo      onState: (s) =^> console.log('[state]', s),
>>"%LOG%" echo      onMessage: (m) =^> console.log('[msg]', m),
>>"%LOG%" echo    });
>>"%LOG%" echo    console.log(r);
>>"%LOG%" echo    r.session.send({ type: 'ping' });
>>"%LOG%" echo.
>>"%LOG%" echo 6. Expected: r.ok === true, r.transport === 'webrtc',
>>"%LOG%" echo    a line [state] connected, then [msg] with a pong payload.
>>"%LOG%" echo 7. Copy the FULL console output here, by hand:
>>"%LOG%" echo    (paste below this line, then save)
>>"%LOG%" echo.
>>"%LOG%" echo --- CONSOLE OUTPUT (paste) ---

goto SUMMARY

:NO_REPO
>>"%LOG%" echo.
>>"%LOG%" echo ERROR: repository not found.
>>"%LOG%" echo Looked for scripts\check-autostart.js in:
>>"%LOG%" echo   %CD%
>>"%LOG%" echo   %~dp0..
>>"%LOG%" echo Put this file in the repo (scripts\stage10-test.bat) or run it
>>"%LOG%" echo from the repo root, then repeat. Nothing was tested.
set "AUTOSTART_RC=9"
set "WEBRTC_RC=9"

:SUMMARY
>>"%LOG%" echo.
>>"%LOG%" echo === SUMMARY ===
>>"%LOG%" echo AUTOSTART_RC=%AUTOSTART_RC%   (0 pass / 1 not seen / 2 arg / 3 old build / 9 no repo)
>>"%LOG%" echo WEBRTC_RC=%WEBRTC_RC%      (0 pass / 1 refused / 2 bridge down / 3 no worker / 4 unreachable / 9 no repo)
>>"%LOG%" echo.
>>"%LOG%" echo Stage 10 may be closed ONLY when:
>>"%LOG%" echo   AUTOSTART_RC=0 AND WEBRTC_RC=0 AND a pong line in the console.
>>"%LOG%" echo Anything else is a fact to report, not a reason to retry blindly.
>>"%LOG%" echo === END %DATE% %TIME% ===

echo.
echo ============================================================
echo   DONE
echo   AUTOSTART_RC=%AUTOSTART_RC%  WEBRTC_RC=%WEBRTC_RC%
echo   Log: %LOG%
echo ============================================================
echo.
echo   Send %LOG% to chat.
echo   Do not edit the log: negative codes are data too.
endlocal
exit /b 0

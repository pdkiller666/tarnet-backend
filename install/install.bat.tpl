@echo off
rem ============================================================
rem  TarNet Worker - установка в один клик (Windows)
rem  Адрес и сервер подставлены сервером при скачивании.
rem  Аргументы не нужны: двойной клик и всё.
rem ============================================================
setlocal EnableDelayedExpansion
title TarNet Worker

set "ADDR=__TARNET_ADDR__"
set "API=__TARNET_API__"
set "MODEL=__TARNET_MODEL__"
set "NODEV=v22.11.0"
set "TARNET_DIR=%LOCALAPPDATA%\TarNet"
set "SKIP_MODEL=0"

rem ---------- проверка адреса ----------
rem Адрес подставляет сервер при скачивании. Если его нет — файл скачали
rem в обход PWA, переслали другому или он устарел. Запускать такой воркер
rem нельзя: он сгенерирует СВОЙ кошелёк, работа уйдёт в чужой баланс, а
rem человек будет смотреть на нулевой счёт и не понимать, почему.
rem Проверяем длину и префикс; сами hex-символы проверит воркер — у него
rem для этого точная регулярка и понятное сообщение.
if "%ADDR%"=="__TARNET_ADDR__" goto fail_addr
if "%ADDR%"=="" goto fail_addr
if not "%ADDR:~0,2%"=="0x" goto fail_addr
rem 0x + 40 hex = 42 символа: 42-й должен отсутствовать, 41-й — быть.
if not "%ADDR:~42,1%"=="" goto fail_addr
if "%ADDR:~41,1%"=="" goto fail_addr
echo ============================================
echo   TarNet Worker - установка
echo ============================================
echo   кошелёк: %ADDR%
echo   сервер:  %API%
echo   папка:   %TARNET_DIR%
echo ============================================
echo.

if not exist "%TARNET_DIR%" mkdir "%TARNET_DIR%" 2>nul
if not exist "%TARNET_DIR%" goto fail_dir

rem ---------- 1/4 Node.js ----------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto have_node

echo [1/4] Node.js не найден - скачиваю portable (34 МБ)...
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

echo [2/4] Ollama не найден - скачиваю и ставлю тихо...
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

rem ждём, пока локальный сервер Ollama поднимется (установщик запускает его сам)
set /a WAIT=0
:wait_ollama
curl.exe -s -f --max-time 2 -o NUL "http://127.0.0.1:11434/api/tags" >nul 2>nul
if not errorlevel 1 goto ollama_ready
set /a WAIT+=1
if !WAIT! geq 20 goto no_ollama
timeout /t 2 /nobreak >nul
goto wait_ollama

:ollama_ready
echo [2/4] сервер Ollama отвечает
goto model

:no_ollama
echo.
echo   ВНИМАНИЕ: Ollama не установилась.
echo   Воркер запустится, но будет отвечать заглушкой
echo   (в /health это честно видно: llm_mode = deterministic_fallback).
echo   Поставить вручную: https://ollama.com/download
echo.
set "SKIP_MODEL=1"

rem ---------- 3/4 модель ----------
:model
if "%SKIP_MODEL%"=="1" (
  echo [3/4] модель пропущена
  goto step4
)
echo [3/4] Модель %MODEL% (около 1 ГБ, это самая долгая часть)...
"%OLLAMA_EXE%" pull %MODEL%
if errorlevel 1 (
  echo       модель не скачалась - воркер пойдёт в режиме без модели
  set "SKIP_MODEL=1"
)

rem ---------- 4/4 воркер ----------
:step4
echo [4/4] Скачиваю воркер...
set "WORKER_JS=%TARNET_DIR%\tarnet-worker.js"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%API%/download/worker.js' -OutFile '%WORKER_JS%'"
if not exist "%WORKER_JS%" goto fail_worker

rem Лаунчер на будущее: после перезагрузки ПК воркер можно поднять повторно,
rem не проходя установку заново.
(
  echo @echo off
  echo setlocal
  echo set "WORKER_ADDRESS=%ADDR%"
  echo set "TARNET_API_URL=%API%"
  echo set "TARNET_MODEL=%MODEL%"
  echo start /min "" "%NODE_EXE%" "%WORKER_JS%"
) > "%TARNET_DIR%\start.cmd"

echo [4/4] Запускаю воркер в фоне...
start /min "" "%TARNET_DIR%\start.cmd"

echo.
echo ============================================
echo   Готово. Воркер запущен в свёрнутом окне.
echo ============================================
echo   Проверить: PWA, вкладка "Мои устройства".
echo   Лог работы виден в этом окне воркера.
echo   Запуск после перезагрузки: "%TARNET_DIR%\start.cmd"
echo.
pause
exit /b 0

rem ---------- ошибки ----------
:fail_addr
echo.
echo   ОШИБКА: адрес воркера не передан или испорчен.
echo.
echo   получено: "%ADDR%"
echo   ожидается: 0x и ровно 40 шестнадцатеричных символов.
echo.
echo   Такой файл нельзя запускать: воркер создаст НОВЫЙ кошелёк, и ваша
rem   работа уйдёт в чужой баланс.
echo.
echo   Что делать: откройте TarNet PWA на телефоне, вкладка
rem   "Мои устройства" - скачайте установщик заново.
echo.
pause
exit /b 2

:fail_dir
echo   ОШИБКА: не могу создать папку %TARNET_DIR%
pause
exit /b 1

:fail_node
echo   ОШИБКА: Node.js не скачался.
echo   Проверьте интернет или поставьте Node вручную: https://nodejs.org
pause
exit /b 1

:fail_worker
echo   ОШИБКА: воркер не скачался с %API%/download/worker.js
pause
exit /b 1

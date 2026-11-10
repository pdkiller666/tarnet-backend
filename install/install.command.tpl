#!/bin/bash
# ============================================================
#  TarNet Worker — установка в один клик (macOS / Linux)
#  Адрес и сервер подставлены сервером при скачивании.
#  Аргументы не нужны: двойной клик — и всё.
# ============================================================
set -u

ADDR="__TARNET_ADDR__"
API="__TARNET_API__"
MODEL="__TARNET_MODEL__"
NODEV="v22.11.0"

TARNET_DIR="$HOME/.tarnet"
WORKER_JS="$TARNET_DIR/tarnet-worker.js"

# Окно закрывается сразу после работы — иначе человек не увидит, что
# произошло. Держим паузу на любом исходе.
pause_exit() {
  echo
  read -r -p "Нажмите Enter, чтобы закрыть окно..." _ || true
  exit "${1:-0}"
}

say() { printf '%s\n' "$*"; }

# ---------- проверка адреса ----------
# Адрес подставляет сервер при скачивании и отвечает 400, если его нет или
# он испорчен, поэтому скачанный файл всегда содержит настоящий адрес.
# Пустой адрес — теперь НОРМА, а не признак порчи файла (2.21.4).
#
# Почему поменялось: установщик больше не вшивает адрес браузера. Если вшить,
# ПК работает ровно на том же кошельке, что и аккаунт, и сервер отвечает
# SAME_ADDRESS при погашении кода (owner == device он отклоняет намеренно).
# Теперь воркер создаёт СВОЙ кошелёк в `~/.tarnet/worker.json`, а владелец
# привязывает его шестизначным кодом из PWA — ровно как задумано.
#
# Адрес всё ещё принимается, если передан (старые ссылки): тогда он обязан
# быть верным, иначе опечатка молча уведёт работу в чужой баланс.
#
# НИКОГДА не сравнивайте ADDR с серверным плейсхолдером: сервер заменяет
# КАЖДОЕ его вхождение, включая копию внутри этой проверки, и условие
# начинает сравнивать адрес с самим собой — оно всегда истинно, и установщик
# падает при запуске у любого пользователя.
if [ -n "$ADDR" ]; then
  case "$ADDR" in
    0x*) ;;
    *) say "  ОШИБКА: адрес испорчен: $ADDR"; pause_exit 2 ;;
  esac
  # 0x + ровно 40 hex = 42 символа.
  if [ "${#ADDR}" -ne 42 ]; then
    say "  ОШИБКА: адрес неверной длины (${#ADDR} вместо 42): $ADDR"
    pause_exit 2
  fi
fi

say "============================================"
say "  TarNet Worker — установка"
say "============================================"
say "  кошелёк: ${ADDR:-будет создан при первом запуске, привяжете кодом}"
say "  сервер:  $API"
say "  папка:   $TARNET_DIR"
say "============================================"
echo

mkdir -p "$TARNET_DIR" || { say "ОШИБКА: не могу создать $TARNET_DIR"; pause_exit 1; }

# ---------- 1/4 Node.js ----------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  say "[1/4] Node.js: ok — $NODE_BIN"
else
  say "[1/4] Node.js не найден — скачиваю portable..."
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux)  OS=linux ;;
    *) say "ОШИБКА: неподдерживаемая ОС $(uname -s)"; pause_exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=x64 ;;
    *) say "ОШИБКА: неподдерживаемая архитектура $(uname -m)"; pause_exit 1 ;;
  esac

  NAME="node-$NODEV-$OS-$ARCH"
  TARBALL="$TARNET_DIR/node.tar.gz"
  URL="https://nodejs.org/dist/$NODEV/$NAME.tar.gz"

  say "      $URL"
  if ! curl -fL --retry 2 --connect-timeout 20 -o "$TARBALL" "$URL"; then
    say "ОШИБКА: Node.js не скачался. Проверьте интернет."
    pause_exit 1
  fi
  if ! tar -xzf "$TARBALL" -C "$TARNET_DIR"; then
    say "ОШИБКА: архив Node.js повреждён."
    pause_exit 1
  fi
  rm -f "$TARBALL"
  NODE_BIN="$TARNET_DIR/$NAME/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    say "ОШИБКА: node не найден после распаковки ($NODE_BIN)"
    pause_exit 1
  fi
  say "[1/4] Node.js: ok — $NODE_BIN"
fi

# ---------- 2/4 Ollama ----------
OLLAMA_BIN=""
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="$(command -v ollama)"
elif [ -x "/Applications/Ollama.app/Contents/Resources/ollama" ]; then
  OLLAMA_BIN="/Applications/Ollama.app/Contents/Resources/ollama"
fi

if [ -n "$OLLAMA_BIN" ]; then
  say "[2/4] Ollama: ok — $OLLAMA_BIN"
else
  say "[2/4] Ollama не найден — скачиваю..."
  if [ "$(uname -s)" = "Darwin" ]; then
    ZIP="$TARNET_DIR/Ollama-darwin.zip"
    if curl -fL --retry 2 --connect-timeout 20 -o "$ZIP" "https://ollama.com/download/Ollama-darwin.zip"; then
      unzip -q -o "$ZIP" -d "$TARNET_DIR" || true
      rm -f "$ZIP"
      # Кладём .app в Applications, если есть право записи; иначе остаётся в ~/.tarnet
      if [ -d "$TARNET_DIR/Ollama.app" ] && [ -w "/Applications" ]; then
        rm -rf "/Applications/Ollama.app" 2>/dev/null || true
        cp -R "$TARNET_DIR/Ollama.app" "/Applications/" 2>/dev/null || true
      fi
      if [ -x "/Applications/Ollama.app/Contents/Resources/ollama" ]; then
        OLLAMA_BIN="/Applications/Ollama.app/Contents/Resources/ollama"
      elif [ -x "$TARNET_DIR/Ollama.app/Contents/Resources/ollama" ]; then
        OLLAMA_BIN="$TARNET_DIR/Ollama.app/Contents/Resources/ollama"
      fi
    fi
  else
    say "      Linux: автоматическая установка не поддерживается, ставлю вручную"
    say "      curl -fsSL https://ollama.com/install.sh | sh"
  fi
fi

if [ -z "$OLLAMA_BIN" ]; then
  say ""
  say "  ВНИМАНИЕ: Ollama не установлена."
  say "  Воркер запустится, но будет отвечать заглушкой — в /health это"
  say "  честно видно: llm_mode = deterministic_fallback."
  say "  Поставить вручную: https://ollama.com/download"
  say ""
else
  # Сервер Ollama мог не запуститься сам — поднимаем в фоне, если не отвечает.
  if ! curl -sf --max-time 2 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    say "[2/4] поднимаю сервер Ollama..."
    nohup "$OLLAMA_BIN" serve >/dev/null 2>&1 &
    for _ in $(seq 1 20); do
      curl -sf --max-time 2 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1 && break
      sleep 1
    done
  fi

  if curl -sf --max-time 2 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    say "[2/4] сервер Ollama отвечает"

    # ---------- 3/4 модель ----------
    say "[3/4] Модель $MODEL (около 1 ГБ, это самая долгая часть)..."
    if ! "$OLLAMA_BIN" pull "$MODEL"; then
      say "      ! модель не скачалась — воркер пойдёт в режиме без модели"
    fi
  else
    say "[3/4] сервер Ollama не поднялся — модель пропущена"
  fi
fi

# ---------- 4/4 воркер ----------
say "[4/4] Скачиваю воркер..."
if ! curl -fL --retry 2 --connect-timeout 20 -o "$WORKER_JS" "$API/download/worker.js"; then
  say "ОШИБКА: воркер не скачался с $API/download/worker.js"
  pause_exit 1
fi

# ---------- 4b. p2p-node (2.22.7) ----------
# До этого шага установщик качал ОДИН файл. `--p2p` искал
# p2p-node/p2p-worker.js рядом с воркером, не находил и молча оставался на
# WS: симптом тот же, что «забыли второе окно», поэтому отсутствующий
# транспорт было не отличить от простаивающего.
#
# В архиве ТОЛЬКО исходники: `node_modules` (105 МБ) ставится здесь по
# package-lock — те же байты, но не через наш канал раздачи. `data/`
# (ключ узла peer-id.bin) не уезжает никогда.
P2P_DIR="$TARNET_DIR/p2p-node"
P2P_OK=0
say "      p2p-транспорт..."
if curl -fL --retry 2 --connect-timeout 20 -o "$TARNET_DIR/p2p-node.zip" "$API/download/p2p-node.zip"; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$TARNET_DIR/p2p-node.zip" -d "$TARNET_DIR" && rm -f "$TARNET_DIR/p2p-node.zip"
  else
    # macOS без Xcode CLT не имеет unzip; tar там есть всегда, но zip он не
    # читает. ditto — системная утилита macOS, читает zip нативно.
    if command -v ditto >/dev/null 2>&1; then
      ditto -x -k "$TARNET_DIR/p2p-node.zip" "$TARNET_DIR" && rm -f "$TARNET_DIR/p2p-node.zip"
    fi
  fi
fi

# jcs.js (2.26.12). `worker-record.js` подключает канонизатор из родительской
# папки (`../jcs.js`), а в установленной раскладке это `<TarNet>/jcs.js`.
# До этой версии архив вёз только p2p-node/*, require промахивался, и
# транспорт падал с MODULE_NOT_FOUND ещё до первого announce — снаружи это
# выглядело как «P2P не работает», а не как отсутствующий файл.
JCS_OK=1
if [ ! -f "$TARNET_DIR/jcs.js" ]; then JCS_OK=0; fi

if [ -f "$P2P_DIR/p2p-worker.js" ] && [ "$JCS_OK" = "1" ]; then
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
  if [ -x "$NPM_BIN" ]; then
    # `ci`, а не `install`: lock-файл лежит в архиве, а ci отказывается
    # выдумывать версии. Ставим В папку p2p — оттуда node разрешает `libp2p`,
    # никаких NODE_PATH не нужно.
    if (cd "$P2P_DIR" && "$NPM_BIN" ci --omit=dev --no-audit --no-fund >"$TARNET_DIR/p2p-install.log" 2>&1); then
      # Проверяем, что транспорт реально загружается ЗДЕСЬ, а не при первом
      # запуске у человека. Иначе отказ импорта вылезет молчаливым откатом
      # на WS — ровно тот дефект, ради которого этот шаг и появился.
      if (cd "$P2P_DIR" && "$NODE_BIN" -e "import('libp2p').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1); then
        P2P_OK=1
        # Discovery нужен kad-dht и gossipsub сверх самого транспорта.
        # relay-v2 обязателен с 2.25.3: p2p-worker.js импортирует его
        # статически, без пакета падает весь модуль, а не только NAT.
        # multiaddr обязателен с 2.25.3a: bridge.js импортирует его
        # статически для dial между seed, и всего на нём 5 файлов.
        # Проверяем отдельно: без них транспорт жив, но объявления в DHT
        # нет — и это надо сказать вслух, а не оставить молчаливым.
        if ! (cd "$P2P_DIR" && "$NODE_BIN" -e "Promise.all([import('@libp2p/kad-dht'),import('@libp2p/gossipsub'),import('@libp2p/circuit-relay-v2'),import('@multiformats/multiaddr')]).then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1); then
          DHT_OK=0
        else
          DHT_OK=1
        fi
        if [ "$DHT_OK" = "1" ]; then
          say "      p2p-транспорт: ok"
        else
          say "      p2p-транспорт: ok (WS)"
          say "      ПРЕДУПРЕЖДЕНИЕ: МОДУЛИ DHT (kad-dht/gossipsub/relay/multiaddr) НЕ ЗАГРУЖАЮТСЯ"
          say "      Discovery выключен — воркер будет работать только через WS-мост"
          say "      Починить: cd \"$P2P_DIR\" && npm ci --omit=dev"
        fi
      else
        say "      ПРЕДУПРЕЖДЕНИЕ: libp2p не загрузился после npm ci — p2p пропущен"
      fi
    else
      say "      ПРЕДУПРЕЖДЕНИЕ: npm ci не удался — p2p пропущен"
      say "      Лог: $TARNET_DIR/p2p-install.log"
    fi
  else
    say "      ПРЕДУПРЕЖДЕНИЕ: npm не найден рядом с node — p2p пропущен"
  fi
else
  if [ "$JCS_OK" = "0" ]; then
    say "      ПРЕДУПРЕЖДЕНИЕ: jcs.js не найден рядом с воркером — p2p пропущен"
    say "      Причина: worker-record.js требует ../jcs.js"
    say "      Починить: переустановить (архив на сервере мог устареть)"
  else
    say "      ПРЕДУПРЕЖДЕНИЕ: архив p2p не скачался — p2p пропущен"
  fi
fi

# ---------- 4c. capabilities для Discovery (2.26.0) ----------
# ЗАЧЕМ УСТАНОВЩИК ЗНАЕТ CAPABILITIES.
#
# `workerCapabilities()` читает P2P_MODEL_FAMILIES / P2P_RUNTIMES /
# P2P_DEVICE_CLASS, а `announce()` при пустом списке ВЫХОДИТ ДО `provide()`.
# До этой правки установщик эти переменные не задавал вообще: у человека
# всё поднималось, воркер работал по WS, а Discovery молчал — то есть
# «работает» было правдой для задач и ложью для сети.
#
# ПОЧЕМУ ОПРЕДЕЛЯЕМ ЗДЕСЬ, А НЕ В ЛАУНЧЕРЕ. Лаунчер запускается каждый
# раз, а модель и железо меняются редко; лишний вызов `nvidia-smi` при
# каждом старте — плата без пользы. Значение вшивается в start.sh и может
# быть переопределено вручную (переменная только если пуста).

# Семейство без тега: qwen2.5-coder:7b -> qwen2.5-coder.
# Тег — это размер конкретной сборки, а не возможность узла: клиент ищет
# «кто умеет qwen2.5-coder», и воркер с :7b обязан найтись по этому запросу.
P2P_MODEL_FAMILY="${MODEL%%:*}"
P2P_MODEL_FAMILY="$(printf '%s' "$P2P_MODEL_FAMILY" | tr -d '[:space:]')"

# Если модель так и не встала (Ollama недоступна), объявлять её нельзя:
# воркер заявил бы в DHT возможность, которой нет, и клиент пришёл бы с
# задачей, которую некому выполнить. Пустая строка честнее выдумки.
if [ "$SKIP_MODEL" = "1" ] 2>/dev/null; then
  P2P_MODEL_FAMILY=""
fi
if ! command -v ollama >/dev/null 2>&1 && [ ! -x "${OLLAMA_BIN:-}" ]; then
  P2P_MODEL_FAMILY=""
fi

# Запасной путь (2.26.12): спросить Ollama, что реально установлено.
#
# Реальный случай: модель уже была скачана на ПК владельца, шаг pull
# пропустился, семейство осталось пустым — и установщик объявил «возможностей
# нет», хотя рабочая модель лежала рядом. Discovery молчал по причине,
# которую снаружи не видно.
#
# `ollama list` — честная проверка: там то, что есть СЕЙЧАС, а не то, что мы
# надеялись поставить. `tail -n +2` отбрасывает заголовок, `cut -d: -f1`
# срезает тег: `qwen2.5-coder:1.5b` -> `qwen2.5-coder`, ровно та форма
# семейства, по которой ищет клиент. Только если семейство всё ещё пусто:
# явный TARNET_MODEL главнее.
if [ -z "$P2P_MODEL_FAMILY" ]; then
  OLLAMA_BIN_RESOLVED="${OLLAMA_BIN:-}"
  if [ -z "$OLLAMA_BIN_RESOLVED" ] && command -v ollama >/dev/null 2>&1; then
    OLLAMA_BIN_RESOLVED="$(command -v ollama)"
  fi
  if [ -n "$OLLAMA_BIN_RESOLVED" ] && [ -x "$OLLAMA_BIN_RESOLVED" ]; then
    P2P_MODEL_FAMILY="$("$OLLAMA_BIN_RESOLVED" list 2>/dev/null | tail -n +2 | head -n 1 | cut -d: -f1 | tr -d '[:space:]')"
  fi
fi

# GPU: nvidia-smi есть и отвечает — gpu, иначе cpu.
# Не `ls /dev/nvidia*`: файла может не быть при рабочем драйвере и наоборот.
P2P_DEVICE="cpu"
if command -v nvidia-smi >/dev/null 2>&1; then
  if nvidia-smi -L >/dev/null 2>&1; then P2P_DEVICE="gpu"; fi
fi

# Рантайм у нас один — ollama. Список, а не строка: формат env — через запятую.
P2P_RUNTIME="ollama"

if [ -n "$P2P_MODEL_FAMILY" ]; then
  say "      Discovery: модели=$P2P_MODEL_FAMILY устройство=$P2P_DEVICE"
else
  say "      Discovery: capabilities не определены — воркер не объявится в DHT"
  say "      Починить: переустановить с рабочей Ollama или задать P2P_MODEL_FAMILIES вручную"
fi

# Лаунчер на будущее: после перезагрузки не надо проходить установку заново.
cat > "$TARNET_DIR/start.sh" <<LAUNCHER
#!/bin/bash
# cd обязателен (2.24.8): воркер ищет p2p-node/ относительно cwd. Запуск из
# чужой папки (ярлык, автозапуск, терминал) терял транспорт молча.
cd "$TARNET_DIR" || exit 1
# Пустой WORKER_ADDRESS — валидное состояние: воркер поймёт это как «создать
# свой кошелёк». Не экспортируем пустую строку вовсе: тогда переменная точно
# не перебьётся значением из прошлого профиля.
if [ -n "$ADDR" ]; then
  echo "export WORKER_ADDRESS=\"$ADDR\""
fi
export TARNET_API_URL="$API"
export TARNET_MODEL="$MODEL"
# Capabilities для Discovery. Значения вшиты установщиком (2.26.0);
# `${VAR:-...}` — чтобы ручная правка start.sh побеждала, а не затиралась.
export P2P_MODEL_FAMILIES="\${P2P_MODEL_FAMILIES:-$P2P_MODEL_FAMILY}"
export P2P_DEVICE_CLASS="\${P2P_DEVICE_CLASS:-$P2P_DEVICE}"
export P2P_RUNTIMES="\${P2P_RUNTIMES:-$P2P_RUNTIME}"
# --p2p только когда транспорт действительно установлен: флаг без p2p-node
# оставляет рабочий WS-воркер плюс строку предупреждения в каждом логе
# запуска, то есть шум вместо пользы.
P2P_FLAG=""
if [ "$P2P_OK" = "1" ]; then P2P_FLAG="--p2p"; fi
exec "$NODE_BIN" "$WORKER_JS" $P2P_FLAG "\$@"
LAUNCHER
chmod +x "$TARNET_DIR/start.sh"

say "[4/4] Запускаю воркер в фоне..."
nohup "$TARNET_DIR/start.sh" > "$TARNET_DIR/worker.log" 2>&1 &
WPID=$!
sleep 3

if kill -0 "$WPID" 2>/dev/null; then
  say ""
  say "============================================"
  say "  Готово. Воркер работает (pid $WPID)."
  say "============================================"
  say "  Проверить: PWA → вкладка «Мои устройства»."
  say "  Лог:       $TARNET_DIR/worker.log"
  say "  Остановить: kill $WPID"
  say "  Запуск снова: $TARNET_DIR/start.sh"
  say ""
  say "  Первые строки лога:"
  sed -n '1,6p' "$TARNET_DIR/worker.log" 2>/dev/null | sed 's/^/    /'
  pause_exit 0
else
  say ""
  say "ОШИБКА: воркер завершился сразу после запуска. Лог:"
  sed -n '1,20p' "$TARNET_DIR/worker.log" 2>/dev/null | sed 's/^/    /'
  pause_exit 1
fi

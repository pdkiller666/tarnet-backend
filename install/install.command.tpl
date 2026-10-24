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

say "============================================"
say "  TarNet Worker — установка"
say "============================================"
say "  кошелёк: $ADDR"
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

# Лаунчер на будущее: после перезагрузки не надо проходить установку заново.
cat > "$TARNET_DIR/start.sh" <<LAUNCHER
#!/bin/bash
export WORKER_ADDRESS="$ADDR"
export TARNET_API_URL="$API"
export TARNET_MODEL="$MODEL"
exec "$NODE_BIN" "$WORKER_JS" "\$@"
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

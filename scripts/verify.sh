#!/bin/bash
# TarNet verify — доказывает, что на VPS лежит ровно то, что в GitHub, и что
# сервис жив. Ничего не меняет: только читает и сравнивает.
#
# Проверяет:
#   1. Локальный HEAD = HEAD на GitHub.
#   2. HEAD на VPS = локальный HEAD (иначе git log на сервере врёт).
#   3. git status на VPS чистый (иначе следующий reset --hard что-то сотрёт).
#   4. sha256 каждого файла из коммита = sha256 файла на VPS.
#   5. Сервис active.
#   6. /health 200 (на сервере и снаружи), /app/ 200 снаружи.
#
# Exit 0 только если все проверки зелёные.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="main"
REPO_SLUG="pdkiller666/tarnet-backend"
GH_CREDS="${TARNET_GH_CREDS:-/home/node/.openclaw/credentials/github/personal/ghp_d000abcd8efeb474c2425f28f1b0a409/hosts.yml}"
VPS="${TARNET_VPS:-root@195.63.131.172}"
SSH_KEY="${TARNET_SSH_KEY:-$HOME/.ssh/tarnet_vps}"
REMOTE_DIR="${TARNET_REMOTE_DIR:-/opt/tarnet/backend-api}"
SERVICE="${TARNET_SERVICE:-tarnet}"
PUBLIC_URL="${TARNET_PUBLIC_URL:-https://v1107336.hosted-by-vdsina.com}"

SSH_OPTS=(-i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
FAIL=0

ok() { printf '  \033[32m✅\033[0m %-26s %s\n' "$1" "$2"; }
no() { printf '  \033[31m❌\033[0m %-26s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

printf '\nTarNet verify — сверка VPS с GitHub\n'
printf 'репозиторий: %s\n\n' "$REPO_DIR"

cd "$REPO_DIR" || { echo "нет каталога $REPO_DIR"; exit 2; }

# ---------- 1. локально и на GitHub ----------
LOCAL_HEAD=$(git rev-parse HEAD)
LOCAL_SHORT=$(git rev-parse --short HEAD)

TOKEN=""
if [ -r "$GH_CREDS" ]; then
  TOKEN=$(grep -m1 '^  oauth_token:' "$GH_CREDS" | sed 's/^  oauth_token: *//' | tr -d '"' | tr -d ' ')
fi
if [ ${#TOKEN} -ge 20 ]; then
  GH_HEAD=$(git ls-remote "https://x-access-token:${TOKEN}@github.com/${REPO_SLUG}.git" \
            "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
else
  GH_HEAD=""
fi

if [ -z "$GH_HEAD" ]; then
  no "GitHub HEAD" "не прочитал (нет токена или сети)"
elif [ "$GH_HEAD" = "$LOCAL_HEAD" ]; then
  ok "GitHub HEAD" "$(printf %.7s "$GH_HEAD") = локальный $LOCAL_SHORT"
else
  no "GitHub HEAD" "GitHub $(printf %.7s "$GH_HEAD") != локальный $LOCAL_SHORT"
fi

LOCAL_DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$LOCAL_DIRTY" = "0" ]; then
  ok "локальное дерево" "чистое"
else
  no "локальное дерево" "$LOCAL_DIRTY незакоммиченных путей (деплой их не увидит)"
fi

# ---------- 2. VPS: HEAD, чистота, файлы ----------
VPS_INFO=$(ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$REMOTE_DIR" <<'REMOTE' 2>/dev/null
DIR=$1
cd "$DIR" || { echo "ERR=nodir"; exit 0; }
echo "HEAD=$(git rev-parse HEAD 2>/dev/null || echo none)"
echo "SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo none)"
echo "DIRTY=$(git status --porcelain | wc -l | tr -d ' ')"
echo "ACTIVE=$(systemctl is-active tarnet 2>/dev/null || echo unknown)"
REMOTE
)

vps_get() { printf '%s\n' "$VPS_INFO" | sed -n "s/^$1=//p" | head -1; }
VPS_HEAD=$(vps_get HEAD)
VPS_SHORT=$(vps_get SHORT)
VPS_DIRTY=$(vps_get DIRTY)
VPS_ACTIVE=$(vps_get ACTIVE)

if [ "$VPS_HEAD" = "nodir" ] || [ -z "$VPS_HEAD" ]; then
  no "VPS HEAD" "не прочитал состояние репозитория на VPS"
elif [ "$VPS_HEAD" = "$LOCAL_HEAD" ]; then
  ok "VPS HEAD" "$VPS_SHORT = локальный $LOCAL_SHORT"
else
  no "VPS HEAD" "$VPS_SHORT != локальный $LOCAL_SHORT"
fi

if [ "$VPS_DIRTY" = "0" ]; then
  ok "git status на VPS" "чистый"
else
  no "git status на VPS" "$VPS_DIRTY грязных путей — следующий reset что-то сотрёт"
fi

# ---------- 3. побайтовая сверка файлов ----------
mapfile -t FILES < <(git ls-tree -r --name-only HEAD)
declare -A LOCAL_SHA=()
for f in "${FILES[@]}"; do
  LOCAL_SHA["$f"]=$(git show "HEAD:$f" | sha256sum | cut -d' ' -f1)
done

REMOTE_SHAS=$(printf '%s\n' "${FILES[@]}" | ssh "${SSH_OPTS[@]}" "$VPS" \
  "cd $REMOTE_DIR && xargs -r -d '\n' sha256sum 2>/dev/null" 2>/dev/null)

declare -A REMOTE_SHA=()
while IFS= read -r line; do
  h=${line%% *}
  p=${line#*  }
  [ -n "$h" ] && [ -n "$p" ] && REMOTE_SHA["$p"]=$h
done <<< "$REMOTE_SHAS"

MATCH=0; MISMATCH=""
for f in "${FILES[@]}"; do
  if [ "${REMOTE_SHA[$f]:-}" = "${LOCAL_SHA[$f]}" ]; then
    MATCH=$((MATCH+1))
  else
    MISMATCH="$MISMATCH ${f}"
  fi
done
TOTAL=${#FILES[@]}

if [ -z "$MISMATCH" ]; then
  ok "sha256 файлов" "$MATCH/$TOTAL совпали с коммитом"
else
  no "sha256 файлов" "$MATCH/$TOTAL, отличия:$MISMATCH"
fi

# ---------- 3.5 systemd drop-in ----------
# Файлы в /etc/systemd не входят в рабочее дерево сервиса: их не видит ни
# git reset, ни сверка sha256 выше. Без этой проверки дрейф drop-in'а
# остаётся невидимым — именно так значение жило только на одном сервере,
# а verify показывал «всё зелёное».
DROPIN_DIR="deploy/systemd/tarnet.service.d"
mapfile -t DROPINS < <(git ls-tree -r --name-only HEAD -- "$DROPIN_DIR" 2>/dev/null | grep '\.conf$' || true)

if [ "${#DROPINS[@]}" -eq 0 ]; then
  no "systemd drop-in" "в репозитории нет $DROPIN_DIR/*.conf"
else
  INST_SHAS=$(ssh "${SSH_OPTS[@]}" "$VPS" \
    "cd /etc/systemd/system/${SERVICE}.service.d 2>/dev/null && sha256sum *.conf" 2>/dev/null)

  declare -A INST_SHA=()
  while IFS= read -r line; do
    h=${line%% *}
    p=${line#*  }
    [ -n "$h" ] && [ -n "$p" ] && INST_SHA["$(basename "$p")"]=$h
  done <<< "$INST_SHAS"

  DMIS=""
  for f in "${DROPINS[@]}"; do
    b=$(basename "$f")
    want=$(git show "HEAD:$f" | sha256sum | cut -d' ' -f1)
    [ "${INST_SHA[$b]:-}" = "$want" ] || DMIS="$DMIS $b"
  done

  if [ -z "$DMIS" ]; then
    ok "systemd drop-in" "${#DROPINS[@]} файлов = репозиторию"
  else
    no "systemd drop-in" "расходится с репозиторием:$DMIS (лечится deploy.sh)"
  fi

  # Файл на диске и переменная в сервисе — разные вещи: без daemon-reload
  # файл лежит, а процесс работает на старом значении.
  SVC_ENV=$(ssh "${SSH_OPTS[@]}" "$VPS" "systemctl show $SERVICE -p Environment" 2>/dev/null)
  ENV_MISS=""
  while IFS= read -r kv; do
    [ -n "$kv" ] || continue
    case " $SVC_ENV " in
      *" $kv "*) : ;;
      *) ENV_MISS="$ENV_MISS $kv" ;;
    esac
  done <<< "$(sed -n 's/^Environment=//p' "$DROPIN_DIR"/*.conf)"

  if [ -z "$ENV_MISS" ]; then
    ok "переменные применены" "systemd видит все значения"
  else
    no "переменные применены" "нет в окружении сервиса:$ENV_MISS"
  fi
fi

# ---------- 3.7 хроника проекта ----------
# verify.sh проверяет дрейф, а не напоминает про гигиену, поэтому здесь
# считаются ФАКТЫ, а не порог настроения.
#
# Что значит «хроника не старше кода»: последний коммит, тронувший
# PROJECT-HISTORY.md, не должен оставлять за собой кодовые коммиты,
# в которых есть изменение поведения сборки (buildVersion). Мелкие
# правки тестов и текста в хронологию не входят по её же правилам (§7).
#
# Не блокирует деплой: TARNET_HISTORY_STRICT=1 делает проверку жёсткой.
HISTORY_FILE="PROJECT-HISTORY.md"
HISTORY_MAX_LAG="${TARNET_HISTORY_MAX_LAG:-5}"
if [ ! -f "$HISTORY_FILE" ]; then
  no "хроника проекта" "нет $HISTORY_FILE — вехи проекта нигде не записаны"
else
  HIST_COMMIT=$(git log -1 --format=%H -- "$HISTORY_FILE" 2>/dev/null)
  if [ -z "$HIST_COMMIT" ]; then
    no "хроника проекта" "$HISTORY_FILE ни разу не менялся в истории git"
  else
    HIST_SHORT=$(printf %.7s "$HIST_COMMIT")
    HIST_WHEN=$(git log -1 --format='%ci' "$HIST_COMMIT" | cut -c1-16)

    # Кодовые коммиты после последней правки хроники. Именно они —
    # реальный дрейф: именно так накопилось 34 коммита за 25–28.10.
    CODE_AFTER=$(git rev-list --count "${HIST_COMMIT}..HEAD" -- '*.js' '*.html' '*.css' '*.sh' deploy 2>/dev/null || echo 0)

    # Смена версии сборки — это изменение поведения, которое нельзя
    # не заметить: именно оно произошло между 24.10 и 28.10 (2.12.1 → 2.12.4).
    #
    # Сравниваем строки версий, а не грепаем дифф: первая редакция этой
    # проверки искала `buildVersion` в server.js — и молча не находила ничего,
    # потому что там `BUILD_VERSION` (другой регистр), а значение по умолчанию
    # вообще живёт в package.json. Проверка выглядела рабочей и не работала.
    VER_THEN=$(git show "${HIST_COMMIT}:package.json" 2>/dev/null \
      | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
    VER_NOW=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)
    VER_CHANGED=0
    if [ -n "$VER_THEN" ] && [ -n "$VER_NOW" ] && [ "$VER_THEN" != "$VER_NOW" ]; then
      VER_CHANGED=1
    fi

    if [ "$CODE_AFTER" -eq 0 ]; then
      ok "хроника проекта" "$HIST_SHORT ($HIST_WHEN), кода после неё нет"
    elif [ "$CODE_AFTER" -le "$HISTORY_MAX_LAG" ] && [ "$VER_CHANGED" -eq 0 ]; then
      ok "хроника проекта" "$HIST_SHORT ($HIST_WHEN), $CODE_AFTER кодовых (порог $HISTORY_MAX_LAG), сборка не менялась"
    else
      if [ "$VER_CHANGED" -eq 1 ]; then
        no "хроника проекта" "сборка $VER_THEN → $VER_NOW, а в $HIST_SHORT вехи нет"
      else
        no "хроника проекта" "$CODE_AFTER кодовых коммитов после $HIST_SHORT (порог $HISTORY_MAX_LAG)"
      fi
      printf '     └ допиши §1 в %s; осознанный пропуск — TARNET_HISTORY_MAX_LAG=999\n' "$HISTORY_FILE"
    fi
  fi
fi

# ---------- 4. сервис и эндпоинты ----------
if [ "$VPS_ACTIVE" = "active" ]; then
  ok "systemd $SERVICE" "active"
else
  no "systemd $SERVICE" "$VPS_ACTIVE"
fi

H_LOCAL=$(ssh "${SSH_OPTS[@]}" "$VPS" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3001/health" 2>/dev/null)
[ "$H_LOCAL" = "200" ] && ok "/health на VPS" "HTTP 200" || no "/health на VPS" "HTTP ${H_LOCAL:-нет}"

H_PUB=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/health")
[ "$H_PUB" = "200" ] && ok "/health снаружи" "HTTP 200" || no "/health снаружи" "HTTP $H_PUB"

H_APP=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/app/")
[ "$H_APP" = "200" ] && ok "/app/ снаружи" "HTTP 200" || no "/app/ снаружи" "HTTP $H_APP"

H_DL=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/download/worker.js")
[ "$H_DL" = "200" ] && ok "/download/worker.js" "HTTP 200" || no "/download/worker.js" "HTTP $H_DL"

# ---------- 3.8 документы в корне воркспейса ----------
# Корень workspace не под git: документы живут в backend-api/docs/, а инвестору
# уходят копии из корня. Раньше копии разъезжались молча (29.10 EMAIL-TEMPLATE
# в корне был 8080 б против 9207 в docs). Теперь корень — симлинки, и расхождение
# стало невозможным — но только пока ссылки целы. Проверяем и это.
WS_ROOT="$(cd "$REPO_DIR/.." && pwd)"
DOC_LINKS="ONE-PAGER.md PITCH-DECK.md DEMO-SCRIPT.md EMAIL-TEMPLATE.md AUDIT-REALITY.md PROJECT-HISTORY.md"
if [ -d "$WS_ROOT" ]; then
  LINKS_BAD=""
  LINKS_OK=0
  for f in $DOC_LINKS; do
    p="$WS_ROOT/$f"
    if [ -L "$p" ] && [ -f "$p" ]; then
      LINKS_OK=$((LINKS_OK+1))
    elif [ -L "$p" ]; then
      LINKS_BAD="$LINKS_BAD $f(битая)"
    elif [ -f "$p" ]; then
      # Обычный файл в корне — это и есть возврат к расхождению.
      LINKS_BAD="$LINKS_BAD $f(копия)"
    else
      LINKS_BAD="$LINKS_BAD $f(нет)"
    fi
  done
  if [ -z "$LINKS_BAD" ]; then
    ok "документы в корне" "$LINKS_OK/$LINKS_OK — симлинки в backend-api"
  else
    no "документы в корне" "не симлинки:$LINKS_BAD"
  fi
fi

# ---------- итог ----------
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mВСЁ ЗЕЛЁНОЕ\033[0m: VPS = GitHub = %s, сервис жив\n\n' "$LOCAL_SHORT"
  exit 0
fi
printf '\033[31mПРОБЛЕМ: %d\033[0m\n\n' "$FAIL"
exit 1

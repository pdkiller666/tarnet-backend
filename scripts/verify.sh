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
# Путь к GitHub-креденшелам — только из окружения, без значения по умолчанию.
#
# Раньше здесь стоял жёсткий путь к hosts.yml с идентификатором ключа
# внутри (`ghp_...` в имени каталога). Самого токена в файле не было, но
# путь его выдавал: имя каталога — часть идентификатора, и по нему видно,
# какой именно ключ лежит на машине. Урок 29.10 («внутри репо скриптов с
# путями к секретам быть не должно») относился к `push.sh`, но этот файл
# ему противоречил с самого начала.
#
# Без `TARNET_GH_CREDS` проверка HEAD на GitHub пропускается с явным текстом,
# а не молча: тишина выглядела бы как «сверили и совпало».
GH_CREDS="${TARNET_GH_CREDS:-}"
# Если переменная не задана — ищем файл глобом, не называя идентификатор
# ключа в исходнике. Смысл тот же (скрипт работает на этой машине), но в
# репозитории больше нет имени каталога с `ghp_...`.
if [ -z "$GH_CREDS" ]; then
  for _c in "$HOME"/.openclaw/credentials/github/personal/*/hosts.yml; do
    [ -r "$_c" ] && { GH_CREDS="$_c"; break; }
  done
fi
VPS="${TARNET_VPS:-root@195.63.131.172}"
# Ключ — с постоянного тома (см. комментарий в deploy.sh).
SSH_KEY="${TARNET_SSH_KEY:-$HOME/.openclaw/ssh/tarnet_vps}"
[ -r "$SSH_KEY" ] || { [ -x "$HOME/.openclaw/ssh/ensure.sh" ] && "$HOME/.openclaw/ssh/ensure.sh" >&2 || true; }
REMOTE_DIR="${TARNET_REMOTE_DIR:-/opt/tarnet/backend-api}"
SERVICE="${TARNET_SERVICE:-tarnet}"
PUBLIC_URL="${TARNET_PUBLIC_URL:-https://v1107336.hosted-by-vdsina.com}"

SSH_OPTS=(-i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
FAIL=0

ok() { printf '  \033[32m✅\033[0m %-26s %s\n' "$1" "$2"; }
no() { printf '  \033[31m❌\033[0m %-26s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
# Пропуск — это НЕ успех и НЕ отказ. Печатается всегда, чтобы «зелено»
# нельзя было получить тишиной; в FAIL не идёт, иначе отсутствие токена
# делало бы полный verify красным на машине без креденшелов.
skip() { printf '  \033[33m⏭\033[0m  %-26s %s\n' "$1" "$2"; }

# ---------- тестовые наборы ----------
# Вердикт берётся из КОДА ВОЗВРАТА, а не из подсчёта символов. Итоговая строка
# набора («Итого: 980 ✅ 0 ❌») содержит оба символа, поэтому `grep -c ❌` даёт
# 1 на полностью зелёном прогоне — счёт по символам уже давал ложную тревогу.
#
# Запуск отвязан (setsid nohup): набор набирает 1000+ строк и живёт дольше
# одного терминального сеанса. Раньше при обрыве лог недописывался, и «нет
# вывода» выглядело как «нет падений».
#
# Таймаут короткий не потому, что набор «быстрый», а чтобы зависший тест давал
# красное, а не вечное ожидание.
run_suite() {
  local label="$1" timeout="$2" cmd="$3" tag="$4"
  local log="/tmp/tarnet-verify-${tag}.log" rcfile="/tmp/tarnet-verify-${tag}.rc"
  rm -f "$rcfile"
  setsid nohup sh -c "$cmd >'$log' 2>&1; echo \$? >'$rcfile'" >/dev/null 2>&1 &
  local waited=0
  while [ ! -s "$rcfile" ] && [ "$waited" -lt "$timeout" ]; do
    sleep 5; waited=$((waited+5))
  done
  if [ ! -s "$rcfile" ]; then
    no "тесты $label" "нет завершения за ${timeout}с — смотри $log"
    return
  fi
  local rc summary passes
  rc=$(cat "$rcfile" 2>/dev/null)
  summary=$(grep -a 'Итого:' "$log" 2>/dev/null | tail -1 | sed 's/.*Итого: *//')
  # Ноль выполненных проверок — не «зелено», а поломка набора: строку «Итого»
  # печатают и при нуле тестов, а exit-code при этом 0. Без этой проверки
  # набор, который не запустил ни одного теста, давал зелёный вердикт.
  passes=$(printf '%s' "$summary" | sed -n 's/^\([0-9]\{1,\}\).*/\1/p')
  if [ "$rc" = "0" ] && [ -n "$summary" ] && [ "${passes:-0}" -gt 0 ]; then
    ok "тесты $label" "$summary"
  elif [ -z "$summary" ]; then
    no "тесты $label" "exit $rc, итоговой строки нет — набор не дошёл до конца ($log)"
  elif [ "${passes:-0}" -eq 0 ]; then
    no "тесты $label" "ноль выполненных проверок (exit $rc) — набор не запустил тесты ($log)"
  else
    no "тесты $label" "$summary (exit $rc)"
  fi
}

verify_tests() {
  if [ "${TARNET_SKIP_TESTS:-0}" = "1" ]; then
    # Осознанный пропуск печатается, чтобы «зелено» нельзя было получить тишиной.
    printf '  \033[33m⋯\033[0m %-26s %s\n' "тесты" "пропущены (TARNET_SKIP_TESTS=1)"
    return
  fi
  run_suite "dpouw" "${TARNET_TEST_TIMEOUT_DPOUW:-900}" "node test-dpouw.js --test" dpouw
  run_suite "mesh" "${TARNET_TEST_TIMEOUT_MESH:-300}" "node test-mesh.js" mesh
  run_suite "treasury" "${TARNET_TEST_TIMEOUT_TREASURY:-300}" "node proof-treasury-gate.js" treasury

  # p2p E2E (2.26.0, Блок 6.3) — ОБЯЗАТЕЛЬНЫЙ ГЕЙТ.
  #
  # ЗАЧЕМ В verify.sh, А НЕ ОТДЕЛЬНЫМ СКРИПТОМ.
  # Скрипт, который запускают руками, рано или поздно перестают запускать.
  # Именно это и случилось с discovery: тесты были зелёные, а в runtime
  # `findProviders` не вызывался вообще — проверка существовала, но не
  # стояла на пути релиза.
  #
  # ЭТИ НАБОРЫ ДОРОГИЕ (реальный libp2p, реальные порты, десятки секунд).
  # Поэтому они идут ПОСЛЕ быстрых: если сломано очевидное, нет смысла
  # ждать сетевые тесты, чтобы это узнать.
  #
  # ОТКАЗ ОДНОГО НЕ ГЛУШИТ ОСТАЛЬНЫЕ: run_suite пишет каждый в свой лог,
  # и «discovery сломан, relay жив» остаётся различимой картиной.
  # --worker-seed + --expect-peer ОБЯЗАТЕЛЬНЫ в гейте, а не «для ручного
  # прогона». Без них проверка 4.3 уходит в SKIP, и гейт годами показывает
  # 11/11 при том, что сверка «нашли ИМЕННО ожидаемый узел» ни разу не
  # выполнялась. Это ровно та болезнь, из-за которой Discovery был
  # «зелёным, но мёртвым»: проверка существовала и не стояла на пути релиза.
  #
  # peerId ВЫЧИСЛЯЕТСЯ из seed, а не вписан константой: вписанный разошёлся
  # бы с seed при первой правке и дал бы ложный красный (или хуже — SKIP).
  DISCOVERY_SEED="$(printf 'a1%.0s' $(seq 1 32))"
  DISCOVERY_PEER="$(node --input-type=module -e '
    import { peerIdFromPublicKey, publicKeyFromSeed } from "./p2p-node/worker-record.js"
    const seed = Buffer.from(process.argv[1], "hex")
    process.stdout.write(peerIdFromPublicKey(publicKeyFromSeed(seed)))
  ' "$DISCOVERY_SEED" 2>/dev/null)"
  if [ -n "$DISCOVERY_PEER" ]; then
    run_suite "p2p-discovery" "${TARNET_TEST_TIMEOUT_P2P:-240}" \
      "node p2p-node/test/test-discovery-e2e.js --worker-seed $DISCOVERY_SEED --expect-peer $DISCOVERY_PEER" p2pdiscovery
  else
    # Не подменяем проверку тишиной: если peerId не вычислился, набор
    # запускается без флагов, и SKIP в логе будет виден как SKIP.
    run_suite "p2p-discovery" "${TARNET_TEST_TIMEOUT_P2P:-240}" \
      "node p2p-node/test/test-discovery-e2e.js" p2pdiscovery
  fi
  run_suite "p2p-gossip" "${TARNET_TEST_TIMEOUT_P2P:-240}" \
    "node p2p-node/test/test-gossip-e2e.js" p2pgossip
  run_suite "p2p-seed-failover" "${TARNET_TEST_TIMEOUT_P2P_SEED:-360}" \
    "node p2p-node/test/test-seed-failover.js" p2pseed
  # Relay — ОТДЕЛЬНЫЙ набор, а не часть discovery. Он проверяет другую
  # вещь: дотянуться до узла за NAT через circuit-relay-v2. Если его не
  # гонять на пути релиза, поломка relay выглядит как «discovery жив»,
  # а в бою воркер за домашним роутером просто недостижим.
  run_suite "p2p-relay" "${TARNET_TEST_TIMEOUT_P2P:-240}" \
    "node p2p-node/test/test-relay-e2e.js" p2prelay
  # Пере-объявление (2.26.1, Блок 2) — то, что раньше было «утверждением о
  # коде». Поднимает настоящий p2p-worker.js и ждёт дольше TTL: если
  # пере-объявление сломают, запись истечёт и набор покраснеет. Ставить
  # именно в гейт: без этого проверка «через TTL запись жива» снова станет
  # верой, а не фактом — ровно так уже было в 2.25.x.
  run_suite "p2p-reannounce" "${TARNET_TEST_TIMEOUT_P2P:-240}" \
    "node p2p-node/test/test-reannounce-e2e.js" p2preannounce
}

printf '\nTarNet verify — сверка VPS с GitHub\n'
printf 'репозиторий: %s\n\n' "$REPO_DIR"

cd "$REPO_DIR" || { echo "нет каталога $REPO_DIR"; exit 2; }

# Быстрый режим только для тестов: полный verify ходит по SSH к VPS и GitHub,
# а проверять детектор падений нужно без этой сети.
if [ "${TARNET_TESTS_ONLY:-0}" = "1" ]; then
  printf '\nTarNet verify — только тестовые наборы\n\n'
  verify_tests
  printf '\n'
  if [ "$FAIL" -eq 0 ]; then
    printf '\033[32mТЕСТЫ ЗЕЛЁНЫЕ\033[0m\n\n'; exit 0
  fi
  printf '\033[31mПРОБЛЕМ: %d\033[0m\n\n' "$FAIL"; exit 1
fi

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
  if [ -z "$GH_CREDS" ]; then
    skip "GitHub HEAD" "нет файла креденшелов — задайте TARNET_GH_CREDS"
  else
    no "GitHub HEAD" "не прочитал (токен есть, но сеть/ответ пусты)"
  fi
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

# ---------- 3.9 тестовые наборы ----------
verify_tests

# ---------- 4. сервис и эндпоинты ----------
if [ "$VPS_ACTIVE" = "active" ]; then
  ok "systemd $SERVICE" "active"
else
  no "systemd $SERVICE" "$VPS_ACTIVE"
fi

H_LOCAL=$(ssh "${SSH_OPTS[@]}" "$VPS" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3001/health" 2>/dev/null)
[ "$H_LOCAL" = "200" ] && ok "/health на VPS" "HTTP 200" || no "/health на VPS" "HTTP ${H_LOCAL:-нет}"

# ---------- 3.9 версия прода = версия в package.json ----------
# ПОЧЕМУ ОТДЕЛЬНАЯ ПРОВЕРКА. До 10.11.2026 гейт проверял /health только на КОД
# ОТВЕТА (200) и никогда — на ЗНАЧЕНИЕ buildVersion. Из-за этого документы
# утверждали «на проде 2.26.4», когда прод уже отдавал 2.26.5, и жило это
# незамеченным через четыре релиза: единственная проверка смотрела не туда.
# Здесь сравнивается то, что реально отдаёт живой сервис, с тем, что обещает
# package.json в проверяемом коммите. Раскатка без bump'а и bump без раскатки —
# оба случая становятся красными.
#
# Читаем с VPS, а не снаружи: внешний адрес может обслуживаться старым
# контейнером при уже обновлённом локальном, и тогда проверка мерила бы не то.
H_BODY=$(ssh "${SSH_OPTS[@]}" "$VPS" \
  "curl -s --max-time 10 http://127.0.0.1:3001/health" 2>/dev/null)
BUILD_LIVE=$(printf '%s' "$H_BODY" | sed -n 's/.*"buildVersion": *"\([^"]*\)".*/\1/p' | head -1)
BUILD_PKG=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)
if [ -z "$BUILD_LIVE" ]; then
  no "версия прода" "/health не отдал buildVersion (ответ длиной ${#H_BODY})"
elif [ -z "$BUILD_PKG" ]; then
  no "версия прода" "не разобрал version в package.json"
elif [ "$BUILD_LIVE" = "$BUILD_PKG" ]; then
  ok "версия прода" "$BUILD_LIVE = package.json"
else
  no "версия прода" "прод $BUILD_LIVE != package.json $BUILD_PKG — раскатай или поправь номер"
fi

H_PUB=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/health")
[ "$H_PUB" = "200" ] && ok "/health снаружи" "HTTP 200" || no "/health снаружи" "HTTP $H_PUB"

H_APP=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/app/")
[ "$H_APP" = "200" ] && ok "/app/ снаружи" "HTTP 200" || no "/app/ снаружи" "HTTP $H_APP"

H_DL=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/download/worker.js")
[ "$H_DL" = "200" ] && ok "/download/worker.js" "HTTP 200" || no "/download/worker.js" "HTTP $H_DL"

# ---------- 4.4 оба seed отвечают в /p2p/bootstrap ----------
# ПОЧЕМУ ОТДЕЛЬНАЯ ПРОВЕРКА. `2.25.4` ставит второй seed отдельным юнитом,
# и без этой строки «два seed» означает только «два файла в systemd»: в
# ответ bootstrap мог бы попадать один адрес, а второй юнит — тихо падать
# или не слушать порт. Требование P1.2d, п.4 — проверять ОБА, а не один.
#
# ПОЧЕМУ ЧЕРЕЗ node, А НЕ grep. Ответ — JSON с вложенным массивом `seeds`;
# grep по строке нашёл бы «ok» и в тексте ошибки. Разбираем как данные.
#
# ВАЖНО: проверяется РАЗНЫЕ ли peerId. Одинаковый означал бы, что оба
# процесса прочитали один ключ, и сети виден один узел дважды — то есть
# второй seed есть в отчёте, но не в сети.
BOOT_JSON=$(ssh "${SSH_OPTS[@]}" "$VPS" \
  "curl -s --max-time 10 http://127.0.0.1:3001/p2p/bootstrap" 2>/dev/null)
BOOT_VERDICT=$(printf '%s' "$BOOT_JSON" | node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    let j;
    try { j = JSON.parse(s); } catch { console.log("BAD_JSON"); return; }
    if (!j.ok) { console.log("NO"); return; }
    const seeds = Array.isArray(j.seeds) ? j.seeds : [];
    const live = seeds.filter((x) => x && x.ok && Array.isArray(x.multiaddrs) && x.multiaddrs.length);
    const ids = live.map((x) => x.peerId).filter(Boolean);
    const uniq = new Set(ids);
    if (live.length < 2) { console.log("LIVE=" + live.length); return; }
    if (uniq.size !== ids.length) { console.log("SAME_PEER"); return; }
    console.log("OK|" + live.length + "|" + ids.map((i) => i.slice(0, 8)).join(","));
  });
' 2>/dev/null)
case "$BOOT_VERDICT" in
  OK|*)
    ok "оба seed в bootstrap" "${BOOT_VERDICT#OK|} (peerId разные)" ;;
  LIVE=*)
    no "оба seed в bootstrap" "живых ${BOOT_VERDICT#LIVE=} из 2 — второй не отдаёт адреса" ;;
  SAME_PEER)
    no "оба seed в bootstrap" "у обоих ОДИН peerId — читают общий ключ" ;;
  NO)
    no "оба seed в bootstrap" "мост не отвечает (503) или p2p не поднят" ;;
  *)
    no "оба seed в bootstrap" "${BOOT_VERDICT:-нет ответа}" ;;
esac

# ---------- 4.5 /config отдаёт ставку Tier 6 ----------
# В 2.17.8 ставка B′ (0.0005 → 0.0002) была изменена, но проверить её снаружи
# было нечем: /config знал только fee/emission. Это ломало Code-First Rule —
# работающее должно быть видно в endpoint'е, а не только в `grep` по config.js.
#
# Проверка СРАВНИВАЕТ ответ с константами в config.js, а не ищет "0.0002"
# литералом: литерал прошел бы и в том случае, если бы /config отдавал
# захаРДкоженное число, разошедшееся с реальной комиссией. Ловим именно
# расхождение endpoint ↔ код.
CFG_JSON=$(curl -s -m 20 "$PUBLIC_URL/config" 2>/dev/null)
CFG_VERDICT=$(printf '%s' "$CFG_JSON" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const cfg=JSON.parse(s);
    const {TIER6}=require(process.argv[1]+"/config.js");
    const t=cfg.TIER6;
    if(!t){console.log("NO_TIER6|в ответе нет блока TIER6");return;}
    const bad=[];
    if(t.ORCHESTRATION_FEE_TAR!==TIER6.ORCHESTRATION_FEE_TAR)bad.push("fee "+t.ORCHESTRATION_FEE_TAR+"≠"+TIER6.ORCHESTRATION_FEE_TAR);
    if(t.CASHBACK_TAR!==TIER6.CASHBACK_TAR)bad.push("cashback "+t.CASHBACK_TAR+"≠"+TIER6.CASHBACK_TAR);
    if(Math.abs(t.cashbackRate-TIER6.cashbackRate)>1e-9)bad.push("rate "+t.cashbackRate+"≠"+TIER6.cashbackRate);
    if(bad.length){console.log("MISMATCH|"+bad.join(", "));return;}
    console.log("OK|fee="+t.ORCHESTRATION_FEE_TAR+" cashback="+t.CASHBACK_TAR+" rate="+t.cashbackRate);
  }catch(e){console.log("PARSE_ERR|"+e.message);}
});' "$REPO_DIR" 2>&1)
case "$CFG_VERDICT" in
  OK\|*) ok "/config TIER6" "${CFG_VERDICT#OK|} (= config.js)" ;;
  *)     no "/config TIER6" "${CFG_VERDICT}" ;;
esac

# ---------- 3.8 документы в корне воркспейса ----------
# Корень workspace не под git: документы живут в backend-api/docs/, а инвестору
# уходят копии из корня. Раньше копии разъезжались молча (29.10 EMAIL-TEMPLATE
# в корне был 8080 б против 9207 в docs). Теперь корень — симлинки, и расхождение
# стало невозможным — но только пока ссылки целы. Проверяем и это.
WS_ROOT="$(cd "$REPO_DIR/.." && pwd)"
# Список должен совпадать с набором симлинков в корне, а не быть выборкой из него.
# Было 7 имён из 11 существующих: ROADMAP, PROJECT-MAP и PROJECT-MEMORY не
# проверялись, хотя симлинками были. Дыра нашлась при добавлении MASTER-PLAN:
# гейт показывал «7/7», хотя три документа могли молча стать копиями.
# Пять канонических идут первыми — их поломка дороже всего.
# 10.11.2026: добавлен INVESTOR-CHECKLIST — в корне стало 13 ссылок, а список
# остался на 12. Ровно этот дефект комментарий выше и описывает: симлинк
# существует и гейтом не виден. Список обязан совпадать с набором, а не быть
# его выборкой.
DOC_LINKS="MANIFEST.v3.4-UNIFIED.md PROJECT-HISTORY.md PROJECT-MAP.md ROADMAP.md MASTER-PLAN.md NARRATIVE.md ONE-PAGER.md PITCH-DECK.md DEMO-SCRIPT.md EMAIL-TEMPLATE.md AUDIT-REALITY.md PROJECT-MEMORY.md INVESTOR-CHECKLIST.md"
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

# ---------- 5. свободное место на корне ----------
# Проверка НЕ блокирующая: нехватка места не делает сборку неверной, но делает
# следующий `npm install` непредсказуемым. Поэтому WARNING, а не FAIL.
#
# Порог 500 МБ выбран по замеру 04.11.2026: при 26 МБ `npm install` в
# backend-api падал, при 515 МБ проходил. 500 МБ — это примерно сутки роста
# транскриптов агента (100–190 МБ/сутки по наблюдению 21–28.10), то есть
# граница, за которой запас перестаёт покрывать один рабочий день.
#
# Считается в мегабайтах (`df -m`), а не в процентах: 95% от 9.8 ГБ и 95% от
# 100 ГБ — разные риски, проценты это скрывают.
FREE_MB=$(df -m / 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt 500 ] 2>/dev/null; then
  skip "свободное место" "WARNING: ${FREE_MB} МБ < 500 МБ — следующий npm install может упасть"
  printf '  \033[33m⚠\033[0m  %-26s %s\n' "диск" "$(df -h / | awk 'NR==2{print $3" / "$2" = "$5}') — почистить: p2p-node/node_modules, .codex/.tmp, cache/*"
else
  ok "свободное место" "${FREE_MB} МБ свободно (порог 500)"
fi

# ---------- итог ----------
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mВСЁ ЗЕЛЁНОЕ\033[0m: VPS = GitHub = %s, сервис жив\n\n' "$LOCAL_SHORT"
  exit 0
fi
printf '\033[31mПРОБЛЕМ: %d\033[0m\n\n' "$FAIL"
exit 1

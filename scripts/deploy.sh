#!/bin/bash
# TarNet deploy — из рабочей папки на VPS одной командой.
#
# ПОЧЕМУ BUNDLE, А НЕ git pull НА СЕРВЕРЕ:
# у VPS нет доступа к GitHub, и заводить туда deploy-ключ — лишний секрет на
# боевой машине. Bundle едет по уже существующему SSH-каналу, доверие
# одностороннее: рабочая машина → сервер, никогда обратно.
#
# ПОЧЕМУ reset --hard БЕЗОПАСЕН ЗДЕСЬ:
# раньше на VPS лежали untracked app/ и scripts/*, а HEAD отставал, поэтому
# любой `git checkout .` молча откатывал сервер на старый коммит и стирал PWA.
# Скрипт снимает такие файлы только после сверки sha256 с целевым коммитом:
# совпало — удаляем и восстанавливаем из git, не совпало — откладываем в
# /root/tarnet-deploy-backup-<ts> и печатаем путь.
#
# Использование:
#   ./scripts/deploy.sh "сообщение коммита"   # закоммитить и раскатать
#   ./scripts/deploy.sh                       # раскатать текущий HEAD
#
# Exit 0 — только если сервис active и /health ответил 200.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="main"
REPO_SLUG="pdkiller666/tarnet-backend"
# Путь к GitHub-креденшелам — только из окружения или поиском по каталогу.
#
# Был жёсткий путь с `ghp_...` в имени каталога — то есть часть идентификатора
# ключа в исходнике. Тот же класс дефекта, что в verify.sh.
GH_CREDS="${TARNET_GH_CREDS:-}"
if [ -z "$GH_CREDS" ]; then
  for _c in "$HOME"/.openclaw/credentials/github/personal/*/hosts.yml; do
    [ -r "$_c" ] && { GH_CREDS="$_c"; break; }
  done
fi
VPS="${TARNET_VPS:-root@195.63.131.172}"
SSH_KEY="${TARNET_SSH_KEY:-$HOME/.ssh/tarnet_vps}"
REMOTE_DIR="${TARNET_REMOTE_DIR:-/opt/tarnet/backend-api}"
REMOTE_BUNDLE="/tmp/tarnet-deploy.bundle"
LOCAL_BUNDLE="/tmp/tarnet-deploy.bundle"
SERVICE="${TARNET_SERVICE:-tarnet}"
# Мост — ОТДЕЛЬНЫЙ юнит (p2p-bridge.service), и его перезапуск обязателен.
# ПОЧЕМУ: 2026-11-07 мост работал на коде от 05.11 двое суток после двух
# деплоев. `bridge.js` на диске знал action `channels`, а процесс в памяти —
# нет, и отвечал UNKNOWN_ACTION. Следствие тихое: P2P-маршрут задач всегда
# получал `channels_failed`, задачи уходили по WS, `framesIn` оставался 0,
# и приёмка P1.1 не могла закрыться при формально зелёном деплое.
BRIDGE_SERVICE="${TARNET_BRIDGE_SERVICE:-p2p-bridge}"
HEALTH_LOCAL="http://127.0.0.1:3001/health"
PUBLIC_URL="${TARNET_PUBLIC_URL:-https://v1107336.hosted-by-vdsina.com}"
MSG="${1:-}"

# Флаг в позиционном аргументе — это почти всегда ошибка вызова, а не сообщение
# коммита. 2026-10-28 я запустил `deploy.sh --dry-run`: режима такого нет, флаг
# молча стал сообщением коммита, и скрипт честно закоммитил, запушил и раскатал
# тестовое дерево на прод. Отказываемся сразу — цена ошибки здесь слишком высока.
case "$MSG" in
  -*) 
    printf 'ОТКАЗ: аргумент «%s» похож на флаг, а не на сообщение коммита.\n' "$MSG" >&2
    printf 'У deploy.sh нет режима --dry-run: он всегда коммитит, пушит и раскатывает.\n' >&2
    printf 'Использование: %s ["сообщение коммита"]\n' "$(basename "$0")" >&2
    printf 'Проверить без деплоя: bash scripts/verify.sh\n' >&2
    exit 2 ;;
esac

SSH_OPTS=(-i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
TOKEN=""

info() { printf '\n== %s\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
mask() { sed -e "s|${TOKEN:-__none__}|<token>|g"; }
die()  { printf '\nПРОВАЛ: %s\n' "$*" >&2; exit 1; }

# ---------- 1. дерево и ветка ----------
cd "$REPO_DIR" || die "нет каталога $REPO_DIR"
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$CUR_BRANCH" = "$BRANCH" ] || die "ветка '$CUR_BRANCH', а деплоим только '$BRANCH'"

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  [ -n "$MSG" ] || die "рабочее дерево грязное. Либо закоммить сам, либо передай сообщение:
    ./scripts/deploy.sh \"сообщение коммита\""
  info "коммичу изменения"
  git add -A || die "git add"

  # Блоклист проверяет STAGED-список, а не `git status`.
  # Почему: `.secrets/` и `*.db` перечислены в .gitignore, поэтому `git status`
  # их вообще не показывает — проверка по статусу их не увидит, и файл уедет
  # в коммит через `git add -f`. Staged-список видит всё, что реально попадёт.
  STAGED=$(git diff --cached --name-only --diff-filter=ACM)
  SECRETS=$(printf '%s\n' "$STAGED" \
    | grep -E '(^|/)\.secrets/|\.db$|\.db-wal$|\.db-shm$|master\.key$|(^|/)\.env$|hosts\.yml$|(^|/)id_(rsa|ed25519)|\.pem$' || true)
  if [ -n "$SECRETS" ]; then
    git reset -q
    die "в коммит попали бы секреты/БД, отказываюсь (индекс сброшен):
$SECRETS"
  fi

  # Мусор: временные и логовые файлы не должны попадать в историю. Именно так
  # в неё уехал zz-guard-test.tmp при проверке самого блоклиста.
  JUNK=$(printf '%s\n' "$STAGED" \
    | grep -E '(^|/)(zz-.*|tmp-.*)|(^|/)npm-debug\.log$|\.tmp$|\.log$|\.swp$|~$' || true)
  if [ -n "$JUNK" ]; then
    git reset -q
    die "в коммит попали бы временные файлы, отказываюсь (индекс сброшен):
$JUNK
Если это осознанно — убери файл или закоммить вручную."
  fi
  git -c user.name="OpenClaw" -c user.email="agent@tarnet.local" \
      commit -q -m "$MSG" || die "git commit"
  git show --stat --oneline HEAD | head -20
else
  info "дерево чистое — коммитить нечего, раскатываю текущий HEAD"
fi
LOCAL_HEAD=$(git rev-parse HEAD)
printf 'локальный HEAD: %s\n' "$LOCAL_HEAD"

# ---------- 1.5. хроника проекта ----------
# Проверка, что PROJECT-HISTORY.md не отстал от кода. Только предупреждение,
# деплой не блокирует — и вот почему это осознанно.
#
# За один рабочий день накапливается до шести кодовых коммитов, которые хроника
# и не должна описывать поштучно: она ведёт вехи, а не git log. Проверено на
# истории 24–28.10 — сама хроника обновлялась 5 раз, кодовых коммитов за это
# время было 34. Требование «обнови в каждом коммите» превратилось бы в шум,
# проверку бы отключили, и разрыв в 4 дня повторился бы.
#
# Порог подобран по факту: 3 кодовых коммита после последней правки хроники —
# это уже реальное отставание, а не рабочий ритм. TARNET_HISTORY_STRICT=1
# делает проверку блокирующей для CI.
HISTORY_FILE="PROJECT-HISTORY.md"
HISTORY_THRESHOLD="${TARNET_HISTORY_THRESHOLD:-3}"
CODE_PATHS=('*.js' '*.html' '*.css' '*.sh' 'deploy')
if [ -f "$HISTORY_FILE" ]; then
  HIST_COMMIT=$(git log -1 --format=%H -- "$HISTORY_FILE" 2>/dev/null)
  if [ -n "$HIST_COMMIT" ]; then
    CODE_AFTER=$(git rev-list --count "${HIST_COMMIT}..HEAD" -- "${CODE_PATHS[@]}" 2>/dev/null || echo 0)
    HEAD_CODE=$(git show --name-only --format= HEAD -- "${CODE_PATHS[@]}" 2>/dev/null | grep -c . || true)
    HEAD_HIST=$(git show --name-only --format= HEAD -- "$HISTORY_FILE" 2>/dev/null | grep -c . || true)

    if [ "$CODE_AFTER" -ge "$HISTORY_THRESHOLD" ]; then
      if [ "$HEAD_CODE" -gt 0 ] && [ "$HEAD_HIST" -eq 0 ]; then
        warn "код изменился, а хроника нет: $CODE_AFTER кодовых коммитов после $(printf %.7s "$HIST_COMMIT")"
      else
        warn "хроника отстаёт: $CODE_AFTER кодовых коммитов после $(printf %.7s "$HIST_COMMIT")"
      fi
      warn "допиши веху в $HISTORY_FILE или задеплой осознанно: TARNET_HISTORY_THRESHOLD=999"
      if [ "${TARNET_HISTORY_STRICT:-0}" = "1" ]; then
        die "строгий режим: $HISTORY_FILE не обновлён после кода"
      fi
    else
      printf 'хроника: %s, отставание %s кодовых коммитов (порог %s)\n' \
        "$(printf %.7s "$HIST_COMMIT")" "$CODE_AFTER" "$HISTORY_THRESHOLD"
    fi
  fi
fi

# ---------- 2. GitHub ----------
[ -r "$GH_CREDS" ] || die "нет credential-файла${GH_CREDS:+ $GH_CREDS}
Задайте TARNET_GH_CREDS или положите hosts.yml в \$HOME/.openclaw/credentials/github/personal/<id>/"
TOKEN=$(grep -m1 '^  oauth_token:' "$GH_CREDS" | sed 's/^  oauth_token: *//' | tr -d '"' | tr -d ' ')
[ ${#TOKEN} -ge 20 ] || die "не разобрал токен GitHub в $GH_CREDS"
PUSH_URL="https://x-access-token:${TOKEN}@github.com/${REPO_SLUG}.git"

info "пуш в GitHub"
git -c credential.helper= push "$PUSH_URL" "$BRANCH" 2>&1 | mask | tail -3
[ "${PIPESTATUS[0]}" -eq 0 ] || die "push не удался"

GH_HEAD=$(git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
[ "$GH_HEAD" = "$LOCAL_HEAD" ] || die "GitHub HEAD ($GH_HEAD) != локальный ($LOCAL_HEAD)"
printf 'GitHub HEAD:    %s (совпал)\n' "$GH_HEAD"

# ---------- 3. bundle и доставка ----------
info "собираю bundle"
rm -f "$LOCAL_BUNDLE"
git bundle create "$LOCAL_BUNDLE" --tags "$BRANCH" >/dev/null 2>&1 || die "git bundle"
printf 'bundle: %s байт\n' "$(stat -c %s "$LOCAL_BUNDLE")"

scp "${SSH_OPTS[@]}" -q "$LOCAL_BUNDLE" "$VPS:$REMOTE_BUNDLE" || die "scp bundle на VPS"

# ---------- 4. VPS: fetch → reset ----------
info "раскатываю на VPS: $REMOTE_DIR"
RESET_OUT=$(ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$REMOTE_DIR" "$BRANCH" "$REMOTE_BUNDLE" <<'REMOTE'
set -uo pipefail
DIR=$1; BR=$2; BUNDLE=$3
cd "$DIR" || { echo "ERR: нет каталога $DIR"; exit 3; }
PREV=$(git rev-parse HEAD 2>/dev/null || echo none)
git fetch "$BUNDLE" "$BR" --force >/dev/null 2>&1 || { echo "ERR: fetch из bundle"; exit 4; }
# NEW снимается сразу после fetch ветки: второй fetch перезаписывает FETCH_HEAD,
# и чтение после него вернуло бы коммит тега вместо HEAD ветки.
NEW=$(git rev-parse FETCH_HEAD)
# Ветка едет одним refspec, теги — отдельным: без второго fetch на сервере
# остаются только те теги, что были до деплоя, и `git describe` врёт на
# сотни коммитов назад. force нужен, потому что тег мог уже существовать.
git fetch "$BUNDLE" "+refs/tags/*:refs/tags/*" --force >/dev/null 2>&1 || { echo "ERR: fetch тегов из bundle"; exit 5; }

# Всё, что разойдётся с целевым коммитом, сначала уезжает в бэкап, и только
# потом reset --hard затирает. Иначе правка, сделанная прямо на сервере,
# исчезнет без следа: reset молчит, сервис остаётся active.
#
#   untracked + есть в коммите, sha совпал   → удалить (git вернёт из коммита)
#   untracked + есть в коммите, sha разошёлся → в бэкап
#   tracked изменён, sha разошёлся с коммитом → в бэкап
#   tracked изменён, sha совпал               → тихо, терять нечего
BK=/root/tarnet-deploy-backup-$(date +%Y%m%d-%H%M%S)
git status --porcelain --untracked-files=all \
 | while IFS= read -r line; do
     st=${line:0:2}
     p=${line:3}
     [ -n "$p" ] || continue
     [ -f "$p" ] || continue
     cur=$(sha256sum "$p" | cut -d' ' -f1)
     if git cat-file -e "$NEW:$p" 2>/dev/null; then
       want=$(git cat-file blob "$NEW:$p" | sha256sum | cut -d' ' -f1)
       if [ "$cur" = "$want" ]; then
         [ "$st" = "??" ] && rm -f "$p"   # совпадает с коммитом — не теряем
       else
         mkdir -p "$BK/$(dirname "$p")"
         cp -p "$p" "$BK/$p" && echo "BACKUP: $p -> $BK/$p"
       fi
     elif [ "$st" = "??" ]; then
       # Файла нет в коммите и он не отслеживается: reset его не тронет.
       :
     fi
   done

git reset --hard "$NEW" >/dev/null 2>&1 || { echo "ERR: reset --hard"; exit 5; }
git remote set-url origin "$BUNDLE" 2>/dev/null || true
echo "PREV=$PREV"
echo "NEW=$(git rev-parse HEAD)"
echo "DIRTY=$(git status --porcelain | wc -l | tr -d ' ')"
REMOTE
) || die "раскатка на VPS упала:
$RESET_OUT"

printf '%s\n' "$RESET_OUT"
VPS_PREV=$(printf '%s\n' "$RESET_OUT" | sed -n 's/^PREV=//p')
VPS_NEW=$(printf '%s\n' "$RESET_OUT" | sed -n 's/^NEW=//p')
VPS_DIRTY=$(printf '%s\n' "$RESET_OUT" | sed -n 's/^DIRTY=//p')

[ "$VPS_NEW" = "$LOCAL_HEAD" ] || die "HEAD на VPS ($VPS_NEW) != локальный ($LOCAL_HEAD)"
[ "$VPS_DIRTY" = "0" ] || die "на VPS осталось $VPS_DIRTY грязных путей после reset"

# ---------- 4.5 systemd drop-in ----------
# Юниты и drop-in'ы не лежат в рабочем дереве сервиса, поэтому их не раскатывает
# ни git reset, ни bundle. Без этого шага TARNET_PUBLIC_URL и RESERVE_OPEX_USD
# жили только на одном конкретном сервере: пересборка машины или переезд на
# новый VPS молча возвращали fallback из server.js, а verify.sh показывал
# «всё зелёное» — он про /etc/systemd ничего не знает.
#
# Порядок: drop-in → daemon-reload → restart (шаг 5). Без reload перезапуск
# применит старое значение, и проверка ниже этого не заметит.
info "раскатываю systemd drop-in"
DROPIN_DIR="deploy/systemd/tarnet.service.d"
[ -d "$REPO_DIR/$DROPIN_DIR" ] || die "нет каталога $DROPIN_DIR в репозитории"

# Сверка до отправки: если адрес в drop-in и адрес, по которому deploy.sh
# проверяет /health, разойдутся — установщик уедет на один сервер, а проверка
# будет смотреть на другой, и обе будут «зелёными».
DROPIN_URL=$(sed -n 's/^Environment=TARNET_PUBLIC_URL=//p' "$REPO_DIR/$DROPIN_DIR"/*.conf | head -1)
[ "$DROPIN_URL" = "$PUBLIC_URL" ] || die "рассинхрон адреса:
  $DROPIN_DIR: $DROPIN_URL
  deploy.sh:      $PUBLIC_URL
Поправь одно из двух — иначе установщик и проверка смотрят на разные серверы."

# Ожидаемые переменные берём из самих файлов, без списка в коде: новый drop-in
# в репозитории начинает проверяться сам, без правки этого скрипта.
DROPIN_EXPECT=$(sed -n 's/^Environment=//p' "$REPO_DIR/$DROPIN_DIR"/*.conf)

DROPIN_OUT=$(ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$REMOTE_DIR" "$SERVICE" "$DROPIN_DIR" <<'REMOTE'
set -uo pipefail
DIR=$1; SVC=$2; REL=$3
SRC="$DIR/$REL"
DST_DIR="/etc/systemd/system/${SVC}.service.d"
[ -d "$SRC" ] || { echo "ERR: нет $SRC на VPS"; exit 8; }
mkdir -p "$DST_DIR" || { echo "ERR: mkdir $DST_DIR"; exit 8; }

# rsync БЕЗ --delete сознательно. С --delete ручной drop-in, поставленный на
# сервере при аварии, исчез бы молча — а deploy.sh по своей же логике (см.
# резервное копирование перед reset выше) сначала сохраняет, потом затирает.
# Лишние файлы не удаляем, но называем вслух.
rsync -a "$SRC"/ "$DST_DIR"/ || { echo "ERR: rsync в $DST_DIR"; exit 8; }
for f in "$DST_DIR"/*.conf; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  [ -f "$SRC/$b" ] || echo "WARN: drop-in на сервере вне репозитория: $b"
done

systemctl daemon-reload || { echo "ERR: daemon-reload"; exit 8; }

# Проверяем, что systemd реально видит переменные, а не что файл лёг на диск.
# Файл без применения — это не раскатка.
echo "ENV=$(systemctl show "$SVC" -p Environment)"
REMOTE
) || die "раскатка drop-in упала:
$DROPIN_OUT"

printf '%s\n' "$DROPIN_OUT"
DROPIN_ENV=$(printf '%s\n' "$DROPIN_OUT" | sed -n 's/^ENV=//p' | head -1)
[ -n "$DROPIN_ENV" ] || die "systemd не отдал Environment после daemon-reload"

# Каждая ожидаемая пара KEY=VALUE должна быть в окружении сервиса целиком:
# KEY без нужного значения — тот же молчаливый откат к дефолту из кода.
DROPIN_BAD=""
while IFS= read -r kv; do
  [ -n "$kv" ] || continue
  case " $DROPIN_ENV " in
    *" $kv "*) : ;;
    *) DROPIN_BAD="$DROPIN_BAD $kv" ;;
  esac
done <<< "$DROPIN_EXPECT"
[ -z "$DROPIN_BAD" ] || die "systemd не видит после reload:$DROPIN_BAD
Фактическое окружение: $DROPIN_ENV"
printf 'drop-in применён: %s\n' "$(printf '%s' "$DROPIN_EXPECT" | tr '\n' ' ')"

# ---------- 5. перезапуск ----------
info "перезапускаю $SERVICE"
ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$SERVICE" <<'REMOTE' || die "сервис не поднялся"
SVC=$1
systemctl restart "$SVC" || { echo "ERR: restart"; exit 6; }
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$SVC"; then echo "active после рестарта"; exit 0; fi
  sleep 1
done
echo "ERR: сервис не стал active за 30 с"
journalctl -u "$SVC" -n 25 --no-pager >&2
exit 7
REMOTE

# ---------- 5b. перезапуск моста ----------
# Отдельно от основного сервиса и НЕ роняя деплой: мост — необязательный
# компонент (libp2p 105 МБ, может отсутствовать на новом хосте), и его
# падение означает только «discovery недоступен», а не поломку API.
# Но молча пропускать его нельзя — это и был двухдневный разрыв выше.
info "перезапускаю мост $BRIDGE_SERVICE"
ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$BRIDGE_SERVICE" <<'REMOTE' || printf 'ВНИМАНИЕ: мост не перезапущен — P2P-маршрут задач может работать на старом коде\n' >&2
BSVC=$1
if ! systemctl list-unit-files "$BSVC.service" >/dev/null 2>&1 || ! systemctl cat "$BSVC" >/dev/null 2>&1; then
  echo "юнита $BSVC нет — пропускаю (P2P не настроен на этом хосте)"
  exit 0
fi

# Зависимости моста ставятся ЯВНО, до рестарта.
# ПОЧЕМУ: p2p-node — отдельный npm-пакет со своим package.json внутри
# репозитория, и `npm ci` для backend-api его НЕ покрывает. 09.11 деплой
# раскатал 2.25.0, где bridge.js импортирует @libp2p/gossipsub, а модуля на
# диске не было: мост падал с ERR_MODULE_NOT_FOUND и уходил в цикл
# рестартов (counter 28). При этом tarnet.service был active, /health отвечал
# 200, и deploy.sh завершался зелёным — отказ был невидим снаружи.
# `npm ci` (а не install) — чтобы ставилось ровно то, что в package-lock.
BWD=$(systemctl show "$BSVC" -p WorkingDirectory --value)
if [ -n "$BWD" ] && [ -f "$BWD/package.json" ]; then
  echo "ставлю зависимости моста: $BWD"
  ( cd "$BWD" && npm ci --no-audit --no-fund ) || { echo "ERR: npm ci в $BWD"; exit 9; }
fi

systemctl restart "$BSVC" || { echo "ERR: restart $BSVC"; exit 6; }
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$BSVC"; then echo "active после рестарта"; exit 0; fi
  sleep 1
done
echo "ERR: $BSVC не стал active за 30 с"
journalctl -u "$BSVC" -n 25 --no-pager >&2
exit 7
REMOTE

# ---------- 6. health ----------
rollback_hint() {
  printf '\nОТКАТ (вернёт предыдущий коммит и перезапустит сервис):\n'
  printf '  ssh -i %s %s "cd %s && git reset --hard %s && systemctl restart %s"\n' \
    "$SSH_KEY" "$VPS" "$REMOTE_DIR" "${VPS_PREV:-<prev>}" "$SERVICE"
}

# /health опрашивается с повтором, а не одним curl.
# ПОЧЕМУ: после systemctl restart процесс уже active, но порт 3001 ещё не
# занят — Node доделывает инициализацию БД и миграции. Одиночный curl ловил
# код 000, и деплой печатал ПРОВАЛ при полностью раскатанном коммите.
# Хуже того: откат по такому выводу вернул бы рабочий сервис на прошлый
# коммит из-за тайминга. Три попытки по 2 с — этого хватает с запасом.
H_LOCAL=""
H_LOCAL_TRY=0
for i in 1 2 3; do
  H_LOCAL_TRY=$i
  H_LOCAL=$(ssh "${SSH_OPTS[@]}" "$VPS" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 $HEALTH_LOCAL" 2>/dev/null)
  [ "$H_LOCAL" = "200" ] && break
  if [ "$i" -lt 3 ]; then sleep 2; fi
done
printf '/health на VPS:   HTTP %s (попытка %s/3)\n' "${H_LOCAL:-нет ответа}" "$H_LOCAL_TRY"
[ "$H_LOCAL" = "200" ] || { rollback_hint; die "/health на VPS вернул $H_LOCAL после 3 попыток"; }

H_PUB=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/health")
H_APP=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/app/")
printf '/health снаружи: HTTP %s\n/app/ снаружи:   HTTP %s\n' "$H_PUB" "$H_APP"
[ "$H_PUB" = "200" ] || { rollback_hint; die "/health снаружи вернул $H_PUB"; }
[ "$H_APP" = "200" ] || { rollback_hint; die "/app/ снаружи вернул $H_APP"; }

# ---------- 7. уборка ----------
rm -f "$LOCAL_BUNDLE"
ssh "${SSH_OPTS[@]}" "$VPS" "rm -f $REMOTE_BUNDLE" 2>/dev/null

info "деплой завершён: $VPS_NEW"
if [ -x "$REPO_DIR/scripts/verify.sh" ]; then
  "$REPO_DIR/scripts/verify.sh" || die "деплой прошёл, но verify.sh нашёл проблемы"
fi

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
GH_CREDS="${TARNET_GH_CREDS:-/home/node/.openclaw/credentials/github/personal/ghp_d000abcd8efeb474c2425f28f1b0a409/hosts.yml}"
VPS="${TARNET_VPS:-root@195.63.131.172}"
SSH_KEY="${TARNET_SSH_KEY:-$HOME/.ssh/tarnet_vps}"
REMOTE_DIR="${TARNET_REMOTE_DIR:-/opt/tarnet/backend-api}"
REMOTE_BUNDLE="/tmp/tarnet-deploy.bundle"
LOCAL_BUNDLE="/tmp/tarnet-deploy.bundle"
SERVICE="${TARNET_SERVICE:-tarnet}"
HEALTH_LOCAL="http://127.0.0.1:3001/health"
PUBLIC_URL="${TARNET_PUBLIC_URL:-https://v1107336.hosted-by-vdsina.com}"
MSG="${1:-}"

SSH_OPTS=(-i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
TOKEN=""

info() { printf '\n== %s\n' "$*"; }
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
  # Блоклист: сюда не должны попадать секреты и БД даже случайно.
  BAD=$(printf '%s\n' "$DIRTY" | awk '{$1="";sub(/^ /,"");print}' \
        | grep -E '(^|/)\.secrets/|\.db$|\.db-wal$|\.db-shm$|master\.key$|(^|/)\.env$|hosts\.yml$|(^|/)id_(rsa|ed25519)' || true)
  [ -z "$BAD" ] || die "в коммит попали бы секреты/БД, отказываюсь:
$BAD"
  info "коммичу изменения"
  git add -A || die "git add"
  git -c user.name="OpenClaw" -c user.email="agent@tarnet.local" \
      commit -q -m "$MSG" || die "git commit"
  git show --stat --oneline HEAD | head -20
else
  info "дерево чистое — коммитить нечего, раскатываю текущий HEAD"
fi
LOCAL_HEAD=$(git rev-parse HEAD)
printf 'локальный HEAD: %s\n' "$LOCAL_HEAD"

# ---------- 2. GitHub ----------
[ -r "$GH_CREDS" ] || die "нет credential-файла $GH_CREDS"
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
git bundle create "$LOCAL_BUNDLE" "$BRANCH" >/dev/null 2>&1 || die "git bundle"
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
NEW=$(git rev-parse FETCH_HEAD)

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

# ---------- 6. health ----------
rollback_hint() {
  printf '\nОТКАТ (вернёт предыдущий коммит и перезапустит сервис):\n'
  printf '  ssh -i %s %s "cd %s && git reset --hard %s && systemctl restart %s"\n' \
    "$SSH_KEY" "$VPS" "$REMOTE_DIR" "${VPS_PREV:-<prev>}" "$SERVICE"
}

H_LOCAL=$(ssh "${SSH_OPTS[@]}" "$VPS" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 $HEALTH_LOCAL" 2>/dev/null)
printf '/health на VPS:   HTTP %s\n' "${H_LOCAL:-нет ответа}"
[ "$H_LOCAL" = "200" ] || { rollback_hint; die "/health на VPS вернул $H_LOCAL"; }

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

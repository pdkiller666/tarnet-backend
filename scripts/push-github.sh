#!/bin/bash
# Пуш в GitHub. Токен берётся из креденшел-файла OpenClaw и попадает
# только в переменную окружения askpass-помощника, не в командную строку.
set -u
cd "$(dirname "$0")" || exit 1

HOSTS=$(ls -1 "$HOME"/.openclaw/credentials/github/personal/*/hosts.yml 2>/dev/null | head -1)
if [ -z "$HOSTS" ]; then echo "нет hosts.yml"; exit 3; fi

TOKEN=$(awk -F': *' '/oauth_token/ {gsub(/["'"'"']/,"",$2); print $2; exit}' "$HOSTS")
if [ -z "$TOKEN" ]; then echo "токен не прочитан"; exit 4; fi
echo "токен прочитан, длина ${#TOKEN}"

ASKPASS="$HOME/.git-askpass-push.sh"
printf '#!/bin/sh\ncase "$1" in *Username*) echo "x-access-token" ;; *) echo "$TARNET_GH_TOKEN" ;; esac\n' > "$ASKPASS"
chmod 700 "$ASKPASS"

export TARNET_GH_TOKEN="$TOKEN"
export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0

git push origin main 2>&1 | sed 's/x-access-token:[^@]*/x-access-token:***/'
RC=${PIPESTATUS[0]:-1}
rm -f "$ASKPASS"

echo "PUSH_RC=$RC"
echo "  локально: $(git rev-parse --short HEAD)"
echo "  origin:   $(git rev-parse --short origin/main)"
echo "  askpass удалён: $([ -f "$ASKPASS" ] && echo НЕТ || echo да)"
exit "$RC"

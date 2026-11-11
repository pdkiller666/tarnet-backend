#!/bin/bash
# TarNet — развёртывание на ЧИСТОМ Debian/Ubuntu с нуля до отвечающего /health.
#
# ЧТО ДЕЛАЕТ (в этом порядке, каждый шаг проверяется):
#   1. проверки: root, ОС, наличие apt/systemd, свободное место
#   2. swap, если RAM < 2 ГБ — без него `npm ci` (811 МБ node_modules) падает по OOM
#   3. пакеты: node >= 22, caddy, ufw, curl, git, tar, gzip, openssl
#   4. каталоги /opt/tarnet и /var/lib/tarnet/{secrets,p2p,p2p-seed2}
#   5. код: из локального дерева или git clone
#   6. npm ci в корне и в p2p-node (это ДВА разных package-lock)
#   7. восстановление из бэкапа (если задан RESTORE) — БД, секреты, peer-id
#   8. секреты: при чистой установке генерирует master.key и faucet-ip.key
#   9. systemd: юниты + drop-in'ы с подстановкой домена
#  10. Caddy: конфиг с доменом, TLS выпустит сам
#  11. ufw: 22/80/443/4001/4002, 3001 НЕ открывается
#  12. запуск, ожидание /health, сверка buildVersion с package.json
#
# ЧЕГО НЕ ДЕЛАЕТ:
#   - не трогает DNS (A-запись должна уже указывать на этот хост, иначе TLS не выпустится)
#   - не восстанавливает воркер: воркер — это ПК владельца, он придёт по DHT сам
#
# Использование:
#   sudo ./bootstrap.sh --domain=tarnet.example.com
#   sudo ./bootstrap.sh --domain=tarnet.example.com --restore=/root/tarnet-....tar.gz
#   sudo ./bootstrap.sh --domain=x --src=/opt/tarnet/backend-api   # код уже на месте
#   sudo ./bootstrap.sh --domain=x --with-cuda    # сервер сам делает инференс на GPU
#
# Переменные: TARNET_DIR (по умолчанию /opt/tarnet/backend-api),
#             TARNET_STATE (/var/lib/tarnet), TARNET_REPO (git URL),
#             TARNET_RESTORE (архив от backup.sh)

set -uo pipefail

DOMAIN=""
RESTORE=""
SRC=""
REPO="${TARNET_REPO:-https://github.com/pdkiller666/tarnet-backend.git}"
DIR="${TARNET_DIR:-/opt/tarnet/backend-api}"
STATE="${TARNET_STATE:-/var/lib/tarnet}"
SWAPFILE="/swapfile"
# 2 ГБ, а не 1: замерено 11.11.2026 на 1.6 ГБ RAM — с 1 ГБ swap `npm ci`
# погибает на распаковке onnxruntime (code 137), с 2 ГБ проходит, пик swap 828 МБ.
# 1 ГБ swap оставлял бы ~200 МБ запаса, а это уже лотерея.
SWAP_GB=2
WITH_CUDA=0

step=0
say() { step=$((step+1)); printf '\n[%02d] %s\n' "$step" "$*"; }
ok()  { printf '     ✅ %s\n' "$*"; }
warn(){ printf '     ⚠️  %s\n' "$*"; }
die() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

for a in "$@"; do
  case "$a" in
    --domain=*) DOMAIN="${a#*=}" ;;
    --restore=*) RESTORE="${a#*=}" ;;
    --src=*) SRC="${a#*=}" ;;
    --repo=*) REPO="${a#*=}" ;;
    --dir=*) DIR="${a#*=}" ;;
    --with-cuda) WITH_CUDA=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "неизвестный аргумент: $a (см. --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
say "проверки окружения"
[ "$(id -u)" -eq 0 ] || die "нужен root: ставим пакеты и пишем в /etc"
command -v systemctl >/dev/null 2>&1 || die "нет systemd — этот скрипт для обычного хоста, не контейнера без init"
command -v apt-get >/dev/null 2>&1 || die "нет apt-get — поддерживаются Debian/Ubuntu"
[ -n "$DOMAIN" ] || die "не задан --domain. Без домена Caddy не выпустит TLS, а TARNET_PUBLIC_URL будет врать"

# Домен вписывается в юниты и Caddyfile, поэтому проверяем форму ДО установки:
# опечатка здесь даёт хост, который поднялся, но недоступен снаружи.
printf '%s' "$DOMAIN" | grep -Eq '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$' \
  || die "домен выглядит неверно: '$DOMAIN' (нужно, например: tarnet.example.com)"

AVAIL_KB=$(df -Pk / | awk 'NR==2 {print $4}')
[ "$AVAIL_KB" -gt 3000000 ] || die "мало места на /: $((AVAIL_KB/1024)) МБ. Нужно ≥ 3 ГБ (node_modules 811 МБ + git 91 МБ + запас)"
ok "root, apt, systemd; свободно $((AVAIL_KB/1024)) МБ"
ok "домен: $DOMAIN"

# ---------------------------------------------------------------------------
say "swap"
if swapon --show | grep -q .; then
  ok "swap уже есть: $(swapon --show=SIZE --noheadings | head -1 | tr -d ' ')"
else
  RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
  if [ "$RAM_MB" -lt 2048 ]; then
    # Замерено 11.11.2026 на 1.6 ГБ RAM: без swap `npm ci` убит ядром
    # (Out of memory: Killed process npm ci, anon-rss 450 МБ, swap 0).
    # С 1 ГБ swap падает позже — на распаковке onnxruntime (code 137,
    # пик swap 828 МБ). С 2 ГБ проходит. Отсюда SWAP_GB=2.
    fallocate -l "${SWAP_GB}G" "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB*1024)) status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null || die "mkswap не сработал"
    swapon "$SWAPFILE" || die "swapon не сработал"
    grep -q "^$SWAPFILE " /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
    ok "создан swap ${SWAP_GB} ГБ (RAM ${RAM_MB} МБ) и прописан в fstab"
  elif [ "$RAM_MB" -lt 3072 ]; then
    # 2–3 ГБ: `npm ci` проходит, но пик близко к пределу. Предупреждаем честно,
    # а не молчим: падение установки на новом хосте ищут в коде, не в памяти.
    warn "RAM ${RAM_MB} МБ без swap — npm ci может упасть по OOM. Если упадёт: fallocate -l 2G /swapfile && mkswap /swapfile && swapon /swapfile"
  else
    ok "RAM ${RAM_MB} МБ — swap не требуется"
  fi
fi

# ---------------------------------------------------------------------------
say "пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || die "apt-get update"
apt-get install -y -qq ca-certificates curl gnupg git tar gzip openssl ufw \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1 \
  || die "apt-get install базовых пакетов"

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  [ "$NODE_MAJOR" -ge 22 ] && NODE_OK=1
fi

if [ "$NODE_OK" -ne 1 ]; then
  # Ключевая деталь: в Debian 12 и Ubuntu 22/24 apt даёт Node 18, а проекту
  # нужен node:sqlite — он появился только в 22. Ставим NodeSource, иначе
  # сервер упадёт на require('node:sqlite') при первом же старте.
  warn "node $(node -v 2>/dev/null || echo 'нет') — нужен ≥ 22, ставлю NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
    || die "не подключил NodeSource"
  apt-get install -y -qq nodejs >/dev/null 2>&1 || die "не установил nodejs 22"
fi
NODE_V=$(node -v)
[ "$(printf '%s' "$NODE_V" | sed 's/^v//' | cut -d. -f1)" -ge 22 ] || die "node $NODE_V всё ещё < 22"
ok "node $NODE_V, npm $(npm -v)"

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq caddy >/dev/null 2>&1 || {
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null 2>&1
  }
fi
command -v caddy >/dev/null 2>&1 || die "caddy не установился"
ok "caddy $(caddy version | head -1 | cut -d' ' -f1)"

# ---------------------------------------------------------------------------
say "каталоги"
mkdir -p "$DIR" "$STATE"/{secrets,p2p,p2p-seed2} "$STATE/backups"
chmod 750 "$STATE"; chmod 700 "$STATE/secrets" "$STATE/p2p" "$STATE/p2p-seed2"
ok "$DIR, $STATE/{secrets,p2p,p2p-seed2}"

# ---------------------------------------------------------------------------
say "код"
if [ -n "$SRC" ]; then
  [ -d "$SRC" ] || die "нет каталога --src=$SRC"
  command -v rsync >/dev/null 2>&1 || apt-get install -y -qq rsync >/dev/null 2>&1
  rsync -a --delete --exclude node_modules --exclude .git "$SRC"/ "$DIR"/ || die "rsync кода"
  # git-метаданные нужны deploy.sh и verify.sh: они сверяют HEAD и дерево.
  if [ -d "$SRC/.git" ] && [ ! -d "$DIR/.git" ]; then
    git clone -q --no-local "$SRC" "$DIR.git-tmp" 2>/dev/null && mv "$DIR.git-tmp/.git" "$DIR/.git" && rm -rf "$DIR.git-tmp"
  fi
  ok "код скопирован из $SRC"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --all -q && git -C "$DIR" reset --hard -q origin/main || die "git reset"
  ok "код обновлён: $(git -C "$DIR" rev-parse --short HEAD)"
else
  git clone -q "$REPO" "$DIR" || die "git clone $REPO"
  ok "код склонирован: $(git -C "$DIR" rev-parse --short HEAD)"
fi
[ -f "$DIR/server.js" ] || die "в $DIR нет server.js — код не тот"
[ -f "$DIR/package-lock.json" ] || die "нет package-lock.json — npm ci невозможен"

# ---------------------------------------------------------------------------
say "зависимости"
# ONNXRUNTIME_NODE_INSTALL=skip: по умолчанию npm тянет CUDA-провайдер
# (libonnxruntime_providers_cuda.so, 272 МБ) и распаковывает его в память —
# именно этот шаг ядро убивает на хостах с 1–2 ГБ RAM. Серверу он не нужен:
# инференс идёт на воркере (llm_mode: worker), а pii-classifier.js использует
# CPU-провайдер, который лежит внутри npm-пакета и остаётся на месте.
# Замер: с skip node_modules 567 МБ и `require('onnxruntime-node')` работает;
# без skip — 839 МБ и падение по OOM. Нужен GPU на самом сервере — --with-cuda.
if [ "$WITH_CUDA" -eq 1 ]; then
  ( cd "$DIR" && npm ci --no-audit --no-fund ) || die "npm ci в $DIR (с CUDA)"
else
  ( cd "$DIR" && ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund ) || die "npm ci в $DIR"
fi
ok "корень: $(du -sh "$DIR/node_modules" | cut -f1)"

# p2p-node — отдельный проект со своим lock. Корневой npm ci его НЕ покрывает:
# 09.11 деплой падал именно на этом — модули libp2p ставились руками.
( cd "$DIR/p2p-node" && npm ci --no-audit --no-fund ) || die "npm ci в $DIR/p2p-node"
ok "p2p-node: $(du -sh "$DIR/p2p-node/node_modules" | cut -f1)"

mkdir -p "$DIR/storage/experience"

# Проверяем, что нативный модуль действительно грузится: `npm ci` без ошибок
# ещё не значит, что бинарь рабочий. На проде это ловилось бы только
# при первом запросе к pii-classifier — то есть через часы.
node -e 'require("onnxruntime-node")' 2>/dev/null \
  && ok "onnxruntime-node загружается" \
  || die "onnxruntime-node не грузится после npm ci (вероятно, нет libstdc++ или не тот arch)"

# ---------------------------------------------------------------------------
say "восстановление данных"
if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] || die "нет архива --restore=$RESTORE"
  TMP=$(mktemp -d)
  tar -xzf "$RESTORE" -C "$TMP" || die "архив не распаковался"
  [ -f "$TMP/db/tarnet.db" ] || die "в архиве нет db/tarnet.db"

  # Проверяем снимок ДО того, как положить его на место: битая БД на новом
  # хосте выглядит как «сервер не стартует», и искать причину будут в коде.
  node "$DIR/scripts/sqlite-tool.js" verify "$TMP/db/tarnet.db" >/dev/null 2>&1 \
    || die "БД из архива не прошла integrity_check"

  install -m 0640 -o root -g root "$TMP/db/tarnet.db" "$STATE/tarnet.db"
  for f in master.key faucet-ip.key; do
    [ -f "$TMP/secrets/$f" ] || die "в архиве нет secrets/$f — БД без мастер-ключа нерасшифровываема"
    install -m 0600 -o root -g root "$TMP/secrets/$f" "$STATE/secrets/$f"
  done
  # Peer-ID: при потере узел получит новый, и воркер владельца его не найдёт.
  [ -f "$TMP/p2p/p2p-peer-id.bin" ] && install -m 0600 "$TMP/p2p/p2p-peer-id.bin" "$STATE/p2p/peer-id.bin"
  [ -f "$TMP/p2p/p2p-seed2-peer-id.bin" ] && install -m 0600 "$TMP/p2p/p2p-seed2-peer-id.bin" "$STATE/p2p-seed2/peer-id.bin"
  [ -f "$TMP/p2p/authorized-peers.json" ] && install -m 0600 "$TMP/p2p/authorized-peers.json" "$STATE/p2p/authorized-peers.json"
  [ -f "$TMP/etc/rclone.conf" ] && install -m 0600 "$TMP/etc/rclone.conf" /etc/tarnet/rclone.conf 2>/dev/null || {
    mkdir -p /etc/tarnet && [ -f "$TMP/etc/rclone.conf" ] && install -m 0600 "$TMP/etc/rclone.conf" /etc/tarnet/rclone.conf
  }
  [ -f "$TMP/etc/litestream-tarnet.yml" ] && install -m 0600 "$TMP/etc/litestream-tarnet.yml" /etc/litestream-tarnet.yml

  ROWS=$(node -e '
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    let n=0; for(const {name} of db.prepare("select name from sqlite_master where type=@t").all({t:"table"})){
      try{n+=db.prepare(`select count(*) c from "${name}"`).get().c}catch{}
    } console.log(n);
  ' "$STATE/tarnet.db" 2>/dev/null)
  rm -rf "$TMP"
  ok "БД восстановлена: строк $ROWS, секреты на месте"
else
  # Чистая установка: схему создаст сам server.js (CREATE TABLE IF NOT EXISTS).
  for f in master.key faucet-ip.key; do
    if [ ! -f "$STATE/secrets/$f" ]; then
      openssl rand -hex 16 > "$STATE/secrets/$f"
      chmod 600 "$STATE/secrets/$f"
      ok "сгенерирован secrets/$f (новая установка)"
    fi
  done
  warn "БД не восстанавливалась — будет создана пустая"
fi

# ---------------------------------------------------------------------------
say "systemd"
UNITS="tarnet.service p2p-bridge.service tarnet-seed2.service tarnet-prune-distill.service tarnet-prune-distill.timer"
for u in $UNITS; do
  [ -f "$DIR/deploy/systemd/$u" ] || die "нет $DIR/deploy/systemd/$u"
  install -m 0644 -o root -g root "$DIR/deploy/systemd/$u" "/etc/systemd/system/$u"
done
mkdir -p /etc/systemd/system/tarnet.service.d
for c in "$DIR"/deploy/systemd/tarnet.service.d/*.conf; do
  install -m 0644 -o root -g root "$c" "/etc/systemd/system/tarnet.service.d/$(basename "$c")"
done

# Подстановка домена: в юнитах он захардкожен под VDSina. Без этой замены
# новый хост поднимется с TARNET_PUBLIC_URL старого сервера — ссылки и
# проверки будут указывать на чужую машину, а TLS-проверка уйдёт не туда.
OLD_DOMAIN="v1107336.hosted-by-vdsina.com"
if [ "$DOMAIN" != "$OLD_DOMAIN" ]; then
  grep -rl "$OLD_DOMAIN" /etc/systemd/system/tarnet*.service.d /etc/systemd/system/p2p-bridge.service \
    /etc/systemd/system/tarnet-seed2.service 2>/dev/null | while read -r f; do
      sed -i "s/$OLD_DOMAIN/$DOMAIN/g" "$f"
    done
  ok "домен в юнитах заменён: $OLD_DOMAIN → $DOMAIN"
fi

systemctl daemon-reload || die "daemon-reload"

# Проверяем, что systemd ВИДИТ переменные, а не что файл лёг на диск.
SVC_ENV=$(systemctl show tarnet.service -p Environment --value)
printf '%s' "$SVC_ENV" | grep -q "TARNET_PUBLIC_URL=https://$DOMAIN" \
  || die "systemd не видит TARNET_PUBLIC_URL=https://$DOMAIN. Фактически: $SVC_ENV"
ok "systemd видит TARNET_PUBLIC_URL=https://$DOMAIN"

# ---------------------------------------------------------------------------
say "caddy"
mkdir -p /etc/caddy /var/log/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null
if [ -f "$DIR/deploy/Caddyfile.tpl" ]; then
  sed "s/{{DOMAIN}}/$DOMAIN/g" "$DIR/deploy/Caddyfile.tpl" > /etc/caddy/Caddyfile
else
  # Фолбэк, если шаблона нет: тот же смысл, что на проде — проксирование
  # и заголовок X-Real-IP, иначе лимиты и логи видят адрес Caddy, не клиента.
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3001 {
		header_up X-Real-IP {remote_host}
	}
	log {
		output file /var/log/caddy/tarnet-access.log {
			roll_size 10mb
			roll_keep 3
		}
		format json
	}
}
EOF
  warn "deploy/Caddyfile.tpl нет — сгенерирован встроенный конфиг"
fi
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddyfile невалиден"
systemctl enable --now caddy >/dev/null 2>&1 || die "caddy не запустился"
ok "Caddyfile применён, caddy active"

# ---------------------------------------------------------------------------
say "firewall"
# 3001 наружу НЕ открываем: внешний трафик идёт только через Caddy с TLS.
# Открытый 3001 = API без TLS и без X-Real-IP.
ufw allow 22/tcp   >/dev/null 2>&1
ufw allow 80/tcp   >/dev/null 2>&1
ufw allow 443/tcp  >/dev/null 2>&1
ufw allow 4001/tcp comment 'TarNet p2p libp2p' >/dev/null 2>&1
ufw allow 4002/tcp comment 'TarNet p2p seed2'  >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1 || die "ufw не включился"
for p in 22 80 443 4001 4002; do
  ufw status | grep -qE "^$p/tcp" || die "правила для $p нет в ufw"
done
ok "ufw active: 22, 80, 443, 4001, 4002 (3001 закрыт намеренно)"

# ---------------------------------------------------------------------------
say "запуск"
systemctl enable tarnet.service p2p-bridge.service tarnet-seed2.service litestream-tarnet.service >/dev/null 2>&1
systemctl restart tarnet.service || die "tarnet не стартовал"
for i in $(seq 1 30); do
  systemctl is-active --quiet tarnet.service && break
  sleep 1
done
systemctl is-active --quiet tarnet.service || {
  journalctl -u tarnet -n 20 --no-pager
  die "tarnet не активен — см. журнал выше"
}
ok "tarnet.service active"

systemctl restart p2p-bridge.service || warn "p2p-bridge не стартовал (не блокирует /health)"
sleep 2
systemctl restart tarnet-seed2.service || warn "tarnet-seed2 не стартовал"
systemctl enable --now tarnet-prune-distill.timer >/dev/null 2>&1 || warn "таймер prune не включился"

# litestream включаем только если есть конфиг с ключами S3: без него сервис
# уйдёт в бесконечный restart и будет выглядеть как поломка.
if [ -f /etc/litestream-tarnet.yml ] && [ -x /usr/local/bin/litestream ]; then
  systemctl enable --now litestream-tarnet >/dev/null 2>&1 && ok "litestream active" || warn "litestream не стартовал"
else
  [ -f /etc/litestream-tarnet.yml ] && warn "конфиг litestream есть, но бинаря нет — репликация выключена" \
    || warn "litestream не настроен — непрерывной репликации нет"
fi

# ---------------------------------------------------------------------------
say "проверка"
ok_health=0
for i in $(seq 1 40); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/health 2>/dev/null)
  [ "$CODE" = "200" ] && { ok_health=1; break; }
  sleep 2
done
[ "$ok_health" -eq 1 ] || {
  journalctl -u tarnet -n 30 --no-pager
  die "локальный /health не ответил 200 за 80 с"
}

BODY=$(curl -s --max-time 10 http://127.0.0.1:3001/health)
BUILD=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).buildVersion||"?")}catch{console.log("?")}})')
PKG=$(node -e 'console.log(require("'$DIR'/package.json").version)')
[ "$BUILD" = "$PKG" ] || warn "buildVersion ($BUILD) != package.json ($PKG)"
ok "локально /health 200, buildVersion $BUILD"

# Внешняя проверка: TLS выпускается только если A-запись уже указывает сюда.
EXT=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/health" 2>/dev/null)
if [ "$EXT" = "200" ]; then
  ok "снаружи https://$DOMAIN/health → 200"
else
  warn "снаружи https://$DOMAIN/health → $EXT. Caddy выпускает сертификат только когда DNS уже указывает на этот хост. Проверь A-запись и повтори: curl -I https://$DOMAIN/health"
fi

printf '\n{"ok":true,"domain":"%s","dir":"%s","state":"%s","commit":"%s","buildVersion":"%s","health_local":"%s","health_external":"%s","ts":"%s"}\n' \
  "$DOMAIN" "$DIR" "$STATE" "$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo unknown)" \
  "$BUILD" "200" "$EXT" "$(date -Iseconds)"

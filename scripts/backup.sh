#!/bin/bash
# TarNet — полный бэкап для переезда на другой хост.
#
# Что кладёт в архив (и почему именно это):
#   1. tarnet.db          — консистентный снимок через VACUUM INTO, не файл байтом:
#                           копия живого .db при WAL даёт рваный снимок.
#   2. secrets/           — master.key + faucet-ip.key. БД без master.key нерасшифровываема:
#                           в wallets.privateKeyPem лежит `enc:v1:...`. Это один объект.
#   3. rclone.conf         — remote для S3-бэкапа.
#   4. litestream-tarnet.yml — ключи S3 + путь репликации.
#   5. peer-id.bin × 2     — не секрет, но при потере узел получит новый Peer-ID,
#                           и воркер владельца его не найдёт.
#   6. authorized-peers.json — allowlist, без него мост отвергнет воркера.
#   7. systemd units + drop-ins — включая public-url.conf (домен меняется при переезде).
#   8. Caddyfile           — reverse-proxy и TLS.
#   9. Канонические документы — хроника переезжает вместе с кодом.
#
# sqlite3 CLI не используется: на VPS его нет, снимок делает node:sqlite.
#
# Печатает один JSON в stdout. Ненулевой exit = провал (архив не создан или не проверен).
#
# Использование:
#   ./backup.sh                       # в /var/backups/tarnet
#   OUT_DIR=/tmp/bk ./backup.sh       # в свой каталог
#   APP_DIR=/opt/tarnet/backend-api ./backup.sh

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/tarnet/backend-api}"
DB="${TARNET_DB:-/var/lib/tarnet/tarnet.db}"
SECRETS="${TARNET_SECRETS_DIR:-/var/lib/tarnet/secrets}"
DATA="${TARNET_DATA_DIR:-/var/lib/tarnet}"
OUT_DIR="${OUT_DIR:-/var/backups/tarnet}"
CACHE_DIR="${CACHE_DIR:-/var/cache/tarnet-backup}"

TS=$(date +%Y-%m-%dT%H-%M-%S)
STAGE="$CACHE_DIR/stage-$TS"
ARCHIVE="$OUT_DIR/tarnet-$TS.tar.gz"

fail() {
  printf '{"ok":false,"error":"%s","ts":"%s"}\n' "$1" "$(date -Iseconds)"
  [ -n "${STAGE:-}" ] && rm -rf "$STAGE" 2>/dev/null
  # Непроверенный архив удаляется: оставленный на диске он выглядит как
  # готовый бэкап, и через месяц его берут для переезда как настоящий.
  [ -n "${ARCHIVE:-}" ] && rm -f "$ARCHIVE" 2>/dev/null
  exit 1
}

log() { printf '[backup] %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || fail "нужен root: читаем /var/lib/tarnet и /etc"
[ -f "$DB" ] || fail "нет БД: $DB"
[ -d "$SECRETS" ] || fail "нет каталога секретов: $SECRETS"
[ -f "$APP_DIR/scripts/sqlite-tool.js" ] || fail "нет sqlite-tool.js в $APP_DIR"
command -v node >/dev/null 2>&1 || fail "нет node"
command -v tar >/dev/null 2>&1 || fail "нет tar"

mkdir -p "$OUT_DIR" "$CACHE_DIR" || fail "не создал $OUT_DIR / $CACHE_DIR"
mkdir -p "$STAGE"/{db,secrets,etc,systemd,p2p,docs} || fail "не создал staging"

# --- 1. Снимок БД (VACUUM INTO — консистентно при живом сервисе) ------------
log "снимок БД через VACUUM INTO"
SNAP_JSON=$(node "$APP_DIR/scripts/sqlite-tool.js" snapshot "$DB" "$STAGE/db/tarnet.db" 2>&1)
SNAP_RC=$?
if [ $SNAP_RC -ne 0 ]; then
  fail "snapshot не удался: $(printf '%s' "$SNAP_JSON" | head -c 300)"
fi
[ -s "$STAGE/db/tarnet.db" ] || fail "снимок пуст — VACUUM INTO не дал данных"

# integrity_check на снимке, а не на живой БД: проверяем то, что уедет
VERIFY_JSON=$(node "$APP_DIR/scripts/sqlite-tool.js" verify "$STAGE/db/tarnet.db" 2>&1)
VERIFY_RC=$?
[ $VERIFY_RC -eq 0 ] || fail "verify снимка не прошёл: $(printf '%s' "$VERIFY_JSON" | head -c 300)"
printf '%s' "$VERIFY_JSON" | grep -q '"ok":true' || fail "verify вернул не ok: $(printf '%s' "$VERIFY_JSON" | head -c 300)"

# --- 2. Секреты (только файлы, не каталоги) ---------------------------------
log "секреты"
for f in master.key faucet-ip.key; do
  [ -f "$SECRETS/$f" ] || fail "нет секрета: $SECRETS/$f"
  cp -p "$SECRETS/$f" "$STAGE/secrets/$f" || fail "не скопировал $f"
done

# --- 3. Конфиги доступа ------------------------------------------------------
log "конфиги"
[ -f /etc/tarnet/rclone.conf ] && cp -p /etc/tarnet/rclone.conf "$STAGE/etc/rclone.conf"
[ -f /etc/litestream-tarnet.yml ] && cp -p /etc/litestream-tarnet.yml "$STAGE/etc/litestream-tarnet.yml"
[ -f /etc/litestream.yml ] && cp -p /etc/litestream.yml "$STAGE/etc/litestream.yml"
[ -f /etc/caddy/Caddyfile ] && cp -p /etc/caddy/Caddyfile "$STAGE/etc/Caddyfile"
[ -f /etc/default/tarnet ] && cp -p /etc/default/tarnet "$STAGE/etc/default-tarnet"

# --- 4. Peer-ID и allowlist --------------------------------------------------
log "peer-id и allowlist"
for d in p2p p2p-seed2; do
  if [ -f "$DATA/$d/peer-id.bin" ]; then
    cp -p "$DATA/$d/peer-id.bin" "$STAGE/p2p/$d-peer-id.bin" || fail "не скопировал peer-id $d"
  fi
  [ -f "$DATA/$d/authorized-peers.json" ] && cp -p "$DATA/$d/authorized-peers.json" "$STAGE/p2p/$d-authorized-peers.json"
done
[ -f "$DATA/p2p/authorized-peers.json" ] && cp -p "$DATA/p2p/authorized-peers.json" "$STAGE/p2p/authorized-peers.json"

# --- 5. systemd: юниты и drop-in'ы ------------------------------------------
log "systemd"
for u in tarnet.service p2p-bridge.service tarnet-seed2.service litestream-tarnet.service \
         tarnet-prune-distill.service tarnet-prune-distill.timer; do
  [ -f "/etc/systemd/system/$u" ] && cp -p "/etc/systemd/system/$u" "$STAGE/systemd/$u"
done
for d in /etc/systemd/system/*.service.d; do
  [ -d "$d" ] || continue
  case "$(basename "$d")" in
    tarnet.service.d|p2p-bridge.service.d|tarnet-seed2.service.d)
      mkdir -p "$STAGE/systemd/$(basename "$d")"
      cp -p "$d"/*.conf "$STAGE/systemd/$(basename "$d")/" 2>/dev/null
      ;;
  esac
done

# --- 6. Канонические документы ---------------------------------------------
log "документы"
for f in MANIFEST.v3.4-UNIFIED.md PROJECT-HISTORY.md PROJECT-MAP.md ROADMAP.md MASTER-PLAN.md; do
  [ -f "$APP_DIR/$f" ] && cp -p "$APP_DIR/$f" "$STAGE/docs/$f"
done
printf '%s\n' "$(cd "$APP_DIR" && git rev-parse HEAD 2>/dev/null || echo unknown)" > "$STAGE/docs/COMMIT.txt"
printf '%s\n' "$(curl -s --max-time 10 http://127.0.0.1:3001/health 2>/dev/null | head -c 2000)" > "$STAGE/docs/HEALTH-AT-BACKUP.json"

# --- 7. Манифест содержимого (что именно уедет) ----------------------------
log "манифест"
{
  printf 'TarNet backup\ncreated: %s\nhost: %s\ncommit: %s\n\n' \
    "$(date -Iseconds)" "$(hostname)" "$(cat "$STAGE/docs/COMMIT.txt")"
  printf '%-58s %10s %s\n' "PATH" "BYTES" "SHA256"
  ( cd "$STAGE" && find . -type f ! -name 'MANIFEST.txt' | sort | while read -r f; do
      printf '%-58s %10s %s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
    done )
} > "$STAGE/MANIFEST.txt"

# --- 8. Архив ---------------------------------------------------------------
log "упаковка"
tar -czf "$ARCHIVE" -C "$STAGE" . 2>/dev/null || fail "tar не создал архив"
[ -s "$ARCHIVE" ] || fail "архив пуст"

# --- 9. Проверка архива: читается и содержит ключевые файлы -----------------
log "проверка архива"
tar -tzf "$ARCHIVE" >/dev/null 2>&1 || fail "архив не читается tar -tzf"

# Листинг снимается ОДИН раз в файл, а не тремя конвейерами `tar | grep -q`.
# Причина: `set -o pipefail` + `grep -q`. grep -q выходит на первом совпадении,
# tar получает SIGPIPE и падает с кодом 141, pipefail делает весь конвейер
# неуспешным — и проверка «файла нет» срабатывала на файле, который ЕСТЬ.
# Именно так первый прогон объявил отсутствующим ./secrets/master.key, который
# лежал в архиве; ./db/tarnet.db проходил лишь потому, что он последний в
# списке и tar успевал дописать ленту до выхода grep. Один `tar -t` заодно
# втрое быстрее: не распаковываем заголовки трижды.
LIST="$CACHE_DIR/list-$TS.txt"
tar -tzf "$ARCHIVE" > "$LIST" 2>/dev/null || fail "не снял листинг архива"
[ -s "$LIST" ] || fail "листинг архива пуст"

for need in ./db/tarnet.db ./secrets/master.key ./secrets/faucet-ip.key ./MANIFEST.txt; do
  grep -Fxq "$need" "$LIST" || fail "в архиве нет $need"
done

# Ключевые каталоги: без них переезд бессмысленен даже при живой БД.
for need in ./etc/Caddyfile ./systemd/tarnet.service ./p2p/authorized-peers.json; do
  grep -Fxq "$need" "$LIST" || fail "в архиве нет $need"
done

ARCHIVE_SIZE=$(stat -c %s "$ARCHIVE")
ARCHIVE_SHA=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
DB_SIZE=$(stat -c %s "$STAGE/db/tarnet.db")
FILE_COUNT=$(grep -vc '/$' "$LIST")
# Коммит читается ДО удаления staging: после rm файла уже нет, и в JSON
# ушло бы "unknown" — то есть бэкап нельзя было бы привязать к версии кода.
COMMIT=$(cat "$STAGE/docs/COMMIT.txt" 2>/dev/null || echo unknown)

rm -rf "$STAGE" "$LIST"

printf '{"ok":true,"archive":"%s","bytes":%s,"sha256":"%s","db_bytes":%s,"files":%s,"commit":"%s","ts":"%s"}\n' \
  "$ARCHIVE" "$ARCHIVE_SIZE" "$ARCHIVE_SHA" "$DB_SIZE" "$FILE_COUNT" \
  "$COMMIT" "$(date -Iseconds)"
exit 0

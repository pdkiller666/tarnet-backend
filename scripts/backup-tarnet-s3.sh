#!/bin/bash
# TarNet backup → S3-compatible (Fornex).
#
# Бэкапит ДВЕ вещи, потому что по отдельности они бесполезны:
#   1. tarnet.db     — консистентный снимок через VACUUM INTO
#   2. secrets/      — мастер-ключ AES-256-GCM
# В wallets.privateKeyPem лежит `enc:v1:...`: без мастер-ключа кошельки
# не расшифровать, поэтому БД без secrets — это не бэкап, а мусор.
#
# Печатает один JSON в stdout для планировщика. Ненулевой exit = провал.
set -uo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
export RCLONE_CONFIG=/etc/tarnet/rclone.conf

REMOTE="fornex:662-652-6fc2e8670a-main"
DB="${TARNET_DB:-/var/lib/tarnet/tarnet.db}"
SECRETS="${TARNET_SECRETS_DIR:-/var/lib/tarnet/secrets}"
TOOL="/opt/tarnet/backend-api/scripts/sqlite-tool.js"
STAGE="/tmp/tarnet-backup"
DATE=$(date +%Y-%m-%d)
TS=$(date -Iseconds)
DUMP="$STAGE/tarnet-$DATE.db"
SEC_TAR="$STAGE/tarnet-secrets-$DATE.tar.gz"
VERIFY="$STAGE/restore-check.db"

mkdir -p "$STAGE" || { echo '{"ok":false,"error":"stage dir"}'; exit 1; }

fail() {
  printf '{"ok":false,"error":"%s","ts":"%s"}\n' "$1" "$(date -Iseconds)"
  exit 1
}

[ -f "$DB" ] || fail "source db missing: $DB"
[ -d "$SECRETS" ] || fail "secrets dir missing: $SECRETS"
command -v rclone >/dev/null 2>&1 || fail "rclone not installed"
[ -f "$TOOL" ] || fail "sqlite-tool.js missing"

# --- 1. Консистентный снимок (VACUUM INTO) ---------------------------------
SNAP=$(node "$TOOL" snapshot "$DB" "$DUMP" 2>&1) || fail "snapshot failed: $SNAP"
case "$SNAP" in *'"ok":true'*) ;; *) fail "snapshot not ok: $SNAP" ;; esac

# --- 2. Доказать, что снимок восстанавливается ------------------------------
REST=$(node "$TOOL" restore "$DUMP" "$VERIFY" 2>&1) || fail "restore failed: $REST"
case "$REST" in *'"ok":true'*) ;; *) fail "restore not ok: $REST" ;; esac
rm -f "$VERIFY"

# --- 3. Сверить число чеков: источник == снимок -----------------------------
COUNTS=$(node -e '
const {DatabaseSync}=require("node:sqlite");
const a=new DatabaseSync(process.argv[1],{readOnly:true});
const b=new DatabaseSync(process.argv[2],{readOnly:true});
const q="SELECT COUNT(*) c FROM work_receipts";
const src=a.prepare(q).get().c, dst=b.prepare(q).get().c;
a.close(); b.close();
console.log(JSON.stringify({src,dst,ok:src===dst}));
' "$DB" "$DUMP" 2>/dev/null)
case "$COUNTS" in *'"ok":true'*) ;; *) fail "receipt count mismatch: $COUNTS" ;; esac
RECEIPTS=$(printf '%s' "$COUNTS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).src))' 2>/dev/null)

SIZE=$(stat -c %s "$DUMP")
# stderr (ExperimentalWarning о node:sqlite) попадает в SNAP вместе с stdout,
# поэтому парсим последнюю строку, начинающуюся с '{', а не весь поток.
TABLES=$(printf '%s' "$SNAP" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=d.trim().split("\n").filter(l=>l.trim().startsWith("{")).pop();try{console.log(JSON.parse(j).tables)}catch(e){console.log(0)}})' 2>/dev/null)

# --- 4. Мастер-ключ: права 0600, в архив с шифрованием имён не кладём ------
tar -czf "$SEC_TAR" -C "$(dirname "$SECRETS")" "$(basename "$SECRETS")" 2>/dev/null \
  || fail "secrets tar failed"
chmod 600 "$SEC_TAR"
SEC_SIZE=$(stat -c %s "$SEC_TAR")

# --- 5. Выгрузка: latest и датированная копия ------------------------------
rclone copy "$DUMP" "$REMOTE/tarnet-backup/latest/" --transfers 4 >/dev/null 2>&1 \
  || fail "rclone copy failed (db latest)"
rclone copy "$DUMP" "$REMOTE/tarnet-backup/$DATE/" --transfers 4 >/dev/null 2>&1 \
  || fail "rclone copy failed (db dated)"
rclone copy "$SEC_TAR" "$REMOTE/tarnet-backup/latest/" --transfers 4 >/dev/null 2>&1 \
  || fail "rclone copy failed (secrets latest)"
rclone copy "$SEC_TAR" "$REMOTE/tarnet-backup/$DATE/" --transfers 4 >/dev/null 2>&1 \
  || fail "rclone copy failed (secrets dated)"

# --- 6. Проверить, что объект реально лёг и размер совпал ------------------
REMOTE_SIZE=$(rclone size "$REMOTE/tarnet-backup/latest/tarnet-$DATE.db" --json 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).bytes||0)}catch(e){console.log(0)}})')
[ "$REMOTE_SIZE" = "$SIZE" ] || fail "remote db size $REMOTE_SIZE != local $SIZE"

REMOTE_SEC=$(rclone size "$REMOTE/tarnet-backup/latest/tarnet-secrets-$DATE.tar.gz" --json 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).bytes||0)}catch(e){console.log(0)}})')
[ "$REMOTE_SEC" = "$SEC_SIZE" ] || fail "remote secrets size $REMOTE_SEC != local $SEC_SIZE"

rm -f "$SEC_TAR"

printf '{"ok":true,"db":"%s/tarnet-backup/latest/tarnet-%s.db","size":%s,"secrets_size":%s,"tables":%s,"receipts":%s,"integrity":"ok","restore_verified":true,"ts":"%s"}\n' \
  "$REMOTE" "$DATE" "$SIZE" "$SEC_SIZE" "$TABLES" "$RECEIPTS" "$TS"

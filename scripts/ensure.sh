#!/bin/bash
# TarNet ensure — добавить резервный SSH-ключ владельца на VPS, не потеряв доступ.
#
# ЗАЧЕМ ЭТОТ СКРИПТ. Сейчас на VPS один рабочий ключ (openclaw-tarnet-deploy).
# Ключ потерян или отозван — доступа нет вообще, и восстановление идёт через
# панель хостера, то есть руками и в спешке. Резервный ключ владельца снимает
# эту единственную точку отказа.
#
# ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ СТРОКА В deploy.sh:
# deploy.sh раскатывает КОД. Ключи доступа — не код: их изменение не должно
# зависеть от того, сходится ли HEAD, и не должно откатываться вместе с деплоем.
# Плюс это редкая операция (раз в месяцы), а не ежедневная.
#
# ЧТО ЗАЩИЩАЕТСЯ ЯВНО:
#   1. Повторный запуск идемпотентен: тот же ключ не добавляется дважды.
#   2. Мусор не принимается: строка обязана пройти `ssh-keygen -l`.
#   3. Файл правится через временный + mv в том же каталоге: обрыв связи
#      посередине не оставит пустой authorized_keys, то есть мгновенную
#      потерю доступа к боевой машине.
#   4. После записи вход ПРОВЕРЯЕТСЯ отдельным подключением именно этим ключом.
#      Не проверилось — файл возвращается из резервной копии, скрипт выходит 1.
#
# Использование:
#   ./scripts/ensure.sh ~/id_owner_backup.pub   # из файла
#   ./scripts/ensure.sh                         # вставкой, Ctrl-D в конце
#
# Exit 0 — только если ключ на месте И вход им проверен.

set -uo pipefail

VPS="${TARNET_VPS:-root@195.63.131.172}"
SSH_KEY="${TARNET_SSH_KEY:-$HOME/.openclaw/ssh/tarnet_vps}"
SSH_OPTS=(-i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
REMOTE_FILE="/root/.ssh/authorized_keys"

info() { printf '\n== %s\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\nПРОВАЛ: %s\n' "$*" >&2; exit 1; }

# ---------- 1. публичный ключ от владельца ----------
if [ $# -ge 1 ]; then
  [ -r "$1" ] || die "не читается файл ключа: $1"
  KEY_LINE=$(tr -d '\r' < "$1" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' | head -1)
else
  info "вставьте публичный ключ одной строкой, затем Ctrl-D"
  KEY_LINE=$(cat | tr -d '\r' | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' | head -1)
fi

[ -n "${KEY_LINE:-}" ] || die "ключ не передан (пустой ввод)"

# Разбор до сети: строка обязана быть настоящим публичным ключом.
# `ssh-keygen -l` ловит и обрезанную строку, и подменённый тип, и валидный
# на вид, но битый base64 — обычная проверка «начинается с ssh-» этого не даёт.
KEY_TYPE=$(printf '%s\n' "$KEY_LINE" | awk '{print $1}')
case "$KEY_TYPE" in
  ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) ;;
  *) die "не похоже на публичный ключ (тип: ${KEY_TYPE:-пусто}). Нужна строка вида 'ssh-ed25519 AAAA... comment'" ;;
esac

PROBE=$(mktemp) || die "не создал временный файл"
printf '%s\n' "$KEY_LINE" > "$PROBE"
KEY_FP=$(ssh-keygen -l -f "$PROBE" 2>/dev/null | awk '{print $2}')
rm -f "$PROBE"
[ -n "${KEY_FP:-}" ] || die "ключ не разбирается ssh-keygen — строка повреждена"

info "ключ: $KEY_TYPE, отпечаток $KEY_FP"

# ---------- 2. доступ к VPS текущим ключом ----------
# Через -i, а не через алиас из ~/.ssh/config: скрипт должен работать и на
# машине без этого конфига (например, у владельца).
ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$VPS" 'true' 2>/dev/null \
  || die "нет доступа к $VPS текущим ключом ($SSH_KEY) — это чинится не здесь"

# ---------- 3. запись ----------
# Скрипт для сервера пишется отдельным файлом с ЗАКАВЫЧЕННЫМ heredoc: иначе
# пришлось бы экранировать каждый $ и обратную кавычку, и одна опечатка
# ломала бы файл доступа на живой машине.
#
# Ключ едет в argv как base64. Публичный ключ секретом не является, а base64
# снимает вопрос кавычек в комментарии. Через stdin ключ передать нельзя:
# stdin уже занят самим скриптом (bash -s).
REMOTE_SCRIPT=$(mktemp) || die "не создал временный файл скрипта"
cat > "$REMOTE_SCRIPT" <<'REMOTE'
set -uo pipefail
FILE="$1"
KEY=$(printf '%s' "$2" | base64 -d) || { echo ERR_DECODE; exit 1; }

mkdir -p "$(dirname "$FILE")"
[ -e "$FILE" ] || : > "$FILE"
chmod 600 "$FILE"

# Сравнение по типу+телу, без комментария: владелец мог переслать тот же
# ключ с другим комментарием, и это не повод заводить вторую строку.
WANT=$(printf '%s' "$KEY" | awk '{print $1" "$2}')
FOUND=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  [ "${line:0:1}" = "#" ] && continue
  have=$(printf '%s' "$line" | awk '{print $1" "$2}')
  if [ "$have" = "$WANT" ]; then FOUND=1; break; fi
done < "$FILE"
if [ "$FOUND" = "1" ]; then echo ALREADY; exit 0; fi

# Резервная копия ДО записи: если проверка входа ниже не пройдёт, вернёмся
# ровно к этому состоянию.
cp -p "$FILE" "$FILE.bak.$(date +%s)" || { echo ERR_BACKUP; exit 1; }

# Дописываем через временный файл и mv в том же каталоге: mv атомарен,
# и файл никогда не бывает полузаписанным.
TMP="$FILE.tmp.$$"
{ cat "$FILE"; printf '%s\n' "$KEY"; } > "$TMP" || { rm -f "$TMP"; echo ERR_WRITE; exit 1; }
mv "$TMP" "$FILE" || { rm -f "$TMP"; echo ERR_MOVE; exit 1; }
chmod 600 "$FILE"
echo ADDED
REMOTE

KEY_B64=$(printf '%s\n' "$KEY_LINE" | base64 -w0) || { rm -f "$REMOTE_SCRIPT"; die "не закодировал ключ"; }
OUT=$(ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$REMOTE_FILE" "$KEY_B64" < "$REMOTE_SCRIPT" 2>&1)
rc=$?
rm -f "$REMOTE_SCRIPT"

if printf '%s\n' "$OUT" | grep -q '^ALREADY'; then
  info "ключ уже был в authorized_keys — проверяю фактический вход"
  # Блок 8.2: наличие строки — НЕ вход.
  #
  # ПОЧЕМУ НЕЛЬЗЯ ВЫХОДИТЬ СРАЗУ. Строка в файле может быть, а вход —
  # нет: неверные права на каталог, `PermitRootLogin prohibit-password`
  # сломано, ключ добавлен с битым телом, sshd не перечитал конфиг, файл
  # подменён после записи. Во всех случаях прежний скрипт говорил «всё
  # хорошо» и выходил — а человек оставался без доступа, узнав об этом
  # только при попытке войти.
  #
  # Проверка тем же способом, что и после добавления (IdentitiesOnly), и
  # без отката: мы ничего не меняли, поэтому откатывать нечего — надо
  # честно сказать «вход не работает».
  VKEY2=$(mktemp) || die "не создал временный ключ"
  printf '%s\n' "$KEY_LINE" > "$VKEY2"
  chmod 600 "$VKEY2"
  VERIFY2=$(ssh -i "$VKEY2" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
    "$VPS" 'echo ENSURE_OK' 2>&1)
  rm -f "$VKEY2"
  if printf '%s' "$VERIFY2" | grep -q 'ENSURE_OK'; then
    info "вход этим ключом работает"
    exit 0
  fi
  die "ключ В ФАЙЛЕ ЕСТЬ, НО ВХОД НЕ РАБОТАЕТ: $(printf '%s' "$VERIFY2" | tail -3 | tr '\n' ' ')"
fi
printf '%s\n' "$OUT" | grep -q '^ADDED' || die "запись не удалась (rc=$rc): $OUT"

# ---------- 4. проверка новым ключом ----------
# Главная проверка: вход ДОЛЖЕН работать этим ключом. Проверяем отдельным
# подключением с IdentitiesOnly=yes, иначе ssh может взять другой ключ из
# агента и «подтвердить» не то, что мы записали.
info "проверяю вход новым ключом"
VKEY=$(mktemp) || die "не создал временный ключ"
printf '%s\n' "$KEY_LINE" > "$VKEY"
chmod 600 "$VKEY"
VERIFY=$(ssh -i "$VKEY" -o IdentitiesOnly=yes -o BatchMode=yes \
  -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
  "$VPS" 'echo ENSURE_OK' 2>&1)
rm -f "$VKEY"

if ! printf '%s' "$VERIFY" | grep -q 'ENSURE_OK'; then
  warn "новый ключ не пускает — откатываю authorized_keys из резервной копии"
  ROLLBACK=$(mktemp)
  cat > "$ROLLBACK" <<'REMOTE'
set -uo pipefail
FILE="$1"
LAST=$(ls -1t "$FILE".bak.* 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  cp -p "$LAST" "$FILE" && chmod 600 "$FILE"
  echo "откат выполнен из $LAST"
else
  echo "резервной копии нет — файл не тронут"
fi
REMOTE
  ssh "${SSH_OPTS[@]}" "$VPS" "bash -s" -- "$REMOTE_FILE" < "$ROLLBACK" 2>&1 | sed 's/^/   /'
  rm -f "$ROLLBACK"
  die "ключ добавлен, но вход им не подтвердился — основной доступ сохранён"
fi

# ---------- 5. итог ----------
COUNT=$(ssh "${SSH_OPTS[@]}" "$VPS" "grep -cvE '^[[:space:]]*(#|\$)' '$REMOTE_FILE'" 2>/dev/null)
info "готово: ключ $KEY_FP работает, всего ключей на VPS — ${COUNT:-?}"
printf '\nРезервный доступ подтверждён. Проверьте и со своей стороны:\n'
printf '  ssh -i <ваш-ключ> %s\n\n' "$VPS"

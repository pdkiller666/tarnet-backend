#!/bin/sh
# TarNet guard: respawn-loop for the API server (port 3001).
#
# Why this exists: the container has no supervisord and no systemd (PID 1 is tini).
# The scheduled "TarNet supervisor" job only runs every 10 minutes, so it cannot
# meet a 10-second recovery target. This loop holds the server in a live parent
# process and restarts it the instant it dies.
#
# Two independent layers of protection:
#   1. this guard  -> immediate respawn (seconds)
#   2. cron job    -> every 10 min, also revives the guard itself
#
# Crash-loop protection: if the server dies faster than 5s repeatedly, back off
# exponentially (1s -> 30s cap) so a broken build cannot burn CPU silently.
set -u

APP_DIR="/home/node/.openclaw/workspace-main/backend-api"
SERVER_LOG="/tmp/tarnet-server.log"
GUARD_LOG="/tmp/tarnet-guard.log"
LOCK="/tmp/tarnet-guard.lock"
API_PORT=3001

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$GUARD_LOG"; }

# Single instance: flock on fd 9. If another guard holds it, exit quietly.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "guard already running (lock held), exiting"
  exit 0
fi

cd "$APP_DIR" || { log "FATAL: cannot cd $APP_DIR"; exit 1; }

# Захват владения: если сервер уже запущен, но не нашим дочерним процессом
# (PPID 1 после kill guard'а), порт занят и новый экземпляр уйдёт в crash-loop,
# а /health будет отвечать 200 от сироты — guard станет бесполезным, оставаясь
# «зелёным». Поэтому сирота снимается, и сервер поднимается заново под guard'ом.
if pgrep -f "[n]ode server.js" >/dev/null 2>&1; then
  log "orphan server found (not owned by guard) -> killing to take ownership"
  pkill -f "[n]ode server.js" 2>/dev/null
  i=0
  while [ $i -lt 20 ]; do
    pgrep -f "[n]ode server.js" >/dev/null 2>&1 || break
    i=$((i + 1))
    sleep 0.5
  done
  if pgrep -f "[n]ode server.js" >/dev/null 2>&1; then
    pkill -9 -f "[n]ode server.js" 2>/dev/null
    sleep 1
  fi
  log "orphan cleared"
fi

backoff=1
log "guard started (pid $$)"

while :; do
  started=$(date +%s)
  log "starting: node server.js (NODE_ENV=production)"
  NODE_ENV=production node server.js >>"$SERVER_LOG" 2>&1 9>&-
  rc=$?
  lived=$(( $(date +%s) - started ))

  if [ "$lived" -lt 5 ]; then
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt 30 ] && backoff=30
    log "server exited rc=$rc after ${lived}s (crash loop) -> backoff ${backoff}s"
  else
    backoff=1
    log "server exited rc=$rc after ${lived}s -> restarting in 1s"
  fi

  sleep "$backoff"
done

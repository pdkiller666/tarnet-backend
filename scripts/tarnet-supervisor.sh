#!/bin/sh
# TarNet supervisor: guarantees the API server (port 3001) and the external
# Cloudflare quick tunnel are both up.
#
# Contract for the scheduled job:
#   - healthy run  -> prints nothing, exit 0
#   - anything was restarted / failed -> prints an ACTION line, exit 1 on failure
#
# Usage: tarnet-supervisor.sh [--verbose]
set -u

APP_DIR="/home/node/.openclaw/workspace-main/backend-api"
TUNNEL="/home/node/.openclaw/scripts/tarnet-tunnel.sh"
GUARD="/home/node/.openclaw/scripts/tarnet-guard.sh"
API_PORT=3001
SERVER_LOG="/tmp/tarnet-server.log"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

say() { echo "$@"; }
note() { [ "$VERBOSE" -eq 1 ] && echo "$@"; return 0; }

api_up() {
  curl -s --max-time 5 "http://localhost:${API_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'
}

server_running() {
  pgrep -f "[n]ode server.js" >/dev/null 2>&1
}

guard_running() {
  pgrep -f "[t]arnet-guard.sh" >/dev/null 2>&1
}

start_guard() {
  setsid nohup "$GUARD" >/dev/null 2>&1 </dev/null &
}

# --- 1. API server ---
if api_up; then
  note "API: up (port ${API_PORT})"
  # Guard protects against crashes between cron runs. If the server is somehow
  # alive but the guard is gone, restore the guard without touching the server:
  # the guard's while-loop picks up the next exit of that same process.
  if ! guard_running; then
    start_guard
    sleep 1
    if guard_running; then
      say "ACTION: guard was missing and has been started"
    else
      say "ACTION_FAILED: could not start guard"
      exit 1
    fi
  fi
else
  if server_running; then
    pkill -f "[n]ode server.js" 2>/dev/null
    sleep 2
  fi
  cd "$APP_DIR" || { say "ACTION_FAILED: cannot cd $APP_DIR"; exit 1; }
  # Always restore via the guard, never as a bare process: a bare `node server.js`
  # has PPID 1 and would not be respawned, so recovery would regress to 10 minutes.
  if ! guard_running; then
    start_guard
  fi
  i=0
  while [ $i -lt 20 ]; do
    api_up && break
    i=$((i + 1))
    sleep 1
  done
  if ! api_up; then
    say "ACTION_FAILED: API server did not come up (see $SERVER_LOG)"
    exit 1
  fi
  say "ACTION: API server was down and has been restarted"
fi

# --- 2. External tunnel ---
out=$(sh "$TUNNEL" ensure 2>&1)
rc=$?
case "$out" in
  *TUNNEL_RESTARTED*)
    say "ACTION: tunnel restarted - new URL: $(sh "$TUNNEL" url)"
    ;;
  *TUNNEL_URL_CHANGED*)
    say "ACTION: tunnel URL changed - $(sh "$TUNNEL" url)"
    ;;
  *)
    if [ $rc -ne 0 ]; then
      say "ACTION_FAILED: tunnel ensure failed - $(echo "$out" | head -3)"
      exit 1
    fi
    note "Tunnel: up - $(sh "$TUNNEL" url 2>/dev/null)"
    ;;
esac

# --- 3. End-to-end verification through the public URL ---
url=$(sh "$TUNNEL" url 2>/dev/null)
if [ -z "$url" ]; then
  say "ACTION_FAILED: no public URL available"
  exit 1
fi
if ! curl -s --max-time 25 "$url/health" 2>/dev/null | grep -q '"status":"ok"'; then
  say "ACTION_FAILED: public URL not responding ($url)"
  exit 1
fi
note "Public check: OK ($url)"
exit 0

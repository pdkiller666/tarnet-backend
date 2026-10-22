#!/bin/sh
# Keep the TarNet external tunnel (Cloudflare quick tunnel) alive.
# Reuses the existing trycloudflare.com URL when the connector is still running.
# Usage: tarnet-tunnel.sh [start|status|url]
set -u

CF_BIN="/tmp/cloudflared"
LOG="/tmp/cloudflared.log"
URL_FILE="/tmp/tarnet-tunnel.url"
API_PORT=3001

if ! command -v curl >/dev/null 2>&1; then
  echo "curl missing" >&2
  exit 1
fi

if [ ! -x "$CF_BIN" ]; then
  echo "downloading cloudflared..." >&2
  curl -sL -o "$CF_BIN" --max-time 120 \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" || exit 1
  chmod +x "$CF_BIN" || exit 1
fi

api_up() {
  curl -s --max-time 5 "http://localhost:${API_PORT}/health" | grep -q '"status":"ok"'
}

cf_running() {
  pgrep -f "[c]loudflared tunnel --url http://localhost:${API_PORT}" >/dev/null 2>&1
}

read_url() {
  [ -f "$URL_FILE" ] && cat "$URL_FILE"
}

start() {
  if cf_running; then
    echo "already running: $(read_url)"
    exit 0
  fi
  if ! api_up; then
    echo "TarNet API on :${API_PORT} is not responding" >&2
    exit 1
  fi
  nohup "$CF_BIN" tunnel --url "http://localhost:${API_PORT}" --no-autoupdate \
    >"$LOG" 2>&1 &
  # wait for the URL line to appear
  i=0
  while [ $i -lt 30 ]; do
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
    if [ -n "$url" ]; then
      echo "$url" > "$URL_FILE"
      echo "$url"
      exit 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "tunnel did not publish a URL; see $LOG" >&2
  exit 1
}

ensure() {
  # Keep the tunnel alive. Prints a notice ONLY when something changed,
  # so a scheduled job stays silent while the link is healthy.
  if cf_running; then
    live=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
    if [ -n "$live" ] && [ "$live" != "$(read_url)" ]; then
      echo "TUNNEL_URL_CHANGED: was $(read_url) now $live"
      echo "$live" > "$URL_FILE"
    fi
    exit 0
  fi
  new=$(start)
  echo "TUNNEL_RESTARTED: $new"
}

case "${1:-start}" in
  start)  start ;;
  ensure) ensure ;;
  status)
    if cf_running; then
      echo "running: $(read_url)"
    else
      echo "not running"
      exit 1
    fi
    ;;
  url)    read_url ;;
  *)      echo "usage: $0 [start|status|url]" >&2; exit 2 ;;
esac

#!/bin/sh
# Keep the TarNet Cloudflare quick tunnel alive between cron runs.
# The quick-tunnel hostname changes on every restart; this loop only limits
# downtime, it cannot make the hostname permanent (that needs a named tunnel).
set -u
TUNNEL="/home/node/.openclaw/scripts/tarnet-tunnel.sh"
LOG="/tmp/tarnet-tunnel-watch.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

log "tunnel watch started (pid $$)"
while :; do
  out=$(sh "$TUNNEL" ensure 2>&1)
  case "$out" in
    *TUNNEL_RESTARTED*|*TUNNEL_URL_CHANGED*|*"did not publish"*|*"not responding"*)
      log "$out"
      ;;
  esac
  sleep 20
done

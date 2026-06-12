#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[sync-volume-r2] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found."
}

require_command curl

DIRECTION="${SYNC_DIRECTION:-}"
APP_URL="${APP_URL:-}"
TOKEN="${VOLUME_SYNC_TOKEN:-}"

if [[ "$DIRECTION" != "push" && "$DIRECTION" != "pull" ]]; then
  fail "SYNC_DIRECTION must be 'push' or 'pull', got '$DIRECTION'."
fi
if [[ -z "$APP_URL" ]]; then
  fail "APP_URL must be set to the Django app's base URL (e.g. https://cqc-pathfinder.ch), no trailing slash."
fi
if [[ -z "$TOKEN" ]]; then
  fail "VOLUME_SYNC_TOKEN must be set and must match the value on the Django app service."
fi

# Strip any trailing slash so we don't end up with a double //internal.
APP_URL="${APP_URL%/}"
URL="$APP_URL/internal/sync-volume-to-r2/?direction=$DIRECTION"

log "Triggering $DIRECTION at $URL"

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

http_code=$(curl -fsS -o "$response_file" -w '%{http_code}' \
  --max-time 60 \
  --retry 2 --retry-delay 5 \
  --location --post301 --post302 --post303 \
  -X POST \
  -H "X-Sync-Token: $TOKEN" \
  "$URL" || true)

log "Response code: $http_code"
log "Response body:"
cat "$response_file" || true
printf '\n'

if [[ "$http_code" != "202" && "$http_code" != "200" ]]; then
  fail "Trigger failed with HTTP '$http_code'."
fi

log "Trigger ($DIRECTION) accepted. The actual sync runs inside the main app service; check its logs for progress."

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

require_command rclone

DIRECTION="${SYNC_DIRECTION:-}"
MEDIA_DIR="${MEDIA_ROOT:-/app/media}"
BUCKET="${R2_BUCKET:-}"

if [[ -z "$DIRECTION" ]]; then
  fail "SYNC_DIRECTION must be set to 'push' (prod -> R2) or 'pull' (R2 -> staging)."
fi
if [[ "$DIRECTION" != "push" && "$DIRECTION" != "pull" ]]; then
  fail "SYNC_DIRECTION must be 'push' or 'pull', got '$DIRECTION'."
fi
if [[ -z "$BUCKET" ]]; then
  fail "R2_BUCKET must be set to the name of the Cloudflare R2 bucket."
fi
if [[ -z "${RCLONE_CONFIG_R2_ACCESS_KEY_ID:-}" || -z "${RCLONE_CONFIG_R2_SECRET_ACCESS_KEY:-}" || -z "${RCLONE_CONFIG_R2_ENDPOINT:-}" ]]; then
  fail "R2 credentials are missing. Set RCLONE_CONFIG_R2_ACCESS_KEY_ID, RCLONE_CONFIG_R2_SECRET_ACCESS_KEY, and RCLONE_CONFIG_R2_ENDPOINT."
fi

# rclone auto-builds a remote called 'r2' from the RCLONE_CONFIG_R2_* env vars,
# but type/provider/region must also be set so they're exported here as defaults.
export RCLONE_CONFIG_R2_TYPE="${RCLONE_CONFIG_R2_TYPE:-s3}"
export RCLONE_CONFIG_R2_PROVIDER="${RCLONE_CONFIG_R2_PROVIDER:-Cloudflare}"
export RCLONE_CONFIG_R2_REGION="${RCLONE_CONFIG_R2_REGION:-auto}"

SUBDIRS=("maps" "masks")

sync_one() {
  local src="$1"
  local dst="$2"
  local label="$3"

  log "Syncing $label: $src -> $dst"
  local start=$SECONDS
  rclone sync "$src" "$dst" \
    --transfers=8 \
    --checkers=16 \
    --fast-list \
    --stats=30s \
    --stats-one-line
  log "$label completed in $((SECONDS - start))s."
}

if [[ "$DIRECTION" == "push" ]]; then
  if [[ ! -d "$MEDIA_DIR" ]]; then
    fail "MEDIA_ROOT '$MEDIA_DIR' does not exist. Refusing to push an empty source (would wipe R2)."
  fi
  for sub in "${SUBDIRS[@]}"; do
    src_dir="$MEDIA_DIR/$sub"
    if [[ ! -d "$src_dir" ]]; then
      log "Skipping '$sub': source directory '$src_dir' does not exist."
      continue
    fi
    file_count=$(find "$src_dir" -type f | head -n 1 | wc -l)
    if [[ "$file_count" -eq 0 ]]; then
      log "Skipping '$sub': source directory '$src_dir' is empty (refusing to wipe R2)."
      continue
    fi
    sync_one "$src_dir" "r2:$BUCKET/$sub" "$sub (push)"
  done
else
  mkdir -p "$MEDIA_DIR"
  for sub in "${SUBDIRS[@]}"; do
    remote="r2:$BUCKET/$sub"
    if ! rclone lsf "$remote" --max-depth 1 >/dev/null 2>&1; then
      log "Skipping '$sub': remote '$remote' is not reachable or does not exist."
      continue
    fi
    sync_one "$remote" "$MEDIA_DIR/$sub" "$sub (pull)"
  done
fi

log "Volume sync ($DIRECTION) completed successfully in ${SECONDS}s."

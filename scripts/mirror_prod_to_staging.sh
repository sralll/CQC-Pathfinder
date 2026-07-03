#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[mirror-prod-to-staging] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found. Install PostgreSQL client tools in this Railway service."
}

PROD_URL="${PROD_DB_PUBLIC_URL:-${PROD_DATABASE_URL:-}}"
TARGET_URL="${STAGING_DB_URL:-${STAGING_DATABASE_URL:-${DATABASE_URL:-}}}"

require_command pg_dump
require_command pg_restore
require_command psql

if [[ -z "$PROD_URL" ]]; then
  fail "Missing production database URL. Set PROD_DB_PUBLIC_URL."
fi

if [[ -z "$TARGET_URL" ]]; then
  fail "Missing staging database URL. Set STAGING_DB_URL, or attach this service to the staging PostgreSQL database so DATABASE_URL exists."
fi

if [[ "$PROD_URL" == "$TARGET_URL" ]]; then
  fail "Production and staging database URLs are identical. Refusing to restore production onto itself."
fi

if [[ "${CONFIRM_STAGING_DB_RESET:-}" != "true" ]]; then
  fail "Set CONFIRM_STAGING_DB_RESET=true on this Railway service to confirm that staging may be wiped and replaced."
fi

log "Starting production to staging database mirror."

# The streamed pipe below wipes staging before the dump starts, so make sure
# prod is actually reachable first -- otherwise a connectivity blip would
# leave staging empty until the next nightly run.
log "Checking production connectivity..."
psql "$PROD_URL" --set=ON_ERROR_STOP=1 --command="SELECT 1;" >/dev/null \
  || fail "Cannot reach the production database; staging left untouched."

log "Resetting staging public schema..."
reset_start=$SECONDS
psql "$TARGET_URL" \
  --set=ON_ERROR_STOP=1 \
  --command="DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
log "Staging schema reset completed in $((SECONDS - reset_start))s."

# Pipe pg_dump straight into pg_restore instead of dumping to a temp file:
# a temp file's contents sit in the OS page cache, which Railway's memory
# metric counts, making the mirror look like a full-DB-size memory spike.
log "Streaming production dump into staging..."
transfer_start=$SECONDS
pg_dump --format=custom --no-owner --no-acl "$PROD_URL" \
  | pg_restore --no-owner --no-acl --dbname="$TARGET_URL"
log "Mirror transfer completed in $((SECONDS - transfer_start))s."

# Default is a plain copy: prod already carries the full migration history, so
# no migrate run is needed after restore. Opt back in with
# RUN_DJANGO_MIGRATIONS_AFTER_RESTORE=true while staging code carries
# migrations that are not yet deployed to prod (otherwise the mirrored schema
# lags behind staging's code until the next staging deploy runs migrate).
if [[ "${RUN_DJANGO_MIGRATIONS_AFTER_RESTORE:-false}" == "true" && -f "manage.py" ]]; then
  export DATABASE_URL="$TARGET_URL"
  export SECRET_KEY="${SECRET_KEY:-db-mirror-temporary-secret-key}"

  log "Running Django migrations on staging..."
  migrate_start=$SECONDS
  python manage.py migrate --noinput
  log "Django migrations completed in $((SECONDS - migrate_start))s."
elif [[ "${RUN_DJANGO_MIGRATIONS_AFTER_RESTORE:-false}" != "true" ]]; then
  log "Skipping Django migrations because RUN_DJANGO_MIGRATIONS_AFTER_RESTORE is not true."
else
  log "Skipping Django migrations because manage.py was not found in this container."
fi

log "Database mirror completed successfully in ${SECONDS}s."

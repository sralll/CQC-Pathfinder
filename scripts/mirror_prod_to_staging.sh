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

DUMP_FILE="/tmp/prod-db.dump"

cleanup() {
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

log "Starting production to staging database mirror."
log "Creating production database dump..."
dump_start=$SECONDS
pg_dump --format=custom --no-owner --no-acl --file="$DUMP_FILE" "$PROD_URL"
log "Production dump completed in $((SECONDS - dump_start))s."

log "Resetting staging public schema..."
reset_start=$SECONDS
psql "$TARGET_URL" \
  --set=ON_ERROR_STOP=1 \
  --command="DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
log "Staging schema reset completed in $((SECONDS - reset_start))s."

log "Restoring production dump into staging..."
restore_start=$SECONDS
pg_restore \
  --no-owner \
  --no-acl \
  --dbname="$TARGET_URL" \
  "$DUMP_FILE"
log "Staging restore completed in $((SECONDS - restore_start))s."

if [[ "${RUN_DJANGO_MIGRATIONS_AFTER_RESTORE:-true}" == "true" && -f "manage.py" ]]; then
  export DATABASE_URL="$TARGET_URL"
  export SECRET_KEY="${SECRET_KEY:-db-mirror-temporary-secret-key}"

  log "Running Django migrations on staging..."
  migrate_start=$SECONDS
  python manage.py migrate --noinput
  log "Django migrations completed in $((SECONDS - migrate_start))s."
elif [[ "${RUN_DJANGO_MIGRATIONS_AFTER_RESTORE:-true}" != "true" ]]; then
  log "Skipping Django migrations because RUN_DJANGO_MIGRATIONS_AFTER_RESTORE is not true."
else
  log "Skipping Django migrations because manage.py was not found in this container."
fi

log "Database mirror completed successfully in ${SECONDS}s."

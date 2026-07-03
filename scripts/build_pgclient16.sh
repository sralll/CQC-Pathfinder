#!/usr/bin/env bash
# Builds a self-contained postgresql-client-16 (pg_dump/pg_restore) into
# /opt/pgclient so the deploy image can dump/restore a PG16 database.
# Invoked by the pgclient16 step in railpack.json; the deploy image only
# keeps /opt/pgclient from this step.
set -o errexit -o nounset -o pipefail

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg patchelf

install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

. /etc/os-release
echo "=== pgdg setup: codename=${VERSION_CODENAME} arch=$(dpkg --print-architecture) ==="
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
cat /etc/apt/sources.list.d/pgdg.list

apt-get update
apt-get install -y --no-install-recommends postgresql-client-16

mkdir -p /opt/pgclient/bin /opt/pgclient/lib
install -m755 /usr/lib/postgresql/16/bin/pg_dump /opt/pgclient/bin/pg_dump
install -m755 /usr/lib/postgresql/16/bin/pg_restore /opt/pgclient/bin/pg_restore

# Bundle every shared library the binaries need except the glibc core ones,
# which the deploy image is guaranteed to provide.
ldd /opt/pgclient/bin/pg_dump /opt/pgclient/bin/pg_restore \
  | awk '$2=="=>"{print $3}' \
  | sort -u \
  | grep -vE '/(libc|libm|libpthread|libdl|librt|libresolv|ld-linux)' \
  | xargs -I{} cp -Lv {} /opt/pgclient/lib/

# --force-rpath writes legacy DT_RPATH instead of DT_RUNPATH: RUNPATH only
# covers a binary's direct deps, so transitive deps (e.g. libpq ->
# libgssapi_krb5) would fail to resolve in the deploy image.
patchelf --force-rpath --set-rpath '$ORIGIN/../lib' /opt/pgclient/bin/pg_dump /opt/pgclient/bin/pg_restore
for lib in /opt/pgclient/lib/*; do
  patchelf --force-rpath --set-rpath '$ORIGIN' "$lib"
done

/opt/pgclient/bin/pg_dump --version
/opt/pgclient/bin/pg_restore --version

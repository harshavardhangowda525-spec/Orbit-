#!/usr/bin/env bash
# Creates roles and the orbit + orbit_test databases on a local PostgreSQL.
# Usage: PGSUPER="psql -U postgres -h localhost" bash infra/db/setup-local.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PSQL="${PGSUPER:-sudo -u postgres psql}"
$PSQL -v ON_ERROR_STOP=1 -f "$DIR/setup.sql"
for db in orbit orbit_test; do
  if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    $PSQL -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db OWNER orbit_migrator"
  fi
  $PSQL -v ON_ERROR_STOP=1 -d "$db" -f "$DIR/setup-db.sql"
done
echo "Databases ready: orbit, orbit_test"

#!/usr/bin/env bash
# Used by docker-compose: runs inside the postgres container on first start.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -f /orbit-db/setup.sql
for db in orbit orbit_test; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -c "CREATE DATABASE $db OWNER orbit_migrator"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" -f /orbit-db/setup-db.sql
done

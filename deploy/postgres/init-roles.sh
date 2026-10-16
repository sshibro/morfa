#!/bin/sh
# Runs once, when the PostgreSQL data volume is first created (docker-entrypoint-initdb.d), or by hand as the cluster's superuser.
# Creates Morfa's database and the three separately passworded roles the migration tool requires: the owner (morfa_migration,
# runs scripts/postgresql/migrate.ts), the application (morfa_runtime) and the read-only backup role (morfa_backup).
# Passwords come from the environment and must be lowercase hex strings.
set -eu
for name in MORFA_DB_MIGRATION_PASSWORD MORFA_DB_RUNTIME_PASSWORD MORFA_DB_BACKUP_PASSWORD; do
  eval "value=\${$name:-}"
  case "$value" in
    *[!0-9a-f]*|"") echo "$name must be a lowercase hex string" >&2; exit 1 ;;
  esac
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<EOSQL
CREATE ROLE morfa_migration LOGIN PASSWORD '${MORFA_DB_MIGRATION_PASSWORD}';
CREATE ROLE morfa_runtime LOGIN NOINHERIT PASSWORD '${MORFA_DB_RUNTIME_PASSWORD}';
CREATE ROLE morfa_backup LOGIN NOINHERIT PASSWORD '${MORFA_DB_BACKUP_PASSWORD}';
CREATE DATABASE morfa OWNER morfa_migration;
REVOKE ALL ON DATABASE morfa FROM PUBLIC;
GRANT CONNECT ON DATABASE morfa TO morfa_runtime, morfa_backup;
EOSQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname morfa <<EOSQL
ALTER SCHEMA public OWNER TO morfa_migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL

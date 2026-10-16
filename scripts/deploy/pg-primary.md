# PostgreSQL primary (production ru-db) — lane B5

The settings are `deploy/postgresql/morfa.conf` (conf.d of the cluster). bench-ru is provisioned the same way by
`scripts/deploy/remote/bench-ru.sh` (`pg` step); production follows these steps by hand (operator).

1. PGDG repository and PostgreSQL 18: `/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && apt-get install
   postgresql-18 pgbackrest`.
2. `deploy/postgresql/morfa.conf` → `/etc/postgresql/18/main/conf.d/`; `listen_addresses` = loopback **and the private
   interface** (`listen_addresses = '127.0.0.1,10.x.y.z'`); `pg_hba.conf`: `hostssl morfa morfa_runtime 10.0.0.0/8 scram-sha-256`
   for ru-4 (the api's config requires TLS with `sslmode=verify-full` for any non-loopback host: the server certificate's CA goes
   to `MORFA_DATABASE_CA_CERT_FILE`). **collab's journal has no TLS** (`crates/journal/src/conn.rs`, `NoTls`): its
   connections from ru-4 need a plain line too, `host morfa morfa_runtime <ru-4 private ip>/32 scram-sha-256` (SCRAM never sends
   the password; the traffic stays on Timeweb's private network, never the public interface). Until the journal speaks TLS this
   is also why a managed PostgreSQL that insists on TLS cannot serve collab.
3. Roles and the database: `POSTGRES_USER=postgres MORFA_DB_*_PASSWORD=<hex> sh deploy/postgres/init-roles.sh` as postgres;
   a `morfa_monitor` role in `pg_monitor` for the exporter.
4. pgBackRest: `deploy/pgbackrest/pgbackrest.conf.example` with the Timeweb bucket and a generated cipher pass;
   `pgbackrest --stanza=morfa stanza-create && pgbackrest --stanza=morfa check`; enable `morfa-backup.timer`.
5. Migrate from a release: `host.sh migrate` (release.sh does it).
6. Sizes to watch: `shared_buffers` 25 % of RAM on a dedicated VM (4 GB of 16), `max_connections` ≥ api processes × pool (20) +
   collab nodes × 4 + workers + exporters + 20.

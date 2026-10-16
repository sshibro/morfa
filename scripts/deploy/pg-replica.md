# PostgreSQL streaming replica — lane B5 (TARGETS D4 ★: the operator chooses sync or async)

A replica bounds the loss of a lost primary to its lag (async: typically < 1 s; sync: 0, at the cost of every commit waiting for
the replica — D1's group commit p99 grows by the round trip). Not on bench-ru (one VM); production: a second small VM in the same DC.

1. On the primary: `CREATE ROLE morfa_replication REPLICATION LOGIN PASSWORD '<generated>'`; `pg_hba.conf`:
   `hostssl replication morfa_replication <replica ip>/32 scram-sha-256`; `max_wal_senders`, `wal_keep_size` are in morfa.conf.
   A physical slot keeps WAL the replica has not read: `SELECT pg_create_physical_replication_slot('replica1')`.
2. On the replica (same PostgreSQL 18 and conf.d): stop the cluster, empty its data directory, then
   `pg_basebackup -h <primary> -U morfa_replication -D /var/lib/postgresql/18/main -R -S replica1 -X stream -P`
   (or `pgbackrest --stanza=morfa --type=standby restore`, which also uses the S3 archive to catch up).
3. Start it; check `SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication` on the primary.
4. Synchronous (D4 = no loss of acked ops even if the primary's disk is lost): `synchronous_standby_names = 'FIRST 1 (replica1)'`
   on the primary. Measure D1 again (`close.sh`) before keeping it.
5. Failover (manual): `pg_ctl promote` (or `SELECT pg_promote()`) on the replica, point `MORFA_DATABASE_URL` /
   `MORFA_COLLAB_PG_URL` of ru-4 at it, restart api and collab (rolling, `host.sh restart`). Leases and fences live in the
   database, so collab's split-brain protection holds across the switch.
6. Alert on `pg_stat_replication` lag > 10 s and on the slot's retained WAL (postgres_exporter: `pg_replication_slots_*`).

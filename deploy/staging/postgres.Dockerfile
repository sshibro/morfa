# PostgreSQL 18 with pgBackRest for the local staging stack (scripts/deploy/staging.sh): production's archive_command and restore
# run in it. The official image already carries the PGDG apt source, so pgBackRest comes from the same place as on the VMs.
ARG BASE=postgres:18
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest ca-certificates && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 750 /var/spool/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest

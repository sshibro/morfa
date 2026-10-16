#!/usr/bin/env bash
# bench-ru's provisioning, run as root ON the VM by scripts/deploy/provision-bench.sh,
# which copies the repository's deploy/ and scripts/deploy/ to $SRC first. Idempotent; DRY_RUN=1 prints instead of changing.
#
#   BENCH_IP=<public IP> RUNET_IP=<ru-net IP> SRC=/root/morfa-provision bash bench-ru.sh [step…]
#
# Steps (all by default): base users pg pgbench pgtls caddy node rust minio s3 pgbackrest systemd observability ssh firewall summary
# What it installs: PostgreSQL 18 (PGDG) with two clusters — main (5432: the systemd stack, WAL archived by pgBackRest) and bench
# (5450: the harness's guarded test cluster, scripts/bench) —, Caddy (official repo), Node 22.23.2 (nodejs.org, checksum checked),
# rustup for the `morfa` user (the toolchain of rust-toolchain.toml: binaries are built here, x86_64-unknown-linux-gnu), MinIO + mc
# (the S3 stand-in), pgBackRest, Docker for the observability compose, ufw. Nothing from production; no domain.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

: "${BENCH_IP:?BENCH_IP}"
: "${RUNET_IP:?RUNET_IP}"
SRC=${SRC:-/root/morfa-provision}
NODE_VERSION=22.23.2
CADDY_VERSION=2.11.7
GO_VERSION=go1.27.1
MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
PG=18
ETC=/etc/morfa
BUCKET=morfa-bench

base() {
  step "base packages"
  if ! probe test -f /var/lib/morfa/.apt-updated; then run apt-get update -q; run_sh "mkdir -p /var/lib/morfa && touch /var/lib/morfa/.apt-updated"; fi
  apt_install ca-certificates curl gnupg jq zstd xz-utils build-essential pkg-config libssl-dev git ufw chrony sysstat iperf3 time \
    acl rsync openssl postgresql-common docker.io docker-compose-v2 linux-tools-common "linux-tools-$(uname -r)" numactl
  quiet_upgrades
  sysctl_tuning
}

users() {
  step "users and directories"
  probe id morfa || run useradd --system --create-home --home-dir /srv/morfa --shell /bin/bash morfa
  probe id minio || run useradd --system --no-create-home --shell /usr/sbin/nologin minio
  run install -d -o morfa -g morfa -m 755 /srv/morfa /srv/morfa/releases /srv/morfa/bench /srv/morfa/cache /srv/morfa/target /srv/morfa/bin
  run install -d -o morfa -g morfa -m 750 /srv/morfa/data
  run install -d -o root -g morfa -m 750 "$ETC"
  run install -d -o root -g root -m 755 /var/lib/morfa /var/lib/morfa/textfile
  run install -d -o minio -g minio -m 750 /srv/minio
  # The harness reaches the ru-net VM as `bench` with this key (scripts/bench/lib/loadgen.ts, morfa-netem).
  if ! probe test -f /srv/morfa/.ssh/id_ed25519; then
    run install -d -o morfa -g morfa -m 700 /srv/morfa/.ssh
    run sudo -u morfa ssh-keygen -q -t ed25519 -N '' -C "morfa@bench-ru" -f /srv/morfa/.ssh/id_ed25519
  fi
}

pg_role_exists() {
  [ "$DRY_RUN" != 1 ] && [ "$(cd /tmp && sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$1'" -d postgres 2>/dev/null)" = 1 ]
}

pg() {
  step "PostgreSQL $PG (PGDG) — main cluster on 5432"
  if ! probe test -f /etc/apt/sources.list.d/pgdg.sources -o -f /etc/apt/sources.list.d/pgdg.list; then
    run /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  fi
  apt_install "postgresql-$PG" "postgresql-client-$PG" pgbackrest
  install_file "$SRC/deploy/systemd/postgresql@.service.d/morfa-slice.conf" /etc/systemd/system/postgresql@.service.d/morfa-slice.conf || true
  local changed=0
  install_file "$SRC/deploy/postgresql/morfa.conf" "/etc/postgresql/$PG/main/conf.d/morfa.conf" 644 postgres:postgres && changed=1
  # The bench VM: half of production's memory for the main cluster (the bench cluster takes the rest during closing runs).
  run_sh "printf 'shared_buffers = 2GB\neffective_cache_size = 6GB\n' >/etc/postgresql/$PG/main/conf.d/zz-bench.conf"
  run systemctl daemon-reload
  if [ $changed = 1 ]; then run systemctl restart "postgresql@$PG-main"; fi
  run systemctl enable --now "postgresql@$PG-main"
  # Roles (deploy/postgres/init-roles.sh) with passwords generated here, kept in /etc/morfa/db.env.
  env_default "$ETC/db.env" MORFA_DB_MIGRATION_PASSWORD "$(secret)"
  env_default "$ETC/db.env" MORFA_DB_RUNTIME_PASSWORD "$(secret)"
  env_default "$ETC/db.env" MORFA_DB_BACKUP_PASSWORD "$(secret)"
  env_default "$ETC/db.env" MORFA_DB_MONITOR_PASSWORD "$(secret)"
  if ! pg_role_exists morfa_runtime; then
    # postgres cannot read /root: the script goes through a private copy it can read.
    run_sh "set -a; . $ETC/db.env; set +a; cd /tmp && install -m 644 $SRC/deploy/postgres/init-roles.sh /tmp/morfa-init-roles.sh && sudo -u postgres --preserve-env=MORFA_DB_MIGRATION_PASSWORD,MORFA_DB_RUNTIME_PASSWORD,MORFA_DB_BACKUP_PASSWORD env POSTGRES_USER=postgres sh /tmp/morfa-init-roles.sh; status=\$?; rm -f /tmp/morfa-init-roles.sh; exit \$status"
  fi
  # The exporters' role (deploy/observability: postgres-exporter).
  if ! pg_role_exists morfa_monitor; then
    run_sh "set -a; . $ETC/db.env; set +a; cd /tmp && sudo -u postgres psql -q -d postgres -v ON_ERROR_STOP=1 -v pw=\"\$MORFA_DB_MONITOR_PASSWORD\" <<'SQL'
CREATE ROLE morfa_monitor LOGIN IN ROLE pg_monitor PASSWORD :'pw';
GRANT CONNECT ON DATABASE morfa TO morfa_monitor;
SQL"
  fi
  # pg_stat_statements lives in the postgres database: the migration tool wants morfa's public schema empty before its ledger.
  run_sh "cd /tmp && sudo -u postgres psql -q -d postgres -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'"
}

db_rotate() {
  step "rotate the database roles' passwords (db.env), then the services' env files and the units"
  [ "$DRY_RUN" = 1 ] && { printf '+ new MORFA_DB_*_PASSWORD; ALTER ROLE …; systemd step; restart morfa units\n'; return 0; }
  local key role
  for key in MIGRATION RUNTIME BACKUP; do
    role=morfa_$(echo "$key" | tr 'A-Z' 'a-z')
    env_set "$ETC/db.env" "MORFA_DB_${key}_PASSWORD" "$(secret)"
    (cd /tmp && sudo -u postgres psql -q -d postgres -v ON_ERROR_STOP=1 -v pw="$(env_get "$ETC/db.env" "MORFA_DB_${key}_PASSWORD")" <<SQL
ALTER ROLE $role PASSWORD :'pw';
SQL
    )
  done
  systemd_units
  systemctl try-restart 'morfa-api@*' morfa-worker 'morfa-collab@*'
}

pg_tls() {
  step "PostgreSQL TLS for api (production mode requires verify-full even on loopback): a VM-local CA, a cert for 127.0.0.1"
  local dir=/etc/morfa/pg-tls
  if ! probe test -f "$dir/server.crt"; then
    run install -d -m 700 "$dir"
    run_sh "set -e; cd $dir && openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=Morfa bench PostgreSQL CA' -keyout ca.key -out ca.crt 2>/dev/null \
      && openssl req -newkey rsa:2048 -nodes -subj '/CN=127.0.0.1' -keyout server.key -out server.csr 2>/dev/null \
      && printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' >ext.cnf \
      && openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile ext.cnf -out server.crt 2>/dev/null"
  fi
  # api reads the CA (MORFA_DATABASE_CA_CERT_FILE); every cluster of the host serves the same certificate.
  run install -m 640 -o root -g morfa "$dir/ca.crt" "$ETC/pg-ca.crt"
  run install -m 600 -o postgres -g postgres "$dir/server.crt" /etc/postgresql/morfa-server.crt
  run install -m 600 -o postgres -g postgres "$dir/server.key" /etc/postgresql/morfa-server.key
  local text="ssl = on
ssl_cert_file = '/etc/postgresql/morfa-server.crt'
ssl_key_file = '/etc/postgresql/morfa-server.key'
"
  for cluster in main bench; do
    [ -d "/etc/postgresql/$PG/$cluster" ] || [ "$DRY_RUN" = 1 ] || continue
    if ! probe test "$(cat "/etc/postgresql/$PG/$cluster/conf.d/zz-tls.conf" 2>/dev/null)" = "$text"; then
      run_sh "printf '%s' \"$text\" >/etc/postgresql/$PG/$cluster/conf.d/zz-tls.conf && chown postgres:postgres /etc/postgresql/$PG/$cluster/conf.d/zz-tls.conf"
      run systemctl restart "postgresql@$PG-$cluster"
    fi
  done
}

pgbench_cluster() {
  step "PostgreSQL $PG — bench cluster on 5450 (the harness's guarded test cluster)"
  if ! probe test -d "/etc/postgresql/$PG/bench"; then
    run pg_createcluster "$PG" bench --port 5450 -- --auth-host=scram-sha-256 --auth-local=peer
  fi
  local changed=0
  install_file "$SRC/deploy/postgresql/morfa.conf" "/etc/postgresql/$PG/bench/conf.d/morfa.conf" 644 postgres:postgres && changed=1
  # No WAL archive for throwaway bench databases; the shape of the main cluster otherwise.
  run_sh "printf 'port = 5450\narchive_mode = off\nmax_connections = 400\nshared_buffers = 3GB\n' >/etc/postgresql/$PG/bench/conf.d/zz-bench.conf"
  if [ $changed = 1 ]; then run systemctl restart "postgresql@$PG-bench"; fi
  run systemctl enable --now "postgresql@$PG-bench"
  # The guard of scripts/postgresql/test-cluster.mjs, as the PostgreSQL test cluster builds it without Docker: a bootstrap role owns the
  # control database and the marker; the admin role (CREATEDB, CREATEROLE, not a superuser) makes and drops the bench databases.
  # D3 freezes this cluster (never the main one): the harness may run that one command as root.
  install_file "$here/morfa-pg-freeze" /usr/local/sbin/morfa-pg-freeze 755 || true
  run_sh "printf 'morfa ALL=(root) NOPASSWD: /usr/local/sbin/morfa-pg-freeze\n' >/etc/sudoers.d/morfa-pg-freeze && chmod 440 /etc/sudoers.d/morfa-pg-freeze && visudo -cq"
  local state=/srv/morfa/bench/pg
  if probe test -f "$state/cluster.env"; then return 0; fi
  run install -d -o morfa -g morfa -m 700 "$state"
  if [ "$DRY_RUN" = 1 ]; then printf '+ create the guard roles, control database and cluster.env in %s\n' "$state"; return 0; fi
  local id token adminpw bootpw
  id=$(openssl rand -hex 16); token=$(secret); adminpw=$(secret); bootpw=$(secret)
  cd /tmp
  sudo -u postgres psql -q -p 5450 -d postgres -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE "morfa_test_bootstrap_$id" LOGIN NOSUPERUSER PASSWORD '$bootpw';
CREATE DATABASE "morfa_test_control_$id" OWNER "morfa_test_bootstrap_$id";
CREATE ROLE "morfa_test_admin_$id" LOGIN NOSUPERUSER CREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '$adminpw';
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
  PGPASSWORD=$bootpw psql -q -h 127.0.0.1 -p 5450 -U "morfa_test_bootstrap_$id" -d "morfa_test_control_$id" -v ON_ERROR_STOP=1 <<SQL
REVOKE ALL ON DATABASE "morfa_test_control_$id" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE "morfa_test_control_$id" TO "morfa_test_admin_$id";
CREATE SCHEMA morfa_test_guard;
CREATE TABLE morfa_test_guard.cluster(cluster_id text PRIMARY KEY,token text NOT NULL,format_version integer NOT NULL);
INSERT INTO morfa_test_guard.cluster VALUES('$id','$token',1);
CREATE TABLE morfa_test_guard.allocations(database_name text PRIMARY KEY CHECK(database_name ~ '^morfa_test_[a-f0-9]{32}\$'),proof text NOT NULL,roles jsonb NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA morfa_test_guard FROM PUBLIC;
GRANT USAGE ON SCHEMA morfa_test_guard TO "morfa_test_admin_$id";
GRANT SELECT ON morfa_test_guard.cluster TO "morfa_test_admin_$id";
GRANT SELECT,INSERT,DELETE ON morfa_test_guard.allocations TO "morfa_test_admin_$id";
SQL
  umask 077
  printf 'MORFA_TEST_DATABASE_URL=postgresql://morfa_test_admin_%s:%s@127.0.0.1:5450/morfa_test_control_%s\nMORFA_TEST_CLUSTER_ID=%s\nMORFA_TEST_CLUSTER_TOKEN=%s\nMORFA_TEST_ENDPOINT=127.0.0.1:5450\n' \
    "$id" "$adminpw" "$id" "$id" "$token" >"$state/cluster.env"
  chown morfa:morfa "$state/cluster.env"; chmod 600 "$state/cluster.env"
  log "bench cluster guard ready ($state/cluster.env)"
}

caddy() {
  step "Caddy $CADDY_VERSION (GitHub release, SHA-512 checked)"
  if ! probe test "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" = "v$CADDY_VERSION"; then
    local name="caddy_${CADDY_VERSION}_linux_amd64.tar.gz" url="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
    run_sh "set -e; cd /tmp && curl -fsSLO $url/$name && curl -fsSL $url/caddy_${CADDY_VERSION}_checksums.txt | grep ' $name\$' | sha512sum -c - && tar -xzf $name caddy && install -m 755 caddy /usr/local/bin/caddy && rm -f caddy $name"
  fi
  probe getent group caddy || run groupadd --system caddy
  probe id caddy || run useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
  run install -d -o caddy -g caddy -m 755 /etc/caddy /var/lib/caddy
  install_file "$SRC/deploy/systemd/caddy.service" /etc/systemd/system/caddy.service || true
  env_set "$ETC/caddy.env" MORFA_BENCH_IP "$BENCH_IP"
  # Quoted: systemd's EnvironmentFile and the shell both read it as one value.
  env_default "$ETC/caddy.env" MORFA_API_UPSTREAMS "127.0.0.1:3401 127.0.0.1:3402"
  env_default "$ETC/caddy.env" MORFA_COLLAB_A 127.0.0.1:3421
  env_default "$ETC/caddy.env" MORFA_COLLAB_B 127.0.0.1:3422
  env_default "$ETC/caddy.env" MORFA_APP_DIR /srv/morfa/current/dist/app
  probe grep -q 's3.bench.morfa' /etc/hosts || run_sh "echo '127.0.0.1 s3.bench.morfa' >>/etc/hosts"
  local changed=0
  install_file "$SRC/deploy/systemd/caddy.service.d/morfa.conf" /etc/systemd/system/caddy.service.d/morfa.conf && changed=1
  install_file "$SRC/deploy/caddy/morfa-routes.caddy" /etc/caddy/morfa-routes.caddy && changed=1
  install_file "$SRC/deploy/caddy/Caddyfile.bench" /etc/caddy/Caddyfile && changed=1
  run systemctl daemon-reload
  run_sh "set -a; . $ETC/caddy.env; set +a; out=\$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || { echo \"\$out\" >&2; exit 1; }"
  if [ $changed = 1 ]; then run systemctl restart caddy; fi
  run systemctl enable --now caddy
}

node_runtime() {
  step "Node $NODE_VERSION (nodejs.org, SHA-256 checked)"
  if probe test "$(/usr/local/bin/node -v 2>/dev/null)" = "v$NODE_VERSION"; then return 0; fi
  local name="node-v$NODE_VERSION-linux-x64" dir=/usr/local/lib/nodejs
  run_sh "set -e; cd /tmp && curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz && curl -fsSL https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt | grep ' $name.tar.xz\$' | sha256sum -c - && mkdir -p $dir && tar -xJf $name.tar.xz -C $dir && rm $name.tar.xz"
  for tool in node npm npx; do run ln -sfn "$dir/$name/bin/$tool" "/usr/local/bin/$tool"; done
}

rust() {
  step "rustup for morfa (the toolchain comes from rust-toolchain.toml on the first build)"
  if probe test -x /srv/morfa/.cargo/bin/rustup; then return 0; fi
  run_sh "sudo -u morfa -H sh -c 'curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain none --no-modify-path'"
}

minio() {
  step "MinIO $MINIO_RELEASE + mc, built from source (S3 stand-in until the operator's Timeweb bucket exists)"
  # MinIO no longer publishes binaries or images (dl.min.io answers 410 Gone, Docker Hub has no tags since late 2025): the last
  # community release is built here with Go from go.dev (checksum from go.dev's own index).
  if ! probe test -x /usr/local/bin/minio -a -x /usr/local/bin/mc; then
    if ! probe test "$(/usr/local/go/bin/go version 2>/dev/null | cut -d' ' -f3)" = "$GO_VERSION"; then
      run_sh "set -e; cd /tmp && curl -fsSLO https://go.dev/dl/$GO_VERSION.linux-amd64.tar.gz && echo \"\$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | jq -r '.[] | select(.version==\"$GO_VERSION\") | .files[] | select(.filename==\"$GO_VERSION.linux-amd64.tar.gz\") | .sha256')  $GO_VERSION.linux-amd64.tar.gz\" | sha256sum -c - && rm -rf /usr/local/go && tar -C /usr/local -xzf $GO_VERSION.linux-amd64.tar.gz && rm $GO_VERSION.linux-amd64.tar.gz"
    fi
    run_sh "set -e; export GOPATH=/root/go GOCACHE=/root/.cache/go-build GOFLAGS=-trimpath CGO_ENABLED=0; /usr/local/go/bin/go install github.com/minio/minio@$MINIO_RELEASE && /usr/local/go/bin/go install github.com/minio/mc@$MC_RELEASE && install -m 755 /root/go/bin/minio /root/go/bin/mc /usr/local/bin/"
  fi
  env_default "$ETC/minio.env" MINIO_ROOT_USER "root-$(secret 6)"
  env_default "$ETC/minio.env" MINIO_ROOT_PASSWORD "$(secret)"
  env_default "$ETC/minio.env" MINIO_SITE_REGION ru-1
  env_default "$ETC/minio.env" MINIO_PROMETHEUS_AUTH_TYPE public
  env_default "$ETC/minio.env" MINIO_BROWSER_REDIRECT_URL http://127.0.0.1:9001
  run chown minio:minio "$ETC/minio.env"
  install_file "$SRC/deploy/systemd/minio.service" /etc/systemd/system/minio.service || true
  run systemctl daemon-reload
  run systemctl enable --now minio
}

s3() {
  step "bucket $BUCKET (versioned), a service user, /etc/morfa/s3.env"
  env_default "$ETC/s3.env" S3_ENDPOINT http://127.0.0.1:9000
  env_default "$ETC/s3.env" S3_REGION ru-1
  env_default "$ETC/s3.env" S3_BUCKET "$BUCKET"
  env_default "$ETC/s3.env" S3_ACCESS_KEY "morfa-$(secret 8)"
  env_default "$ETC/s3.env" S3_SECRET_KEY "$(secret)"
  env_default "$ETC/s3.env" S3_KIND minio
  if [ "$DRY_RUN" = 1 ]; then printf '+ mc: alias, bucket %s, versioning, user + readwrite policy\n' "$BUCKET"; return 0; fi
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:9000/minio/health/live >/dev/null && break; sleep 1; done
  (
    set -a; . "$ETC/minio.env"; . "$ETC/s3.env"; set +a
    export MC_CONFIG_DIR=/root/.mc
    mc alias set bench http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing --region ru-1 "bench/$BUCKET" >/dev/null
    # Versioning keeps every checkpoint object (ckpt/) and backup file recoverable after an overwrite or a delete.
    mc version enable "bench/$BUCKET" >/dev/null
    mc admin user info bench "$S3_ACCESS_KEY" >/dev/null 2>&1 || mc admin user add bench "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
    mc admin policy attach bench readwrite --user "$S3_ACCESS_KEY" >/dev/null 2>&1 || true
  )
  log "bucket $BUCKET ready"
}

pgbackrest_setup() {
  step "pgBackRest → S3 (MinIO through Caddy's TLS front), WAL archive, stanza"
  local ca=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  if [ "$DRY_RUN" != 1 ]; then for _ in $(seq 1 30); do [ -f "$ca" ] && break; sleep 1; done; fi
  run install -d -o postgres -g postgres -m 750 /etc/pgbackrest
  run install -m 644 "$ca" /etc/pgbackrest/bench-ca.crt
  env_default "$ETC/backup.env" PGBACKREST_CIPHER_PASS "$(secret)"
  if [ "$DRY_RUN" = 1 ]; then printf '+ write /etc/pgbackrest/pgbackrest.conf (bench values); stanza-create; check\n'; return 0; fi
  (
    set -a; . "$ETC/s3.env"; . "$ETC/backup.env"; set +a
    umask 027
    cat >/etc/pgbackrest/pgbackrest.conf.new <<CONF
# bench-ru (scripts/deploy/remote/bench-ru.sh): the MinIO stand-in through Caddy's TLS front. Production: deploy/pgbackrest.
[global]
repo1-type=s3
repo1-s3-uri-style=path
repo1-s3-endpoint=s3.bench.morfa
repo1-storage-port=9443
repo1-storage-ca-file=/etc/pgbackrest/bench-ca.crt
repo1-s3-region=$S3_REGION
repo1-s3-bucket=$S3_BUCKET
repo1-s3-key=$S3_ACCESS_KEY
repo1-s3-key-secret=$S3_SECRET_KEY
repo1-path=/pgbackrest
repo1-retention-full=2
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PGBACKREST_CIPHER_PASS
compress-type=zst
compress-level=3
process-max=2
start-fast=y
archive-async=y
spool-path=/var/spool/pgbackrest
log-level-console=info
log-level-file=detail

[morfa]
pg1-path=/var/lib/postgresql/$PG/main
pg1-port=5432
CONF
    chown postgres:postgres /etc/pgbackrest/pgbackrest.conf.new
    mv /etc/pgbackrest/pgbackrest.conf.new /etc/pgbackrest/pgbackrest.conf
  )
  install -d -o postgres -g postgres -m 750 /var/spool/pgbackrest /var/log/pgbackrest
  sudo -u postgres pgbackrest --stanza=morfa stanza-create >/dev/null
  sudo -u postgres pgbackrest --stanza=morfa check >/dev/null
  install_file "$SRC/deploy/systemd/morfa-backup.service" /etc/systemd/system/morfa-backup.service || true
  install_file "$SRC/deploy/systemd/morfa-backup.timer" /etc/systemd/system/morfa-backup.timer || true
  systemctl daemon-reload
  systemctl enable --now morfa-backup.timer
  log "pgBackRest stanza morfa checked (WAL archive works)"
}

systemd_units() {
  step "Morfa units, slice, environment files"
  for unit in morfa.slice morfa.target morfa-api@.service morfa-worker.service morfa-collab@.service morfa-render.service; do
    install_file "$SRC/deploy/systemd/$unit" "/etc/systemd/system/$unit" || true
  done
  run systemctl daemon-reload
  # Secrets for api and collab, generated here (never in the repository): the internal secret and the ticket key pair.
  env_default "$ETC/collab-secrets.env" INTERNAL_SECRET "$(secret)"
  if [ -z "$(env_get "$ETC/collab-secrets.env" TICKET_PRIVATE_KEY)" ] && [ "$DRY_RUN" != 1 ]; then
    local der; der=$(mktemp)
    openssl genpkey -algorithm ed25519 -outform DER -out "$der" 2>/dev/null
    env_set "$ETC/collab-secrets.env" TICKET_PRIVATE_KEY "$(tail -c 32 "$der" | base64 | tr '+/' '-_' | tr -d '=\n')"
    env_set "$ETC/collab-secrets.env" TICKET_PUBLIC_KEY "$(openssl pkey -inform DER -in "$der" -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
    shred -u "$der"
  fi
  if [ "$DRY_RUN" = 1 ]; then printf '+ write /etc/morfa/{api,collab,collab-a,collab-b}.env from db.env, s3.env, collab-secrets.env\n'; return 0; fi
  (
    set -a; . "$ETC/db.env"; . "$ETC/s3.env"; . "$ETC/collab-secrets.env"; set +a
    # api in production mode verifies TLS even on loopback (server/postgresql/config.ts); collab's crates/journal speaks plain
    # TCP (tokio-postgres NoTls), which loopback or the private network carries.
    local db="127.0.0.1:5432/morfa?sslmode=verify-full" plain="127.0.0.1:5432/morfa?sslmode=disable" origin="https://$BENCH_IP"
    local api=$ETC/api.env collab=$ETC/collab.env
    env_set "$api" APP_ORIGIN "$origin"
    env_set "$api" TRUST_PROXY 1
    env_set "$api" DATA_DIR /srv/morfa/data
    env_set "$api" MORFA_DATABASE_URL "postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$db"
    env_set "$api" MORFA_MIGRATION_DATABASE_URL "postgresql://morfa_migration:$MORFA_DB_MIGRATION_PASSWORD@$db"
    env_set "$api" MORFA_BACKUP_DATABASE_URL "postgresql://morfa_backup:$MORFA_DB_BACKUP_PASSWORD@$db"
    env_set "$api" MORFA_DATABASE_CA_CERT_FILE "$ETC/pg-ca.crt"
    env_set "$api" MORFA_DATABASE_POOL_MAX 20
    env_set "$api" DESIGN_LIVE_FANOUT postgres
    # bench-ru's public socket bases go through Caddy's plain-HTTP site (the drill client and loadgen speak ws://).
    env_set "$api" DESIGN_COLLAB_NODES "a=http://127.0.0.1:3421|ws://$BENCH_IP/n/a,b=http://127.0.0.1:3422|ws://$BENCH_IP/n/b"
    env_default "$api" DESIGN_COLLAB rust
    env_set "$api" DESIGN_COLLAB_INTERNAL_SECRET "$INTERNAL_SECRET"
    env_set "$api" DESIGN_COLLAB_TICKET_KEY "$TICKET_PRIVATE_KEY"
    env_set "$api" DESIGN_BLOBS s3
    env_set "$api" DESIGN_S3_ENDPOINT "$S3_ENDPOINT"
    env_set "$api" DESIGN_S3_REGION "$S3_REGION"
    env_set "$api" DESIGN_S3_BUCKET "$S3_BUCKET"
    env_set "$api" DESIGN_S3_ACCESS_KEY "$S3_ACCESS_KEY"
    env_set "$api" DESIGN_S3_SECRET_KEY "$S3_SECRET_KEY"
    env_set "$api" OTEL_EXPORTER_OTLP_ENDPOINT http://127.0.0.1:4318
    env_set "$api" OTEL_SERVICE_NAME morfa-api
    env_set "$collab" MORFA_COLLAB_TICKET_KEY "$TICKET_PUBLIC_KEY"
    env_set "$collab" MORFA_COLLAB_INTERNAL_SECRET "$INTERNAL_SECRET"
    env_set "$collab" MORFA_COLLAB_API_URL http://127.0.0.1:3401
    env_set "$collab" MORFA_COLLAB_ORIGINS "$origin,http://$BENCH_IP"
    env_set "$collab" MORFA_COLLAB_PG_URL "postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$plain"
    env_set "$collab" MORFA_COLLAB_S3_ENDPOINT "$S3_ENDPOINT"
    env_set "$collab" MORFA_COLLAB_S3_REGION "$S3_REGION"
    env_set "$collab" MORFA_COLLAB_S3_BUCKET "$S3_BUCKET"
    env_set "$collab" MORFA_COLLAB_S3_ACCESS_KEY "$S3_ACCESS_KEY"
    env_set "$collab" MORFA_COLLAB_S3_SECRET_KEY "$S3_SECRET_KEY"
    env_set "$collab" MORFA_COLLAB_DRAIN_NOTICE_MS 2500
    env_set "$collab" MORFA_COLLAB_DRAIN_TIMEOUT_MS 25000
    env_set "$collab" OTEL_EXPORTER_OTLP_ENDPOINT http://127.0.0.1:4318
    env_set "$collab" MORFA_TRACE_SAMPLE 0.01
    env_set "$collab" MORFA_TRACE_SLOW_MS 20
    env_set "$collab" RUST_LOG info
    for node in a b; do
      local port=3421; [ $node = b ] && port=3422
      env_set "$ETC/collab-$node.env" MORFA_COLLAB_NODE "$node"
      env_set "$ETC/collab-$node.env" MORFA_COLLAB_ADDR "127.0.0.1:$port"
    done
  )
  # Readable by the services' group only; systemd reads them as root.
  run_sh "chown root:morfa $ETC/*.env && chmod 640 $ETC/api.env $ETC/collab.env $ETC/collab-a.env $ETC/collab-b.env && chmod 600 $ETC/db.env $ETC/collab-secrets.env $ETC/s3.env $ETC/backup.env"
  run systemctl enable morfa.target
}

observability() {
  step "observability compose (Prometheus, Grafana, Tempo, Loki, Alloy, exporters) — 127.0.0.1 only"
  if ! probe test -f /etc/docker/daemon.json; then
    # Docker Hub through Timeweb's mirror (fast from MSK-1); Docker Hub itself stays the fallback.
    run_sh "mkdir -p /etc/docker && printf '{\"registry-mirrors\": [\"https://dockerhub.timeweb.cloud\"], \"log-driver\": \"json-file\", \"log-opts\": {\"max-size\": \"20m\"}}\n' >/etc/docker/daemon.json && systemctl restart docker"
  fi
  run systemctl enable --now docker
  run rsync -a --delete "$SRC/deploy/observability/" /srv/morfa/observability/
  env_default "$ETC/observability.env" GF_SECURITY_ADMIN_USER admin
  env_default "$ETC/observability.env" GF_SECURITY_ADMIN_PASSWORD "$(secret 16)"
  env_default "$ETC/observability.env" OBS_CPUSET 4-7
  if [ "$DRY_RUN" != 1 ]; then
    env_set "$ETC/observability.env" DATA_SOURCE_NAME "postgresql://morfa_monitor:$(env_get "$ETC/db.env" MORFA_DB_MONITOR_PASSWORD)@127.0.0.1:5432/morfa?sslmode=disable"
  fi
  run chmod 600 "$ETC/observability.env"
  run_sh "cd /srv/morfa/observability && docker compose --env-file $ETC/observability.env up -d --quiet-pull --remove-orphans"
}

firewall() {
  step "ufw: 22, 80, 443 for everyone; 3400-3499 (bench servers) and 5201 (iperf3) from ru-net only; 10050 from Timeweb's monitoring"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ ufw default deny incoming; allow 22,80,443; allow from %s to 3400:3499,5201; zabbix servers to 10050; ufw --force enable\n' "$RUNET_IP"
    return 0
  fi
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  # 22 first: the session that runs this must survive the enable.
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow from "$RUNET_IP" to any port 3400:3499 proto tcp >/dev/null
  ufw allow from "$RUNET_IP" to any port 5201 proto tcp >/dev/null
  for server in $(zabbix_servers); do ufw allow from "$server" to any port 10050 proto tcp >/dev/null; done
  ufw --force enable >/dev/null
  ufw status verbose | sed -n '1,40p' >&2
}

summary() {
  step "summary"
  [ "$DRY_RUN" = 1 ] && return 0
  {
    echo "postgresql: $(systemctl is-active postgresql@$PG-main) main, $(systemctl is-active postgresql@$PG-bench) bench"
    echo "caddy: $(systemctl is-active caddy); minio: $(systemctl is-active minio); docker: $(systemctl is-active docker)"
    echo "node: $(/usr/local/bin/node -v); rustup: $([ -x /srv/morfa/.cargo/bin/rustup ] && echo yes)"
    echo "morfa ssh key: $(cat /srv/morfa/.ssh/id_ed25519.pub)"
  } >&2
}

ALL=(base users pg pgbench pgtls caddy node rust minio s3 pgbackrest systemd observability ssh firewall summary)
steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=("${ALL[@]}")
for name in "${steps[@]}"; do
  case $name in
    base) base ;;
    users) users ;;
    pg) pg ;;
    pgbench) pgbench_cluster ;;
    pgtls) pg_tls ;;
    dbrotate) db_rotate ;;
    caddy) caddy ;;
    node) node_runtime ;;
    rust) rust ;;
    minio) minio ;;
    s3) s3 ;;
    pgbackrest) pgbackrest_setup ;;
    systemd) systemd_units ;;
    observability) observability ;;
    ssh) harden_ssh ;;
    firewall) firewall ;;
    summary) summary ;;
    *) echo "unknown step $name (steps: ${ALL[*]})" >&2; exit 2 ;;
  esac
done

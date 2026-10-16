#!/usr/bin/env bash
# Production provisioning for morfa.example, run as root ON each VM by
# scripts/deploy/provision-prod.sh, which copies deploy/ and scripts/deploy/remote/ to $SRC first. Idempotent (a second run changes
# nothing); DRY_RUN=1 prints every command instead. The operator runs it.
#
#   ROLE=db  APP_PRIVATE_IP=<ip> DB_PRIVATE_IP=<ip> [REPLICA_PRIVATE_IP=<ip>] SRC=… bash prod.sh [step…]   ru-db (PostgreSQL)
#   ROLE=app APP_PRIVATE_IP=<ip> DB_PRIVATE_IP=<ip> SRC=… bash prod.sh [step…]                            ru-4 (everything else)
#
# db steps:  base pg pgtls pgbackrest observability ssh firewall summary
# app steps: base users node rust caddy secrets env systemd ssh firewall summary
#
# The operator's inputs, put on the VMs before the first run (mode 600; never in the repository):
#   app  /etc/morfa/s3.env         S3_ENDPOINT=https://s3.timeweb.cloud S3_REGION=ru-1 S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY (services)
#   app  /etc/morfa/caddy.env      MORFA_ACME_EMAIL (the names default to morfa.example / app.morfa.example)
#   db   /etc/morfa/backup-s3.env  the same five for pgBackRest's own key (prefix pgbackrest/)
# Generated on the VMs: the database roles' passwords (db: /etc/morfa/db.env, carried to the app VM by provision-prod.sh without
# being printed, with the database's CA certificate), the collab internal secret, the ticket key pair, the render secret, the
# pgBackRest cipher pass (db: /etc/morfa/backup.env — the operator keeps a copy offline: without it no backup can be read).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

: "${ROLE:?ROLE=app|db}"
: "${APP_PRIVATE_IP:?APP_PRIVATE_IP}"
: "${DB_PRIVATE_IP:?DB_PRIVATE_IP}"
REPLICA_PRIVATE_IP=${REPLICA_PRIVATE_IP:-}
SRC=${SRC:-/root/morfa-provision}
NODE_VERSION=22.23.2
CADDY_VERSION=2.11.7
PG=18
ETC=/etc/morfa
for ip in "$APP_PRIVATE_IP" "$DB_PRIVATE_IP" $REPLICA_PRIVATE_IP; do
  [[ $ip =~ ^(10|172|192)\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a private IPv4 address: $ip" >&2; exit 2; }
done

base() {
  step "base packages, security upgrades (no automatic reboot; PostgreSQL waits for a maintenance window), sysctl"
  run apt-get update -q
  local packages=(ca-certificates curl gnupg jq zstd xz-utils git ufw chrony acl rsync openssl unattended-upgrades postgresql-common)
  [ "$ROLE" = app ] && packages+=(build-essential pkg-config libssl-dev)
  [ "$ROLE" = db ] && packages+=(docker.io docker-compose-v2)
  apt_install "${packages[@]}"
  local text='// Morfa production (scripts/deploy/remote/prod.sh): security updates daily, never a reboot or a PostgreSQL restart unasked.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Package-Blacklist { "postgresql-"; "pgbackrest"; "caddy"; };
'
  if ! probe test "$(cat /etc/apt/apt.conf.d/52morfa 2>/dev/null)" = "$text"; then
    run_sh "printf '%s' '$text' >/etc/apt/apt.conf.d/52morfa"
    run_sh "printf 'APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n' >/etc/apt/apt.conf.d/20auto-upgrades"
  fi
  sysctl_tuning
  run timedatectl set-timezone Europe/Moscow
}

# ---------------------------------------------------------------- database VM
pg() {
  step "PostgreSQL $PG (PGDG): deploy/postgresql/morfa.conf, listening on loopback and $DB_PRIVATE_IP"
  if ! probe test -f /etc/apt/sources.list.d/pgdg.sources -o -f /etc/apt/sources.list.d/pgdg.list; then
    run /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  fi
  apt_install "postgresql-$PG" "postgresql-client-$PG" pgbackrest
  local changed=0
  install_file "$SRC/deploy/postgresql/morfa.conf" "/etc/postgresql/$PG/main/conf.d/morfa.conf" 644 postgres:postgres && changed=1
  # A dedicated 16 GB VM: a quarter of RAM for shared_buffers (scripts/deploy/pg-primary.md "Sizes").
  local text="listen_addresses = '127.0.0.1,$DB_PRIVATE_IP'
shared_buffers = 4GB
effective_cache_size = 11GB
"
  if ! probe test "$(cat "/etc/postgresql/$PG/main/conf.d/zz-prod.conf" 2>/dev/null)" = "$text"; then
    run_sh "printf '%s' \"$text\" >/etc/postgresql/$PG/main/conf.d/zz-prod.conf && chown postgres:postgres /etc/postgresql/$PG/main/conf.d/zz-prod.conf"
    changed=1
  fi
  # The app VM only, over the private network: api over verified TLS; collab's journal has no TLS (crates/journal NoTls), so the
  # runtime role also gets a plain line from that one address (SCRAM never sends the password). The replica: replication only.
  local hba="/etc/postgresql/$PG/main/pg_hba.conf"
  local lines="# Morfa (scripts/deploy/remote/prod.sh)
hostssl morfa morfa_runtime,morfa_migration,morfa_backup $APP_PRIVATE_IP/32 scram-sha-256
host    morfa morfa_runtime $APP_PRIVATE_IP/32 scram-sha-256"
  [ -n "$REPLICA_PRIVATE_IP" ] && lines="$lines
hostssl replication morfa_replication $REPLICA_PRIVATE_IP/32 scram-sha-256"
  if ! probe grep -qF "host    morfa morfa_runtime $APP_PRIVATE_IP/32" "$hba"; then
    run_sh "sed -i '/^# Morfa (scripts\/deploy\/remote\/prod.sh)/,\$d' $hba && printf '%s\n' \"$lines\" >>$hba"
    changed=1
  fi
  run systemctl daemon-reload
  if [ $changed = 1 ]; then run systemctl restart "postgresql@$PG-main"; fi
  run systemctl enable --now "postgresql@$PG-main"
  env_default "$ETC/db.env" MORFA_DB_MIGRATION_PASSWORD "$(secret)"
  env_default "$ETC/db.env" MORFA_DB_RUNTIME_PASSWORD "$(secret)"
  env_default "$ETC/db.env" MORFA_DB_BACKUP_PASSWORD "$(secret)"
  env_default "$ETC/db.env" MORFA_DB_MONITOR_PASSWORD "$(secret)"
  [ -n "$REPLICA_PRIVATE_IP" ] && env_default "$ETC/db.env" MORFA_DB_REPLICATION_PASSWORD "$(secret)"
  run chmod 600 "$ETC/db.env"
  if [ "$DRY_RUN" = 1 ] || [ "$(cd /tmp && sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='morfa_runtime'" -d postgres)" != 1 ]; then
    run_sh "set -a; . $ETC/db.env; set +a; cd /tmp && install -m 644 $SRC/deploy/postgres/init-roles.sh /tmp/morfa-init-roles.sh && sudo -u postgres --preserve-env=MORFA_DB_MIGRATION_PASSWORD,MORFA_DB_RUNTIME_PASSWORD,MORFA_DB_BACKUP_PASSWORD env POSTGRES_USER=postgres sh /tmp/morfa-init-roles.sh; status=\$?; rm -f /tmp/morfa-init-roles.sh; exit \$status"
    run_sh "set -a; . $ETC/db.env; set +a; cd /tmp && sudo -u postgres psql -q -d postgres -v ON_ERROR_STOP=1 -v pw=\"\$MORFA_DB_MONITOR_PASSWORD\" -c \"CREATE ROLE morfa_monitor LOGIN IN ROLE pg_monitor PASSWORD :'pw'\" -c 'GRANT CONNECT ON DATABASE morfa TO morfa_monitor' -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'"
  fi
  if [ -n "$REPLICA_PRIVATE_IP" ]; then
    run_sh "set -a; . $ETC/db.env; set +a; cd /tmp && sudo -u postgres psql -q -d postgres -v pw=\"\$MORFA_DB_REPLICATION_PASSWORD\" -c \"DO \\\$\\\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='morfa_replication') THEN CREATE ROLE morfa_replication REPLICATION LOGIN; END IF; END\\\$\\\$\" -c \"ALTER ROLE morfa_replication PASSWORD :'pw'\" -c \"SELECT pg_create_physical_replication_slot('replica1') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='replica1')\""
    log "replica: follow scripts/deploy/pg-replica.md on $REPLICA_PRIVATE_IP (MORFA_DB_REPLICATION_PASSWORD in $ETC/db.env)"
  fi
}

pg_tls() {
  step "PostgreSQL TLS: a CA of this VM, a server certificate for $DB_PRIVATE_IP (api: sslmode=verify-full + /etc/morfa/pg-ca.crt)"
  local dir=$ETC/pg-tls
  if ! probe test -f "$dir/server.crt"; then
    run install -d -m 700 "$dir"
    run_sh "set -e; cd $dir && openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=Morfa PostgreSQL CA' -keyout ca.key -out ca.crt 2>/dev/null \
      && openssl req -newkey rsa:2048 -nodes -subj '/CN=$DB_PRIVATE_IP' -keyout server.key -out server.csr 2>/dev/null \
      && printf 'subjectAltName=IP:$DB_PRIVATE_IP,IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' >ext.cnf \
      && openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile ext.cnf -out server.crt 2>/dev/null"
  fi
  run install -m 644 "$dir/ca.crt" "$ETC/pg-ca.crt"
  run install -m 600 -o postgres -g postgres "$dir/server.crt" /etc/postgresql/morfa-server.crt
  run install -m 600 -o postgres -g postgres "$dir/server.key" /etc/postgresql/morfa-server.key
  local text="ssl = on
ssl_cert_file = '/etc/postgresql/morfa-server.crt'
ssl_key_file = '/etc/postgresql/morfa-server.key'
"
  if ! probe test "$(cat "/etc/postgresql/$PG/main/conf.d/zz-tls.conf" 2>/dev/null)" = "$text"; then
    run_sh "printf '%s' \"$text\" >/etc/postgresql/$PG/main/conf.d/zz-tls.conf && chown postgres:postgres /etc/postgresql/$PG/main/conf.d/zz-tls.conf"
    run systemctl restart "postgresql@$PG-main"
  fi
}

pgbackrest_setup() {
  step "pgBackRest → Timeweb S3 (WAL archive, nightly full backup at 03:30, two kept), stanza check"
  probe test -s "$ETC/backup-s3.env" || [ "$DRY_RUN" = 1 ] || { log "$ETC/backup-s3.env is missing: the operator writes pgBackRest's S3 key there first"; return 1; }
  env_default "$ETC/backup.env" PGBACKREST_CIPHER_PASS "$(secret)"
  run chmod 600 "$ETC/backup.env"
  if [ "$DRY_RUN" = 1 ]; then printf '+ write /etc/pgbackrest/pgbackrest.conf (deploy/pgbackrest/pgbackrest.conf.example + backup-s3.env); stanza-create; check; timer\n'; return 0; fi
  (
    set -a; . "$ETC/backup-s3.env"; . "$ETC/backup.env"; set +a
    install -d -o postgres -g postgres -m 750 /etc/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest
    umask 027
    sed -e "s#^repo1-s3-endpoint=.*#repo1-s3-endpoint=${S3_ENDPOINT#https://}#" -e "s#^repo1-s3-region=.*#repo1-s3-region=$S3_REGION#" \
      -e "s#^repo1-s3-bucket=.*#repo1-s3-bucket=$S3_BUCKET#" -e "s#^repo1-s3-key=.*#repo1-s3-key=$S3_ACCESS_KEY#" \
      -e "s#^repo1-s3-key-secret=.*#repo1-s3-key-secret=$S3_SECRET_KEY#" -e "s#^repo1-cipher-pass=.*#repo1-cipher-pass=$PGBACKREST_CIPHER_PASS#" \
      -e "s#^pg1-path=.*#pg1-path=/var/lib/postgresql/$PG/main#" \
      "$SRC/deploy/pgbackrest/pgbackrest.conf.example" | grep -v '^# /etc/pgbackrest' >/etc/pgbackrest/pgbackrest.conf.new
    chown postgres:postgres /etc/pgbackrest/pgbackrest.conf.new
    mv /etc/pgbackrest/pgbackrest.conf.new /etc/pgbackrest/pgbackrest.conf
  )
  grep -q CHANGE_ME /etc/pgbackrest/pgbackrest.conf && { log "pgbackrest.conf still has a placeholder: check $ETC/backup-s3.env"; return 1; }
  sudo -u postgres pgbackrest --stanza=morfa stanza-create >/dev/null
  sudo -u postgres pgbackrest --stanza=morfa check >/dev/null
  install_file "$SRC/deploy/systemd/morfa-backup.service" /etc/systemd/system/morfa-backup.service || true
  install_file "$SRC/deploy/systemd/morfa-backup.timer" /etc/systemd/system/morfa-backup.timer || true
  systemctl daemon-reload
  systemctl enable --now morfa-backup.timer
  log "WAL archive works; the first full backup: systemctl start morfa-backup"
}

observability() {
  step "observability compose on this VM (127.0.0.1 only; Prometheus also scrapes the app VM at $APP_PRIVATE_IP)"
  if ! probe test -f /etc/docker/daemon.json; then
    run_sh "mkdir -p /etc/docker && printf '{\"registry-mirrors\": [\"https://dockerhub.timeweb.cloud\"], \"log-driver\": \"json-file\", \"log-opts\": {\"max-size\": \"20m\"}}\n' >/etc/docker/daemon.json && systemctl restart docker"
  fi
  run systemctl enable --now docker
  run rsync -a --delete "$SRC/deploy/observability/" /srv/morfa-observability/
  # Two VMs: Prometheus reads the app VM's services through its private metrics site (deploy/caddy/morfa-metrics.caddy), and
  # Tempo takes the app VM's spans on this VM's private address (ufw: from the app VM only).
  run_sh "sed 's/APP_PRIVATE_IP/$APP_PRIVATE_IP/g' /srv/morfa-observability/prometheus/prometheus.split.yml >/srv/morfa-observability/prometheus/prometheus.yml"
  run_sh "sed -i 's/endpoint: 127.0.0.1:4318/endpoint: $DB_PRIVATE_IP:4318/' /srv/morfa-observability/tempo/tempo.yaml"
  env_default "$ETC/observability.env" GF_SECURITY_ADMIN_USER admin
  env_default "$ETC/observability.env" GF_SECURITY_ADMIN_PASSWORD "$(secret 16)"
  env_default "$ETC/observability.env" OBS_CPUSET 0-3
  if [ "$DRY_RUN" != 1 ]; then
    env_set "$ETC/observability.env" DATA_SOURCE_NAME "postgresql://morfa_monitor:$(env_get "$ETC/db.env" MORFA_DB_MONITOR_PASSWORD)@127.0.0.1:5432/morfa?sslmode=disable"
  fi
  run chmod 600 "$ETC/observability.env"
  run_sh "cd /srv/morfa-observability && docker compose --env-file $ETC/observability.env up -d --quiet-pull --remove-orphans"
}

# ---------------------------------------------------------------- app VM
users() {
  step "the morfa user and its directories"
  probe id morfa || run useradd --system --create-home --home-dir /srv/morfa --shell /bin/bash morfa
  run install -d -o morfa -g morfa -m 755 /srv/morfa /srv/morfa/releases /srv/morfa/cache /srv/morfa/target /srv/morfa/downloads /srv/morfa/updates
  run install -d -o morfa -g morfa -m 750 /srv/morfa/data
  run install -d -o root -g morfa -m 750 "$ETC"
}

node_runtime() {
  step "Node $NODE_VERSION (nodejs.org, SHA-256 checked)"
  if probe test "$(/usr/local/bin/node -v 2>/dev/null)" = "v$NODE_VERSION"; then return 0; fi
  local name="node-v$NODE_VERSION-linux-x64" dir=/usr/local/lib/nodejs
  run_sh "set -e; cd /tmp && curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz && curl -fsSL https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt | grep ' $name.tar.xz\$' | sha256sum -c - && mkdir -p $dir && tar -xJf $name.tar.xz -C $dir && rm $name.tar.xz"
  for tool in node npm npx; do run ln -sfn "$dir/$name/bin/$tool" "/usr/local/bin/$tool"; done
}

rust() {
  step "rustup for morfa (release.sh builds on this VM; the toolchain comes from rust-toolchain.toml)"
  if probe test -x /srv/morfa/.cargo/bin/rustup; then return 0; fi
  run_sh "sudo -u morfa -H sh -c 'curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain none --no-modify-path'"
}

caddy() {
  step "Caddy $CADDY_VERSION (GitHub release, SHA-512 checked): morfa.example sites by ACME (deploy/caddy/Caddyfile.morfa)"
  if ! probe test "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" = "v$CADDY_VERSION"; then
    local name="caddy_${CADDY_VERSION}_linux_amd64.tar.gz" url="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
    run_sh "set -e; cd /tmp && curl -fsSLO $url/$name && curl -fsSL $url/caddy_${CADDY_VERSION}_checksums.txt | grep ' $name\$' | sha512sum -c - && tar -xzf $name caddy && install -m 755 caddy /usr/local/bin/caddy && rm -f caddy $name"
  fi
  probe getent group caddy || run groupadd --system caddy
  probe id caddy || run useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
  run install -d -o caddy -g caddy -m 755 /etc/caddy /var/lib/caddy
  install_file "$SRC/deploy/systemd/caddy.service" /etc/systemd/system/caddy.service || true
  [ -n "$(env_get "$ETC/caddy.env" MORFA_ACME_EMAIL)" ] || [ "$DRY_RUN" = 1 ] || { log "$ETC/caddy.env: MORFA_ACME_EMAIL is not set (the operator's)"; return 1; }
  env_default "$ETC/caddy.env" MORFA_DOMAIN app.morfa.example
  env_default "$ETC/caddy.env" MORFA_MARKETING_DOMAIN morfa.example
  env_default "$ETC/caddy.env" MORFA_API_UPSTREAMS "127.0.0.1:3401 127.0.0.1:3402"
  env_default "$ETC/caddy.env" MORFA_COLLAB_A 127.0.0.1:3421
  env_default "$ETC/caddy.env" MORFA_COLLAB_B 127.0.0.1:3422
  env_default "$ETC/caddy.env" MORFA_APP_DIR /srv/morfa/current/dist/app
  env_default "$ETC/caddy.env" MORFA_DOWNLOADS_DIR /srv/morfa/downloads
  env_default "$ETC/caddy.env" MORFA_UPDATES_DIR /srv/morfa/updates
  env_set "$ETC/caddy.env" MORFA_METRICS_BIND "$APP_PRIVATE_IP"
  local changed=0
  install_file "$SRC/deploy/systemd/caddy.service.d/morfa.conf" /etc/systemd/system/caddy.service.d/morfa.conf && changed=1
  install_file "$SRC/deploy/caddy/morfa-routes.caddy" /etc/caddy/morfa-routes.caddy && changed=1
  install_file "$SRC/deploy/caddy/morfa-sites.caddy" /etc/caddy/morfa-sites.caddy && changed=1
  install_file "$SRC/deploy/caddy/morfa-metrics.caddy" /etc/caddy/morfa-metrics.caddy && changed=1
  install_file "$SRC/deploy/caddy/Caddyfile.morfa" /etc/caddy/Caddyfile && changed=1
  run systemctl daemon-reload
  run_sh "set -a; . $ETC/caddy.env; set +a; out=\$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || { echo \"\$out\" >&2; exit 1; }"
  # Caddy asks ACME for every name at start: only once the DNS records point here.
  local ip; ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  if [ "$DRY_RUN" != 1 ] && [ "$(getent ahostsv4 "$(env_get "$ETC/caddy.env" MORFA_DOMAIN)" | awk 'NR==1{print $1}')" != "$ip" ]; then
    log "DNS: $(env_get "$ETC/caddy.env" MORFA_DOMAIN) does not point at this VM yet: Caddy is installed but not started"
    return 0
  fi
  if [ $changed = 1 ]; then run systemctl restart caddy; fi
  run systemctl enable --now caddy
}

secrets() {
  step "generated secrets: collab's internal secret, the ticket key pair, the render secret ($ETC/app-secrets.env)"
  local file=$ETC/app-secrets.env
  env_default "$file" COLLAB_INTERNAL_SECRET "$(secret)"
  env_default "$file" RENDER_SECRET "$(secret)"
  if [ -z "$(env_get "$file" TICKET_PRIVATE_KEY)" ] && [ "$DRY_RUN" != 1 ]; then
    local der; der=$(mktemp)
    openssl genpkey -algorithm ed25519 -outform DER -out "$der" 2>/dev/null
    env_set "$file" TICKET_PRIVATE_KEY "$(tail -c 32 "$der" | base64 | tr '+/' '-_' | tr -d '=\n')"
    env_set "$file" TICKET_PUBLIC_KEY "$(openssl pkey -inform DER -in "$der" -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
    shred -u "$der"
  fi
  run chmod 600 "$file"
}

env_files() {
  step "/etc/morfa/{api,collab,collab-a,collab-b,render,build}.env from db.env, s3.env, app-secrets.env (values never printed)"
  if [ "$DRY_RUN" = 1 ]; then printf '+ write the env files (deploy/env/*.example with production values)\n'; return 0; fi
  for need in db.env s3.env pg-ca.crt app-secrets.env; do
    [ -s "$ETC/$need" ] || { log "$ETC/$need is missing (db.env and pg-ca.crt come from the database VM: provision-prod.sh carries them)"; return 1; }
  done
  (
    set -a; . "$ETC/db.env"; . "$ETC/s3.env"; . "$ETC/app-secrets.env"; set +a
    local db="$DB_PRIVATE_IP:5432/morfa?sslmode=verify-full" plain="$DB_PRIVATE_IP:5432/morfa?sslmode=disable"
    local origin=https://app.morfa.example api=$ETC/api.env collab=$ETC/collab.env render=$ETC/render.env
    env_set "$api" APP_ORIGIN "$origin"
    env_set "$api" TRUST_PROXY 1
    env_set "$api" DATA_DIR /srv/morfa/data
    env_set "$api" MORFA_DATABASE_URL "postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$db"
    env_set "$api" MORFA_MIGRATION_DATABASE_URL "postgresql://morfa_migration:$MORFA_DB_MIGRATION_PASSWORD@$db"
    env_set "$api" MORFA_BACKUP_DATABASE_URL "postgresql://morfa_backup:$MORFA_DB_BACKUP_PASSWORD@$db"
    env_set "$api" MORFA_DATABASE_CA_CERT_FILE "$ETC/pg-ca.crt"
    env_set "$api" MORFA_DATABASE_POOL_MAX 20
    env_set "$api" DESIGN_LIVE_FANOUT postgres
    env_set "$api" DESIGN_COLLAB_NODES "a=http://127.0.0.1:3421|wss://collab-a.morfa.example,b=http://127.0.0.1:3422|wss://collab-b.morfa.example"
    # The launch values; env_default: a later flip by host.sh collab survives a re-run.
    env_default "$api" DESIGN_COLLAB legacy
    env_default "$api" DESIGN_SERVER_LAYOUT 0
    env_default "$api" DESIGN_BIG_FILES 0
    env_set "$api" DESIGN_COLLAB_INTERNAL_SECRET "$COLLAB_INTERNAL_SECRET"
    env_set "$api" DESIGN_COLLAB_TICKET_KEY "$TICKET_PRIVATE_KEY"
    env_set "$api" DESIGN_BLOBS s3
    env_set "$api" DESIGN_S3_ENDPOINT "$S3_ENDPOINT"
    env_set "$api" DESIGN_S3_REGION "$S3_REGION"
    env_set "$api" DESIGN_S3_BUCKET "$S3_BUCKET"
    env_set "$api" DESIGN_S3_ACCESS_KEY "$S3_ACCESS_KEY"
    env_set "$api" DESIGN_S3_SECRET_KEY "$S3_SECRET_KEY"
    env_set "$api" ENABLE_DESIGN_PDF_EXPORT 1
    env_default "$api" DESIGN_PDF_ENGINE service
    env_set "$api" DESIGN_RENDER_URL http://127.0.0.1:3440
    env_set "$api" DESIGN_RENDER_SECRET "$RENDER_SECRET"
    env_set "$api" OTEL_EXPORTER_OTLP_ENDPOINT "http://$DB_PRIVATE_IP:4318"
    env_set "$api" OTEL_SERVICE_NAME morfa-api
    env_set "$collab" MORFA_COLLAB_TICKET_KEY "$TICKET_PUBLIC_KEY"
    env_set "$collab" MORFA_COLLAB_INTERNAL_SECRET "$COLLAB_INTERNAL_SECRET"
    env_set "$collab" MORFA_COLLAB_API_URL http://127.0.0.1:3401
    env_set "$collab" MORFA_COLLAB_ORIGINS "$origin"
    env_set "$collab" MORFA_COLLAB_PG_URL "postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$plain"
    env_set "$collab" MORFA_COLLAB_S3_ENDPOINT "$S3_ENDPOINT"
    env_set "$collab" MORFA_COLLAB_S3_REGION "$S3_REGION"
    env_set "$collab" MORFA_COLLAB_S3_BUCKET "$S3_BUCKET"
    env_set "$collab" MORFA_COLLAB_S3_ACCESS_KEY "$S3_ACCESS_KEY"
    env_set "$collab" MORFA_COLLAB_S3_SECRET_KEY "$S3_SECRET_KEY"
    env_default "$collab" MORFA_COLLAB_SHARDS 3
    env_default "$collab" MORFA_COLLAB_MEMORY_LIMIT_MB 6144
    env_default "$collab" MORFA_BIG_FILES 0
    env_set "$collab" MORFA_COLLAB_DRAIN_NOTICE_MS 2500
    env_set "$collab" MORFA_COLLAB_DRAIN_TIMEOUT_MS 25000
    env_set "$collab" OTEL_EXPORTER_OTLP_ENDPOINT "http://$DB_PRIVATE_IP:4318"
    env_set "$collab" MORFA_TRACE_SAMPLE 0.01
    env_set "$collab" MORFA_TRACE_SLOW_MS 20
    env_set "$collab" RUST_LOG info
    for node in a b; do
      local port=3421; [ $node = b ] && port=3422
      env_set "$ETC/collab-$node.env" MORFA_COLLAB_NODE "$node"
      env_set "$ETC/collab-$node.env" MORFA_COLLAB_ADDR "127.0.0.1:$port"
    done
    env_set "$render" MORFA_RENDER_ADDR 127.0.0.1:3440
    env_set "$render" MORFA_RENDER_INTERNAL_SECRET "$RENDER_SECRET"
    env_set "$render" MORFA_RENDER_FONTS_DIR /srv/morfa/current/public/fonts
    env_default "$render" MORFA_RENDER_WORKERS 4
    env_set "$render" RUST_LOG info
    env_set "$ETC/build.env" VITE_APP_ORIGIN "$origin"
  )
  run_sh "chown root:morfa $ETC/*.env $ETC/pg-ca.crt && chmod 640 $ETC/api.env $ETC/collab.env $ETC/collab-a.env $ETC/collab-b.env $ETC/render.env $ETC/build.env $ETC/pg-ca.crt && chmod 600 $ETC/db.env $ETC/s3.env $ETC/app-secrets.env"
}

systemd_units() {
  step "Morfa units and slice (enabled by release.sh --first)"
  for unit in morfa.slice morfa.target morfa-api@.service morfa-worker.service morfa-collab@.service morfa-render.service; do
    install_file "$SRC/deploy/systemd/$unit" "/etc/systemd/system/$unit" || true
  done
  run systemctl daemon-reload
  run systemctl enable morfa.target
}

firewall() {
  local text
  if [ "$ROLE" = app ]; then text="22, 80, 443 for everyone; 9400 (metrics) from $DB_PRIVATE_IP only"
  else text="22 for everyone; 5432 and 4318 from $APP_PRIVATE_IP only${REPLICA_PRIVATE_IP:+; 5432 from $REPLICA_PRIVATE_IP}"; fi
  step "ufw ($ROLE): $text"
  if [ "$DRY_RUN" = 1 ]; then printf '+ ufw default deny incoming; %s; ufw --force enable\n' "$text"; return 0; fi
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  if [ "$ROLE" = app ]; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    # Prometheus on the database VM reads every service's /metrics through Caddy's private site (deploy/caddy/morfa-metrics.caddy).
    ufw allow from "$DB_PRIVATE_IP" to any port 9400 proto tcp >/dev/null
  else
    ufw allow from "$APP_PRIVATE_IP" to any port 5432 proto tcp >/dev/null
    ufw allow from "$APP_PRIVATE_IP" to any port 4318 proto tcp >/dev/null
    [ -n "$REPLICA_PRIVATE_IP" ] && ufw allow from "$REPLICA_PRIVATE_IP" to any port 5432 proto tcp >/dev/null
  fi
  for server in $(zabbix_servers); do ufw allow from "$server" to any port 10050 proto tcp >/dev/null; done
  ufw --force enable >/dev/null
  ufw status verbose | sed -n '1,40p' >&2
}

summary() {
  step "summary ($ROLE)"
  [ "$DRY_RUN" = 1 ] && return 0
  if [ "$ROLE" = db ]; then
    echo "postgresql: $(systemctl is-active postgresql@$PG-main); backup timer: $(systemctl is-active morfa-backup.timer 2>/dev/null); docker: $(systemctl is-active docker)" >&2
  else
    echo "caddy: $(systemctl is-active caddy); node: $(/usr/local/bin/node -v 2>/dev/null); rustup: $([ -x /srv/morfa/.cargo/bin/rustup ] && echo yes)" >&2
    echo "next: scripts/deploy/release.sh root@<this VM> <commit> --first" >&2
  fi
}

case $ROLE in
  db) ALL=(base pg pgtls pgbackrest observability ssh firewall summary) ;;
  app) ALL=(base users node rust caddy secrets env systemd ssh firewall summary) ;;
  *) echo "ROLE=app|db" >&2; exit 2 ;;
esac
steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=("${ALL[@]}")
for name in "${steps[@]}"; do
  case " ${ALL[*]} " in *" $name "*) ;; *) echo "unknown $ROLE step $name (steps: ${ALL[*]})" >&2; exit 2 ;; esac
  case $name in
    base) base ;;
    pg) pg ;;
    pgtls) pg_tls ;;
    pgbackrest) pgbackrest_setup ;;
    observability) observability ;;
    users) users ;;
    node) node_runtime ;;
    rust) rust ;;
    caddy) caddy ;;
    secrets) secrets ;;
    env) env_files ;;
    systemd) systemd_units ;;
    ssh) harden_ssh ;;
    firewall) firewall ;;
    summary) summary ;;
  esac
done

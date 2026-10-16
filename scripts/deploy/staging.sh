#!/usr/bin/env bash
# The production-shaped staging stack on ONE machine: this checkout built as a release, then
# PostgreSQL 18 with pgBackRest (Docker), MinIO as the S3 stand-in, api ×2, worker, collab ×2, morfa-render and Caddy with
# production's sites and routes (deploy/caddy/morfa-sites.caddy, morfa-routes.caddy) on morfa.test names and Caddy's local CA,
# then the smoke and the two drills: drain one collab node under editors (0 acked ops lost, everyone back on the other
# node) and restore PostgreSQL from the base backup + WAL into a fresh cluster that a fresh api and collab node open at the
# live version with the same document.
#
#   scripts/deploy/staging.sh all        build, up, smoke, drain, restore, report (the stack keeps running; `down` stops it)
#   scripts/deploy/staging.sh build      wasm, fonts, the app (staging origin), the release binaries
#   scripts/deploy/staging.sh up         start everything (first time: secrets, cluster, roles, migrations, bucket, stanza,
#                                        the base backup)
#   scripts/deploy/staging.sh smoke      scripts/deploy/staging-smoke.ts: the edge, dev sign-in, a file on the rust collab
#                                        path, PDF through api → morfa-render, SVG from morfa-render
#   scripts/deploy/staging.sh drain      scripts/deploy/drain-drill.ts through the edge, node a stopped with SIGTERM
#   scripts/deploy/staging.sh restore    the restore drill
#   scripts/deploy/staging.sh status | stop-node <a|b> | start-node <a|b> | down | destroy (down + delete the state)
#
# Differences from production, all deliberate: one machine and Docker for PostgreSQL and Caddy (host network); MinIO's root
# key for every service; NODE_ENV=staging (its session
# cookie is forma_session instead of production's __Host-forma_session); no observability compose; smaller PostgreSQL memory settings.
# Secrets are generated into $MORFA_STAGING_DIR (mode 700) and never printed. Nothing here connects to any remote host.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
STATE=${MORFA_STAGING_DIR:-$HOME/.cache/morfa-staging}
TARGET=${MORFA_STAGING_TARGET:-$HOME/.cache/morfa-target/staging}
DOMAIN=${MORFA_STAGING_DOMAIN:-morfa.test}
APP=app.$DOMAIN
PG_PORT=5460 RESTORE_PG_PORT=5470 MINIO_PORT=9100 S3_TLS_PORT=9443 RENDER_PORT=3440
API_PORTS=(3401 3402) RESTORE_API_PORT=3409 RESTORE_COLLAB_PORT=3429
declare -A COLLAB_PORTS=([a]=3421 [b]=3422)
PG_IMAGE=morfa-staging-pg:18 CADDY_IMAGE=${MORFA_STAGING_CADDY_IMAGE:-mirror.gcr.io/library/caddy:2}
PG_BASE_IMAGE=${MORFA_STAGING_PG_BASE:-mirror.gcr.io/library/postgres:18}
MINIO_BIN=${MINIO_BIN:-$(command -v minio || echo "$HOME/go/bin/minio")}
MC_BIN=${MC_BIN:-$(command -v mc || echo "$HOME/go/bin/mc")}
RUN=$STATE/run LOGS=$STATE/logs RESULTS=$STATE/results
# The staging names resolve to loopback: never through an outbound proxy the environment may set.
for var in NO_PROXY no_proxy GLOBAL_AGENT_NO_PROXY; do export "$var=${!var:+${!var},}.$DOMAIN,$DOMAIN"; done
say() { printf '[staging %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { say "$*"; exit 1; }
cd "$ROOT"

wait_http() { # wait_http <url> <seconds> [curl args…]
  local url=$1 limit=$2; shift 2
  for _ in $(seq 1 $((limit * 5))); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$@" "$url")" = 200 ] && return 0
    sleep 0.2
  done
  return 1
}
hex() { openssl rand -hex "${1:-32}"; }

# ---- secrets and settings (generated once, mode 600) ----
settings() {
  mkdir -p "$STATE" "$RUN" "$LOGS" "$RESULTS" "$STATE/data" "$STATE/minio" "$STATE/pgbackrest" "$STATE/caddy-data"
  chmod 700 "$STATE"
  local secrets=$STATE/secrets.env
  if [ ! -s "$secrets" ]; then
    [ -x "$TARGET/release/morfa-collab" ] || die "build first ($0 build)"
    local keys; keys=$("$TARGET/release/morfa-collab" keygen)
    ( umask 077
      cat >"$secrets" <<EOF
PG_SUPER_PASSWORD=$(hex 24)
MORFA_DB_MIGRATION_PASSWORD=$(hex 24)
MORFA_DB_RUNTIME_PASSWORD=$(hex 24)
MORFA_DB_BACKUP_PASSWORD=$(hex 24)
MINIO_ROOT_USER=staging$(hex 4)
MINIO_ROOT_PASSWORD=$(hex 24)
COLLAB_INTERNAL_SECRET=$(hex 32)
RENDER_SECRET=$(hex 32)
PGBACKREST_CIPHER=$(hex 32)
TICKET_PRIVATE=$(sed -n 's/^MORFA_COLLAB_TICKET_PRIVATE_KEY=//p' <<<"$keys")
TICKET_PUBLIC=$(sed -n 's/^MORFA_COLLAB_TICKET_KEY=//p' <<<"$keys")
EOF
    )
  fi
  set -a; . "$secrets"; set +a
  local pg="127.0.0.1:$PG_PORT/morfa?sslmode=disable"
  ( umask 077
    # api.env: deploy/env/api.env.example's variables with staging values.
    cat >"$STATE/api.env" <<EOF
APP_ORIGIN=https://$APP
TRUST_PROXY=1
DATA_DIR=$STATE/data
MORFA_DATABASE_URL=postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$pg
MORFA_MIGRATION_DATABASE_URL=postgresql://morfa_migration:$MORFA_DB_MIGRATION_PASSWORD@$pg
MORFA_BACKUP_DATABASE_URL=postgresql://morfa_backup:$MORFA_DB_BACKUP_PASSWORD@$pg
MORFA_DATABASE_POOL_MAX=20
DESIGN_LIVE_FANOUT=postgres
DESIGN_COLLAB_NODES='a=http://127.0.0.1:${COLLAB_PORTS[a]}|wss://collab-a.$DOMAIN,b=http://127.0.0.1:${COLLAB_PORTS[b]}|wss://collab-b.$DOMAIN'
DESIGN_COLLAB=rust
DESIGN_COLLAB_ACCOUNTS=
DESIGN_COLLAB_INTERNAL_SECRET=$COLLAB_INTERNAL_SECRET
DESIGN_COLLAB_TICKET_KEY=$TICKET_PRIVATE
DESIGN_SERVER_LAYOUT=0
DESIGN_BIG_FILES=0
DESIGN_BLOBS=s3
DESIGN_S3_ENDPOINT=http://127.0.0.1:$MINIO_PORT
DESIGN_S3_REGION=ru-1
DESIGN_S3_BUCKET=morfa
DESIGN_S3_ACCESS_KEY=$MINIO_ROOT_USER
DESIGN_S3_SECRET_KEY=$MINIO_ROOT_PASSWORD
ENABLE_DESIGN_PDF_EXPORT=1
DESIGN_PDF_ENGINE=service
DESIGN_RENDER_URL=http://127.0.0.1:$RENDER_PORT
DESIGN_RENDER_SECRET=$RENDER_SECRET
IMPORT_CHROMIUM_PATH=${IMPORT_CHROMIUM_PATH:-/opt/pw-browsers/chromium}
MORFA_BUILD_COMMIT=$(git rev-parse --short=9 HEAD)
EOF
    cat >"$STATE/collab.env" <<EOF
MORFA_COLLAB_TICKET_KEY=$TICKET_PUBLIC
MORFA_COLLAB_INTERNAL_SECRET=$COLLAB_INTERNAL_SECRET
MORFA_COLLAB_API_URL=http://127.0.0.1:${API_PORTS[0]}
MORFA_COLLAB_ORIGINS=https://$APP
MORFA_COLLAB_PG_URL=postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$pg
MORFA_COLLAB_S3_ENDPOINT=http://127.0.0.1:$MINIO_PORT
MORFA_COLLAB_S3_REGION=ru-1
MORFA_COLLAB_S3_BUCKET=morfa
MORFA_COLLAB_S3_ACCESS_KEY=$MINIO_ROOT_USER
MORFA_COLLAB_S3_SECRET_KEY=$MINIO_ROOT_PASSWORD
MORFA_COLLAB_SHARDS=2
MORFA_COLLAB_MEMORY_LIMIT_MB=4096
MORFA_BIG_FILES=0
MORFA_COLLAB_DRAIN_NOTICE_MS=2500
MORFA_COLLAB_DRAIN_TIMEOUT_MS=25000
RUST_LOG=info
NO_COLOR=1
EOF
    cat >"$STATE/render.env" <<EOF
MORFA_RENDER_ADDR=127.0.0.1:$RENDER_PORT
MORFA_RENDER_INTERNAL_SECRET=$RENDER_SECRET
MORFA_RENDER_FONTS_DIR=$ROOT/public/fonts
MORFA_RENDER_WORKERS=2
RUST_LOG=info
EOF
    cat >"$STATE/caddy.env" <<EOF
MORFA_DOMAIN=$APP
MORFA_MARKETING_DOMAIN=$DOMAIN
MORFA_API_UPSTREAMS=127.0.0.1:${API_PORTS[0]} 127.0.0.1:${API_PORTS[1]}
MORFA_COLLAB_A=127.0.0.1:${COLLAB_PORTS[a]}
MORFA_COLLAB_B=127.0.0.1:${COLLAB_PORTS[b]}
MORFA_APP_DIR=$ROOT/dist/app
MORFA_DOWNLOADS_DIR=$STATE/downloads
MORFA_UPDATES_DIR=$STATE/updates
MORFA_S3_UPSTREAM=127.0.0.1:$MINIO_PORT
MORFA_S3_TLS_PORT=$S3_TLS_PORT
EOF
    # pgBackRest (deploy/pgbackrest/pgbackrest.conf.example) against MinIO through Caddy's TLS front.
    cat >"$STATE/pgbackrest/pgbackrest.conf" <<EOF
[global]
repo1-type=s3
repo1-s3-uri-style=path
repo1-s3-endpoint=s3.$DOMAIN
repo1-storage-port=$S3_TLS_PORT
repo1-storage-ca-file=/etc/pgbackrest/ca.crt
repo1-s3-region=ru-1
repo1-s3-bucket=morfa
repo1-s3-key=$MINIO_ROOT_USER
repo1-s3-key-secret=$MINIO_ROOT_PASSWORD
repo1-path=/pgbackrest
repo1-retention-full=2
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PGBACKREST_CIPHER
compress-type=zst
compress-level=3
start-fast=y
log-level-console=warn
log-level-file=off

[morfa]
pg1-path=/var/lib/postgresql/data
pg1-port=$PG_PORT
pg1-socket-path=/var/run/postgresql
EOF
  )
  mkdir -p "$STATE/downloads" "$STATE/updates"
  chmod 755 "$STATE/pgbackrest" && chmod 644 "$STATE/pgbackrest/pgbackrest.conf"
}

hosts() { # the staging names on loopback (Caddy answers them with its local CA)
  local names="$DOMAIN www.$DOMAIN $APP collab-a.$DOMAIN collab-b.$DOMAIN updates.$DOMAIN s3.$DOMAIN"
  grep -q "# morfa-staging" /etc/hosts && sed -i '/# morfa-staging$/d' /etc/hosts
  echo "127.0.0.1 $names # morfa-staging" >>/etc/hosts
}

# ---- build ----
build() {
  say "wasm modules, fonts"
  bash scripts/wasm-build.sh >/dev/null
  bash scripts/wasm-text-build.sh >/dev/null
  bash scripts/wasm-geometry-build.sh >/dev/null
  bash scripts/wasm-export-build.sh >/dev/null
  npm run --silent fonts >/dev/null
  say "app for https://$APP"
  VITE_APP_ORIGIN=https://$APP npm run --silent build:app >/dev/null
  say "cargo build --release morfa-collab, morfa-render (target $TARGET)"
  CARGO_TARGET_DIR=$TARGET MORFA_BUILD_COMMIT=$(git rev-parse --short=9 HEAD) cargo build --release --locked -q -p morfa-collab -p morfa-render-service
  [ -f fixtures/bench/f20k.json ] || { say "fixtures/bench/f20k.json (the drill's big file)"; npx tsx scripts/bench/gen-file.ts --name f20k >/dev/null; }
  if [ ! -x "$MINIO_BIN" ] || [ ! -x "$MC_BIN" ]; then
    command -v go >/dev/null || die "MinIO: no minio binary and no Go to build it (MINIO_BIN, MC_BIN)"
    say "MinIO from source (it ships no binaries or images any more; same releases as bench-ru)"
    local minio_release mc_release
    minio_release=$(sed -n 's/^MINIO_RELEASE=//p' scripts/deploy/remote/bench-ru.sh)
    mc_release=$(sed -n 's/^MC_RELEASE=//p' scripts/deploy/remote/bench-ru.sh)
    GOFLAGS=-trimpath CGO_ENABLED=0 go install "github.com/minio/minio@$minio_release"
    GOFLAGS=-trimpath CGO_ENABLED=0 go install "github.com/minio/mc@$mc_release"
  fi
  if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
    say "PostgreSQL 18 + pgBackRest image"
    docker pull -q "$PG_BASE_IMAGE" >/dev/null
    docker build -q --network host --build-arg BASE="$PG_BASE_IMAGE" \
      ${HTTPS_PROXY:+--build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg https_proxy="$HTTPS_PROXY"} \
      ${HTTP_PROXY:+--build-arg HTTP_PROXY="$HTTP_PROXY" --build-arg http_proxy="$HTTP_PROXY"} \
      -t "$PG_IMAGE" -f deploy/staging/postgres.Dockerfile deploy/staging >/dev/null
  fi
  docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1 || docker pull -q "$CADDY_IMAGE" >/dev/null
}

# ---- processes ----
running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
start_proc() { # start_proc <name> <env file…> -- <command…>   (extra VAR=value pairs may follow the env files)
  local name=$1; shift
  running "$name" && return 0
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  (
    set -a
    for e in "${envs[@]}"; do case $e in *=*) export "${e?}" ;; *) . "$e" ;; esac; done
    set +a
    exec setsid "$@" >>"$LOGS/$name.log" 2>&1 </dev/null
  ) &
  echo $! >"$RUN/$name.pid"
}
stop_proc() { # stop_proc <name> [seconds]: SIGTERM, then SIGKILL after the grace (systemd's TimeoutStopSec)
  local name=$1 grace=${2:-30}
  running "$name" || { rm -f "$RUN/$name.pid"; return 0; }
  local pid; pid=$(cat "$RUN/$name.pid")
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 $((grace * 10))); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && { say "$name: still running after ${grace} s, SIGKILL"; kill -KILL "$pid" 2>/dev/null || true; }
  rm -f "$RUN/$name.pid"
}

pg_up() {
  if ! docker container inspect morfa-staging-pg >/dev/null 2>&1; then
    say "PostgreSQL 18 (Docker, host network, port $PG_PORT; roles by deploy/postgres/init-roles.sh)"
    mkdir -p "$STATE/pg"
    docker run -d --name morfa-staging-pg --network host --add-host "s3.$DOMAIN:127.0.0.1" --shm-size 256m \
      -e PGDATA=/var/lib/postgresql/data -e POSTGRES_PASSWORD="$PG_SUPER_PASSWORD" \
      -e MORFA_DB_MIGRATION_PASSWORD -e MORFA_DB_RUNTIME_PASSWORD -e MORFA_DB_BACKUP_PASSWORD \
      -v "$STATE/pg:/var/lib/postgresql/data" -v "$ROOT/deploy/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-morfa-roles.sh:ro" \
      -v "$STATE/pgbackrest:/etc/pgbackrest:ro" \
      "$PG_IMAGE" "${PG_SETTINGS[@]}" >/dev/null
  else
    docker start morfa-staging-pg >/dev/null
  fi
  for _ in $(seq 1 120); do docker exec morfa-staging-pg pg_isready -q -h 127.0.0.1 -p $PG_PORT 2>/dev/null && break; sleep 0.5; done
  # The entrypoint's first start runs init scripts on a socket-only server, then restarts: wait for the real one.
  for _ in $(seq 1 120); do
    docker exec morfa-staging-pg psql -qtA -h 127.0.0.1 -p $PG_PORT -U postgres -d morfa -c 'SELECT 1' >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  die "PostgreSQL did not come up (docker logs morfa-staging-pg)"
}
# deploy/postgresql/morfa.conf's durability and archive settings; memory sized for a shared container.
PG_SETTINGS=(-c port=$PG_PORT -c listen_addresses=127.0.0.1 -c max_connections=200 -c shared_buffers=512MB
  -c fsync=on -c synchronous_commit=on -c wal_level=replica -c wal_compression=lz4 -c max_wal_size=2GB
  -c default_toast_compression=lz4 -c archive_mode=on -c "archive_command=pgbackrest --stanza=morfa archive-push %p"
  -c archive_timeout=60s -c max_wal_senders=10 -c shared_preload_libraries=pg_stat_statements)
pgbr() { docker exec -u postgres morfa-staging-pg pgbackrest --stanza=morfa "$@"; }

minio_up() {
  start_proc minio MINIO_ROOT_USER="$MINIO_ROOT_USER" MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" MINIO_SITE_REGION=ru-1 \
    MINIO_BROWSER=off -- "$MINIO_BIN" server "$STATE/minio" --address 127.0.0.1:$MINIO_PORT --quiet
  wait_http "http://127.0.0.1:$MINIO_PORT/minio/health/live" 30 || die "MinIO did not start ($LOGS/minio.log)"
  MC_CONFIG_DIR=$STATE/mc "$MC_BIN" alias set staging "http://127.0.0.1:$MINIO_PORT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  MC_CONFIG_DIR=$STATE/mc "$MC_BIN" mb --ignore-existing staging/morfa >/dev/null
  # Versioning on, as production's bucket has it.
  MC_CONFIG_DIR=$STATE/mc "$MC_BIN" version enable staging/morfa >/dev/null
}

caddy_up() {
  if ! docker container inspect morfa-staging-caddy >/dev/null 2>&1; then
    docker run -d --name morfa-staging-caddy --network host --env-file "$STATE/caddy.env" \
      -v "$ROOT/deploy/caddy:/etc/caddy:ro" -v "$ROOT:$ROOT:ro" -v "$STATE:$STATE:ro" -v "$STATE/caddy-data:/data" \
      "$CADDY_IMAGE" caddy run --config /etc/caddy/Caddyfile.staging --adapter caddyfile >/dev/null
  else
    docker start morfa-staging-caddy >/dev/null
  fi
  local ca=$STATE/caddy-data/caddy/pki/authorities/local/root.crt
  for _ in $(seq 1 100); do [ -s "$ca" ] && break; sleep 0.2; done
  [ -s "$ca" ] || die "Caddy made no local CA (docker logs morfa-staging-caddy)"
  cp "$ca" "$STATE/ca.crt" && cp "$ca" "$STATE/pgbackrest/ca.crt" && chmod 644 "$STATE/pgbackrest/ca.crt"
  wait_http "https://s3.$DOMAIN:$S3_TLS_PORT/minio/health/live" 30 --cacert "$STATE/ca.crt" || die "Caddy's S3 front does not answer"
}

collab_up() { # collab_up <node>
  local node=$1
  start_proc "collab-$node" "$STATE/collab.env" MORFA_COLLAB_NODE="$node" MORFA_COLLAB_ADDR="127.0.0.1:${COLLAB_PORTS[$node]}" \
    -- "$TARGET/release/morfa-collab" serve
  wait_http "http://127.0.0.1:${COLLAB_PORTS[$node]}/healthz" 60 || die "collab $node did not start ($LOGS/collab-$node.log)"
}

up() {
  settings
  hosts
  [ -d dist/app ] || die "build first ($0 build)"
  say "preflight of the generated settings (scripts/deploy/preflight.ts, as release.sh runs it on a host)"
  npx tsx scripts/deploy/preflight.ts --etc "$STATE" --staging >&2 || die "preflight found problems in $STATE"
  minio_up
  caddy_up
  pg_up
  say "migrations (forward only)"
  ( set -a; . "$STATE/api.env"; set +a; node --import tsx scripts/postgresql/migrate.ts --mode fresh >>"$LOGS/migrate.log" 2>&1 ) \
    || die "migration failed ($LOGS/migrate.log)"
  if ! pgbr info --output=json 2>/dev/null | grep -q '"backup":\[{'; then
    say "pgBackRest: stanza and the first full backup (WAL archived to MinIO from now on)"
    pgbr stanza-create >/dev/null
    pgbr check >/dev/null
    pgbr --type=full backup >/dev/null
  fi
  start_proc render "$STATE/render.env" -- "$TARGET/release/morfa-render"
  wait_http "http://127.0.0.1:$RENDER_PORT/healthz" 30 || die "morfa-render did not start ($LOGS/render.log)"
  for node in a b; do collab_up $node; done
  local i=0
  for port in "${API_PORTS[@]}"; do
    i=$((i + 1))
    start_proc "api-$i" "$STATE/api.env" NODE_ENV=staging HOST=127.0.0.1 PORT=$port METRICS_PORT=$((9400 + i)) MORFA_INSTANCE=api-$i \
      SHUTDOWN_GRACE_MS=25000 -- node --enable-source-maps --import tsx server/index.ts
  done
  i=0
  for port in "${API_PORTS[@]}"; do
    i=$((i + 1))
    wait_http "http://127.0.0.1:$port/api/health" 90 || die "api-$i did not start ($LOGS/api-$i.log)"
  done
  start_proc worker "$STATE/api.env" NODE_ENV=staging MORFA_INSTANCE=worker -- node --enable-source-maps --import tsx server/worker.ts
  wait_http "https://$APP/api/health" 30 --cacert "$STATE/ca.crt" || die "the edge does not answer https://$APP/api/health"
  say "up: https://$DOMAIN https://$APP wss://collab-{a,b}.$DOMAIN (CA $STATE/ca.crt)"
}

down() {
  for name in worker api-1 api-2 collab-a collab-b render restore-api restore-collab minio; do stop_proc "$name"; done
  docker stop -t 30 morfa-staging-caddy morfa-staging-pg morfa-staging-pg-restore >/dev/null 2>&1 || true
  say "down (state kept in $STATE; '$0 destroy' deletes it)"
}

destroy() {
  down
  docker rm -f morfa-staging-caddy morfa-staging-pg morfa-staging-pg-restore >/dev/null 2>&1 || true
  # The cluster's files belong to the container's postgres user: remove them from inside a container.
  [ -d "$STATE" ] && docker run --rm -v "$STATE:/state" "$PG_IMAGE" rm -rf /state/pg /state/pg-restore >/dev/null 2>&1 || true
  rm -rf "$STATE"
  sed -i '/# morfa-staging$/d' /etc/hosts
  say "destroyed"
}

status() {
  for name in minio render collab-a collab-b api-1 api-2 worker; do printf '  %-9s %s\n' "$name" "$(running $name && echo running || echo stopped)"; done
  docker ps --filter name=morfa-staging --format '  {{.Names}} {{.Status}}'
  for node in a b; do echo "  collab $node /healthz: $(curl -s --max-time 2 "http://127.0.0.1:${COLLAB_PORTS[$node]}/healthz" | head -c 300)"; done
  echo "  edge https://$APP/api/health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 --cacert "$STATE/ca.crt" "https://$APP/api/health")"
}

env_node() { # node with the staging CA trusted (the edge's certificates) and the api's settings for scripts
  NODE_EXTRA_CA_CERTS=$STATE/ca.crt "$@"
}

smoke() {
  settings >/dev/null
  say "smoke"
  env_node npx tsx scripts/deploy/staging-smoke.ts smoke --env "$STATE/api.env" --render-env "$STATE/render.env" \
    --domain "$DOMAIN" --state "$STATE" --out "$RESULTS/smoke.json"
}

drain() {
  settings >/dev/null
  local node=${1:-a} verdict=0
  say "drain drill: node $node stopped with SIGTERM under editors"
  env_node npx tsx scripts/deploy/drain-drill.ts --env "$STATE/api.env" --base "https://$APP" --cookie forma_session \
    --files "${DRILL_FILES:-24}" --editors "${DRILL_EDITORS:-4}" --big "${DRILL_BIG:-1}" --before "${DRILL_BEFORE:-10}" \
    --after "${DRILL_AFTER:-12}" --rate "${DRILL_RATE:-4}" --node "$node" --drain "bash $0 stop-node $node" \
    --out "$RESULTS/drain.json" >/dev/null || verdict=$?
  collab_up "$node"
  say "node $node started again"
  return $verdict
}

# The restore drill (scripts/deploy/restore-drill.sh's steps, on this machine): the base backup + archived WAL into a FRESH
# cluster on $RESTORE_PG_PORT, a fresh api ($RESTORE_API_PORT) and collab node ($RESTORE_COLLAB_PORT) on it with the same
# bucket, and they must open the smoke's file at the version the live stack has, with the same document.
restore() {
  settings >/dev/null
  local verdict=0
  local file; file=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).file)' "$RESULTS/smoke.json")
  [ -n "$file" ] || die "run the smoke first (its file is the one restored)"
  local cookie; cookie=$(cat "$STATE/smoke-cookie")
  say "restore drill: file $file"
  local live; live=$(env_node npx tsx scripts/deploy/staging-smoke.ts document --base "https://$APP" --file "$file" --cookie "$cookie")
  say "live: $live"
  # Everything committed so far goes to the archive (the restore replays it).
  docker exec morfa-staging-pg psql -qtA -h 127.0.0.1 -p $PG_PORT -U postgres -c 'SELECT pg_switch_wal()' >/dev/null
  pgbr check >/dev/null
  pgbr info >"$RESULTS/pgbackrest-info.txt"
  stop_proc restore-api; stop_proc restore-collab
  docker rm -f morfa-staging-pg-restore >/dev/null 2>&1 || true
  docker run --rm -v "$STATE:/state" "$PG_IMAGE" rm -rf /state/pg-restore >/dev/null
  mkdir -p "$STATE/pg-restore"
  local t0; t0=$(date +%s.%N)
  say "pgBackRest restore into a fresh cluster (port $RESTORE_PG_PORT)"
  docker run --rm --network host --add-host "s3.$DOMAIN:127.0.0.1" -v "$STATE/pg-restore:/var/lib/postgresql/data" \
    -v "$STATE/pgbackrest:/etc/pgbackrest:ro" "$PG_IMAGE" \
    sh -c 'chown postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data && exec gosu postgres pgbackrest --stanza=morfa --pg1-path=/var/lib/postgresql/data --archive-mode=off restore'
  # The primary's settings (a standby in recovery refuses max_connections, max_wal_senders… lower than the primary's), then
  # its own port and no archiving: the restored cluster never writes into the live stanza.
  docker run -d --name morfa-staging-pg-restore --network host --add-host "s3.$DOMAIN:127.0.0.1" --shm-size 256m \
    -e PGDATA=/var/lib/postgresql/data -v "$STATE/pg-restore:/var/lib/postgresql/data" -v "$STATE/pgbackrest:/etc/pgbackrest:ro" \
    "$PG_IMAGE" "${PG_SETTINGS[@]}" -c port=$RESTORE_PG_PORT -c archive_mode=off -c shared_buffers=256MB >/dev/null
  local promoted=""
  for _ in $(seq 1 240); do
    promoted=$(docker exec morfa-staging-pg-restore psql -qtA -h 127.0.0.1 -p $RESTORE_PG_PORT -U postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true)
    [ "$promoted" = f ] && break
    [ "$(docker inspect -f '{{.State.Running}}' morfa-staging-pg-restore 2>/dev/null)" = true ] || break
    sleep 0.5
  done
  [ "$promoted" = f ] || die "the restored cluster did not finish recovery (docker logs morfa-staging-pg-restore)"
  local t1; t1=$(date +%s.%N)
  local seconds; seconds=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')
  say "restored and promoted in $seconds s"
  local restored_pg="127.0.0.1:$RESTORE_PG_PORT/morfa?sslmode=disable"
  start_proc restore-collab "$STATE/collab.env" MORFA_COLLAB_NODE=restore MORFA_COLLAB_ADDR=127.0.0.1:$RESTORE_COLLAB_PORT \
    MORFA_COLLAB_PG_URL="postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$restored_pg" MORFA_COLLAB_API_URL=http://127.0.0.1:$RESTORE_API_PORT \
    MORFA_COLLAB_ORIGINS= -- "$TARGET/release/morfa-collab" serve
  start_proc restore-api "$STATE/api.env" NODE_ENV=staging HOST=127.0.0.1 PORT=$RESTORE_API_PORT MORFA_INSTANCE=restore-api \
    DATA_DIR="$STATE/restore-data" MORFA_DATABASE_URL="postgresql://morfa_runtime:$MORFA_DB_RUNTIME_PASSWORD@$restored_pg" \
    MORFA_MIGRATION_DATABASE_URL="postgresql://morfa_migration:$MORFA_DB_MIGRATION_PASSWORD@$restored_pg" \
    MORFA_BACKUP_DATABASE_URL="postgresql://morfa_backup:$MORFA_DB_BACKUP_PASSWORD@$restored_pg" \
    DESIGN_COLLAB_NODES="restore=http://127.0.0.1:$RESTORE_COLLAB_PORT|ws://127.0.0.1:$RESTORE_COLLAB_PORT" \
    -- node --import tsx server/index.ts
  wait_http "http://127.0.0.1:$RESTORE_COLLAB_PORT/healthz" 60 || die "restore collab did not start"
  wait_http "http://127.0.0.1:$RESTORE_API_PORT/api/health" 90 || die "restore api did not start ($LOGS/restore-api.log)"
  local restored; restored=$(env_node npx tsx scripts/deploy/staging-smoke.ts document --base "http://127.0.0.1:$RESTORE_API_PORT" \
    --file "$file" --cookie "$cookie" --welcome --origin "https://$APP")
  say "restored: $restored"
  node -e '
    const [live, restored, seconds, out] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), Number(process.argv[3]), process.argv[4]];
    const result = {date: new Date().toISOString(), file: live.file, liveVersion: live.version, restoredVersion: restored.version,
      collabWelcomeVersion: restored.welcome, documentEqual: live.sha256 === restored.sha256, liveSha256: live.sha256,
      restoredSha256: restored.sha256, restoreSeconds: seconds};
    result.pass = result.documentEqual && result.liveVersion === result.restoredVersion && result.collabWelcomeVersion === result.liveVersion;
    require("fs").writeFileSync(out, JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
    process.exit(result.pass ? 0 : 1);' "$live" "$restored" "$seconds" "$RESULTS/restore.json" || verdict=$?
  stop_proc restore-api; stop_proc restore-collab
  docker rm -f morfa-staging-pg-restore >/dev/null 2>&1 || true
  return $verdict
}

report() {
  node -e '
    const fs = require("fs"), dir = process.argv[1];
    const read = name => { try { return JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8")); } catch { return null; } };
    const [smoke, drain, restore] = ["smoke", "drain", "restore"].map(read);
    const line = (name, r, text) => console.log(`${r?.pass ? "PASS" : "FAIL"} ${name}: ${r ? text(r) : "not run"}`);
    line("smoke", smoke, r => r.checks.map(c => `${c.pass ? "✓" : "✗"} ${c.name}`).join(", "));
    line("drain", drain, r => `${r.drainedFiles} files / ${r.drainedSockets} sockets on node ${r.drainedNode}, drain ${r.drainSeconds.toFixed(1)} s, ${r.ackedTotal} acked ops, ${r.missing} lost, ${r.unackedLeft} unacked left, reconnect p50 ${r.reconnectMs.p50} ms p95 ${r.reconnectMs.p95} ms max ${r.reconnectMs.max} ms, ${r.notBack} not back, ${r.checkpointed}/${r.drainedFiles} checkpointed`);
    line("restore", restore, r => `${r.file}: live v${r.liveVersion}, restored v${r.restoredVersion}, collab welcome v${r.collabWelcomeVersion}, documents ${r.documentEqual ? "equal" : "DIFFER"}, restore ${r.restoreSeconds} s`);
    process.exit([smoke, drain, restore].every(r => r?.pass) ? 0 : 1);' "$RESULTS"
}

case ${1:-} in
  build) build ;;
  up) up ;;
  smoke) smoke ;;
  drain) drain "${2:-a}" ;;
  restore) restore ;;
  report) report ;;
  status) settings >/dev/null; status ;;
  stop-node) stop_proc "collab-${2:?node}" 30 ;;
  start-node) settings >/dev/null; collab_up "${2:?node}" ;;
  down) settings >/dev/null 2>&1 || true; down ;;
  destroy) destroy ;;
  all)
    build
    up
    ok=0
    smoke || ok=1
    drain a || ok=1
    restore || ok=1
    report || ok=1
    exit $ok
    ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
# The restore drill: PostgreSQL from the last base backup plus the archived WAL
# (pgBackRest, S3), collab's checkpoints from the same bucket, into a FRESH stack beside the running one — a restored
# cluster on 5470, an api on 3409 and a collab node on 3429 as transient units — and the restored stack must open the given
# file at the version the live stack has now, with the same document.
#
#   bash scripts/deploy/restore-drill.sh [<file id>]     (root, on the host, from a release tree; default: the largest file
#                                                       changed since the last base backup)
#
# The live stack is not touched: the restored cluster never archives (archive_mode=off) and the fresh services use
# their own ports; everything the drill made is removed at the end (the backup and the bucket stay).
set -euo pipefail
file=${1:-}
release=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PG=18 PORT=5470 API_PORT=3409 COLLAB_PORT=3429
data=/var/lib/postgresql/$PG/restore
say() { printf '[restore %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
cleanup() {
  systemctl stop morfa-restore-api morfa-restore-collab 2>/dev/null || true
  [ -n "${work:-}" ] && rm -rf "$work"
  [ -n "${token:-}" ] && sudo -u postgres psql -q -d morfa -c "DELETE FROM sessions WHERE token=encode(sha256('$token'::bytea),'hex')" 2>/dev/null || true
  systemctl reset-failed morfa-restore-api morfa-restore-collab 2>/dev/null || true
  if [ -d /etc/postgresql/$PG/restore ]; then pg_dropcluster --stop $PG restore || true; fi
}
trap cleanup EXIT
# The failing line's number only: commands here carry database URLs.
trap 'say "failed at line $LINENO"' ERR
cleanup

if [ -z "$file" ]; then
  since=$(sudo -u postgres pgbackrest --stanza=morfa info --output=json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s)[0].backup.at(-1);console.log(b.timestamp.stop)})')
  file=$(sudo -u postgres psql -tAq -d morfa -c "SELECT f.id FROM design_files f WHERE f.updated_at > to_timestamp($since) ORDER BY f.bytes DESC NULLS LAST LIMIT 1")
fi
[ -n "$file" ] || { say "no file changed since the last base backup"; exit 1; }
# A session of the file's owner, made now in the live database (so the restored one has it too); bench accounts only.
token=$(openssl rand -hex 32)
sudo -u postgres psql -q -d morfa -v ON_ERROR_STOP=1 -c "INSERT INTO sessions(token,user_id,expires) SELECT encode(sha256('$token'::bytea),'hex'), user_id, (extract(epoch from now())*1000)::bigint + 3600000 FROM design_files WHERE id='$file'"
# What the live stack says now (the target of the restore).
live_version=$(sudo -u postgres psql -tAq -d morfa -c "SELECT version FROM design_files WHERE id='$file'")
work=$(mktemp -d)
document() { # document <api port> <out>: the file's document as api reads it (checkpoint + journal), canonical JSON
  curl -fsS -H "cookie: __Host-forma_session=$token" "http://127.0.0.1:$1/api/design-files/$file" | node -e '
    const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
    let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(JSON.stringify(sort(JSON.parse(s).document))));' >"$2"
}
document 3401 "$work/live.json"
live_hash=$(sha256sum "$work/live.json" | cut -c1-64)
say "live: $file at version $live_version, document sha256 ${live_hash:0:16}…"
# Everything up to now goes to the archive (the restore replays it).
sudo -u postgres psql -tAq -d postgres -c "SELECT pg_switch_wal()" >/dev/null
sleep 2
sudo -u postgres pgbackrest --stanza=morfa check >/dev/null
sudo -u postgres pgbackrest --stanza=morfa info | sed -n '1,20p' >&2

say "restoring the last base backup + WAL into a fresh cluster on $PORT"
t0=$(date +%s)
pg_createcluster $PG restore --port $PORT >/dev/null
systemctl stop postgresql@$PG-restore 2>/dev/null || true
rm -rf "${data:?}"/*
sudo -u postgres pgbackrest --stanza=morfa --pg1-path="$data" --archive-mode=off --type=default restore >/dev/null
cp /etc/postgresql/$PG/main/conf.d/morfa.conf /etc/postgresql/$PG/main/conf.d/zz-tls.conf /etc/postgresql/$PG/restore/conf.d/ 2>/dev/null || true
printf "port = %s\narchive_mode = off\nshared_buffers = 1GB\n" "$PORT" >/etc/postgresql/$PG/restore/conf.d/zz-restore.conf
systemctl start postgresql@$PG-restore
for _ in $(seq 1 120); do
  [ "$(sudo -u postgres psql -p $PORT -tAq -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ] && break
  sleep 1
done
t1=$(date +%s)
restored_version=$(sudo -u postgres psql -p $PORT -tAq -d morfa -c "SELECT version FROM design_files WHERE id='$file'")
say "restored in $((t1 - t0)) s: $file at version $restored_version in the database"

say "a fresh api ($API_PORT) and collab node ($COLLAB_PORT) on the restored database and the same bucket"
set -a; . /etc/morfa/api.env; set +a
# collab's journal connects without TLS (crates/journal): its own URL from collab.env, on the restored port.
collab_url=$(sed -n "s/^MORFA_COLLAB_PG_URL=//p" /etc/morfa/collab.env | tr -d "'" | sed "s/:5432\//:$PORT\//")
restored_url=$(echo "$MORFA_DATABASE_URL" | sed "s/:5432\//:$PORT\//")
migration_url=$(echo "$MORFA_MIGRATION_DATABASE_URL" | sed "s/:5432\//:$PORT\//")
backup_url=$(echo "$MORFA_BACKUP_DATABASE_URL" | sed "s/:5432\//:$PORT\//")
install -d -o morfa -g morfa /srv/morfa/restore-data
systemd-run --quiet --unit=morfa-restore-collab --slice=morfa.slice --uid=morfa --gid=morfa --working-directory=/srv/morfa/restore-data \
  -p EnvironmentFile=/etc/morfa/collab.env -E MORFA_COLLAB_NODE=restore -E MORFA_COLLAB_ADDR=127.0.0.1:$COLLAB_PORT \
  -E MORFA_COLLAB_PG_URL="$collab_url" -E MORFA_COLLAB_API_URL=http://127.0.0.1:$API_PORT -E OTEL_EXPORTER_OTLP_ENDPOINT= \
  "$release/bin/morfa-collab" serve
systemd-run --quiet --unit=morfa-restore-api --slice=morfa.slice --uid=morfa --gid=morfa --working-directory="$release" \
  -p EnvironmentFile=/etc/morfa/api.env -E NODE_ENV=production -E HOST=127.0.0.1 -E PORT=$API_PORT -E DATA_DIR=/srv/morfa/restore-data \
  -E MORFA_DATABASE_URL="$restored_url" -E MORFA_MIGRATION_DATABASE_URL="$migration_url" -E MORFA_BACKUP_DATABASE_URL="$backup_url" \
  -E DESIGN_COLLAB_NODES="restore=http://127.0.0.1:$COLLAB_PORT|ws://127.0.0.1:$COLLAB_PORT" -E DESIGN_COLLAB=rust -E OTEL_EXPORTER_OTLP_ENDPOINT= \
  /usr/local/bin/node --import tsx server/index.ts
for _ in $(seq 1 120); do curl -fs "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break; sleep 0.5; done

# 1. api's read (checkpoint in S3 + journal tail of the restored database).
document $API_PORT "$work/restored.json"
read_hash=$(sha256sum "$work/restored.json" | cut -c1-64)
if [ "$read_hash" != "$live_hash" ]; then
  node -e '
    const [a, b] = process.argv.slice(1).map(f => JSON.parse(require("fs").readFileSync(f, "utf8")));
    const diff = (x, y, path) => { if (JSON.stringify(x) === JSON.stringify(y)) return null;
      if (x && y && typeof x === "object" && typeof y === "object") for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = diff(x[k], y[k], path + "/" + k); if (d) return d; }
      return path + ": " + JSON.stringify(x)?.slice(0, 120) + " ≠ " + JSON.stringify(y)?.slice(0, 120); };
    console.error("first difference " + diff(a, b, ""));' "$work/live.json" "$work/restored.json" >&2
fi
# 2. The collab node loads it (cold load: checkpoint + tail) and welcomes a socket at that version.
welcome=$(cd "$release" && sudo -u morfa node -e '
  const [api, file, token, origin] = process.argv.slice(1);
  (async () => {
    // The restored database still holds the leases of the live nodes: 503 until they run out (15 s); retried for 30 s.
    let r = await fetch(`${api}/api/design-files/${file}/session`, {headers: {cookie: `__Host-forma_session=${token}`}});
    for (let i = 0; r.status === 503 && i < 30; i++) {
      await new Promise(done => setTimeout(done, 1000));
      r = await fetch(`${api}/api/design-files/${file}/session`, {headers: {cookie: `__Host-forma_session=${token}`}});
    }
    if (r.status !== 200) { console.log("session " + r.status); process.exit(1); }
    const s = await r.json();
    const ws = new WebSocket(s.wsUrl, {headers: {origin}});
    ws.onerror = () => { console.log("socket error"); process.exit(1); };
    ws.onopen = () => ws.send(JSON.stringify({t: "hello", ticket: s.ticket, clientId: "restore-drill", since: 0, lastSeq: 0, protocol: 1}));
    ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.t === "welcome") { console.log(m.version); process.exit(0); } if (m.t === "bye") { console.log("bye " + m.reason); process.exit(1); } };
    setTimeout(() => { console.log("timeout"); process.exit(1); }, 30000);
  })();
' "http://127.0.0.1:$API_PORT" "$file" "$token" "$APP_ORIGIN") || true
say "restored stack: api document sha256 ${read_hash:0:16}…, collab welcome at version $welcome"
pass=false
[ "$restored_version" = "$live_version" ] && [ "$read_hash" = "$live_hash" ] && [ "$welcome" = "$live_version" ] && pass=true
printf '{"file":"%s","liveVersion":%s,"restoredVersion":%s,"collabWelcomeVersion":"%s","documentEqual":%s,"restoreSeconds":%s,"pass":%s}\n' \
  "$file" "$live_version" "${restored_version:-null}" "$welcome" "$([ "$read_hash" = "$live_hash" ] && echo true || echo false)" "$((t1 - t0))" "$pass"
$pass

#!/usr/bin/env bash
# Provisions production for morfa.example: the database VM, then the app VM. The operator runs it
# from a machine holding both VMs' root SSH keys. Idempotent: run it again after any change to deploy/.
#
#   scripts/deploy/provision-prod.sh <app public IP> <db public or jump IP> --app-private <ip> --db-private <ip>
#       [--replica-private <ip>] [--dry-run] [--app-steps "caddy env …"] [--db-steps "pg pgtls …"]
#
# Before the first run the operator writes, on the VMs (mode 600, never in the repository):
#   app  /etc/morfa/s3.env (the services' S3 key) and /etc/morfa/caddy.env (MORFA_ACME_EMAIL)
#   db   /etc/morfa/backup-s3.env (pgBackRest's S3 key)
# The DNS records of the public names (deploy/caddy/morfa-sites.caddy) should point at the app VM first: Caddy starts only once they do.
# Between the two VMs this script carries the database roles' passwords (db.env) and the database's CA certificate, piped from
# one ssh session into the other: never printed, never written on this machine.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
[ $# -ge 2 ] || { sed -n '2,15p' "$0"; exit 2; }
APP=$1 DB=$2
shift 2
APP_PRIVATE="" DB_PRIVATE="" REPLICA_PRIVATE="" DRY=0 APP_STEPS="" DB_STEPS=""
while [ $# -gt 0 ]; do
  case $1 in
    --app-private) APP_PRIVATE=$2; shift 2 ;;
    --db-private) DB_PRIVATE=$2; shift 2 ;;
    --replica-private) REPLICA_PRIVATE=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --app-steps) APP_STEPS=$2; shift 2 ;;
    --db-steps) DB_STEPS=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$APP_PRIVATE" ] && [ -n "$DB_PRIVATE" ] || { echo "--app-private and --db-private are required" >&2; exit 2; }
for ip in "$APP" "$DB"; do
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not an IPv4 address: $ip" >&2; exit 2; }
done
vars="APP_PRIVATE_IP=$APP_PRIVATE DB_PRIVATE_IP=$DB_PRIVATE REPLICA_PRIVATE_IP=$REPLICA_PRIVATE SRC=/root/morfa-provision"

if [ $DRY = 1 ]; then
  echo "# dry run: app $APP ($APP_PRIVATE), database $DB ($DB_PRIVATE)${REPLICA_PRIVATE:+, replica $REPLICA_PRIVATE}"
  echo "+ tar deploy scripts/deploy/remote | ssh root@$DB 'tar -x -C /root/morfa-provision'"
  # shellcheck disable=SC2086
  env DRY_RUN=1 ROLE=db $vars bash scripts/deploy/remote/prod.sh $DB_STEPS
  echo "+ ssh root@$DB cat /etc/morfa/db.env /etc/morfa/pg-ca.crt | ssh root@$APP 'install them in /etc/morfa (600 / 640)'"
  echo "+ tar deploy scripts/deploy/remote | ssh root@$APP 'tar -x -C /root/morfa-provision'"
  # shellcheck disable=SC2086
  env DRY_RUN=1 ROLE=app $vars bash scripts/deploy/remote/prod.sh $APP_STEPS
  echo "+ ssh root@$APP true; ssh root@$DB true   (new sessions: key login still works)"
  exit 0
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)
bundle() { COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$here" -czf - deploy scripts/deploy/remote 2>/dev/null || tar -C "$here" -czf - deploy scripts/deploy/remote; }
remote() { # remote <ip> <role> [step…]
  local ip=$1 role=$2; shift 2
  bundle | "${SSH[@]}" "root@$ip" 'rm -rf /root/morfa-provision && mkdir -p /root/morfa-provision && tar -xzf - -C /root/morfa-provision'
  "${SSH[@]}" "root@$ip" "cd /root/morfa-provision && env ROLE=$role $vars bash scripts/deploy/remote/prod.sh $*"
}
echo "== database $DB"
# shellcheck disable=SC2086
remote "$DB" db $DB_STEPS
echo "== database → app: db.env and the CA (piped, not printed)"
"${SSH[@]}" "root@$DB" 'cat /etc/morfa/db.env' | "${SSH[@]}" "root@$APP" 'install -d -m 750 /etc/morfa && umask 077 && cat >/etc/morfa/db.env'
"${SSH[@]}" "root@$DB" 'cat /etc/morfa/pg-ca.crt' | "${SSH[@]}" "root@$APP" 'cat >/etc/morfa/pg-ca.crt && chmod 644 /etc/morfa/pg-ca.crt'
echo "== app $APP"
# shellcheck disable=SC2086
remote "$APP" app $APP_STEPS
echo "== new sessions (key login still works)"
"${SSH[@]}" "root@$APP" true && "${SSH[@]}" "root@$DB" true && echo "ok: root key login works on both"
echo "next: scripts/deploy/release.sh root@$APP <commit> --first"

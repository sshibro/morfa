#!/usr/bin/env bash
# Provisions bench-ru and the ru-net VM from your workstation. Idempotent: run it again after
# any change to deploy/ and only what differs changes. Non-production VMs: no production data, secrets or domain ever go there;
# every secret is generated on the VM (/etc/morfa/*.env, mode 600) and never printed.
#
#   scripts/deploy/provision-bench.sh <bench-ru IP> <ru-net IP> [--dry-run] [--bench-steps "pg caddy …"] [--net-steps "…"]
#
# --dry-run prints every command (the remote scripts run here with DRY_RUN=1; nothing connects anywhere).
# Order: bench-ru first (its `morfa` user's key is made there), then ru-net (authorizes that key, measures the base RTT, sets the
# netem profile), then bench-ru's known_hosts for ru-net. ssh hardening and ufw come last on each VM, and a NEW ssh session is
# opened to prove root key login still works before this script ends (phase 2, rule 1).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"

[ $# -ge 2 ] || { sed -n '2,14p' "$0"; exit 2; }
BENCH_IP=$1 RUNET_IP=$2
shift 2
DRY=0 BENCH_STEPS="" NET_STEPS=""
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1; shift ;;
    --bench-steps) BENCH_STEPS=$2; shift 2 ;;
    --net-steps) NET_STEPS=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
for ip in "$BENCH_IP" "$RUNET_IP"; do
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not an IPv4 address: $ip" >&2; exit 2; }
done

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)
bundle() {
  # The files the remote scripts read: deploy/ and scripts/deploy/remote/ of this checkout.
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$here" -czf - deploy scripts/deploy/remote 2>/dev/null ||
    tar -C "$here" -czf - deploy scripts/deploy/remote
}

if [ $DRY = 1 ]; then
  echo "# dry run: bench-ru $BENCH_IP, ru-net $RUNET_IP"
  echo "+ tar deploy scripts/deploy/remote | ssh root@$BENCH_IP 'tar -x -C /root/morfa-provision'"
  # shellcheck disable=SC2086
  DRY_RUN=1 BENCH_IP=$BENCH_IP RUNET_IP=$RUNET_IP SRC=/root/morfa-provision bash scripts/deploy/remote/bench-ru.sh $BENCH_STEPS
  echo "+ tar deploy scripts/deploy/remote | ssh root@$RUNET_IP 'tar -x -C /root/morfa-provision'"
  # shellcheck disable=SC2086
  DRY_RUN=1 BENCH_IP=$BENCH_IP RUNET_IP=$RUNET_IP BENCH_KEY='<bench-ru morfa key>' SRC=/root/morfa-provision bash scripts/deploy/remote/ru-net.sh $NET_STEPS
  echo "+ ssh root@$BENCH_IP: ssh-keyscan $RUNET_IP >> /srv/morfa/.ssh/known_hosts; ssh bench@$RUNET_IP true"
  echo "+ ssh root@$BENCH_IP true; ssh root@$RUNET_IP true   (new sessions: key login still works)"
  exit 0
fi

remote() { # remote <ip> <script> '<VAR=value …>' [step…]
  local ip=$1 script=$2 vars=$3; shift 3
  bundle | "${SSH[@]}" "root@$ip" 'rm -rf /root/morfa-provision && mkdir -p /root/morfa-provision && tar -xzf - -C /root/morfa-provision'
  "${SSH[@]}" "root@$ip" "cd /root/morfa-provision && env $vars bash scripts/deploy/remote/$script $*"
}

echo "== bench-ru $BENCH_IP"
# shellcheck disable=SC2086
remote "$BENCH_IP" bench-ru.sh "BENCH_IP=$BENCH_IP RUNET_IP=$RUNET_IP SRC=/root/morfa-provision" $BENCH_STEPS
key=$("${SSH[@]}" "root@$BENCH_IP" 'cat /srv/morfa/.ssh/id_ed25519.pub')
echo "== ru-net $RUNET_IP"
# shellcheck disable=SC2086
remote "$RUNET_IP" ru-net.sh "BENCH_IP=$BENCH_IP RUNET_IP=$RUNET_IP SRC=/root/morfa-provision BENCH_KEY='$key'" $NET_STEPS
echo "== bench-ru → ru-net (the harness's ssh)"
"${SSH[@]}" "root@$BENCH_IP" "sudo -u morfa sh -c 'touch ~/.ssh/known_hosts && (ssh-keygen -F $RUNET_IP >/dev/null || ssh-keyscan -t ed25519 $RUNET_IP 2>/dev/null >>~/.ssh/known_hosts) && ssh -o BatchMode=yes bench@$RUNET_IP true && echo ok'"
echo "== new sessions (key login still works)"
"${SSH[@]}" "root@$BENCH_IP" true && "${SSH[@]}" "root@$RUNET_IP" true && echo "ok: root key login works on both"

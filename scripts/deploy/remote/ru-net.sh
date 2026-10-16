#!/usr/bin/env bash
# The ru-net VM's provisioning (lane B5): a light load machine for crates/loadgen. Run as root ON the VM by
# scripts/deploy/provision-bench.sh. Idempotent; DRY_RUN=1 prints instead of changing.
#
#   BENCH_IP=<bench-ru> RUNET_IP=<this VM> BENCH_KEY='<bench-ru morfa user public key>' SRC=/root/morfa-provision bash ru-net.sh [step…]
#
# Steps: base bench rtt netem ssh firewall summary. It installs only what loadgen needs (its binary is copied from bench-ru,
# built there), a `bench` user that bench-ru's harness reaches by key, and morfa-netem (sudo for `bench`, nothing else).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
: "${BENCH_IP:?BENCH_IP}"
SRC=${SRC:-/root/morfa-provision}
ETC=/etc/morfa
TARGET_RTT_MS=${TARGET_RTT_MS:-30}

base() {
  step "base packages"
  if ! probe test -f /var/lib/morfa/.apt-updated; then run apt-get update -q; run_sh "mkdir -p /var/lib/morfa && touch /var/lib/morfa/.apt-updated"; fi
  apt_install ca-certificates curl iperf3 time ufw chrony sysstat iproute2
  quiet_upgrades
  sysctl_tuning
}

bench_user() {
  step "user bench (loadgen runs as it; bench-ru's harness logs in with its key)"
  probe id bench || run useradd --create-home --shell /bin/bash bench
  run install -d -o bench -g bench -m 700 /home/bench/.ssh /home/bench/bin /home/bench/runs
  if [ -n "${BENCH_KEY:-}" ]; then
    if ! probe grep -qF "$BENCH_KEY" /home/bench/.ssh/authorized_keys; then
      run_sh "printf '%s\n' '$BENCH_KEY' >>/home/bench/.ssh/authorized_keys"
    fi
    run chown bench:bench /home/bench/.ssh/authorized_keys
    run chmod 600 /home/bench/.ssh/authorized_keys
  fi
  install_file "$here/morfa-netem" /usr/local/sbin/morfa-netem 755 || true
  run_sh "printf 'bench ALL=(root) NOPASSWD: /usr/local/sbin/morfa-netem\n' >/etc/sudoers.d/morfa-netem && chmod 440 /etc/sudoers.d/morfa-netem && visudo -cq"
}

rtt() {
  step "base RTT to bench-ru (200 pings) → netem delay = ${TARGET_RTT_MS} ms − base"
  if [ "$DRY_RUN" = 1 ]; then printf '+ ping -c 200 -i 0.2 %s; write %s/netem.env\n' "$BENCH_IP" "$ETC"; return 0; fi
  run tc qdisc del dev "$(ip -4 route get "$BENCH_IP" | sed -n 's/.* dev \([^ ]*\).*/\1/p')" root 2>/dev/null || true
  local line avg mdev
  line=$(ping -c 200 -i 0.2 -q "$BENCH_IP" | tail -n 1)
  avg=$(echo "$line" | awk -F'/' '{print $5}'); mdev=$(echo "$line" | awk -F'/' '{print $7}' | sed 's/ ms//')
  local delay; delay=$(awk -v t="$TARGET_RTT_MS" -v a="$avg" 'BEGIN{d=t-a; if (d<0) d=0; printf "%.1f", d}')
  install -d -m 755 "$ETC"
  {
    echo "BENCH_IP=$BENCH_IP"
    echo "BASE_RTT_MS=$avg"
    echo "BASE_RTT_MDEV_MS=$mdev"
    echo "DELAY_MS=$delay"
    echo "LOSS=0.1%"
    echo "MEASURED=$(date -u +%FT%TZ)"
  } >"$ETC/netem.env"
  chmod 644 "$ETC/netem.env"
  log "base RTT avg $avg ms (mdev $mdev): netem adds $delay ms → ${TARGET_RTT_MS} ms; 0.1 % loss"
}

netem_check() {
  step "netem on → RTT ≈ ${TARGET_RTT_MS} ms, then off"
  [ "$DRY_RUN" = 1 ] && { printf '+ morfa-netem on; ping; morfa-netem off\n'; return 0; }
  /usr/local/sbin/morfa-netem on >&2
  ping -c 50 -i 0.2 -q "$BENCH_IP" | tail -n 2 >&2
  /usr/local/sbin/morfa-netem off >&2
}

firewall() {
  step "ufw: 22 only (loadgen only connects out); 10050 from Timeweb's monitoring"
  if [ "$DRY_RUN" = 1 ]; then printf '+ ufw default deny incoming; allow 22; zabbix servers to 10050; ufw --force enable\n'; return 0; fi
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  for server in $(zabbix_servers); do ufw allow from "$server" to any port 10050 proto tcp >/dev/null; done
  ufw --force enable >/dev/null
  ufw status verbose | sed -n '1,20p' >&2
}

summary() {
  step "summary"
  [ "$DRY_RUN" = 1 ] && return 0
  cat "$ETC/netem.env" >&2
}

ALL=(base bench rtt netem ssh firewall summary)
steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=("${ALL[@]}")
for name in "${steps[@]}"; do
  case $name in
    base) base ;;
    bench) bench_user ;;
    rtt) rtt ;;
    netem) netem_check ;;
    ssh) harden_ssh ;;
    firewall) firewall ;;
    summary) summary ;;
    *) echo "unknown step $name (steps: ${ALL[*]})" >&2; exit 2 ;;
  esac
done

#!/usr/bin/env bash
# Shared helpers of the remote provisioning scripts (bench-ru.sh, ru-net.sh): run on the VM as root, or with DRY_RUN=1 anywhere
# to print what they would do. Every step is idempotent: it checks before it changes, so a second run changes nothing.
# Secrets are generated on the VM (openssl rand), written to /etc/morfa/*.env (mode 600) and never printed.
set -euo pipefail

DRY_RUN=${DRY_RUN:-0}
STEP=""

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
step() { STEP=$1; log "── $1"; }

# run <command…>: runs it, or prints it in a dry run.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '+ %s\n' "$*"; return 0; fi
  "$@"
}

# run_sh '<shell text>': a pipeline or redirect, as one string.
run_sh() {
  if [ "$DRY_RUN" = 1 ]; then printf '+ sh -c %q\n' "$1"; return 0; fi
  bash -c "$1"
}

# probe <command…>: a read-only check; false in a dry run (so the dry run shows every change).
probe() {
  if [ "$DRY_RUN" = 1 ]; then return 1; fi
  "$@" >/dev/null 2>&1
}

# A random lowercase hex secret (deploy/postgres/init-roles.sh wants hex).
secret() { openssl rand -hex "${1:-32}"; }

# env_get <file> <KEY>: a value of an env file (empty when missing), without the quotes env_set may have put around it.
env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/; s/^\"\(.*\)\"\$/\1/" || true; }

# A value as both systemd's EnvironmentFile and `set -a; . file` read it: single-quoted when it holds anything a shell would
# interpret (URLs with ? & |, lists with spaces). Values never contain a single quote (hex secrets, URLs).
env_quote() { case $1 in *[!A-Za-z0-9_.,:/@=+-]*) printf "'%s'" "$1" ;; *) printf '%s' "$1" ;; esac; }

# env_set <file> <KEY> <value>: sets or replaces one line; the file stays mode 600. The value is never printed.
env_set() {
  local file=$1 key=$2 value
  value=$(env_quote "$3")
  if [ "$DRY_RUN" = 1 ]; then printf '+ set %s in %s\n' "$key" "$file"; return 0; fi
  install -d -m 750 "$(dirname "$file")"
  touch "$file"; chmod 600 "$file"
  if grep -q "^$key=" "$file"; then
    local tmp; tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" >"$tmp"
    cat "$tmp" >"$file"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# env_default <file> <KEY> <value>: sets it only when it is not there yet (secrets survive a second run).
env_default() {
  if [ -n "$(env_get "$1" "$2")" ]; then return 0; fi
  env_set "$1" "$2" "$3"
}

# install_file <source> <target> [mode] [owner]: copies when the content differs; answers 0 when it changed.
install_file() {
  local source=$1 target=$2 mode=${3:-644} owner=${4:-root:root}
  if [ "$DRY_RUN" = 1 ]; then printf '+ install -m %s -o %s %s %s\n' "$mode" "$owner" "$source" "$target"; return 0; fi
  if [ -f "$target" ] && cmp -s "$source" "$target"; then return 1; fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$source" "$target"
  log "installed $target"
  return 0
}

apt_install() {
  local missing=()
  for package in "$@"; do dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
}

# sshd: keys only (rule 1 of phase 2: root key login keeps working; the caller opens a NEW session before closing the old one).
harden_ssh() {
  step "ssh: keys only"
  local conf=/etc/ssh/sshd_config.d/00-morfa.conf
  local text='# Morfa (scripts/deploy/remote/lib.sh): keys only. Read before 50-cloud-init.conf, so these win.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
'
  if [ "$DRY_RUN" = 1 ]; then printf '+ write %s; sshd -t; systemctl reload ssh\n' "$conf"; return 0; fi
  [ -s /root/.ssh/authorized_keys ] || { log "no /root/.ssh/authorized_keys: refusing to turn passwords off"; return 1; }
  if [ -f "$conf" ] && [ "$(cat "$conf")" = "$text" ]; then return 0; fi
  printf '%s' "$text" >"$conf"
  sshd -t
  systemctl reload ssh
}

# The Timeweb monitoring agent (zabbix, passive on 10050) keeps working behind ufw: its servers are read from its own config.
zabbix_servers() {
  sed -n 's/^Server=//p' /etc/zabbix/zabbix_agentd.conf /etc/zabbix/zabbix_agent2.conf 2>/dev/null | tr ',' '\n' | sed 's/ //g' | grep -E '^[0-9.]+$' || true
}

# Unattended upgrades would restart PostgreSQL or the kernel's services in the middle of a benchmark: off on the bench VMs.
quiet_upgrades() {
  step "unattended upgrades off (bench VMs only)"
  if probe grep -q 'Unattended-Upgrade "0"' /etc/apt/apt.conf.d/20auto-upgrades; then return 0; fi
  run_sh "printf 'APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"0\";\n' >/etc/apt/apt.conf.d/20auto-upgrades"
  run systemctl disable --now apt-daily-upgrade.timer
}

sysctl_tuning() {
  step "sysctl and limits"
  local text='# Morfa bench: thousands of sockets (loadgen, collab).
fs.file-max = 2097152
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_tw_reuse = 1
net.core.netdev_max_backlog = 16384
'
  if probe test "$(cat /etc/sysctl.d/90-morfa.conf 2>/dev/null)" = "$text"; then return 0; fi
  run_sh "printf '%s' '$text' >/etc/sysctl.d/90-morfa.conf && sysctl -q --system"
  run_sh "printf '* soft nofile 262144\n* hard nofile 262144\nroot soft nofile 262144\nroot hard nofile 262144\n' >/etc/security/limits.d/90-morfa.conf"
}

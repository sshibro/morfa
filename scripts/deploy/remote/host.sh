#!/usr/bin/env bash
# The VM side of a deploy: run as root on the host by release.sh,
# drain.sh and rollback.sh over SSH. Every step waits for health before the next one, so a deploy never takes both api
# processes or both collab nodes away at once.
#
#   host.sh preflight <release dir> check /etc/morfa's settings against each other (scripts/deploy/preflight.ts; no value printed)
#   host.sh switch <release dir>   point /srv/morfa/current at it (the old target goes to /srv/morfa/previous)
#   host.sh migrate                migrate the database to the current release's schema (forward only)
#   host.sh restart                rolling restart: render, api@N one by one, worker, collab nodes one by one through a drain
#   host.sh drain <node>           drain one collab node (systemctl stop = SIGTERM = drain) and show what it did; --start
#   host.sh rollback               switch back to /srv/morfa/previous, then a rolling restart
#   host.sh collab <legacy|rust>   flip DESIGN_COLLAB in api.env and restart the api processes (BACKEND §7 roll back)
#   host.sh status                 units, health, current release
set -euo pipefail
ETC=/etc/morfa
CURRENT=/srv/morfa/current PREVIOUS=/srv/morfa/previous
say() { printf '[host %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

instances() { systemctl list-units --all --plain --no-legend "$1" 2>/dev/null | awk '{print $1}' | sed -n 's/.*@\(.*\)\.service/\1/p'; }
enabled_instances() { # the instances enabled (or running) of a template
  { systemctl list-unit-files --plain --no-legend "$1" 2>/dev/null | awk '$2=="enabled"{print $1}' | sed -n 's/.*@\(.\+\)\.service/\1/p'; instances "$1"; } | sort -u
}

wait_http() { # wait_http <url> <seconds> → 0 when it answers 200
  local url=$1 limit=$2
  for _ in $(seq 1 $((limit * 5))); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$url")" = 200 ] && return 0
    sleep 0.2
  done
  return 1
}

preflight() {
  local dir=$1
  ( cd "$dir" && /usr/local/bin/node --import tsx scripts/deploy/preflight.ts --etc "$ETC" ) || { say "preflight found problems in $ETC: fix them first"; exit 1; }
}

switch() {
  local dir=$1
  [ -x "$dir/bin/morfa-collab" ] || { say "$dir has no bin/morfa-collab: build it first"; exit 1; }
  local old=""
  [ -L "$CURRENT" ] && old=$(readlink -f "$CURRENT")
  if [ -n "$old" ] && [ "$old" != "$(readlink -f "$dir")" ]; then ln -sfn "$old" "$PREVIOUS"; fi
  ln -sfn "$dir" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"
  say "current → $(readlink "$CURRENT") (previous: $(readlink "$PREVIOUS" 2>/dev/null || echo none))"
}

migrate() {
  say "migrating to $(cat "$CURRENT/BUILD_COMMIT")'s schema"
  ( set -a; . "$ETC/api.env"; set +a
    cd "$CURRENT" && sudo -u morfa --preserve-env=MORFA_MIGRATION_DATABASE_URL,MORFA_DATABASE_CA_CERT_FILE /usr/local/bin/node --import tsx scripts/postgresql/migrate.ts --mode fresh )
}

restart_api() {
  for n in $(enabled_instances 'morfa-api@*'); do
    say "api@$n: restart"
    systemctl restart "morfa-api@$n"
    wait_http "http://127.0.0.1:340$n/api/health" 60 || { say "api@$n is not healthy after 60 s"; journalctl -u "morfa-api@$n" -n 30 --no-pager >&2; exit 1; }
  done
  if systemctl is-enabled -q morfa-worker 2>/dev/null; then say "worker: restart"; systemctl restart morfa-worker; fi
}

drain_node() { # drain_node <node> [--start]
  local node=$1 start=${2:-}
  local port; port=$(sed -n 's/^MORFA_COLLAB_ADDR=.*:\([0-9]*\)$/\1/p' "$ETC/collab-$node.env")
  local since; since=$(date '+%Y-%m-%d %H:%M:%S')
  say "collab@$node: drain (SIGTERM; files checkpointed, sockets told bye {shutdown}, leases released)"
  local t0; t0=$(date +%s.%N)
  systemctl stop "morfa-collab@$node"
  local t1; t1=$(date +%s.%N)
  say "collab@$node stopped after $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}') s"
  journalctl -u "morfa-collab@$node" --since "$since" --no-pager -o cat | grep -E 'drain|drained|stop requested' | sed 's/^/    /' >&2 || true
  if [ "$start" = --start ]; then
    systemctl start "morfa-collab@$node"
    wait_http "http://127.0.0.1:$port/healthz" 60 || { say "collab@$node is not healthy after 60 s"; exit 1; }
    say "collab@$node: healthy again"
  fi
}

restart_render() { # stateless: an export in flight meets a restart and goes to Chromium (server/design/pdf/service.ts)
  systemctl is-enabled -q morfa-render 2>/dev/null || return 0
  local addr; addr=$(sed -n 's/^MORFA_RENDER_ADDR=//p' "$ETC/render.env" 2>/dev/null)
  say "render: restart"
  systemctl restart morfa-render
  wait_http "http://${addr:-127.0.0.1:3440}/healthz" 30 || { say "render is not healthy after 30 s"; journalctl -u morfa-render -n 30 --no-pager >&2; exit 1; }
}

edge_health() { # through Caddy: the production name (caddy.env MORFA_DOMAIN) on loopback, else bench-ru's plain :80
  local domain; domain=$(sed -n 's/^MORFA_DOMAIN=//p' "$ETC/caddy.env" 2>/dev/null)
  if [ -n "$domain" ] && grep -q morfa-sites.caddy /etc/caddy/Caddyfile 2>/dev/null; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health")" = 200 ]
  else
    wait_http http://127.0.0.1/api/health 30
  fi
}

restart() {
  restart_render
  restart_api
  for node in $(enabled_instances 'morfa-collab@*'); do drain_node "$node" --start; done
  systemctl is-active -q caddy && edge_health && say "edge: /api/health 200 through Caddy"
}

rollback() {
  [ -L "$PREVIOUS" ] || { say "no previous release recorded"; exit 1; }
  local target; target=$(readlink -f "$PREVIOUS")
  say "rolling back to $target"
  switch "$target"
  restart
}

collab_mode() {
  local mode=$1
  case $mode in legacy|shadow|rust) ;; *) say "DESIGN_COLLAB: legacy|shadow|rust"; exit 2 ;; esac
  if grep -q '^DESIGN_COLLAB=' "$ETC/api.env"; then sed -i "s/^DESIGN_COLLAB=.*/DESIGN_COLLAB=$mode/" "$ETC/api.env"
  else echo "DESIGN_COLLAB=$mode" >>"$ETC/api.env"; fi
  say "DESIGN_COLLAB=$mode; restarting api (it tells the nodes to let go of files the switch no longer puts on collab)"
  restart_api
}

status() {
  echo "current: $(readlink "$CURRENT" 2>/dev/null) ($(cat "$CURRENT/BUILD_COMMIT" 2>/dev/null))"
  echo "previous: $(readlink "$PREVIOUS" 2>/dev/null || echo none)"
  systemctl --no-pager --plain --no-legend list-units 'morfa-*' caddy.service minio.service 'postgresql@*' | awk '{print "  " $1, $3, $4}'
  if systemctl is-enabled -q morfa-render 2>/dev/null; then
    echo "  render /healthz: $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$(sed -n 's/^MORFA_RENDER_ADDR=//p' "$ETC/render.env" 2>/dev/null || echo 127.0.0.1:3440)/healthz")"
  fi
  for n in $(enabled_instances 'morfa-api@*'); do echo "  api@$n /api/health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:340$n/api/health")"; done
  for node in $(enabled_instances 'morfa-collab@*'); do
    port=$(sed -n 's/^MORFA_COLLAB_ADDR=.*:\([0-9]*\)$/\1/p' "$ETC/collab-$node.env")
    echo "  collab@$node /healthz: $(curl -s --max-time 2 "http://127.0.0.1:$port/healthz")"
  done
}

case ${1:-status} in
  preflight) preflight "$2" ;;
  switch) switch "$2" ;;
  migrate) migrate ;;
  restart) restart ;;
  restart-api) restart_api ;;
  drain) drain_node "$2" "${3:-}" ;;
  rollback) rollback ;;
  collab) collab_mode "$2" ;;
  status) status ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac

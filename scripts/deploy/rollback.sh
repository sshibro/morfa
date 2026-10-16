#!/usr/bin/env bash
# Rolls a host back.
#
#   scripts/deploy/rollback.sh <host>                 the previous release again (switch + rolling restart; the schema is
#                                                      forward-compatible: migrations only add)
#   scripts/deploy/rollback.sh <host> --collab legacy  co-editing back to SSE + PATCH (DESIGN_COLLAB=legacy, BACKEND §7):
#                                                      api tells the nodes to let go, editors reconnect, nothing is lost
set -euo pipefail
[ $# -ge 1 ] || { sed -n '2,9p' "$0"; exit 2; }
host=$1; shift
if [ "${1:-}" = --collab ]; then
  ssh -o BatchMode=yes "$host" "bash /srv/morfa/current/scripts/deploy/remote/host.sh collab ${2:?legacy|shadow|rust}"
else
  ssh -o BatchMode=yes "$host" "bash /srv/morfa/current/scripts/deploy/remote/host.sh rollback"
fi

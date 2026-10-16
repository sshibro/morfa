#!/usr/bin/env bash
# Drains one collab node of a host (lane B5; crates/collab/src/drain.rs): SIGTERM → /healthz 503 "draining" → every open file
# checkpointed → `bye {shutdown}` → leases released → exit ≤ 30 s. Its clients reconnect through /session to the other node.
#
#   scripts/deploy/drain.sh <host> <node> [--start]     --start brings the node back once drained
set -euo pipefail
[ $# -ge 2 ] || { sed -n '2,6p' "$0"; exit 2; }
host=$1 node=$2 start=${3:-}
ssh -o BatchMode=yes "$host" "bash /srv/morfa/current/scripts/deploy/remote/host.sh drain $node $start"

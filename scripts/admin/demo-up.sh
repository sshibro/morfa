#!/usr/bin/env bash
# One command to the operator console with demo data (docs/admin.md): a database in the running PostgreSQL test cluster (docs/dev.md),
# migrated to this checkout's schema and seeded by scripts/admin/seed-demo.ts, then the commands that start the API and the app on it.
#
#   scripts/admin/demo-up.sh [seed-demo options, e.g. --seed 7 --accounts 1000 --days 365]
#
# Needs the test cluster's env: load it first (set -a; . "$STATE/cluster.env"; set +a) or set MORFA_TEST_ENV_FILE to that file. The demo
# database's connection settings go to $MORFA_DEMO_STATE/demo.env (default ~/.cache/morfa-demo, private: they hold passwords); a second
# run reuses that database and reseeds it (--reset). Nothing secret is printed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state="${MORFA_DEMO_STATE:-$HOME/.cache/morfa-demo}"
cd "$root"

if [ -z "${MORFA_TEST_DATABASE_URL:-}" ]; then
  if [ -z "${MORFA_TEST_ENV_FILE:-}" ]; then
    echo "Load the PostgreSQL test cluster's env first (docs/dev.md), or set MORFA_TEST_ENV_FILE=<state dir>/cluster.env." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$MORFA_TEST_ENV_FILE"
  set +a
fi

npx tsx scripts/admin/seed/demo-database.ts --write-env "$state/demo.env"
(
  # The seeder reads the demo database's migration role from the file; the cluster's own keys stay out of it.
  unset MORFA_TEST_DATABASE_URL MORFA_TEST_CLUSTER_ID MORFA_TEST_CLUSTER_TOKEN MORFA_TEST_ENDPOINT
  set -a
  # shellcheck disable=SC1090
  . "$state/demo.env"
  set +a
  npx tsx scripts/admin/seed-demo.ts --reset --yes "$@"
)

cat <<EOF

Start the API (port 3400) from this checkout:
  set -a; . "$state/demo.env"; set +a
  MORFA_OPERATORS=owner@name.invalid DATA_DIR="$state/data" PORT=3400 npx tsx server/index.ts

and the app (Vite, port 5400) in another terminal:
  npx vite --host 127.0.0.1

Open http://127.0.0.1:5400/, sign in with the name "owner", then open http://127.0.0.1:5400/#admin.
Do not start the worker (server/worker.ts) on this database. Run this script again to reseed; the database lives until the test
cluster goes down.
EOF

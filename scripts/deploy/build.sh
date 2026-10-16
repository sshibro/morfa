#!/usr/bin/env bash
# Builds one Morfa release ON its VM (bench-ru, ru-4), as the `morfa` user, from the release directory that release.sh (or
# close.sh) unpacked with `git archive`. Native build: the VM is x86_64 Linux, so
# nothing is cross-compiled on the Mac.
#
#   scripts/deploy/build.sh [--dir <release dir>] [--no-app] [--crates morfa-collab,morfa-render,morfa-loadgen]
#   (--dir: build another tree with this script, e.g. a commit from before it existed; default: this script's own tree)
#
# 1. node_modules: one `npm ci` per package-lock.json, kept in /srv/morfa/cache/nm-<sha> and linked into the release.
# 2. The Rust toolchain of rust-toolchain.toml and the wasm tools (scripts/cloud-setup.sh: wasm-pack, wasm-bindgen, wasm-opt).
# 3. The wasm modules the api and the editor load (scripts/wasm-build.sh, wasm-text-build.sh, wasm-geometry-build.sh,
#    wasm-export-build.sh).
# 4. Fonts and the app (dist/app, app.morfa.example) unless --no-app; its origin comes from VITE_APP_ORIGIN (default: the
#    production https://app.morfa.example).
# 5. The services: cargo build --release, binaries copied to bin/ (MORFA_BUILD_COMMIT stamps collab_build_info).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
app=1 crates=morfa-collab,morfa-render
while [ $# -gt 0 ]; do
  case $1 in
    --dir) root=$(cd "$2" && pwd); shift 2 ;;
    --no-app) app=0; shift ;;
    --crates) crates=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
cd "$root"
export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/srv/morfa/target} CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-$(nproc)}
commit=$(cat BUILD_COMMIT 2>/dev/null || echo unknown)
say() { printf '[build %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

lock_sha=$(sha256sum package-lock.json | cut -c1-16)
cache=/srv/morfa/cache/nm-$lock_sha
if [ ! -f "$cache/.complete" ]; then
  say "npm ci for package-lock $lock_sha into $cache"
  rm -rf "$cache" && mkdir -p "$cache"
  cp package.json package-lock.json "$cache/"
  (cd "$cache" && npm ci --no-audit --no-fund --loglevel=error)
  touch "$cache/.complete"
fi
[ -L node_modules ] || rm -rf node_modules
ln -sfn "$cache/node_modules" node_modules

say "Rust toolchain and wasm tools (scripts/cloud-setup.sh)"
scripts/cloud-setup.sh >/dev/null
say "wasm modules"
scripts/wasm-build.sh >/dev/null
scripts/wasm-text-build.sh >/dev/null
scripts/wasm-geometry-build.sh >/dev/null
[ -x scripts/wasm-export-build.sh ] && scripts/wasm-export-build.sh >/dev/null
npm run --silent fonts >/dev/null
if [ $app = 1 ]; then
  # The public origin the build bakes in (deploy/env/build.env.example); staging passes its own in the environment.
  if [ -r /etc/morfa/build.env ]; then set -a; . /etc/morfa/build.env; set +a; fi
  say "app (vite build --mode app; VITE_APP_ORIGIN=${VITE_APP_ORIGIN:-default})"
  npm run --silent build:app >/dev/null
fi
# Binary names → their packages (crates/render-service builds `morfa-render`).
package() { case $1 in morfa-render) echo morfa-render-service ;; *) echo "$1" ;; esac; }
args=()
for crate in ${crates//,/ }; do args+=(-p "$(package "$crate")"); done
say "cargo build --release ${args[*]} (commit $commit)"
MORFA_BUILD_COMMIT=$commit cargo build --release --locked "${args[@]}"
mkdir -p bin
for crate in ${crates//,/ }; do
  binary=$crate
  [ "$crate" = morfa-loadgen ] && binary=loadgen
  install -m 755 "$CARGO_TARGET_DIR/release/$binary" "bin/$binary"
done
say "built $commit: $(ls bin | tr '\n' ' ')"

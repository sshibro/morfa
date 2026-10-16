#!/usr/bin/env bash
# Prepares a cloud container for building Morfa's Rust crates (docs/dev.md §Rust): the Rust toolchain
# from rust-toolchain.toml, cargo-binstall, wasm-pack, the wasm-bindgen CLI, binaryen's wasm-opt, the Node
# version in .nvmrc (package.json `engines`) and node_modules. Idempotent: every step either runs or says why it
# was skipped, so a second run only skips.
#
# A script cannot change its parent shell's environment, so it ends by printing `export` lines on stdout (all
# progress goes to stderr). Either paste them, or run it as
#     eval "$(scripts/cloud-setup.sh)"
# to install and set PATH (when Node had to be installed), CARGO_BUILD_JOBS, MORFA_CLOUD and CARGO_TARGET_DIR
# in one go. Linux only (the Mac lanes set up by hand, docs/dev.md §Rust).
#
# Overrides: MORFA_NODE_DIR (where Node is installed, default /opt/node-v<.nvmrc>), CARGO_BUILD_JOBS (default 2),
# CARGO_TARGET_DIR (default suggestion ~/.cache/morfa-target/<lane>).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

# Progress to stderr; fd 3 keeps the real stdout for the export lines at the end.
exec 3>&1 1>&2

ran=() skipped=() tmp_dirs=()
trap 'rm -rf "${tmp_dirs[@]}"' EXIT
say() { printf '[cloud-setup] %s\n' "$*"; }
did() { ran+=("$1"); say "done: $1"; }
skip() { skipped+=("$1"); say "skip: $1"; }
die() { say "error: $*"; exit 1; }

# Cloud containers compile with two jobs and skip e2e/PostgreSQL. Exported for the cargo
# installs below too.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" MORFA_CLOUD=1

# --- Rust toolchain -----------------------------------------------------------------------------------------
command -v rustup >/dev/null || die 'rustup is missing: install it from https://rustup.rs, then run this again'
toolchain_value() { sed -n "s/^$1 *= *//p" rust-toolchain.toml | tr -d '"[] ' | tr ',' ' '; }
channel=$(toolchain_value channel)
targets=$(toolchain_value targets)
components=$(toolchain_value components)
[[ -n $channel ]] || die 'no channel in rust-toolchain.toml'

missing=''
if rustup toolchain list | grep -q "^$channel-"; then
  installed_targets=$(rustup target list --installed --toolchain "$channel")
  installed_components=$(rustup component list --installed --toolchain "$channel")
  for target in $targets; do
    grep -qx "$target" <<<"$installed_targets" || missing+=" target:$target"
  done
  for component in $components; do
    grep -q "^$component-" <<<"$installed_components" || missing+=" component:$component"
  done
else
  missing=" toolchain:$channel"
fi
if [[ -z $missing ]]; then
  skip "rust $channel ($(rustup run "$channel" rustc --version)) with ${targets:-no extra targets}, ${components:-no extra components}"
else
  say "rust $channel lacks:$missing"
  args=(toolchain install "$channel" --profile minimal)
  for target in $targets; do args+=(--target "$target"); done
  for component in $components; do args+=(--component "$component"); done
  rustup "${args[@]}"
  did "rustup ${args[*]}"
fi

# --- cargo-binstall and wasm-pack -------------------------------------------------------------------------
# `cargo install` builds in a temporary directory unless CARGO_TARGET_DIR is set; keep the lane's target dir
# for the workspace only.
if command -v cargo-binstall >/dev/null; then
  skip "cargo-binstall ($(cargo binstall -V))"
else
  env -u CARGO_TARGET_DIR cargo install --locked cargo-binstall
  did "cargo install --locked cargo-binstall ($(cargo binstall -V))"
fi

if command -v wasm-pack >/dev/null; then
  skip "wasm-pack ($(wasm-pack --version))"
elif env -u CARGO_TARGET_DIR cargo binstall -y wasm-pack; then
  did "cargo binstall -y wasm-pack ($(wasm-pack --version))"
else
  say 'cargo binstall failed; building wasm-pack from source'
  env -u CARGO_TARGET_DIR cargo install --locked wasm-pack
  did "cargo install --locked wasm-pack ($(wasm-pack --version))"
fi

# --- wasm-bindgen CLI ---------------------------------------------------------------------------------------
# wasm-pack needs the wasm-bindgen CLI of exactly the version in Cargo.lock and uses the one on PATH when the
# version matches. Its own download fails behind the cloud proxy, after which it compiles the CLI itself on the
# first wasm build (≈3 min, ≈480 MB left in the lane's CARGO_TARGET_DIR); installing it here avoids both.
bindgen=$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)
[[ -n $bindgen ]] || die 'no wasm-bindgen in Cargo.lock'
if [[ $(wasm-bindgen --version 2>/dev/null) == "wasm-bindgen $bindgen" ]]; then
  skip "wasm-bindgen-cli $bindgen (Cargo.lock's wasm-bindgen) at $(command -v wasm-bindgen)"
elif env -u CARGO_TARGET_DIR cargo binstall -y "wasm-bindgen-cli@$bindgen"; then
  did "cargo binstall -y wasm-bindgen-cli@$bindgen ($(wasm-bindgen --version))"
else
  say 'cargo binstall failed; building wasm-bindgen-cli from source'
  env -u CARGO_TARGET_DIR cargo install --locked wasm-bindgen-cli --version "$bindgen"
  did "cargo install --locked wasm-bindgen-cli --version $bindgen ($(wasm-bindgen --version))"
fi

# --- wasm-opt (binaryen) ------------------------------------------------------------------------------------
# wasm-pack runs wasm-opt on release builds (crates/wasm/Cargo.toml) and uses the one on PATH when there is one.
# Its own download of binaryen fails behind the cloud proxy (curl through the same proxy works), so the
# release tarball wasm-pack would fetch (version 117 for wasm-pack 0.13–0.15) is installed here: only the
# static wasm-opt binary, sha256-checked against the release's .sha256 file, into cargo's bin directory.
binaryen=117
if command -v wasm-opt >/dev/null; then
  skip "wasm-opt ($(wasm-opt --version) at $(command -v wasm-opt))"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) binaryen_arch=x86_64-linux ;;
    Linux-aarch64 | Linux-arm64) binaryen_arch=aarch64-linux ;;
    *) die "no binaryen download rule for $(uname -sm): install wasm-opt yourself (brew install binaryen)" ;;
  esac
  tarball=binaryen-version_$binaryen-$binaryen_arch.tar.gz
  url=https://github.com/WebAssembly/binaryen/releases/download/version_$binaryen/$tarball
  work=$(mktemp -d)
  tmp_dirs+=("$work")
  say "downloading $url"
  curl -fsSL --retry 3 -o "$work/$tarball" "$url"
  curl -fsSL --retry 3 -o "$work/$tarball.sha256" "$url.sha256"
  expected=$(cut -d' ' -f1 "$work/$tarball.sha256")
  actual=$(sha256sum "$work/$tarball" | cut -d' ' -f1)
  [[ $actual == "$expected" ]] || die "sha256 mismatch for $tarball: got $actual, $tarball.sha256 says $expected"
  say "sha256 ok ($actual)"
  tar -xzf "$work/$tarball" -C "$work" "binaryen-version_$binaryen/bin/wasm-opt"
  cargo_bin=${CARGO_HOME:-$HOME/.cargo}/bin
  install -m 755 "$work/binaryen-version_$binaryen/bin/wasm-opt" "$cargo_bin/.wasm-opt.partial"
  mv "$cargo_bin/.wasm-opt.partial" "$cargo_bin/wasm-opt"
  did "wasm-opt $binaryen installed into $cargo_bin (binaryen release tarball, sha256 checked; $(wasm-opt --version))"
fi

# --- Node ---------------------------------------------------------------------------------------------------
want=$(tr -d ' v\n\r' <.nvmrc)
node_dir=${MORFA_NODE_DIR:-/opt/node-v$want}

# version_ge A B: true when version A >= version B (x.y.z).
version_ge() {
  local IFS=. i a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((${a[i]:-0} > ${b[i]:-0})); then return 0; fi
    if ((${a[i]:-0} < ${b[i]:-0})); then return 1; fi
  done
}
# node_fits BINARY: package.json `engines` is ">=<.nvmrc> <next major>".
node_fits() {
  local version
  version=$("$1" --version 2>/dev/null) || return 1
  version=${version#v}
  [[ ${version%%.*} == "${want%%.*}" ]] && version_ge "$version" "$want"
}

install_node() {
  local arch tarball base expected actual
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) arch=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) arch=linux-arm64 ;;
    *) die "no Node download rule for $(uname -sm): install Node $want yourself (nvm install, see .nvmrc)" ;;
  esac
  tarball=node-v$want-$arch.tar.xz
  base=https://nodejs.org/dist/v$want
  mkdir -p "$(dirname "$node_dir")"
  # A fresh directory next to the destination: the final move is a rename, never a half-extracted Node.
  node_tmp=$(mktemp -d "$(dirname "$node_dir")/.node-v$want.XXXXXX")
  tmp_dirs+=("$node_tmp")
  say "downloading $base/$tarball"
  curl -fsSL --retry 3 -o "$node_tmp/$tarball" "$base/$tarball"
  curl -fsSL --retry 3 -o "$node_tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  expected=$(awk -v file="$tarball" '$2 == file { print $1 }' "$node_tmp/SHASUMS256.txt")
  [[ -n $expected ]] || die "$tarball is not listed in $base/SHASUMS256.txt"
  actual=$(sha256sum "$node_tmp/$tarball" | cut -d' ' -f1)
  [[ $actual == "$expected" ]] || die "sha256 mismatch for $tarball: got $actual, SHASUMS256.txt says $expected"
  say "sha256 ok ($actual)"
  mkdir "$node_tmp/node"
  tar -xJf "$node_tmp/$tarball" -C "$node_tmp/node" --strip-components=1
  mv "$node_tmp/node" "$node_dir"
}

node_path_line=''
if command -v node >/dev/null && node_fits node; then
  skip "node $(node --version) on PATH ($(command -v node)) fits >=$want <$((${want%%.*} + 1))"
else
  say "node on PATH: $(command -v node >/dev/null && echo "$(node --version) at $(command -v node)" || echo none); package.json wants >=$want <$((${want%%.*} + 1))"
  if node_fits "$node_dir/bin/node"; then
    skip "node install: $node_dir already has $("$node_dir/bin/node" --version)"
  elif [[ -e $node_dir ]]; then
    die "$node_dir exists but has no working Node $want: move it away or set MORFA_NODE_DIR"
  else
    install_node
    did "node $want installed into $node_dir (nodejs.org tarball, sha256 checked against SHASUMS256.txt)"
  fi
  export PATH="$node_dir/bin:$PATH"
  node_path_line="export PATH=\"$node_dir/bin:\$PATH\""
fi

# --- node_modules -------------------------------------------------------------------------------------------
# npm writes node_modules/.package-lock.json on every install: a lockfile newer than it means a stale install.
if [[ -L node_modules ]]; then
  skip "npm ci: node_modules is a symlink ($(readlink node_modules)), shared with other checkouts; not touching it"
elif [[ -d node_modules && ! package-lock.json -nt node_modules/.package-lock.json ]]; then
  skip 'npm ci: node_modules is newer than package-lock.json'
else
  npm ci
  did "npm ci (node $(node --version), npm $(npm --version))"
fi

# --- Summary and the environment for the caller's shell -----------------------------------------------------
say "ran ${#ran[@]}, skipped ${#skipped[@]}"
# A per-lane target dir keeps cargo's build-dir lock and ./target out of the checkout (docs/dev.md §Rust).
target_line=''
if [[ -z ${CARGO_TARGET_DIR:-} ]]; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  case "$branch" in
    claude/lane-* | lane/*) lane=${branch##*lane[-/]} ;;
    *) lane=$(basename "$root") ;;
  esac
  target_line="export CARGO_TARGET_DIR=\"\$HOME/.cache/morfa-target/$lane\""
fi
# shellcheck disable=SC2016 # the command is printed for the reader, not expanded
say 'environment for your shell (or run: eval "$(scripts/cloud-setup.sh)"):'
{
  [[ -z $node_path_line ]] || printf '%s\n' "$node_path_line"
  printf 'export CARGO_BUILD_JOBS=%s MORFA_CLOUD=1\n' "$CARGO_BUILD_JOBS"
  [[ -z $target_line ]] || printf '%s\n' "$target_line"
} >&3

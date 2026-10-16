#!/usr/bin/env bash
# macOS: a universal (Apple silicon + Intel) Morfa.app and .dmg (docs/desktop.md §Builds). Run on the Mac:
#
#   desktop/scripts/build-macos.sh
#
# Signing and notarisation are the owner's (docs/desktop.md §Owner checklist). Without the variables below the build
# is unsigned (fine to try locally; Gatekeeper refuses it elsewhere):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: <name> (<team id>)" from the login keychain
#   APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID   — or APPLE_API_KEY, APPLE_API_ISSUER,
#   APPLE_API_KEY_PATH       (an App Store Connect API key) — Tauri notarises and staples when they are set.
#   TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD)  the updater key: adds the signed .app.tar.gz the updater downloads.
# Output: desktop/src-tauri/target/universal-apple-darwin/release/bundle/{macos,dmg}/.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "build-macos: run this on a Mac" >&2; exit 2; }
command -v cargo >/dev/null || { echo "build-macos: install Rust first (https://rustup.rs)" >&2; exit 2; }
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"
[ -d node_modules/@tauri-apps/cli ] || npm ci --no-audit --no-fund
args=(build --target universal-apple-darwin --bundles app,dmg --ci)
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then args+=(--config '{"bundle":{"createUpdaterArtifacts":true}}'); fi
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then echo "build-macos: APPLE_SIGNING_IDENTITY unset — the build is unsigned and not notarised"; fi
npx tauri "${args[@]}"
ls -la "$CARGO_TARGET_DIR"/universal-apple-darwin/release/bundle/dmg/*.dmg

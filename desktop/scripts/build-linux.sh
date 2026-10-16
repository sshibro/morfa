#!/usr/bin/env bash
# Linux packages of the desktop app: AppImage and .deb (docs/desktop.md §Builds). Runs on Ubuntu 22.04+/Debian 12+
# with the libraries desktop/scripts/check.sh names. Output: desktop/src-tauri/target/release/bundle/{appimage,deb}/.
#
#   desktop/scripts/build-linux.sh                       production (https://app.morfa.example)
#   MORFA_DESKTOP_FEATURES=smoke desktop/…               the smoke build (dialogs answered from the environment)
#
# Updater artifacts (.sig) only when a signing key is in the environment: TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD).
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"
[ -d node_modules/@tauri-apps/cli ] || npm ci --no-audit --no-fund
args=(build --bundles appimage,deb --ci)
[ -n "${MORFA_DESKTOP_FEATURES:-}" ] && args+=(--features "$MORFA_DESKTOP_FEATURES")
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then args+=(--config '{"bundle":{"createUpdaterArtifacts":true}}'); fi
# linuxdeploy (AppImage) runs as an AppImage itself; containers without FUSE extract it instead.
export APPIMAGE_EXTRACT_AND_RUN=1
npx tauri "${args[@]}"
ls -la "$CARGO_TARGET_DIR"/release/bundle/appimage/*.AppImage "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb

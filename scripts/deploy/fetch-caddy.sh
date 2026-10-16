#!/usr/bin/env bash
# Fetches the Caddy release the hosts run (2.11.7, the version Caddyfile.morfa was validated with) into ~/.cache/morfa-caddy/caddy
# for tests/design-deploy-caddy.test.ts (lane D), which runs deploy/caddy's sites locally. The archive's SHA-512 is pinned here
# (from the release's caddy_2.11.7_checksums.txt); a mismatch stops before anything is unpacked. Idempotent.
#
#   scripts/deploy/fetch-caddy.sh        prints the binary's path
set -euo pipefail
VERSION=2.11.7
DEST=${MORFA_CADDY_CACHE:-$HOME/.cache/morfa-caddy}
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux_amd64 sum=a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7 ;;
  Linux-aarch64) platform=linux_arm64 sum=3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e ;;
  Darwin-x86_64) platform=mac_amd64 sum=147886811fa2320a8881c6116dc8cc3f0562e2f686509ccc60f55cf85dfd5ea78e9f5f770c75da13bf124a2536b72e887b975fefd58706de3dafb57483610e70 ;;
  Darwin-arm64) platform=mac_arm64 sum=68f592df8f0ec058fbdb9b137b64e9a0aa792d28c06e1e3b9ec12d0e7fb371683a54e73ef6d8e6d0dd70dc6b941a5b5d5b73faedd3f89de119ad2eb78bdc668e ;;
  *) echo "fetch-caddy: no pinned Caddy for $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
if [ -x "$DEST/caddy" ] && "$DEST/caddy" version 2>/dev/null | grep -q "^v$VERSION "; then echo "$DEST/caddy"; exit 0; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -sSfL -o "$tmp/caddy.tar.gz" "https://github.com/caddyserver/caddy/releases/download/v$VERSION/caddy_${VERSION}_$platform.tar.gz"
got=$( (sha512sum "$tmp/caddy.tar.gz" 2>/dev/null || shasum -a 512 "$tmp/caddy.tar.gz") | awk '{print $1}')
[ "$got" = "$sum" ] || { echo "fetch-caddy: SHA-512 mismatch for caddy_${VERSION}_$platform.tar.gz" >&2; exit 1; }
mkdir -p "$tmp/x" "$DEST"
tar -xzf "$tmp/caddy.tar.gz" -C "$tmp/x" caddy
install -m 755 "$tmp/x/caddy" "$DEST/caddy"
echo "$DEST/caddy"

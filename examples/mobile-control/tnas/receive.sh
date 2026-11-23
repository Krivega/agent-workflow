#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/catalog"
exec 9>.sync-lock
flock -x 9
tmp=$(mktemp .snapshot.XXXXXXXX)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
test "$(sha256sum "$tmp" | cut -c1-64)" = "$1"
stamp() { head -c 64 "$1" | cut -d: -f2 | cut -d, -f1; }
if test -f current.json; then test "$(stamp "$tmp")" -gt "$(stamp current.json)"; fi
chmod 640 "$tmp"
mv -f "$tmp" current.json

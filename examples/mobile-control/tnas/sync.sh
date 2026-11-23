#!/bin/sh
# Run periodically on Mac under the same account as Worker.
set -eu
umask 077
test "$#" = 3 || { echo 'sync.sh WORKER_JSON SSH_HOST SSH_PORT' >&2; exit 2; }
cd "$(dirname "$0")/../../.."
snapshot=$(mktemp)
trap 'rm -f "$snapshot"' EXIT
node --import tsx examples/mobile-control/tnas/export.mjs "$1" > "$snapshot"
checksum=$(shasum -a 256 "$snapshot" | cut -d' ' -f1)
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -p "$3" -- "$2" \
  "sh /srv/agent-mobile/receive.sh $checksum" < "$snapshot"

#!/bin/sh
# approved contains one immutable GHCR reference, maintained by the operator.
set -eu
umask 077
cd "$(dirname "$0")"
exec 9>.update-lock
flock -n -E 75 9 || {
  code=$?
  if test "$code" -eq 75; then exit 0; fi
  exit "$code"
}
image_ok() {
  digest=${1#ghcr.io/krivega/agent-workflow-mobile@sha256:}
  test "$digest" != "$1" && test "${#digest}" -eq 64 || return 1
  case "$digest" in *[!0-9a-f]*) return 1;; esac
}
start() {
  MOBILE_IMAGE="$1" docker compose -f compose.yaml up --no-deps --wait --wait-timeout 45 -d mobile-web
}
record() {
  printf '%s\n' "$2" > ".$1.tmp"
  mv -f ".$1.tmp" "$1"
}
desired=$(cat approved)
image_ok "$desired"
previous=''
if test -f active; then previous=$(cat active); image_ok "$previous"; fi
# If interrupted before activation completed, recover the recorded good version first.
if test -f pending && test -n "$previous"; then
  start "$previous"
  rm pending
fi
if test -f pending && test -z "$previous" && test -f failed; then
  interrupted=$(cat pending)
  image_ok "$interrupted"
  MOBILE_IMAGE="$interrupted" docker compose -f compose.yaml stop mobile-web
  rm pending
fi
if test "$previous" = "$desired"; then start "$desired"; exit 0; fi
if test -f failed && test "$(cat failed)" = "$desired"; then
  echo 'Release previously failed. Inspect logs and approve a replacement or remove failed to retry.' >&2
  exit 1
fi
docker pull --platform linux/amd64 "$desired"
record pending "$desired"
if start "$desired"; then
  record active "$desired"
  rm -f pending failed
else
  record failed "$desired"
  if test -n "$previous"; then start "$previous"; else
    MOBILE_IMAGE="$desired" docker compose -f compose.yaml stop mobile-web
  fi
  rm -f pending
  exit 1
fi

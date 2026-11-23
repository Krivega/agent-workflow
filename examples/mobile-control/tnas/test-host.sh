#!/bin/sh
# Linux filesystem and locking are real; only Docker commands are substituted.
set -eu
base=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$base/update.sh" "$base/receive.sh" "$tmp"
cd "$tmp"
mkdir catalog bin
receive() {
  echo "{\"generatedAt\":$1,\"version\":1,\"projects\":[]}" > snapshot
  hash=$(sha256sum snapshot | cut -c1-64)
  sh receive.sh "${2:-$hash}" < snapshot
}
receive 100
cp catalog/current.json good
if receive 101 wrong || receive 99; then exit 1; fi
cmp good catalog/current.json
receive 101
cat > bin/docker <<'SH'
#!/bin/sh
set -eu
if test "$1" = pull; then exit 0; fi
echo "$MOBILE_IMAGE $*" >> calls
case "$*" in
  *' up '*) echo "$MOBILE_IMAGE" > actual; test "$MOBILE_IMAGE" != "${BAD_IMAGE:-}";;
  *' stop '*) rm -f actual;;
  *) exit 1;;
esac
SH
chmod +x bin/docker
PATH="$tmp/bin:$PATH"; export PATH
prefix=ghcr.io/krivega/agent-workflow-mobile@sha256:
first=$prefix$(printf '%064d' 1)
second=$prefix$(printf '%064d' 2)
echo invalid > approved
if sh update.sh; then exit 1; fi
echo "$first" > approved
sh update.sh
test "$(cat active)" = "$first"
echo "$second" > approved
export BAD_IMAGE="$second"
if sh update.sh; then exit 1; fi
test "$(cat actual)" = "$first"
test "$(cat failed)" = "$second"
if sh update.sh; then exit 1; fi
rm failed
unset BAD_IMAGE
echo "$second" > pending
sh update.sh
test "$(cat active)" = "$second"
test "$(cat actual)" = "$second"

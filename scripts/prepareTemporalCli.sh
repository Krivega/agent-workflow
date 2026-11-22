#!/bin/sh
# Install only the named binary from the pinned Temporal CLI v1.9.1 release archive.
set -eu
test "$#" -eq 1 || { echo "Usage: yarn prepare:temporal-cli /path/to/temporal_cli_1.9.1_PLATFORM.tar.gz" >&2; exit 2; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) expected=41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56 ;;
  Darwin-x86_64) expected=48cdd6c84c56e27ae8e4d9a47052b89289a9c552dee029b49dd312c6fb72873f ;;
  Linux-aarch64|Linux-arm64) expected=6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145 ;;
  Linux-x86_64) expected=09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5 ;;
  *) echo "Unsupported Temporal SDK test platform" >&2; exit 2 ;;
esac
output="$(dirname "$0")/../tmp/temporal-downloads"
mkdir -p "$output"
stage="$(mktemp -d "$output/.prepare.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
cp -- "$1" "$stage/archive"
(cd "$stage" && echo "$expected  archive" | shasum -a 256 --check --status)
tar -xzOf "$stage/archive" temporal > "$stage/temporal"
chmod 755 "$stage/temporal"
mv -f "$stage/temporal" "$output/temporal-v1.9.1"

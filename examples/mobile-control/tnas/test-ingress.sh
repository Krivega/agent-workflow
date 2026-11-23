#!/bin/sh
# Exercise the shipped nginx virtual host on an ephemeral local port.
set -eu
export DOCKER_DEFAULT_PLATFORM=linux/amd64
image=${1:?image}
base=$(cd "$(dirname "$0")" && pwd)
nginx=nginx:stable-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3
dir=$(mktemp -d)
socket=$(docker volume create)
site=''
proxy=''
cleanup() {
  if test -n "$proxy"; then docker rm -f "$proxy" >/dev/null; fi
  if test -n "$site"; then docker rm -f "$site" >/dev/null; fi
  docker volume rm "$socket" >/dev/null
  rm -rf "$dir"
}
trap cleanup EXIT
cd "$dir"
mkdir config catalog tls
openssl req -new -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=Test-CA \
  -keyout issuer.key -out tls/ca.pem 2>/dev/null
for identity in server owner other; do
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$identity" \
    -keyout "$identity.key" -out "$identity.csr" 2>/dev/null
  if test "$identity" = server; then
    printf '%s\n' 'subjectAltName=DNS:agent.krivega.com' 'extendedKeyUsage=serverAuth' > extensions
  else
    echo 'extendedKeyUsage=clientAuth' > extensions
  fi
  openssl x509 -req -in "$identity.csr" -CA tls/ca.pem -CAkey issuer.key \
    -CAcreateserial -days 1 -extfile extensions -out "$identity.pem" 2>/dev/null
done
mv server.key tls/server-key.pem
mv server.pem tls/server-chain.pem
openssl x509 -in owner.pem -noout -fingerprint -sha256 | cut -d= -f2 > config/phone.sha256
echo '{"generatedAt":1795305600000,"version":1,"projects":[{"id":"demo","tasks":[]}]}' > catalog/current.json
chmod 755 catalog config
chmod 644 catalog/current.json config/phone.sha256
docker run --rm --entrypoint sh -v "$socket:/socket" "$nginx" -c 'chown 1000:nginx /socket; chmod 2750 /socket'
gid=$(docker run --rm --entrypoint id "$nginx" -g nginx)
site=$(docker run -d --platform linux/amd64 --network none --read-only --user "1000:$gid" \
  -v "$socket:/run/mobile" -v "$dir/catalog:/catalog:ro" -v "$dir/config:/config:ro" "$image")
proxy=$(docker run -d -p 127.0.0.1::443 -v "$socket:/srv/agent-mobile/run:ro" \
  -v "$dir/tls:/srv/agent-mobile/tls:ro" \
  -v "$base/nginx.conf.example:/etc/nginx/conf.d/default.conf:ro" "$nginx")
port=$(docker port "$proxy" 443/tcp | cut -d: -f2)
request() {
  curl --silent --show-error --noproxy '*' --max-time 5 --cacert tls/ca.pem \
    --resolve "agent.krivega.com:$port:127.0.0.1" "$@" \
    -o result -w '%{http_code}' "https://agent.krivega.com:$port/"
}
tries=0
until test "$(request --cert owner.pem --key owner.key)" = 200; do
  tries=$((tries + 1))
  if test "$tries" -ge 15; then docker logs "$proxy"; docker logs "$site"; exit 1; fi
  sleep 1
done
grep -q '/project/demo' result
test "$(request --cert other.pem --key other.key -H 'X-Mobile-Verified: SUCCESS')" = 403
if test "$(request -H 'X-Mobile-Verified: SUCCESS')" = 200; then exit 1; fi
rm config/phone.sha256
test "$(request --cert owner.pem --key owner.key)" = 403

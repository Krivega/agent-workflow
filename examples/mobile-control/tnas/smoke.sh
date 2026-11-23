#!/bin/sh
# Test the built image through its actual socket without a Worker or network.
set -eu
image=${1:?image}
dir=$(mktemp -d)
name=''
cleanup() {
  if test -n "$name"; then docker rm -f "$name" >/dev/null; fi
  rm -rf "$dir"
}
trap cleanup EXIT
mkdir "$dir/catalog" "$dir/config"
openssl req -new -newkey rsa:2048 -nodes -x509 -days 1 -subj /CN=smoke \
  -keyout "$dir/test.key" -out "$dir/test.pem" 2>/dev/null
openssl x509 -in "$dir/test.pem" -noout -fingerprint -sha256 | cut -d= -f2 > "$dir/config/phone.sha256"
printf '%s\n' '{"generatedAt":1795305600000,"version":1,"projects":[{"id":"demo","tasks":[{"id":"one","status":"done","confirmedAt":"2026-11-22T00:00:00.000Z"}]}]}' > "$dir/catalog/current.json"
chmod 755 "$dir/config" "$dir/catalog"
chmod 644 "$dir/config/phone.sha256" "$dir/catalog/current.json"
name=$(docker run -d --platform linux/amd64 --network none --read-only --cap-drop ALL \
  --tmpfs /run/mobile:uid=1000,gid=1000,mode=0700 \
  -v "$dir/config:/config:ro" -v "$dir/catalog:/catalog:ro" "$image")
cert=$(cat "$dir/test.pem")
check() {
docker exec -i -e "CERT=$cert" "$name" node --input-type=module - "$1" <<'JS'
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {setTimeout} from 'node:timers/promises';
async function request(path, verified) {
  return await new Promise((resolve,reject) => {
    get({socketPath:'/run/mobile/site.sock',path, headers: verified ?
      {'x-mobile-verified':'SUCCESS','x-mobile-certificate':encodeURIComponent(process.env.CERT)} : {}}, res => {
      let body='';res.on('data', chunk=>body+=chunk);
      res.on('end',()=>resolve({code:res.statusCode,body}));
    }).on('error',reject);
  });
}
for(let i=0;;i++) {
  try {await request('/health');break;} catch(e){if(i===49) throw e; await setTimeout(100);}
}
assert.equal((await request('/')).code,403);
if(process.argv[2]==='revoked') {
  assert.equal((await request('/',true)).code,403);
} else {
  assert.equal((await request('/health')).code,204);
  assert.match((await request('/',true)).body,/demo/);
  const data=JSON.parse((await request('/api/aw/task/demo/one',true)).body);
  assert.equal(data.confirmedAt,'2026-11-22T00:00:00.000Z');
  assert.equal(data.snapshot,true);
}
JS
}
check valid
docker restart "$name" >/dev/null
check valid
rm "$dir/config/phone.sha256"
check revoked

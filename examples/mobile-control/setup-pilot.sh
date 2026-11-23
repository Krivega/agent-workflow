#!/bin/sh
# Create a new read-only pilot configuration. Never replace an existing device pin.
set -eu
umask 077
if [ "$#" -ne 4 ]; then
  echo 'Использование: setup-pilot.sh НОВЫЙ_КАТАЛОГ WORKER_JSON ИМЯ_СЕРВЕРА ЧАСТНЫЙ_IPV4' >&2
  exit 2
fi
destination=$1
worker_config=$2
host_name=$3
private_ip=$4
node --input-type=module - "$host_name" "$private_ip" "$worker_config" "$destination" <<'JS'
import { isIPv4 } from 'node:net';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const [name, ip, worker, dest] = process.argv.slice(2);
if (!/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]+$/.test(name) || !isIPv4(ip) ||
    !isAbsolute(dest) || !isAbsolute(worker) || !existsSync(worker)) {
  throw Error('Проверьте имя, IPv4 и абсолютные пути к новому каталогу и worker.json');
}
JS
mkdir -p "$(dirname "$destination")"
mkdir "$destination"
cd "$destination"
work=$(mktemp -d ./issuance.XXXXXXXX)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$work/ca.conf" <<'CONF'
[req]
prompt = no
distinguished_name = dn
x509_extensions = ca
[dn]
CN = Agent Workflow Pilot CA
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign
subjectKeyIdentifier = hash
CONF
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -config "$work/ca.conf" \
  -keyout "$work/issuer.key" -out ca.pem
for role in server phone; do
  if [ "$role" = server ]; then
    purpose=serverAuth
    subject=$host_name
  else
    purpose=clientAuth
    subject=Agent-Workflow-Owner
  fi
  openssl req -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=$subject" \
    -keyout "$work/$role.key" -out "$work/$role.csr"
  cat > "$work/$role.ext" <<CONF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = $purpose
authorityKeyIdentifier = keyid
CONF
  if [ "$role" = server ]; then
    echo "subjectAltName = DNS:$host_name,IP:$private_ip" >> "$work/$role.ext"
  fi
  openssl x509 -req -sha256 -days 29 -in "$work/$role.csr" -CA ca.pem \
    -CAkey "$work/issuer.key" -CAcreateserial -CAserial "$work/serial" \
    -extfile "$work/$role.ext" -out "$work/$role.pem"
done
openssl x509 -in ca.pem -outform der -out pilot-ca.cer
echo 'Задайте пароль для переноса сертификата на телефон и повторите его.' >&2
openssl pkcs12 -export -name Agent-Workflow-Owner -inkey "$work/phone.key" \
  -in "$work/phone.pem" -certfile ca.pem -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
  -out phone.p12
openssl x509 -noout -fingerprint -sha256 -in "$work/phone.pem" | cut -d= -f2 > phone.sha256
mv "$work/server.key" server-key.pem
mv "$work/server.pem" server-chain.pem
node --input-type=module - "$worker_config" "$private_ip" <<'JS'
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const [workerConfig, address] = process.argv.slice(2);
const config = { workerConfig, address, cert: resolve('server-chain.pem'), key: resolve('server-key.pem'),
  ca: resolve('ca.pem'), devicePin: resolve('phone.sha256') };
writeFileSync('mobile.json', JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
JS
echo "Готово. Для переноса на телефон: $destination/pilot-ca.cer и $destination/phone.p12"

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const args = JSON.stringify(process.argv.slice(2));
const ps =
  args === JSON.stringify(['-axo', 'pid=,ppid=,stat=,lstart='])
    ? 'identities'
    : args === JSON.stringify(['-axo', 'pgid=,pid='])
      ? 'groups'
      : null;
if (!ps) process.exit(2);
const configuration = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../full-consumer.json'), 'utf8'),
);
const connection = net.connect(configuration.socket);
let data = '';
connection.on('connect', () => connection.write(JSON.stringify({ ps }) + '\n'));
connection.on('data', (chunk) => {
  data += chunk;
});
connection.on('end', () => {
  const receipt = JSON.parse(data);
  process.stdout.write(receipt.stdout || '');
  process.exitCode = receipt.code;
});
connection.on('error', (error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});

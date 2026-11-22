import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { digest } from './spec.mjs';

const [socket, kind, owner] = process.argv.slice(2);
const bytes = readFileSync(resolve(owner));
const request = { kind, sha256: digest(bytes), bytes: bytes.toString('base64') };
const connection = connect(socket);
let result = '';
connection.on('connect', () => connection.write(JSON.stringify(request) + '\n'));
connection.on('data', (chunk) => {
  result += chunk;
});
connection.on('end', () => {
  const receipt = JSON.parse(result);
  process.stdout.write(JSON.stringify(receipt) + '\n');
  process.exitCode = receipt.code === 0 && receipt.stopped === true ? 0 : 1;
});
connection.on('error', (error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});

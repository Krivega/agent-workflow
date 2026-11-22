import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { NativeConnection, Runtime } from '@temporalio/worker';
import { createReaderHost } from '../../dist/worker/readerHost.js';

assert.ok(process.send);
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let sequence = 0;
const pending = new Map();
process.on('message', (message) => {
  if (message.type !== 'response') return;
  const request = pending.get(message.id);
  assert.ok(request);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message.value);
});
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send({ type: 'request', id, method, params });
  });
}
const rpc = { request: call, completed: (thread, turn) => call('__completed', { thread, turn }) };
const connection = await NativeConnection.connect({ address: config.address });
try {
  const host = await createReaderHost(
    connection,
    config.queue,
    config.workflowsPath,
    [
      {
        registration: config.registration,
        rpc,
        authority: {
          async verify() {
            throw new Error('No command authority in crash qualification');
          },
        },
      },
    ],
    config.profile,
    config.hostRoot,
    config.maxStarts,
  );
  await host.runUntil(
    () =>
      new Promise((resolve) => {
        process.on('message', (message) => {
          if (message.type === 'finish') resolve();
        });
        process.send({ type: 'ready' });
      }),
  );
} finally {
  await connection.close();
  process.disconnect();
}

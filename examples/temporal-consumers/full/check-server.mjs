import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { digest, validateCheckRequest } from './spec.mjs';
import { checkSource } from './inventories.mjs';
import { ownProcess } from './safety.mjs';

const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const snapshot = JSON.parse(readFileSync(configuration.snapshot, 'utf8'));
let currentOwner = configuration.consumer.before;
let busy = false,
  sequence = 0,
  active;
const connections = new Set();
const server = createServer((connection) => {
  connections.add(connection);
  connection.once('close', () => connections.delete(connection));
  let request = '';
  connection.on('data', async (chunk) => {
    request += chunk;
    if (request.length > 4 * 1024 * 1024) {
      connection.destroy();
      return;
    }
    if (!request.endsWith('\n')) return;
    connection.removeAllListeners('data');
    let ownsCheck = false,
      control,
      directory,
      stopReceipt;
    let log = '';
    const stop = () => {
      if (control) void control.stop();
    };
    try {
      const value = JSON.parse(request);
      if (value.ps) {
        assert.deepEqual(Object.keys(value), ['ps']);
        assert.ok(['identities', 'groups'].includes(value.ps));
        const args =
          value.ps === 'identities' ? ['-axo', 'pid=,ppid=,stat=,lstart='] : ['-axo', 'pgid=,pid='];
        connection.end(
          JSON.stringify({ code: 0, stdout: execFileSync('/bin/ps', args, { encoding: 'utf8' }) }),
        );
        return;
      }
      assert.equal(busy, false, 'only one trusted check may run');
      const consumer = configuration.consumer;
      const bytes = validateCheckRequest(value, consumer);
      checkSource(consumer.workspace, snapshot, consumer.owner, currentOwner);
      directory = join(configuration.evidence, String(++sequence).padStart(3, '0'));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'request.json'),
        JSON.stringify({ ...value, bytes: undefined, consumer: consumer.name }) + '\n',
      );
      writeFileSync(join(consumer.workspace, consumer.owner), bytes);
      currentOwner = value.sha256;
      busy = true;
      ownsCheck = true;
      const command = consumer.commands[value.kind];
      const tmp = join(consumer.workspace, 'tmp');
      const previousLogs = new Set(existsSync(tmp) ? readdirSync(tmp) : []);
      const outputs = ['coverage/lcov.info', 'coverage/cobertura-coverage.xml', 'junit.xml'];
      const previousOutputs = new Map(
        outputs.map((path) => [
          path,
          existsSync(join(consumer.workspace, path))
            ? statSync(join(consumer.workspace, path)).mtimeMs
            : null,
        ]),
      );
      const child = spawn(command.executable, command.args, {
        cwd: consumer.workspace,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...consumer.env },
      });
      control = ownProcess(child, { deadline: performance.now() + 1200000 });
      active = control;
      child.stdout.on('data', (chunk) => {
        log += chunk;
      });
      child.stderr.on('data', (chunk) => {
        log += chunk;
      });
      connection.once('close', stop);
      stopReceipt = await control.done;
      const code = stopReceipt.code;
      const stopped = stopReceipt.stopped;
      const timeout = stopReceipt.deadlineReached === true;
      let sourceError = null;
      try {
        checkSource(consumer.workspace, snapshot, consumer.owner, value.sha256);
      } catch (error) {
        sourceError = String(error);
      }
      for (const path of outputs) {
        const file = join(consumer.workspace, path);
        if (existsSync(file) && statSync(file).mtimeMs !== previousOutputs.get(path))
          cpSync(file, join(directory, path.replaceAll('/', '-')));
      }
      if (existsSync(tmp))
        for (const name of readdirSync(tmp)) {
          if (
            !previousLogs.has(name) &&
            name.startsWith('validation-') &&
            existsSync(join(tmp, name, 'full.log'))
          )
            cpSync(join(tmp, name), join(directory, name), { recursive: true });
        }
      const receipt = {
        code: sourceError === null ? code : 1,
        commandCode: code,
        sourceError,
        stopped,
        stop: stopReceipt,
        timeout,
        kind: value.kind,
        sha256: value.sha256,
        command,
        logSha256: digest(log),
        log,
      };
      writeFileSync(join(directory, 'full.log'), log);
      writeFileSync(
        join(directory, 'receipt.json'),
        JSON.stringify({ ...receipt, log: undefined }, null, 2) + '\n',
      );
      connection.end(JSON.stringify(receipt));
    } catch (error) {
      if (control) stopReceipt = await control.stop();
      const receipt = {
        code: 1,
        stopped: stopReceipt?.stopped === true,
        stop: stopReceipt,
        error: String(error),
      };
      if (directory) {
        writeFileSync(join(directory, 'full.log'), log);
        writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
      }
      connection.end(JSON.stringify(receipt));
    } finally {
      connection.removeListener('close', stop);
      if (ownsCheck && stopReceipt?.stopped === true) {
        active = undefined;
        busy = false;
      }
    }
  });
});
server.listen(configuration.socket, () => process.stdout.write('ready\n'));
process.once('SIGTERM', async () => {
  const receipt = active ? await active.stop() : { stopped: true };
  writeFileSync(configuration.evidence + '.stop.json', JSON.stringify(receipt, null, 2));
  for (const connection of connections) connection.destroy();
  server.close(() => {
    if (receipt.stopped) process.exit();
  });
  if (!receipt.stopped) process.exitCode = 1;
});

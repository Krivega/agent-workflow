import { constants, openSync, fstatSync, readFileSync, closeSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function pinned(path, hash) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('h04-native-file');
    const bytes = readFileSync(fd);
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new Error('h04-native-pin');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** Read-only Node process. Only the owning host starts and applies the operation. */
export async function h04NativeWait(args) {
  if (args.length !== 3 || args[0] !== '--wait') throw new Error('h04-native-wait-usage');
  const path = resolve(args[1]),
    hash = args[2],
    request = JSON.parse(pinned(path, hash).toString('utf8'));
  if (
    request.kind !== 'comparison-h04-native-operation' ||
    request.schemaVersion !== 1 ||
    !/^\d+$/u.test(request.deadlineNs)
  )
    throw new Error('h04-native-wait-request');
  pinned(request.node.locator, request.node.hash);
  pinned(request.waiter.locator, request.waiter.hash);
  const remaining = Number(BigInt(request.deadlineNs) - process.hrtime.bigint()) / 1e6;
  if (!(remaining > 0 && remaining <= 2_147_483_647)) throw new Error('h04-native-wait-deadline');
  const inputHash = createHash('sha256').update(canonical(request)).digest('hex');
  return await new Promise((accept, reject) => {
    let settled = false;
    const watcher = watch(request.outputRoot, read);
    const timer = setTimeout(() => finish(new Error('h04-native-wait-timeout')), remaining);
    function finish(error, text) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else accept(text);
    }
    function read() {
      try {
        pinned(path, hash);
        const text = readFileSync(join(request.outputRoot, 'terminal.json'), 'utf8'),
          result = JSON.parse(text);
        if (
          result.kind !== 'comparison-h04-native-terminal' ||
          result.operationId !== request.operationId ||
          result.inputHash !== inputHash ||
          result.opId !== request.opId
        )
          throw new Error('h04-native-terminal-binding');
        finish(null, text);
      } catch (error) {
        if (error.code !== 'ENOENT') finish(error);
      }
    }
    watcher.on('error', finish);
    read();
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h04NativeWait(process.argv.slice(2))
    .then((text) => process.stdout.write(text))
    .catch(() => {
      process.stderr.write('h04-native-wait-failed\n');
      process.exitCode = 1;
    });

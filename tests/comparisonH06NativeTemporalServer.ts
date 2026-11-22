import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as same, promisify } from 'node:util';
import { verifyPinnedBinary } from '../examples/temporal-consumers/full/safety.mjs';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';

const exec = promisify(execFile);
const ps = '/bin/ps';
const lsof = '/usr/sbin/lsof';
const startedPattern = '[A-Za-z]{3} [A-Za-z]{3} +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}';
const processLine = new RegExp('^(\\d+) +(\\d+) +(' + startedPattern + ') +(.+)$', 'u');
const startTime = new RegExp('^' + startedPattern + '$', 'u');

interface ExpectedServer {
  requestHash: string;
  binary: H04Pin;
  address: string;
  httpPort: number;
  metricsPort: number;
  sqlitePath: string;
}

function validPort(port: number) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

function vnode(path: string) {
  requireContract(realpathSync(path) === path, 'h06-temporal-server-file-alias');
  const stat = lstatSync(path, { bigint: true });
  requireContract(stat.isFile() && stat.nlink === 1n, 'h06-temporal-server-file-kind');
  return { device: stat.dev, inode: stat.ino };
}

function openFiles(output: string) {
  if (output === '') return [];
  requireContract(output.endsWith('\n'), 'h06-temporal-server-lsof-format');
  return output
    .slice(0, -1)
    .split(/\n(?=p)/u)
    .flatMap((group) => {
      const [owner, ...files] = group.split(/\n(?=f)/u);
      requireContract(
        /^p[1-9][0-9]*$/u.test(owner!) && files.length > 0,
        'h06-temporal-server-lsof-format',
      );
      const pid = Number(owner!.slice(1));
      requireContract(Number.isSafeInteger(pid), 'h06-temporal-server-lsof-format');
      return files.map((entry) => {
        const [fd, ...fields] = entry.split('\n');
        requireContract(/^f\S+$/u.test(fd!), 'h06-temporal-server-lsof-format');
        const values = new Map<string, string>();
        for (const line of fields) {
          const key = line.slice(0, 1);
          requireContract(
            /^[atDin]$/u.test(key) && line.length > 1 && !values.has(key),
            'h06-temporal-server-lsof-format',
          );
          values.set(key, line.slice(1));
        }
        requireContract(values.has('n'), 'h06-temporal-server-lsof-format');
        return { pid, fd: fd!.slice(1), values };
      });
    });
}

function exactFile(
  row: ReturnType<typeof openFiles>[number],
  path: string,
  identity: ReturnType<typeof vnode>,
) {
  const device = row.values.get('D');
  const inode = row.values.get('i');
  return (
    row.values.get('n') === path &&
    row.values.get('t') === 'REG' &&
    device !== undefined &&
    /^0x[0-9a-f]+$/iu.test(device) &&
    BigInt(device) === identity.device &&
    inode !== undefined &&
    /^[0-9]+$/u.test(inode) &&
    BigInt(inode) === identity.inode
  );
}

/** Validate the trusted launch receipt against two bounded observations of the live server. */
export async function verifyH06NativeTemporalServer(
  expectedValue: ExpectedServer,
  proofValue: H04Pin,
  deadlineMs: number,
): Promise<void> {
  const expected = structuredClone(expectedValue);
  const { requestHash, binary: binaryValue, address, httpPort, metricsPort, sqlitePath } = expected;
  const binary = h04Pin(binaryValue);
  const grpc = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(address);
  requireContract(
    /^[a-f0-9]{64}$/u.test(requestHash) &&
      grpc !== null &&
      [Number(grpc[1]), httpPort, metricsPort].every(validPort) &&
      new Set([Number(grpc[1]), httpPort, metricsPort]).size === 3 &&
      isAbsolute(sqlitePath) &&
      resolve(sqlitePath) === sqlitePath &&
      !/[\s\p{Cc}]/u.test(binary.path + sqlitePath) &&
      binary.path !== sqlitePath,
    'h06-temporal-server-expected',
  );
  const proof = h04Pin(structuredClone(proofValue));
  const receipt = object(JSON.parse(readH04Pin(proof).toString('utf8')) as unknown);
  exactFields(receipt, [
    'kind',
    'requestHash',
    'binary',
    'address',
    'httpPort',
    'metricsPort',
    'sqlitePath',
    'process',
  ]);
  const { kind, process: launchProcess, ...binding } = receipt;
  requireContract(
    kind === 'comparison-h06-native-temporal-server/2' && same(binding, expected),
    'h06-temporal-server-binding',
  );
  const identity = object(launchProcess);
  exactFields(identity, ['pid', 'parent', 'started']);
  const { pid, parent, started } = identity;
  requireContract(
    typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      typeof parent === 'number' &&
      Number.isSafeInteger(parent) &&
      parent > 0 &&
      parent !== pid &&
      typeof started === 'string' &&
      startTime.test(started),
    'h06-temporal-server-process-identity',
  );

  const deadline = performance.now() + deadlineMs - Date.now();
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    requireContract(Number.isSafeInteger(deadlineMs) && left > 0, 'h06-temporal-server-deadline');
    return Math.min(left, 2000);
  };
  remaining();
  const executableIdentity = vnode(binary.path);
  verifyPinnedBinary(binary.path, binary.sha256);
  const databaseIdentity = vnode(sqlitePath);
  const command = [
    binary.path,
    'server',
    'start-dev',
    '--ip',
    '127.0.0.1',
    '--port',
    grpc[1],
    '--http-port',
    httpPort,
    '--metrics-port',
    metricsPort,
    '--headless',
    '--db-filename',
    sqlitePath,
  ].join(' ');

  async function observe(file: string, args: string[], allowAbsent = false) {
    const timeout = remaining();
    try {
      const result = await exec(file, args, {
        encoding: 'utf8',
        env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', NODE_ENV: 'production' },
        timeout,
        maxBuffer: 1024 * 1024,
      });
      requireContract(
        result.stderr === '' && result.stdout !== '',
        'h06-temporal-server-probe-output',
      );
      return result.stdout;
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (allowAbsent && failure.code === 1 && failure.stdout === '' && failure.stderr === '')
        return '';
      throw new Error('h06-temporal-server-probe-failed', { cause: error });
    }
  }
  async function observeIdentity() {
    const row = processLine.exec(
      (
        await observe(ps, [
          '-ww',
          '-p',
          String(pid),
          '-o',
          'pid=',
          '-o',
          'ppid=',
          '-o',
          'lstart=',
          '-o',
          'command=',
        ])
      ).trim(),
    );
    requireContract(
      row !== null &&
        Number(row[1]) === pid &&
        Number(row[2]) === parent &&
        row[3] === started &&
        row[4] === command,
      'h06-temporal-server-process-changed',
    );
  }
  async function observePort(port: number, required: boolean) {
    const rows = openFiles(
      await observe(lsof, ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpfnt'], !required),
    );
    requireContract(!required || rows.length === 1, 'h06-temporal-server-listener-required');
    requireContract(
      rows.every(
        (row) =>
          row.pid === pid &&
          row.values.get('t') === 'IPv4' &&
          row.values.get('n') === '127.0.0.1:' + port,
      ),
      'h06-temporal-server-listener-owner',
    );
  }

  await observeIdentity();
  for (let pass = 0; pass < 2; pass++) {
    await Promise.all([
      observePort(Number(grpc[1]), true),
      observePort(httpPort, false),
      observePort(metricsPort, false),
      observe(lsof, ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-FpfntDi']).then((output) => {
        const files = openFiles(output);
        requireContract(
          files.every((row) => row.pid === pid && row.fd === 'txt') &&
            files.some((row) => exactFile(row, binary.path, executableIdentity)),
          'h06-temporal-server-executable-owner',
        );
      }),
      observe(lsof, ['-nP', '-FpfatDin', '--', sqlitePath]).then((output) => {
        const files = openFiles(output);
        requireContract(
          files.every((row) => row.pid === pid && exactFile(row, sqlitePath, databaseIdentity)) &&
            files.some((row) => /^[0-9]+$/u.test(row.fd) && row.values.get('a') === 'u'),
          'h06-temporal-server-database-owner',
        );
      }),
    ]);
    await observeIdentity();
  }
  verifyPinnedBinary(binary.path, binary.sha256);
  requireContract(
    same(vnode(binary.path), executableIdentity) && same(vnode(sqlitePath), databaseIdentity),
    'h06-temporal-server-files-changed',
  );
  readH04Pin(proof);
  remaining();
}

import type * as ChildProcess from 'node:child_process';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../src/adapters/artifacts/files.js';
import { verifyH06NativeTemporalServer } from './comparisonH06NativeTemporalServer.js';

const ports = vi.hoisted(() => ({
  observe:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { timeout: number; env: Record<string, string> },
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
}));
vi.mock('node:child_process', async (load) => {
  const original = await load<typeof ChildProcess>();
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: ports.observe,
  });
  return { ...original, execFile };
});

const roots: string[] = [];
afterEach(() => {
  ports.observe.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-server-'));
  roots.push(root);
  const binary = { path: join(root, 'temporal'), sha256: digest('executable') };
  const sqlitePath = join(root, 'temporal.sqlite');
  writeFileSync(binary.path, 'executable', { mode: 0o700 });
  writeFileSync(sqlitePath, 'database');
  const expected = {
    requestHash: digest('request'),
    binary,
    address: '127.0.0.1:17233',
    httpPort: 17234,
    metricsPort: 17235,
    sqlitePath,
  };
  const identity = { pid: 1234, parent: 123, started: 'Wed Nov  4 19:31:33 2026' };
  const args = `server start-dev --ip 127.0.0.1 --port 17233 --http-port 17234 --metrics-port 17235 --headless --db-filename ${sqlitePath}`;
  const processLine = ` ${identity.pid} ${identity.parent} ${identity.started}     ${binary.path} ${args}\n`;
  function fields(path: string) {
    const file = lstatSync(path, { bigint: true });
    return `tREG\nD0x${file.dev.toString(16)}\ni${file.ino}\nn${path}\n`;
  }
  const exe = `p1234\nftxt\n${fields(binary.path)}`;
  const db = `p1234\nf7\nau\n${fields(sqlitePath)}`;
  const listen = (port: number) => `p1234\nf9\ntIPv4\nn127.0.0.1:${port}\n`;
  const absent = Object.assign(new Error('no listener'), { code: 1, stdout: '', stderr: '' });
  function probe(file: string, args: string[]) {
    if (file === '/bin/ps') return processLine;
    if (args.includes('txt')) return exe;
    if (args.includes('--')) return db;
    if (args.includes('-iTCP:17233')) return listen(17233);
    if (args.includes('-iTCP:17234')) throw absent;
    return listen(17235);
  }
  ports.observe.mockImplementation(async (file, args) => ({
    stdout: probe(file, args),
    stderr: '',
  }));
  const receipt = {
    kind: 'comparison-h06-native-temporal-server/2',
    ...expected,
    process: identity,
  };
  function pin(value: unknown = receipt) {
    const path = join(root, 'server-launch.json');
    const body = JSON.stringify(value) + '\n';
    writeFileSync(path, body);
    return { path, sha256: digest(body) };
  }
  return {
    root,
    expected,
    receipt,
    identity,
    sqlitePath,
    binary,
    pin,
    probe,
    listen,
    processLine,
    exe,
    db,
    absent,
  };
}

it('binds both observations to the same exact executable, SQLite vnode, and loopback listeners', async () => {
  const f = fixture();
  await expect(
    verifyH06NativeTemporalServer(f.expected, f.pin(), Date.now() + 30000),
  ).resolves.toBeUndefined();
  expect(ports.observe.mock.calls.filter(([file]) => file === '/bin/ps')).toHaveLength(3);
  for (const [file, , { timeout, env }] of ports.observe.mock.calls) {
    expect(['/bin/ps', '/usr/sbin/lsof']).toContain(file);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(2000);
    expect(env).toEqual({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC', NODE_ENV: 'production' });
  }
});

it.each([
  ['requestHash', 'x'],
  ['address', '0.0.0.0:17233'],
  ['address', '127.0.0.1:65536'],
  ['httpPort', 0],
  ['metricsPort', 1.5],
  ['metricsPort', 17234],
  ['sqlitePath', 'db.sqlite'],
] as const)('rejects malformed expected %s=%s', async (key, value) => {
  const f = fixture();
  await expect(
    verifyH06NativeTemporalServer({ ...f.expected, [key]: value }, f.pin(), Date.now() + 30000),
  ).rejects.toThrow('h06-temporal-server-expected');
  expect(ports.observe).not.toHaveBeenCalled();
});

it.each([
  'sqlite-alias',
  'sqlite-space',
  'same-file',
  'binary-content',
  'sqlite-symlink',
  'sqlite-directory',
  'sqlite-hardlink',
] as const)('rejects an invalid initial file boundary (%s)', async (which) => {
  const f = fixture();
  const expected = { ...f.expected };
  if (which === 'sqlite-alias')
    expected.sqlitePath = f.root + '/../' + f.root.split('/').at(-1)! + '/temporal.sqlite';
  if (which === 'sqlite-space') expected.sqlitePath = join(f.root, 'space name.sqlite');
  if (which === 'same-file') expected.sqlitePath = f.binary.path;
  if (which === 'binary-content') writeFileSync(f.binary.path, 'different executable');
  if (which === 'sqlite-symlink') {
    renameSync(f.sqlitePath, f.sqlitePath + '.original');
    symlinkSync(f.sqlitePath + '.original', f.sqlitePath);
  }
  if (which === 'sqlite-directory') {
    rmSync(f.sqlitePath);
    mkdirSync(f.sqlitePath);
  }
  if (which === 'sqlite-hardlink') linkSync(f.sqlitePath, f.sqlitePath + '.second');
  await expect(
    verifyH06NativeTemporalServer(
      expected,
      f.pin({ ...f.receipt, ...expected }),
      Date.now() + 30000,
    ),
  ).rejects.toThrow();
  expect(ports.observe).not.toHaveBeenCalled();
});

it.each([
  { kind: 'wrong-kind' },
  { address: '127.0.0.1:17240' },
  { process: { pid: 1, parent: 2, started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234, parent: 1234, started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234, parent: 0, started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234, parent: 2, started: 'wrong start' } },
  { process: { pid: '1234', parent: 2, started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234.1, parent: 2, started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234, parent: '2', started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234, parent: 2.1, started: 'Wed Nov  4 19:31:33 2026' } },
  { process: { pid: 1234, parent: 2, started: 5 } },
])('rejects unbound or malformed launch receipt %j', async (change) => {
  const f = fixture();
  await expect(
    verifyH06NativeTemporalServer(
      f.expected,
      f.pin({ ...f.receipt, ...change }),
      Date.now() + 30000,
    ),
  ).rejects.toThrow();
  expect(ports.observe).not.toHaveBeenCalled();
});

it.each([0, Number.NaN])(
  'fails before observation if the deadline is invalid or exhausted (%s)',
  async (deadline) => {
    const f = fixture();
    await expect(verifyH06NativeTemporalServer(f.expected, f.pin(), deadline)).rejects.toThrow(
      'h06-temporal-server-deadline',
    );
    expect(ports.observe).not.toHaveBeenCalled();
  },
);

it.each(['format', 'pid', 'parent', 'started', 'argv', 'warning', 'empty', 'permission'] as const)(
  'refuses an unconfirmed process observation (%s)',
  async (which) => {
    const f = fixture();
    const lines = {
      format: 'wrong\n',
      pid: f.processLine.replace('1234', '1235'),
      parent: f.processLine.replace(' 123 ', ' 124 '),
      started: f.processLine.replace('19:31', '19:30'),
      argv: f.processLine.replace('--headless', '--log-format json'),
      warning: f.processLine,
      empty: '',
      permission: f.processLine,
    };
    ports.observe.mockImplementation(async () => {
      if (which === 'permission')
        throw Object.assign(new Error('access denied'), { code: 1, stdout: '', stderr: 'denied' });
      return { stdout: lines[which], stderr: which === 'warning' ? 'warning' : '' };
    });
    await expect(
      verifyH06NativeTemporalServer(f.expected, f.pin(), Date.now() + 30000),
    ).rejects.toThrow();
    expect(ports.observe).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['grpc', 'foreign-owner'],
  ['grpc', 'wildcard'],
  ['grpc', 'ipv6'],
  ['grpc', 'missing'],
  ['grpc', 'duplicate'],
  ['http', 'foreign-owner'],
  ['metrics', 'foreign-owner'],
  ['metrics', 'warning-absent'],
  ['metrics', 'timeout-absent'],
] as const)('refuses a disputed listener (%s, %s)', async (name, which) => {
  const f = fixture();
  const number = { grpc: 17233, http: 17234, metrics: 17235 }[name];
  const listener = f.listen(number);
  const replacements = {
    'foreign-owner': listener.replace('p1234', 'p9876'),
    wildcard: listener.replace('127.0.0.1', '*'),
    ipv6: listener.replace('tIPv4', 'tIPv6'),
    missing: '',
    duplicate: listener + listener,
    'warning-absent': '',
    'timeout-absent': '',
  };
  ports.observe.mockImplementation(async (file, args) => {
    if (!args.includes('-iTCP:' + number)) return { stdout: f.probe(file, args), stderr: '' };
    if (which === 'missing') throw f.absent;
    if (which === 'warning-absent')
      throw Object.assign(new Error('unknown'), { code: 1, stdout: '', stderr: 'warning' });
    if (which === 'timeout-absent')
      throw Object.assign(new Error('timeout'), { code: null, stdout: '', stderr: '' });
    return { stdout: replacements[which], stderr: '' };
  });
  await expect(
    verifyH06NativeTemporalServer(f.expected, f.pin(), Date.now() + 30000),
  ).rejects.toThrow();
});

it.each([
  ['txt', 'pid'],
  ['txt', 'fd'],
  ['txt', 'name'],
  ['txt', 'type'],
  ['txt', 'device-absent'],
  ['txt', 'device-format'],
  ['txt', 'device-foreign'],
  ['txt', 'inode-absent'],
  ['txt', 'inode-format'],
  ['txt', 'inode-foreign'],
  ['db', 'pid'],
  ['db', 'fd'],
  ['db', 'access'],
] as const)('refuses unbound file observations (%s, %s)', async (kind, which) => {
  const f = fixture();
  const source = kind === 'txt' ? f.exe : f.db;
  const changes = {
    pid: source.replace('p1234', 'p4321'),
    fd: source.replace(/\nf(?:txt|7)\n/u, kind === 'txt' ? '\nf8\n' : '\nfmem\n'),
    name: source.replace(f.binary.path, f.binary.path + '.old'),
    type: source.replace('tREG', 'tDIR'),
    'device-absent': source.replace(/^D.*\n/mu, ''),
    'device-format': source.replace(/^D.*$/mu, 'Dwrong'),
    'device-foreign': source.replace(/^D.*$/mu, 'D0x0'),
    'inode-absent': source.replace(/^i.*\n/mu, ''),
    'inode-format': source.replace(/^i.*$/mu, 'iwrong'),
    'inode-foreign': source.replace(/^i.*$/mu, 'i0'),
    access: source.replace('au\n', 'ar\n'),
  };
  ports.observe.mockImplementation(async (file, args) => ({
    stdout: args.includes(kind === 'txt' ? 'txt' : '--') ? changes[which] : f.probe(file, args),
    stderr: '',
  }));
  await expect(
    verifyH06NativeTemporalServer(f.expected, f.pin(), Date.now() + 30000),
  ).rejects.toThrow(
    'h06-temporal-server-' + (kind === 'txt' ? 'executable' : 'database') + '-owner',
  );
});

it.each([
  'p1234\nf9\nn127.0.0.1:17233',
  'o1234\nf9\nn127.0.0.1:17233\n',
  'p1234\n',
  'p9007199254740993\nf9\nn127.0.0.1:17233\n',
  'p1234\nf\nn127.0.0.1:17233\n',
  'p1234\nf9\nxunexpected\n',
  'p1234\nf9\nn\n',
  'p1234\nf9\nn127.0.0.1:17233\nn127.0.0.1:17233\n',
  'p1234\nf9\ntIPv4\n',
])('fails closed on malformed lsof records %j', async (stdout) => {
  const f = fixture();
  ports.observe.mockImplementation(async (file, args) => ({
    stdout: args.includes('-iTCP:17233') ? stdout : f.probe(file, args),
    stderr: '',
  }));
  await expect(
    verifyH06NativeTemporalServer(f.expected, f.pin(), Date.now() + 30000),
  ).rejects.toThrow('h06-temporal-server-lsof-format');
});

it.each(['process', 'listener', 'database', 'binary', 'proof'] as const)(
  'catches replacement between observations (%s)',
  async (which) => {
    const f = fixture();
    const proof = f.pin();
    let processProbes = 0;
    ports.observe.mockImplementation(async (file, args) => {
      const output = f.probe(file, args);
      if (file === '/bin/ps') processProbes++;
      if (processProbes === 2 && args.includes('-iTCP:17233') && which === 'listener')
        return { stdout: output.replace('p1234', 'p4321'), stderr: '' };
      if (processProbes === 3 && file === '/bin/ps') {
        if (which === 'process') return { stdout: output.replace('19:31', '19:30'), stderr: '' };
        if (which === 'database' || which === 'binary') {
          const path = which === 'database' ? f.sqlitePath : f.binary.path;
          renameSync(path, path + '.old');
          writeFileSync(path, which === 'database' ? 'database' : 'executable', { mode: 0o700 });
        }
        if (which === 'proof') f.pin({ ...f.receipt, kind: 'changed' });
      }
      return { stdout: output, stderr: '' };
    });
    await expect(
      verifyH06NativeTemporalServer(f.expected, proof, Date.now() + 30000),
    ).rejects.toThrow();
  },
);

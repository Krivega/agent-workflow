import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pinnedSpawn, processSample } from './t4-pg-temporal-binaries.mjs';

export function descendantPids(parent, output) {
  assert.equal(output.status, 0, 'process observation unavailable');
  const rows = output.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/u)),
    owned = new Set([parent]);
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const row of rows) if (owned.has(Number(row[1]))) owned.add(Number(row[0]));
  }
  return [...owned];
}
function observe(args, pins, environment, execute) {
  return pinnedSpawn(
    '/usr/sbin/lsof',
    args,
    { encoding: 'utf8', timeout: 2000, env: environment },
    pins,
    execute,
  );
}
export function assertOwnedPostgres(data, socket, port, binary, pins, environment, execute) {
  const path = join(data, 'postmaster.pid'),
    stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.nlink === 1, 'unsafe postmaster identity file');
  const lines = readFileSync(path, 'utf8').split('\n'),
    pid = Number(lines[0]);
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'invalid postmaster PID');
  assert.equal(realpathSync(lines[1]), realpathSync(data), 'postmaster data-directory mismatch');
  assert.equal(Number(lines[3]), port, 'postmaster port mismatch');
  assert.equal(lines[4], socket, 'postmaster private socket mismatch');
  const processes = processSample(pins, execute, environment);
  assert.ok(
    processes.stdout
      .trim()
      .split('\n')
      .some((line) => Number(line.trim().split(/\s+/u)[0]) === pid),
    'postmaster process missing',
  );
  const tcp = observe(
      ['-nP', '-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'],
      pins,
      environment,
      execute,
    ),
    unix = observe(['-nP', '-a', '-p', String(pid), '-U', '-Fn'], pins, environment, execute),
    text = observe(
      ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn'],
      pins,
      environment,
      execute,
    );
  for (const result of [tcp, unix, text]) {
    assert.equal(result.status, 0, 'postmaster ownership observation unavailable');
    assert.ok(result.stdout.split('\n').includes('p' + pid), 'observer PID mismatch');
  }
  assert.ok(
    tcp.stdout.split('\n').includes('n127.0.0.1:' + port),
    'PostgreSQL TCP listener is not owned loopback',
  );
  assert.ok(
    unix.stdout.split('\n').includes('n' + join(socket, '.s.PGSQL.' + port)),
    'PostgreSQL private socket is not owned',
  );
  assert.ok(
    text.stdout.split('\n').includes('n' + binary),
    'postmaster executable identity mismatch',
  );
  return { pid, data, socket, port, descendants: descendantPids(pid, processes) };
}
function assertStopObservation(result, statuses, message) {
  const diagnostic = result.error || result.signal || result.stderr?.trim();
  assert.ok(
    statuses.includes(result.status) && typeof result.stdout === 'string' && !diagnostic,
    diagnostic ? message + ': ' + diagnostic : message,
  );
}
export function assertServicesStopped(pids, ports, socketPath, pins, environment, execute) {
  const processes = processSample(pins, execute, environment);
  assertStopObservation(processes, [0], 'process stop observation unavailable');
  const alive = new Set(
    processes.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => Number(line.trim().split(/\s+/u)[0])),
  );
  assert.ok(!pids.some((pid) => alive.has(pid)), 'owned process or descendant still present');
  for (const port of ports) {
    const result = observe(
      ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'],
      pins,
      environment,
      execute,
    );
    assertStopObservation(
      result,
      [1],
      'listener remains or TCP stop observation unavailable: ' + port,
    );
    assert.equal(result.stdout.trim(), '', 'listener output remains');
  }
  if (socketPath) {
    const unix = observe(['-nP', '-U', '-Fn'], pins, environment, execute);
    assertStopObservation(unix, [0, 1], 'Unix socket stop observation unavailable');
    assert.ok(
      !unix.stdout.split('\n').includes('n' + socketPath),
      'private PostgreSQL socket still owned by a process',
    );
  }
  return { descendantsStopped: true, listenersStopped: true };
}

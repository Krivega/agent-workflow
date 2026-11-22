import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import console from 'node:console';
import process from 'node:process';

const scope = 'isolated-synthetic-postgres-restore';
export function isolatedPostgresEnvironment(environment, socket, port) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith('PG')),
    ),
    PGHOST: socket,
    PGPORT: String(port),
    PGUSER: 'aw_recovery',
    PGCONNECT_TIMEOUT: '5',
  };
}
function elapsedMs(start, end) {
  assert.ok(
    Number.isFinite(start) && Number.isFinite(end) && end >= start,
    'monotonic clock invalid',
  );
  return Math.round(end - start);
}
function fields(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'unexpected fields');
}
export function parseConfig(value) {
  fields(value, [
    'schemaVersion',
    'authorization',
    'binaries',
    'parent',
    'port',
    'limits',
    'rpoTargetMs',
    'rtoTargetMs',
  ]);
  assert.equal(value.schemaVersion, 1);
  fields(value.authorization, ['scope', 'evidence']);
  assert.equal(value.authorization.scope, scope);
  assert.equal(typeof value.authorization.evidence, 'string');
  assert.ok(
    value.authorization.evidence.length >= 10 && !value.authorization.evidence.includes('REPLACE'),
    'direct user authorization must be recorded before run',
  );
  for (const path of [value.binaries, value.parent])
    assert.ok(
      typeof path === 'string' && isAbsolute(path) && !/[\r\n\0]/u.test(path),
      'absolute local path required',
    );
  assert.ok(
    Number.isSafeInteger(value.port) && value.port >= 1024 && value.port <= 65535,
    'unprivileged port required',
  );
  fields(value.limits, ['wallTimeMs', 'sharedBuffersMb', 'maxConnections', 'maxDiskBytes']);
  for (const [key, minimum, maximum] of [
    ['wallTimeMs', 30_000, 180_000],
    ['sharedBuffersMb', 16, 64],
    ['maxConnections', 4, 8],
    ['maxDiskBytes', 64 * 1024 * 1024, 512 * 1024 * 1024],
  ])
    assert.ok(
      Number.isSafeInteger(value.limits[key]) &&
        value.limits[key] >= minimum &&
        value.limits[key] <= maximum,
      'resource limit invalid: ' + key,
    );
  for (const key of ['rpoTargetMs', 'rtoTargetMs'])
    assert.ok(Number.isSafeInteger(value[key]) && value[key] > 0, 'target required');
  return value;
}
export function recoveryPlan(config) {
  const v = parseConfig(config);
  return {
    scope,
    serverStarts: 1,
    models: 0,
    installations: 0,
    network: 'Unix socket only; TCP disabled',
    port: v.port,
    files: 'one newly created aw-t4-pg-* child of ' + v.parent,
    changes: [
      'initdb private synthetic cluster',
      'create source database and FAIL/evidence fixture',
      'custom pg_dump',
      'DROP DATABASE of synthetic source',
      'create independent destination and pg_restore',
      'compare original IDs/hash/FAIL/findings/Result',
      'stop PostgreSQL in finally',
    ],
    limits: v.limits,
    processLimit: 'one PostgreSQL cluster; maintenance autovacuum and parallel workers disabled',
    stop: 'pg_ctl -D <reported root>/data -m immediate -w stop; no persistent service',
    retained:
      'proof.json, operator-config.json, postgres.log, real dump and stopped synthetic cluster stay in the reported root for inspection',
    limitations: [
      'synthetic PostgreSQL database only',
      'Temporal schema/server/replay/worker continuation NOT RUN',
      'daily backup scheduling and disk-failure RPO/RTO NOT RUN',
      'disk bound checked between commands; no filesystem quota or hard process RSS cap',
    ],
  };
}
function size(path) {
  const stat = lstatSync(path);
  return stat.isDirectory()
    ? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0)
    : stat.size;
}
function postgresResources(data) {
  if (!existsSync(join(data, 'postmaster.pid'))) return null;
  const pid = Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]),
    result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,time='], {
      encoding: 'utf8',
      timeout: 2000,
    });
  if (result.status !== 0) return { status: 'unknown' };
  const rows = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/u)),
    owners = new Set([pid]);
  for (let previous = -1; previous !== owners.size;) {
    previous = owners.size;
    for (const row of rows) if (owners.has(Number(row[1]))) owners.add(Number(row[0]));
  }
  const processes = rows
    .filter((row) => owners.has(Number(row[0])))
    .map((row) => ({ pid: Number(row[0]), rssKb: Number(row[2]), cpuTime: row[3] }));
  return {
    status: 'observed',
    processes,
    rssKbSum: processes.reduce((sum, row) => sum + row.rssKb, 0),
    caveat: 'shared pages counted per process; point-in-time samples do not establish a hard peak',
  };
}
export function runRecovery(raw) {
  const config = parseConfig(raw),
    plan = recoveryPlan(config),
    parent = realpathSync(config.parent);
  assert.equal(parent, resolve(config.parent), 'linked parent rejected');
  assert.ok(lstatSync(parent).isDirectory());
  for (const name of ['initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore'])
    assert.ok(
      lstatSync(join(config.binaries, name)).isFile(),
      'missing PostgreSQL binary: ' + name,
    );
  const root = mkdtempSync(join(parent, 'aw-t4-pg-')),
    data = join(root, 'data'),
    socket = join(root, 'socket'),
    dump = join(root, 'source.pgdump'),
    childEnvironment = isolatedPostgresEnvironment(process.env, socket, config.port),
    startedAt = Date.now(),
    startedMono = performance.now(),
    deadline = startedMono + config.limits.wallTimeMs,
    proof = {
      schemaVersion: 1,
      scope,
      status: 'RUNNING',
      authorization: config.authorization,
      root,
      plan,
      startedAt: new Date(startedAt).toISOString(),
      modelStarts: 0,
      temporalPersistenceRestore: 'NOT RUN',
      phases: [],
      resources: { nodeMaxRssKb: null, diskBytes: 0 },
      cleanup: { stopped: false, exitStatus: null },
    };
  chmodSync(root, 0o700);
  mkdirSync(socket, { mode: 0o700 });
  writeFileSync(join(root, 'operator-config.json'), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  const persist = () =>
    writeFileSync(join(root, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
  persist();
  function run(name, args) {
    const remaining = Math.floor(deadline - performance.now());
    assert.ok(remaining > 0, 'wall-time budget exhausted');
    const began = performance.now(),
      output = execFileSync(join(config.binaries, name), args, {
        encoding: 'utf8',
        timeout: remaining,
        maxBuffer: 4 * 1024 * 1024,
        env: childEnvironment,
      });
    proof.phases.push({ command: name, elapsedMs: elapsedMs(began, performance.now()) });
    proof.resources.diskBytes = size(root);
    proof.resources.postgresLast = postgresResources(data);
    persist();
    assert.ok(proof.resources.diskBytes <= config.limits.maxDiskBytes, 'disk budget exceeded');
    return output.trim();
  }
  const sql = (database, query) =>
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database, '-c', query]);
  let primaryError;
  try {
    proof.postgresVersion = run('psql', ['--version']);
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'aw_recovery', '--no-locale', '-E', 'UTF8']);
    const quote = (text) => "'" + text.replaceAll("'", "''") + "'";
    appendFileSync(
      join(data, 'postgresql.conf'),
      `\nlisten_addresses=''\nunix_socket_directories=${quote(socket)}\nport=${config.port}\nshared_buffers='${config.limits.sharedBuffersMb}MB'\nmax_connections=${config.limits.maxConnections}\nwork_mem='1MB'\nmaintenance_work_mem='16MB'\nmax_wal_size='64MB'\nmin_wal_size='32MB'\ntemp_file_limit='64MB'\nmax_worker_processes=0\nmax_parallel_workers=0\nautovacuum=off\nfsync=on\n`,
    );
    run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-w', 'start']);
    sql('postgres', 'CREATE DATABASE probe_source');
    const original = 'original FAIL F-1 Result',
      evidenceHash = createHash('sha256').update(original).digest('hex');
    sql(
      'probe_source',
      `CREATE TABLE recovery_probe (id text PRIMARY KEY,event_id text,evidence_sha256 text,outcome text,payload jsonb); INSERT INTO recovery_probe VALUES ('proof-1','event-7','${evidenceHash}','FAIL','{"findings":[{"id":"F-1","status":"open"}],"Result":"FAIL","raw":"${original}"}');`,
    );
    const query =
        'SELECT id,event_id,evidence_sha256,outcome,payload::text FROM recovery_probe ORDER BY id',
      expected = sql('probe_source', query),
      snapshotAt = Date.now(),
      snapshotMono = performance.now();
    run('pg_dump', ['-Fc', '-d', 'probe_source', '-f', dump]);
    const dumpBytes = readFileSync(dump);
    assert.equal(dumpBytes.subarray(0, 5).toString(), 'PGDMP');
    chmodSync(dump, 0o600);
    proof.dump = {
      sha256: createHash('sha256').update(dumpBytes).digest('hex'),
      bytes: dumpBytes.length,
    };
    sql(
      'probe_source',
      "INSERT INTO recovery_probe VALUES ('after-snapshot','event-lost','unknown','unknown','{}')",
    );
    const lossAt = Date.now(),
      lossMono = performance.now();
    sql('postgres', 'DROP DATABASE probe_source');
    proof.sourceDroppedBeforeRestore = true;
    sql('postgres', 'CREATE DATABASE probe_restored');
    run('pg_restore', [
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
      '-d',
      'probe_restored',
      dump,
    ]);
    const restored = sql('probe_restored', query);
    assert.equal(restored, expected, 'restored original evidence differs');
    const restoredAt = Date.now(),
      restoredMono = performance.now();
    proof.recovery = {
      snapshotAt: new Date(snapshotAt).toISOString(),
      lossAt: new Date(lossAt).toISOString(),
      restoredAt: new Date(restoredAt).toISOString(),
      clock: 'monotonic performance.now; UTC annotations only',
      rpoMs: elapsedMs(snapshotMono, lossMono),
      rtoMs: elapsedMs(lossMono, restoredMono),
      rpoTargetMs: config.rpoTargetMs,
      rtoTargetMs: config.rtoTargetMs,
      deliberatelyUnbackedRows: 1,
      originalIdsHashesFailFindingsResult: true,
    };
    assert.ok(proof.recovery.rpoMs <= config.rpoTargetMs, 'RPO target missed');
    assert.ok(proof.recovery.rtoMs <= config.rtoTargetMs, 'RTO target missed');
    proof.status = 'PASS';
  } catch (error) {
    primaryError = error;
    proof.status = 'FAIL';
    proof.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (existsSync(join(data, 'PG_VERSION'))) {
      const stopped = spawnSync(
          join(config.binaries, 'pg_ctl'),
          ['-D', data, '-m', 'immediate', '-w', 'stop'],
          { encoding: 'utf8', timeout: 15_000, env: childEnvironment },
        ),
        status = spawnSync(join(config.binaries, 'pg_ctl'), ['-D', data, 'status'], {
          encoding: 'utf8',
          timeout: 5000,
          env: childEnvironment,
        });
      proof.cleanup = {
        stopped: status.status === 3,
        exitStatus: stopped.status,
        statusAfterStop: status.status,
      };
      if (!proof.cleanup.stopped) {
        proof.status = 'FAIL';
        proof.cleanup.error = stopped.stderr + status.stderr;
      }
    } else proof.cleanup = { stopped: true, exitStatus: null, clusterNeverInitialized: true };
    proof.resources.nodeMaxRssKb = process.resourceUsage().maxRSS;
    proof.resources.diskBytes = size(root);
    proof.elapsedMs = elapsedMs(startedMono, performance.now());
    persist();
    console.log(
      JSON.stringify({
        status: proof.status,
        root,
        proof: join(root, 'proof.json'),
        cleanup: proof.cleanup,
        recovery: proof.recovery ?? null,
        temporalPersistenceRestore: 'NOT RUN',
      }),
    );
  }
  if (primaryError || proof.status !== 'PASS') process.exitCode = 1;
  return proof;
}
export function selfTest() {
  const config = {
    schemaVersion: 1,
    authorization: { scope, evidence: 'self-test only; no server launch authorized' },
    binaries: '/example/postgres/bin',
    parent: '/private/tmp',
    port: 55437,
    limits: {
      wallTimeMs: 120_000,
      sharedBuffersMb: 32,
      maxConnections: 8,
      maxDiskBytes: 256 * 1024 * 1024,
    },
    rpoTargetMs: 86_400_000,
    rtoTargetMs: 7_200_000,
  };
  assert.deepEqual(parseConfig(config), config);
  const plan = recoveryPlan(config);
  assert.equal(plan.serverStarts, 1);
  assert.equal(plan.installations, 0);
  assert.equal(elapsedMs(12.4, 32.4), 20);
  assert.throws(() => elapsedMs(32.4, 12.4));
  const polluted = {
      KEEP: 'fixture',
      PGSERVICE: 'fixture-service',
      PGSERVICEFILE: '/fixture/service',
      PGHOSTADDR: 'fixture-address',
      PGDATABASE: 'fixture-database',
      PGPASSWORD: 'fixture-password',
      PGPASSFILE: '/fixture/password-file',
      PGOPTIONS: 'fixture-options',
      PGDATA: '/fixture/data',
      PGHOST: 'fixture-host',
      PGPORT: '1234',
      PGUSER: 'fixture-user',
    },
    before = JSON.stringify(polluted),
    clean = isolatedPostgresEnvironment(polluted, '/fixture/private-socket', 55437);
  assert.deepEqual(
    Object.keys(clean)
      .filter((key) => key.toUpperCase().startsWith('PG'))
      .sort(),
    ['PGCONNECT_TIMEOUT', 'PGHOST', 'PGPORT', 'PGUSER'],
  );
  assert.equal(clean.KEEP, polluted.KEEP);
  assert.equal(clean.PGHOST, '/fixture/private-socket');
  assert.equal(clean.PGPORT, '55437');
  assert.equal(clean.PGUSER, 'aw_recovery');
  assert.equal(clean.PGCONNECT_TIMEOUT, '5');
  assert.equal(JSON.stringify(polluted), before);
  for (const altered of [
    { ...config, authorization: null },
    { ...config, authorization: { scope, evidence: 'REPLACE_WITH_DIRECT_USER_AUTHORIZATION' } },
    { ...config, binaries: 'relative' },
    { ...config, port: 543 },
    { ...config, limits: { ...config.limits, maxConnections: 9 } },
    { ...config, limits: { ...config.limits, maxDiskBytes: 2 ** 40 } },
    { ...config, rpoTargetMs: 0 },
    { ...config, schemaVersion: 2 },
  ])
    assert.throws(() => parseConfig(altered));
  assert.equal(basename(fileURLToPath(import.meta.url)), 't4-postgres-recovery.mjs');
  console.log(
    JSON.stringify({
      status: 'PASS',
      scope: 'configuration-and-authorization-self-test',
      serverStarts: 0,
      modelStarts: 0,
      nativeDatabaseRestore: 'NOT RUN',
      pgEnvironmentIsolated: true,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
  else if (process.argv.length === 4 && process.argv[2] === '--run')
    runRecovery(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  else {
    console.error(
      'Usage: node t4-postgres-recovery.mjs --self-test | --run CONFIG.json (explicit user authorization required)',
    );
    process.exitCode = 2;
  }
}

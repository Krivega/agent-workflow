import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client, Connection } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/proto-utils';
import console from 'node:console';
import process from 'node:process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  scope = 'restore-closed-temporal-sqlite';
const systemIds = new Set(['temporal-sys-tq-scanner', 'temporal-sys-history-scanner']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = (bytes) => ({ sha256: hash(bytes), bytes: bytes.length });
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export function canonicalHistory(value) {
  return JSON.parse(historyToJSON(value));
}
function plain(file) {
  const stat = lstatSync(file);
  assert.ok(
    stat.isFile() && stat.nlink === 1 && realpathSync(file) === file,
    'plain unlinked file required: ' + file,
  );
  return readFileSync(file);
}
function inventory(root) {
  assert.equal(realpathSync(root), root);
  const entries = [];
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      assert.ok(
        !['host-owner', 'source-reservation', 'permission-lock'].includes(name) &&
          !name.startsWith('.pending-'),
        'unfinished source file: ' + name,
      );
      const file = join(directory, name),
        stat = lstatSync(file),
        path = prefix + name;
      assert.equal(realpathSync(file), file, 'linked source path');
      if (stat.isDirectory()) visit(file, path + '/');
      else entries.push({ path, ...ref(plain(file)) });
    }
  }
  visit(root, '');
  return entries;
}
export function assertClosedExecutions(rows) {
  const business = rows.filter((row) => row.workflowId.startsWith('aw/'));
  for (const row of rows)
    assert.ok(
      row.workflowId.startsWith('aw/') || systemIds.has(row.workflowId),
      'unknown workflow identity: ' + row.workflowId,
    );
  assert.equal(business.length, 8, 'expected eight selected business executions');
  for (const row of business)
    assert.ok(
      row.status >= 2 && row.status <= 7 && row.closeTime,
      'business execution is not closed: ' + row.workflowId,
    );
  return business;
}
function closedRows(database) {
  for (const suffix of ['-journal', '-wal', '-shm'])
    assert.equal(existsSync(database + suffix), false, 'uncheckpointed snapshot: ' + suffix);
  const before = ref(plain(database)),
    db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const rows = db
        .prepare(
          'SELECT workflow_id AS workflowId,CAST(run_id AS TEXT) AS runId,status,close_time AS closeTime FROM executions_visibility ORDER BY workflow_id,run_id',
        )
        .all(),
      business = assertClosedExecutions(rows);
    db.exec('COMMIT;');
    assert.deepEqual(ref(plain(database)), before, 'source SQLite changed during read');
    return {
      database: before,
      business: business.map((row) => ({ ...row })),
      systemExecutions: rows
        .filter((row) => systemIds.has(row.workflowId))
        .map((row) => ({ ...row })),
    };
  } finally {
    db.close();
  }
}
function artifactRefs(value, found = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) artifactRefs(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  if (
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  ) {
    const previous = found.get(value.sha256);
    assert.ok(
      previous === undefined || previous.bytes === value.bytes,
      'conflicting artifact size',
    );
    found.set(value.sha256, { sha256: value.sha256, bytes: value.bytes });
  }
  for (const item of Object.values(value)) artifactRefs(item, found);
  return found;
}
function payloadValue(payload) {
  const metadata = payload.metadata?.encoding,
    encoding = Buffer.from(
      metadata ?? [],
      typeof metadata === 'string' ? 'base64' : undefined,
    ).toString();
  assert.equal(encoding, 'json/plain', 'expected the existing JSON payload converter');
  return JSON.parse(
    Buffer.from(payload.data, typeof payload.data === 'string' ? 'base64' : undefined).toString(),
  );
}
function completedResult(history) {
  const last = history.events.at(-1),
    completed = last?.workflowExecutionCompletedEventAttributes;
  assert.ok(completed, 'selected PASS history must be completed');
  assert.equal(completed.result.payloads.length, 1);
  return payloadValue(completed.result.payloads[0]);
}
function verifyRefs(directory, refs) {
  for (const expected of refs)
    assert.deepEqual(
      ref(plain(join(directory, expected.sha256))),
      expected,
      'artifact bytes/hash differ',
    );
}
export function inspectCase(rawPath) {
  assert.ok(typeof rawPath === 'string' && isAbsolute(rawPath));
  const sourceCase = resolve(rawPath),
    files = inventory(sourceCase),
    state = closedRows(join(sourceCase, 'temporal.sqlite'));
  assert.equal(json(join(sourceCase, 'report.json')).status, 'PASS');
  const cleanup = json(join(sourceCase, 'cleanup.json'));
  assert.equal(cleanup.controlledStop, true);
  assert.deepEqual(cleanup.alive, []);
  const histories = state.business.map((row) => {
    const file = hash(row.workflowId) + '-history.json',
      bytes = plain(join(sourceCase, file)),
      history = JSON.parse(bytes),
      canonical = canonicalHistory(history);
    assert.equal(canonical.events.at(-1).eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED');
    const started = history.events[0].workflowExecutionStartedEventAttributes;
    assert.equal(
      started.originalExecutionRunId,
      row.runId,
      'snapshot run ID differs from original history',
    );
    return {
      ...row,
      file,
      original: ref(bytes),
      semanticSha256: hash(JSON.stringify(canonical)),
      result: completedResult(history),
    };
  });
  const recordedResult = json(join(sourceCase, 'result.json'));
  assert.deepEqual(
    histories.find((item) => item.workflowId.startsWith('aw/task/')).result,
    recordedResult,
    'primary result differs from closed history',
  );
  const refs = artifactRefs(recordedResult);
  artifactRefs(json(join(sourceCase, 'verified-summary.json')), refs);
  for (const history of histories) artifactRefs(history.result, refs);
  const artifacts = [];
  for (const name of readdirSync(join(sourceCase, 'artifacts')).sort()) {
    assert.match(name, /^[a-f0-9]{64}$/u);
    const bytes = plain(join(sourceCase, 'artifacts', name));
    assert.equal(hash(bytes), name);
    artifacts.push(ref(bytes));
  }
  verifyRefs(join(sourceCase, 'artifacts'), refs.values());
  assert.deepEqual(inventory(sourceCase), files, 'source case changed during inspection');
  return {
    schemaVersion: 1,
    format: 'temporal-cli-sqlite',
    cliVersion: '1.9.1',
    namespace: 'default',
    sourceCase,
    ...state,
    histories,
    files,
    artifactRefs: [...refs.values()],
    artifacts,
    unknown: {
      previousWorkspace: 'unknown; not restored',
      previousGrants: 'unknown; historical receipts are not authority',
      inFlightBusinessExecution: 'not imported',
      postgresRestore: 'NOT RUN',
    },
  };
}
export function parseConfig(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    'authorization',
    'cli',
    'schemaVersion',
    'sourceCase',
    'wallTimeMs',
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.authorization?.scope, scope);
  assert.equal(typeof value.authorization.evidence, 'string');
  assert.ok(
    value.authorization.evidence.length >= 10 && !value.authorization.evidence.includes('REPLACE'),
  );
  for (const key of ['sourceCase', 'cli'])
    assert.ok(typeof value[key] === 'string' && isAbsolute(value[key]));
  assert.ok(
    Number.isSafeInteger(value.wallTimeMs) &&
      value.wallTimeMs >= 30_000 &&
      value.wallTimeMs <= 180_000,
  );
  return value;
}
async function ports() {
  const listeners = [];
  try {
    for (let i = 0; i < 3; i++) {
      const server = createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      listeners.push(server);
    }
    return listeners.map((server) => server.address().port);
  } finally {
    await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
async function stopped(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exit;
  } finally {
    clearTimeout(timer);
  }
}
export async function runRestore(raw) {
  const config = parseConfig(raw),
    primary = inspectCase(config.sourceCase),
    original = primary.files,
    cli = resolve(config.cli),
    cliBytes = plain(cli);
  assert.ok(lstatSync(cli).mode & 0o100, 'cached CLI must already exist and be executable');
  const cliVersion = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.match(cliVersion, /\b1\.9\.1\b/u, 'requires the existing qualified CLI 1.9.1');
  const { createBackup, inspectFileBackup, stageRestore, verifyBackup } = await import(
      join(packageRoot, 'dist/adapters/artifacts/backup.js')
    ),
    { artifactStore } = await import(join(packageRoot, 'dist/adapters/artifacts/files.js')),
    evidence = realpathSync(mkdtempSync(join(packageRoot, 'tmp/t4-temporal-restore-'))),
    temporary = realpathSync(mkdtempSync(join(tmpdir(), 'aw-t4-temporal-'))),
    source = join(temporary, 'source'),
    restored = join(temporary, 'restored'),
    proof = {
      schemaVersion: 1,
      status: 'RUNNING',
      scope,
      authorization: config.authorization,
      evidence,
      sourceCase: primary.sourceCase,
      originalDatabase: primary.database,
      cli: { path: cli, ...ref(cliBytes), version: cliVersion },
      modelStarts: 0,
      workerStarts: 0,
      serverStarts: 0,
      recovered: [],
      unknown: primary.unknown,
      cleanup: {},
    };
  save(join(evidence, 'operator-config.json'), config);
  save(join(evidence, 'primary.json'), primary);
  let child, connection, watchdog;
  const started = performance.now();
  async function bounded(operation) {
    const remaining = Math.floor(config.wallTimeMs - (performance.now() - started));
    assert.ok(remaining > 0, 'wall budget exceeded');
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('wall budget exceeded')), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    mkdirSync(source, { mode: 0o700 });
    const roots = Object.fromEntries(
      ['artifacts', 'receipts', 'projections'].map((name) => [name, join(source, name)]),
    );
    for (const directory of Object.values(roots)) mkdirSync(directory, { mode: 0o700 });
    cpSync(join(primary.sourceCase, 'artifacts'), roots.artifacts, { recursive: true });
    for (const entry of readdirSync(primary.sourceCase))
      if (entry !== 'artifacts' && entry !== 'temporal.sqlite')
        cpSync(join(primary.sourceCase, entry), join(roots.receipts, entry), { recursive: true });
    const snapshot = artifactStore(roots.artifacts).publish(
      plain(join(primary.sourceCase, 'temporal.sqlite')),
    );
    assert.deepEqual(snapshot, primary.database);
    save(join(roots.projections, 'storage-manifest.json'), {
      ...primary,
      sourceCase: primary.sourceCase,
      database: snapshot,
    });
    const result = json(join(primary.sourceCase, 'result.json'));
    writeFileSync(
      join(roots.projections, 'result-projection.json'),
      plain(join(primary.sourceCase, 'artifacts', result.projection.sha256)),
      { mode: 0o600 },
    );
    const input = { schemaVersion: 2, roots, destination: join(evidence, 'backup') },
      inspected = inspectFileBackup(input),
      saved = createBackup(input, inspected.manifest);
    assert.deepEqual(saved.manifest, inspected.manifest);
    proof.backup = saved;
    verifyBackup({ schemaVersion: 1, backup: input.destination, manifest: saved.manifest });
    const loss = performance.now();
    rmSync(source, { recursive: true });
    assert.equal(existsSync(source), false);
    proof.sourceCopyRemovedBeforeRestore = true;
    stageRestore({
      schemaVersion: 1,
      backup: input.destination,
      manifest: saved.manifest,
      destination: restored,
    });
    const storage = json(join(restored, 'projections/storage-manifest.json'));
    assert.equal(storage.schemaVersion, 1);
    assert.deepEqual(storage.database, primary.database);
    assert.equal(storage.format, 'temporal-cli-sqlite');
    assert.equal(storage.cliVersion, '1.9.1');
    verifyRefs(join(restored, 'artifacts'), [primary.database, ...primary.artifacts]);
    mkdirSync(join(restored, 'runtime-data'), { mode: 0o700 });
    const database = join(restored, 'runtime-data/temporal.sqlite');
    writeFileSync(database, plain(join(restored, 'artifacts', snapshot.sha256)), { mode: 0o600 });
    assert.deepEqual(closedRows(database).business, primary.business);
    assert.ok(
      performance.now() - started < config.wallTimeMs,
      'wall budget exceeded before server start',
    );
    const [port, httpPort, metricsPort] = await ports(),
      address = '127.0.0.1:' + port,
      args = [
        'server',
        'start-dev',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--http-port',
        String(httpPort),
        '--metrics-port',
        String(metricsPort),
        '--headless',
        '--db-filename',
        database,
      ],
      stdout = openSync(join(evidence, 'server.stdout.log'), 'wx', 0o600),
      stderr = openSync(join(evidence, 'server.stderr.log'), 'wx', 0o600);
    try {
      child = spawn(cli, args, {
        cwd: temporary,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('TEMPORAL')),
        ),
        stdio: ['ignore', stdout, stderr],
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    proof.serverStarts = 1;
    proof.server = { pid: child.pid, address, httpPort, metricsPort, args };
    child.on('error', (error) => {
      proof.spawnError = String(error);
    });
    watchdog = setTimeout(
      () => {
        proof.wallBudgetExceeded = true;
        child.kill('SIGTERM');
      },
      Math.max(1, config.wallTimeMs - (performance.now() - started)),
    );
    connection = await bounded(() =>
      Connection.connect({
        address,
        connectTimeout: Math.max(1, config.wallTimeMs - (performance.now() - started)),
        channelArgs: { 'grpc.enable_http_proxy': 0 },
      }),
    );
    const client = new Client({ connection, namespace: 'default' });
    for (const expected of primary.histories) {
      assert.ok(performance.now() - started < config.wallTimeMs, 'wall budget exceeded');
      const handle = client.workflow.getHandle(expected.workflowId, expected.runId),
        description = await bounded(() => handle.describe()),
        history = await bounded(() => handle.fetchHistory()),
        value = await bounded(() => handle.result());
      assert.equal(description.status.name, 'COMPLETED');
      assert.equal(description.workflowId, expected.workflowId);
      assert.equal(description.runId, expected.runId);
      const originalHistory = json(join(restored, 'receipts', expected.file));
      assert.deepEqual(
        canonicalHistory(history),
        canonicalHistory(originalHistory),
        'protobuf history semantics differ',
      );
      assert.deepEqual(value, expected.result);
      save(
        join(evidence, expected.file.replace('-history.json', '-restored-history.json')),
        history,
      );
      proof.recovered.push({
        workflowId: expected.workflowId,
        runId: expected.runId,
        status: description.status.name,
        semanticSha256: hash(JSON.stringify(canonicalHistory(history))),
        originalHistory: expected.original,
        result: value,
      });
    }
    const listed = await bounded(() =>
      connection.workflowService.listWorkflowExecutions({
        namespace: 'default',
        query: "ExecutionStatus = 'Running'",
        pageSize: 100,
      }),
    );
    assert.equal(
      listed.executions.filter((execution) => execution.execution.workflowId.startsWith('aw/'))
        .length,
      0,
      'no selected business execution may be in flight',
    );
    verifyRefs(join(restored, 'artifacts'), primary.artifacts);
    const terminal = proof.recovered.find((item) => item.workflowId.startsWith('aw/task/'));
    assert.deepEqual(terminal.result, result);
    const resultBody = json(join(restored, 'artifacts', result.result.sha256)),
      projection = json(join(restored, 'projections/result-projection.json'));
    save(join(evidence, 'result-body.json'), resultBody);
    save(join(evidence, 'projection.json'), projection);
    proof.rtoMs = Math.round(performance.now() - loss);
    assert.ok(!proof.wallBudgetExceeded);
    proof.status = 'PASS';
  } catch (error) {
    proof.status = 'FAIL';
    proof.error = error instanceof Error ? error.stack : String(error);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        proof.status = 'FAIL';
        proof.cleanup.connectionCloseError = String(error);
      }
    }
    if (child) {
      await stopped(child);
      proof.cleanup.serverStopped = child.exitCode !== null || child.signalCode !== null;
      proof.cleanup.exitCode = child.exitCode;
      proof.cleanup.signal = child.signalCode;
    } else proof.cleanup.serverNeverStarted = true;
    if (existsSync(join(restored, 'artifacts'))) {
      try {
        verifyRefs(join(restored, 'artifacts'), [primary.database, ...primary.artifacts]);
        proof.cleanup.immutableSnapshotAndArtifactsUnchanged = true;
      } catch (error) {
        proof.status = 'FAIL';
        proof.cleanup.snapshotError = String(error);
      }
    }
    try {
      assert.deepEqual(inventory(primary.sourceCase), original);
      proof.cleanup.originalCaseUnchanged = true;
    } catch (error) {
      proof.status = 'FAIL';
      proof.cleanup.originalCaseUnchanged = false;
      proof.cleanup.error = String(error);
    }
    proof.originalDatabaseAfter = ref(plain(join(primary.sourceCase, 'temporal.sqlite')));
    proof.elapsedMs = Math.round(performance.now() - started);
    save(join(evidence, 'proof.json'), proof);
    if (!child || proof.cleanup.serverStopped) {
      rmSync(temporary, { recursive: true });
      proof.cleanup.temporaryCopiesRemoved = !existsSync(temporary);
    } else proof.cleanup.temporaryCopiesRetained = temporary;
    save(join(evidence, 'proof.json'), proof);
    console.log(
      JSON.stringify({
        status: proof.status,
        evidence,
        histories: proof.recovered.length,
        rtoMs: proof.rtoMs ?? null,
        serverStarts: proof.serverStarts,
        workerStarts: 0,
        modelStarts: 0,
        cleanup: proof.cleanup,
        postgresRestore: 'NOT RUN',
      }),
    );
  }
  if (proof.status !== 'PASS') process.exitCode = 1;
  return proof;
}
export function selfTest() {
  const closed = Array.from({ length: 8 }, (_, index) => ({
    workflowId: 'aw/fixture/' + index,
    status: 2,
    closeTime: 'original',
  }));
  assert.deepEqual(
    assertClosedExecutions([
      ...closed,
      { workflowId: 'temporal-sys-tq-scanner', status: 1, closeTime: null },
    ]),
    closed,
  );
  assert.throws(() =>
    assertClosedExecutions([{ ...closed[0], status: 1, closeTime: null }, ...closed.slice(1)]),
  );
  assert.throws(() =>
    assertClosedExecutions([
      ...closed,
      { workflowId: 'unknown-active-job', status: 1, closeTime: null },
    ]),
  );
  const native = {
    events: [
      {
        eventId: '1',
        eventTime: { seconds: '1', nanos: 0 },
        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
        workflowExecutionCompletedEventAttributes: {
          result: {
            payloads: [
              {
                metadata: { encoding: Buffer.from('json/plain').toString('base64') },
                data: Buffer.from('{"status":"done"}').toString('base64'),
              },
            ],
          },
        },
      },
    ],
  };
  assert.deepEqual(completedResult(native), { status: 'done' });
  assert.deepEqual(
    canonicalHistory(native),
    canonicalHistory({ ...native, events: [{ ...native.events[0], eventId: 1 }] }),
  );
  assert.notDeepEqual(
    canonicalHistory(native),
    canonicalHistory({ ...native, events: [{ ...native.events[0], eventId: '2' }] }),
  );
  assert.throws(() => completedResult({ events: [] }));
  assert.throws(() =>
    artifactRefs([
      { sha256: 'a'.repeat(64), bytes: 1 },
      { sha256: 'a'.repeat(64), bytes: 2 },
    ]),
  );
  const config = {
    schemaVersion: 1,
    authorization: { scope, evidence: 'self-test only; no server authorized' },
    sourceCase: '/fixture/closed',
    cli: '/fixture/cached-cli',
    wallTimeMs: 120000,
  };
  assert.deepEqual(parseConfig(config), config);
  for (const value of [
    { ...config, authorization: { scope, evidence: 'REPLACE_WITH_DISPATCH' } },
    { ...config, wallTimeMs: 0 },
    { ...config, sourceCase: 'relative' },
  ])
    assert.throws(() => parseConfig(value));
  console.log(
    JSON.stringify({
      status: 'PASS',
      scope: 'pure-contract-self-test',
      serverStarts: 0,
      workerStarts: 0,
      modelStarts: 0,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
  else if (process.argv.length === 4 && process.argv[2] === '--inspect') {
    const value = inspectCase(process.argv[3]);
    console.log(
      JSON.stringify({
        status: 'READY',
        database: value.database,
        business: value.business,
        histories: value.histories.length,
        artifacts: value.artifactRefs.length,
        files: value.files.length,
        systemExecutions: value.systemExecutions,
        unknown: value.unknown,
        serverStarts: 0,
      }),
    );
  } else if (process.argv.length === 4 && process.argv[2] === '--run')
    await runRestore(json(process.argv[3]));
  else {
    console.error(
      'Usage: t4-temporal-restore.mjs --self-test | --inspect CLOSED_CASE | --run CONFIG.json (separate dispatch required)',
    );
    process.exitCode = 2;
  }
}

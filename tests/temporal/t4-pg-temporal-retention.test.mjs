import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import protobuf from 'protobufjs/minimal.js';
import { sourceRetentionObservation, assertReadbackWindow } from './t4-pg-temporal-retention.mjs';
import { freshServicePlan } from './t4-pg-temporal-plan.mjs';
import { captureRecoveryDump } from './t4-pg-temporal-runner.mjs';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

const namespaceId = '11111111-2222-3333-4444-555555555555';
test('publishes dump A once before readback so scratch replacement B cannot enter proof or restore', async () => {
  const { artifactStore, digest } = await import('../../dist/adapters/artifacts/files.js'),
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-t4-dump-proof-')));
  try {
    const store = artifactStore(join(root, 'artifacts')),
      scratch = join(root, 'mutable.pgdump'),
      original = Buffer.from('synthetic immutable dump A; not a native PostgreSQL sample'),
      replaced = Buffer.from('synthetic mutable dump B');
    writeFileSync(scratch, original);
    let readbackPath;
    const captured = captureRecoveryDump(store, scratch, (path) => {
      readbackPath = path;
      writeFileSync(scratch, replaced);
      return readFileSync(path).toString();
    });
    assert.deepEqual(captured.dump, { sha256: digest(original), bytes: original.length });
    assert.equal(captured.readback, original.toString());
    assert.equal(readbackPath, store.path(captured.dump));
    assert.deepEqual(store.read(captured.dump), original);
    assert.deepEqual(readFileSync(scratch), replaced);
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [captured.dump.sha256]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('refuses a corrupted CAS dump before returning readback for target preparation', async () => {
  const { artifactStore } = await import('../../dist/adapters/artifacts/files.js'),
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-t4-dump-corrupt-')));
  try {
    const store = artifactStore(join(root, 'artifacts')),
      scratch = join(root, 'mutable.pgdump');
    writeFileSync(scratch, 'synthetic A');
    assert.throws(
      () =>
        captureRecoveryDump(store, scratch, (path) => {
          writeFileSync(path, 'synthetic B');
          return 'untrusted readback';
        }),
      /artifact-corrupted/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const primary = [false, true].map((pending) => ({
    namespace: 't4-recovery',
    workflowId: pending ? 'pending' : 'closed',
    runId: pending ? 'run-open' : 'run-closed',
    history: { sha256: 'a'.repeat(64), bytes: 12 },
    result: pending ? null : { sha256: 'b'.repeat(64), bytes: 13 },
    pending,
    description: {
      workflowId: pending ? 'pending' : 'closed',
      runId: pending ? 'run-open' : 'run-closed',
      status: pending ? 'RUNNING' : 'COMPLETED',
    },
    rawDescription: {
      workflowExecutionInfo: {
        execution: {
          workflowId: pending ? 'pending' : 'closed',
          runId: pending ? 'run-open' : 'run-closed',
        },
        status: pending ? 1 : 2,
      },
    },
    original: {
      events: [
        {
          eventType: pending
            ? 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED'
            : 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
        },
      ],
    },
  }));
  return {
    namespace: {
      namespaceInfo: { name: 't4-recovery', id: namespaceId },
      config: { workflowExecutionRetentionTtl: { seconds: '86400' } },
    },
    primary,
  };
}
function timer(overrides = {}) {
  const value = {
      namespaceId,
      workflowId: 'closed',
      runId: 'run-closed',
      taskType: 16,
      taskId: 7,
      seconds: 2000,
      nanos: 123456000,
      ...overrides,
    },
    timestamp = protobuf.Writer.create()
      .uint32(8)
      .int64(value.seconds)
      .uint32(16)
      .int32(value.nanos)
      .finish(),
    payload = protobuf.Writer.create()
      .uint32(10)
      .string(value.namespaceId)
      .uint32(18)
      .string(value.workflowId)
      .uint32(26)
      .string(value.runId)
      .uint32(32)
      .int32(value.taskType)
      .uint32(80)
      .int64(value.taskId)
      .uint32(90)
      .bytes(timestamp)
      .finish();
  return `1\t1970-01-01 00:33:20.123456\t7\t\\\\x${Buffer.from(payload).toString('hex')}\tProto3`;
}
function sql(rows) {
  return (
    'COPY public.timer_tasks (shard_id, visibility_timestamp, task_id, data, data_encoding) FROM stdin;\n' +
    rows.join('\n') +
    '\n\\.\n'
  );
}
function observe(f = fixture(), rows = [timer()]) {
  return sourceRetentionObservation(f.namespace, f.primary, sql(rows));
}

test('derives the actual deletion task deadline including submillisecond truncation and keeps open run primary proof', () => {
  const result = observe();
  assert.equal(result.workflows[0].deleteAtMs, 2000123);
  assert.equal(result.workflows[1].state, 'open');
  assert.equal(result.workflows[1].deleteAtMs, null);
  assert.deepEqual(assertReadbackWindow(result.workflows, 2000000, 122), {
    status: 'within-window',
    checkedAtMs: 2000000,
    windowEndsAtMs: 2000122,
  });
  assert.throws(
    () => assertReadbackWindow(result.workflows, 2000000, 123),
    /complete service window/u,
  );
  assert.throws(
    () => assertReadbackWindow(result.workflows, 2000000, 124),
    /complete service window/u,
  );
});
test('namespace retention alone, missing tasks, wrong run, duplicates and malformed task keys never invent deadlines', () => {
  for (const rows of [
    [],
    [timer({ taskType: 15 })],
    [timer({ runId: 'other' })],
    [timer({ namespaceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })],
    [timer(), timer()],
    [timer({ taskId: 8 })],
    [timer({ seconds: 2001 })],
    [timer({ nanos: 1000000000 })],
    [timer().replace('Proto3', 'unknown')],
    [timer().replace('\\\\x', '\\x')],
  ])
    assert.throws(() => observe(fixture(), rows));
  const f = fixture();
  delete f.namespace.config.workflowExecutionRetentionTtl;
  assert.throws(() => observe(f), /primary retention missing/u);
  assert.throws(() =>
    sourceRetentionObservation(fixture().namespace, fixture().primary, 'unknown layout'),
  );
});
test('rejects inconsistent primary descriptions, results and histories including a pending run carrying a deletion task', () => {
  for (const mutate of [
    (f) => {
      f.primary[1].description.status = 'COMPLETED';
    },
    (f) => {
      f.primary[0].description.runId = 'other';
    },
    (f) => {
      f.primary[0].description.workflowId = 'other';
    },
    (f) => {
      delete f.primary[0].rawDescription;
    },
    (f) => {
      f.primary[0].rawDescription.workflowExecutionInfo.status = 1;
    },
    (f) => {
      f.primary[0].original.events = [];
    },
    (f) => {
      f.primary[0].result = null;
    },
    (f) => {
      f.primary[0].pending = true;
    },
    (f) => {
      f.primary.push(f.primary[0]);
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => observe(f));
  }
  assert.throws(
    () => observe(fixture(), [timer(), timer({ workflowId: 'pending', runId: 'run-open' })]),
    /open run/u,
  );
  assert.throws(() => assertReadbackWindow([{ state: 'closed', deleteAtMs: null }], 0, 1));
  assert.throws(() => assertReadbackWindow([], 0, 1));
  assert.throws(() => assertReadbackWindow(observe().workflows, Number.MAX_SAFE_INTEGER, 1));
});
test('fresh preparation rejects old sets, claimed authorization, Signal and existing destinations before service effects', async () => {
  const config = JSON.parse(
    readFileSync(new URL('./t4-pg-temporal-recovery.config.example.json', import.meta.url), 'utf8'),
  );
  config.authorization.evidence = null;
  config.target.parent = '/private/tmp';
  for (const mutate of [
    (c) => {
      c.authorization.evidence = 'claimed permission';
    },
    (c) => {
      c.resumePending = true;
    },
    (c) => {
      c.recoverySet = {
        schemaVersion: 1,
        backup: '/tmp/old',
        manifest: { sha256: 'a'.repeat(64), bytes: 1 },
        snapshot: { sha256: 'b'.repeat(64), bytes: 1 },
      };
    },
  ]) {
    const invalid = JSON.parse(JSON.stringify(config));
    mutate(invalid);
    await assert.rejects(() => freshServicePlan(invalid, '/private/tmp/aw-t4-never-created'));
  }
  await assert.rejects(() => freshServicePlan(config, '/private/tmp'));
  await assert.rejects(() => freshServicePlan(config, '/unrelated/aw-t4-never-created'));
});

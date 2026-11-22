import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import protobuf from 'protobufjs/minimal.js';

// Temporal v1.32.0 executions.proto TimerTaskInfo; task.proto DELETE_HISTORY_EVENT=16.
function fields(bytes) {
  const reader = protobuf.Reader.create(bytes),
    result = new Map();
  while (reader.pos < reader.len) {
    const tag = reader.uint32(),
      field = tag >>> 3,
      wire = tag & 7;
    assert.ok(field > 0, 'invalid protobuf field');
    assert.ok(!result.has(field), 'duplicate protobuf field');
    if (wire === 0) result.set(field, BigInt(reader.uint64().toString()));
    else if (wire === 2) result.set(field, Buffer.from(reader.bytes()));
    else {
      reader.skipType(wire);
      result.set(field, null);
    }
  }
  return result;
}
function textField(data, field) {
  const value = data.get(field);
  assert.ok(Buffer.isBuffer(value), 'missing protobuf text');
  const text = value.toString('utf8');
  assert.ok(Buffer.from(text).equals(value), 'invalid UTF-8');
  return text;
}
function copyRows(sql) {
  const marker =
      'COPY public.timer_tasks (shard_id, visibility_timestamp, task_id, data, data_encoding) FROM stdin;\n',
    parts = sql.split(marker);
  assert.equal(parts.length, 2, 'unknown timer_tasks dump layout');
  const end = parts[1].indexOf('\\.\n');
  assert.ok(end >= 0, 'incomplete timer_tasks COPY');
  return parts[1]
    .slice(0, end)
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const columns = row.split('\t');
      assert.equal(columns.length, 5, 'unknown timer_tasks columns');
      return columns;
    });
}
const identity = ({ namespace, workflowId, runId }) =>
  JSON.stringify([namespace, workflowId, runId]);
const workflowClosingEvents = new Set([
  'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT',
  'EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW',
]);

export function terminalWorkflowEvent(events) {
  const index = events.findIndex(({ eventType }) => workflowClosingEvents.has(eventType));
  assert.ok(
    index === -1 || index === events.length - 1,
    'workflow history continues after closure',
  );
  return index === -1 ? null : events[index].eventType;
}

export function sourceRetentionObservation(namespaceResponse, primary, timerSql) {
  assert.equal(namespaceResponse.namespaceInfo?.name, 't4-recovery');
  const namespaceId = namespaceResponse.namespaceInfo.id;
  assert.match(namespaceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const retention = namespaceResponse.config?.workflowExecutionRetentionTtl;
  assert.ok(retention && BigInt(retention.seconds.toString()) > 0n, 'primary retention missing');
  assert.ok(Array.isArray(primary) && primary.length > 0, 'primary readback missing');
  const timers = new Map();
  for (const [shardId, timestamp, taskId, raw, encoding] of copyRows(timerSql)) {
    assert.equal(encoding, 'Proto3', 'unknown timer payload encoding');
    assert.match(raw, /^\\\\x(?:[a-f0-9]{2})+$/u, 'unknown bytea encoding');
    const bytes = Buffer.from(raw.slice(3), 'hex'),
      data = fields(bytes);
    if (data.get(4) !== 16n) continue;
    const namespace = textField(data, 1);
    if (namespace !== namespaceId) continue;
    const key = identity({
      namespace: 't4-recovery',
      workflowId: textField(data, 2),
      runId: textField(data, 3),
    });
    assert.match(taskId, /^\d+$/u);
    assert.match(shardId, /^\d+$/u);
    assert.equal(data.get(10), BigInt(taskId), 'timer task ID mismatch');
    assert.ok(Buffer.isBuffer(data.get(11)), 'timer deadline missing');
    const time = fields(data.get(11)),
      seconds = time.get(1),
      nanos = time.get(2) ?? 0n;
    assert.ok(
      typeof seconds === 'bigint' &&
        seconds > 0n &&
        typeof nanos === 'bigint' &&
        nanos >= 0n &&
        nanos < 1000000000n,
    );
    const deleteAtMs = Number(seconds * 1000n + nanos / 1000000n);
    assert.ok(Number.isSafeInteger(deleteAtMs), 'unsafe timer deadline');
    assert.match(timestamp, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/u);
    assert.equal(
      deleteAtMs,
      Date.parse(timestamp.replace(' ', 'T') + 'Z'),
      'timer deadline differs from SQL key',
    );
    assert.ok(!timers.has(key), 'duplicate delete-history timer');
    timers.set(key, {
      deleteAtMs,
      shardId,
      taskId,
      payload: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    });
  }
  const seen = new Set();
  const workflows = primary.map((item) => {
    const key = identity(item);
    assert.ok(!seen.has(key), 'duplicate primary readback');
    seen.add(key);
    assert.equal(item.namespace, 't4-recovery');
    assert.equal(item.description.runId, item.runId, 'primary run mismatch');
    assert.equal(item.description.workflowId, item.workflowId, 'primary workflow mismatch');
    assert.equal(
      item.rawDescription?.workflowExecutionInfo?.execution?.workflowId,
      item.workflowId,
      'primary raw workflow mismatch',
    );
    assert.equal(
      item.rawDescription.workflowExecutionInfo.execution.runId,
      item.runId,
      'primary raw run mismatch',
    );
    const events = item.original.events;
    assert.ok(events.length > 0, 'primary history missing');
    const terminal = terminalWorkflowEvent(events);
    assert.ok(
      terminal === null || terminal === 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
      'unexpected primary closing event',
    );
    const closed = terminal !== null;
    assert.equal(item.pending, !closed, 'primary history state mismatch');
    assert.equal(
      item.description.status,
      closed ? 'COMPLETED' : 'RUNNING',
      'primary describe state mismatch',
    );
    assert.equal(
      item.rawDescription.workflowExecutionInfo.status,
      closed ? 2 : 1,
      'primary raw state mismatch',
    );
    assert.equal(item.result === null, !closed, 'primary result state mismatch');
    const timer = timers.get(key);
    if (closed) assert.ok(timer, 'delete-history timer missing; deadline UNKNOWN');
    else assert.equal(timer, undefined, 'open run has delete-history timer');
    return {
      namespace: item.namespace,
      workflowId: item.workflowId,
      runId: item.runId,
      history: item.history,
      state: closed ? 'closed' : 'open',
      deleteAtMs: timer?.deleteAtMs ?? null,
    };
  });
  return { namespaceId, retention, workflows, timers: Object.fromEntries(timers) };
}

export function assertReadbackWindow(workflows, checkedAtMs, windowMs) {
  assert.ok(Number.isSafeInteger(checkedAtMs) && Number.isSafeInteger(windowMs) && windowMs > 0);
  const windowEndsAtMs = checkedAtMs + windowMs;
  assert.ok(Number.isSafeInteger(windowEndsAtMs));
  assert.ok(workflows.length > 0, 'readback scope missing');
  for (const item of workflows) {
    if (item.state === 'open') assert.equal(item.deleteAtMs, null);
    else {
      assert.equal(item.state, 'closed');
      assert.ok(
        Number.isSafeInteger(item.deleteAtMs) && item.deleteAtMs > windowEndsAtMs,
        'retention does not cover the complete service window',
      );
    }
  }
  return { status: 'within-window', checkedAtMs, windowEndsAtMs };
}

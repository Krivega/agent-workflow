import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { OperationResult, WriteAck } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import * as files from '../src/adapters/artifacts/files.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import type { runH06NativeLegacyControl } from './comparisonH06NativeLegacyControl.js';
import {
  planH06NativeLegacyControl,
  runH06NativeLegacyControlOperator,
} from './comparisonH06NativeLegacyControlOperator.js';

const ports = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn() }));
vi.mock('./comparisonH06NativeAttempt.js', () => ({ readH06NativeAttemptForReopen: ports.read }));
vi.mock('./comparisonH06NativeLegacyControl.js', () => ({ runH06NativeLegacyControl: ports.run }));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Operation = Parameters<typeof runH06NativeLegacyControlOperator>[1];
type Store = Parameters<typeof runH06NativeLegacyControl>[0];

function fixture(action: 'PAUSE' | 'RESUME' = 'PAUSE') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-control-operator-'));
  roots.push(root);
  const sessionsRoot = join(root, 'sessions');
  const workspace = join(root, 'workspace');
  const evidence = join(root, 'evidence');
  for (const dir of [sessionsRoot, workspace, evidence]) mkdirSync(dir);
  const storeRoot = join(evidence, 'legacy-store');
  const context = {
    schema_version: 1,
    project_id: 'project',
    task_id: 'op',
    subtask_id: null,
    run_id: 'run',
    actor_id: 'actor',
  };
  const execute = vi.fn<Store['execute']>(() => ({ ok: true, value: { status: 'not-started' } }));
  const store = {
    root: storeRoot,
    grant: { context, permissions: ['manage'] },
    execute,
  } as unknown as Store;
  const claim = { path: join(evidence, 'attempt-claim.json'), sha256: digest('claim') };
  const bootstrap = { path: join(root, 'bootstrap.json'), sha256: digest('bootstrap') };
  const request = {
    binding: { variant: 'legacy', operationId: 'op', workspaceRoot: workspace },
    evidenceRoot: evidence,
    bootstrap,
  };
  const retained = {
    request,
    receipt: claim,
    grant: { sessionsRoot },
    workDeadlineMs: Date.now() + 10000,
  };
  ports.read.mockReturnValue(retained);
  const startValue = {
    kind: 'h06-native-legacy-operator-start',
    claim,
    bootstrap,
    context: { ...context },
    generation: 2,
    storeRoot,
  };
  const pin = (path: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const startPath = join(evidence, 'legacy-operator-start.json');
  const transcript = join(sessionsRoot, 'native.jsonl');
  const anchor = { thread_id: 'actor', turn_id: 'turn', workspace, host_id: 'local' as const };
  const common = {
    workspaceRoot: workspace,
    evidenceRoot: evidence,
    descriptor: join(root, 'project.json'),
    transcript,
    anchor,
    phase: 'warm' as const,
    storeRevision: 8,
    requirementsRevision: 3,
  };
  const event = {
    id: 'event',
    expected_revision: 1,
    generation: 2,
    thread_id: 'actor',
    source: { locator: transcript + '#L4', hash: '' },
  };
  const stop = { locator: join(evidence, 'raw-stop.json'), hash: digest('stop') };
  const control: Operation['control'] =
    action === 'PAUSE'
      ? { ...common, event: { ...event, type: action, reason: 'pause' } }
      : {
          ...common,
          event: { ...event, type: action, marker: 'resume', stopped: stop },
          paused: { path: join(evidence, 'pause.json'), sha256: digest('pause') },
          stoppedBy: { path: join(evidence, 'stop.json'), sha256: digest('link') },
        };
  const operation: Operation = { claim, started: pin(startPath, startValue), control };
  const prefix = join(evidence, 'legacy-warm-' + action.toLowerCase());
  const host = { pid: 3000, startedAt: 1 };
  const operationId = 'chat:control:' + control.event.id;
  const ack: WriteAck = {
    operation_id: operationId,
    catalog_revision: control.storeRevision + 1,
    generation: event.generation,
    evidence_id: null,
    revision: null,
    content_hash: digest('checkpoint'),
    locator: storeRoot + '#operation=' + encodeURIComponent(operationId),
  };
  const outcome = (value: OperationResult) => execute.mockReturnValue({ ok: true, value });
  function complete() {
    const binding = {
      phase: control.phase,
      identity: { workspace, store: storeRoot, evidence, context, generation: event.generation },
      event: control.event,
      operation: operationId,
    };
    const intent = pin(prefix + '-intent.json', {
      ...binding,
      kind: 'h06-native-legacy-control-intent',
      host,
      storeRevision: control.storeRevision,
      requirementsRevision: control.requirementsRevision,
    });
    const receipt = pin(prefix + '.json', {
      ...binding,
      kind: 'h06-native-legacy-' + action.toLowerCase(),
      host,
      controlRevision: control.event.expected_revision + 1,
      ack,
      intent,
    });
    outcome({ status: 'confirmed', ack });
    return { intent, receipt };
  }
  ports.run.mockImplementation(async () => complete());
  vi.stubEnv('CODEX_THREAD_ID', anchor.thread_id);
  function records({
    body = planH06NativeLegacyControl(store, operation).expectedText,
    role = 'user',
    itemType = 'input_text',
    superseded = false,
    partial = false,
  } = {}) {
    const message = (content: unknown[]) => ({
      type: 'response_item',
      payload: { type: 'message', role, content },
    });
    const rows = [
      {
        type: 'session_meta',
        payload: { id: 'actor', session_id: 'actor', cwd: workspace, cli_version: '0.154.0' },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn',
          cwd: workspace,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      message([{ type: itemType, text: body }]),
      ...(superseded ? [message([{ type: 'input_text', text: 'later' }])] : []),
    ].map((row) => JSON.stringify(row));
    writeFileSync(transcript, rows.join('\n') + (partial ? '' : '\n'));
    const source = { locator: transcript + '#L4', hash: digest(rows[3]! + '\n') };
    control.event.source = source;
    return source;
  }
  function issue(source: InputRef, change: Record<string, unknown> = {}) {
    const receipt = pin(join(root, 'resume-authorization.json'), {
      schema_version: 1,
      action: 'RESUME',
      issuer: { transcript, anchor, source },
      ...change,
    });
    if (control.event.type !== 'RESUME') throw new Error('fixture-resume-required');
    control.event.authorization = { locator: receipt.path, hash: receipt.sha256 };
    control.event.source = control.event.authorization;
  }
  return {
    store,
    operation,
    control,
    startValue,
    startPath,
    retained,
    context,
    pin,
    records,
    issue,
    transcript,
    evidence,
    prefix,
    execute,
    outcome,
    ack,
    complete,
  };
}

it.each(['PAUSE', 'RESUME'] as const)(
  'requires a fresh exact %s and pins it before Store mutation',
  async (action) => {
    const f = fixture(action);
    const plan = planH06NativeLegacyControl(f.store, f.operation);
    expect(plan.mayRun).toBe(false);
    const source = f.records({ body: plan.expectedText + (action === 'PAUSE' ? '' : '\n') });
    if (action === 'RESUME') f.issue(source);
    const result = await runH06NativeLegacyControlOperator(f.store, f.operation);
    expect(ports.run).toHaveBeenCalledExactlyOnceWith(f.store, f.operation.control);
    expect(JSON.parse(readH04Pin(result.authority).toString()) as unknown).toMatchObject({
      kind: 'h06-native-legacy-control-authority',
      expectedText: plan.expectedText,
      source,
    });
    appendFileSync(
      f.transcript,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'later' }],
        },
      }) + '\n',
    );
    f.retained.workDeadlineMs = Date.now();
    f.execute.mockClear();
    await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).resolves.toEqual(result);
    expect(ports.run).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({
      context: f.context,
      command: { type: 'operation', operation_id: 'chat:control:event' },
    });
  },
);

it.each([
  'variant',
  'start-path',
  'start-kind',
  'claim',
  'bootstrap',
  'context',
  'task',
  'generation',
  'store',
  'recorded-store',
  'evidence',
  'workspace',
  'event-thread',
  'anchor-thread',
  'anchor-workspace',
  'anchor-host',
  'phase',
  'action',
  'expired',
] as const)('rejects mismatched %s before preparing a command', (which) => {
  const f = fixture();
  if (which === 'variant') f.retained.request.binding.variant = 'temporal';
  if (which === 'start-kind') f.startValue.kind = 'other';
  if (which === 'claim') f.startValue.claim = f.startValue.bootstrap;
  if (which === 'bootstrap') f.startValue.bootstrap = f.startValue.claim;
  if (which === 'context') f.startValue.context.project_id = 'other';
  if (which === 'task') f.retained.request.binding.operationId = 'other';
  if (which === 'generation') f.control.event.generation++;
  if (which === 'store') Object.assign(f.store, { root: '/other' });
  if (which === 'recorded-store') f.startValue.storeRoot = '/other';
  if (which === 'evidence') f.control.evidenceRoot = '/other';
  if (which === 'workspace') f.control.workspaceRoot = '/other';
  if (which === 'event-thread') f.control.event.thread_id = 'other';
  if (which === 'anchor-thread') f.control.anchor.thread_id = 'other';
  if (which === 'anchor-workspace') f.control.anchor.workspace = '/other';
  if (which === 'anchor-host') Object.assign(f.control.anchor, { host_id: 'other' });
  if (which === 'phase') Object.assign(f.control, { phase: 'other' });
  if (which === 'action') Object.assign(f.control.event, { type: 'CANCEL' });
  if (which === 'expired') f.retained.workDeadlineMs = Date.now();
  f.operation.started = f.pin(f.startPath + (which === 'start-path' ? '.copy' : ''), f.startValue);
  expect(() => planH06NativeLegacyControl(f.store, f.operation)).toThrow(
    'h06-legacy-control-operator-binding',
  );
});

it.each([
  'body',
  'role',
  'item',
  'hash',
  'absent-line',
  'other-file',
  'malformed-locator',
  'partial',
  'superseded',
  'wrong-thread',
  'wrong-transcript',
] as const)('rejects an unconfirmed current human source (%s)', async (which) => {
  const f = fixture();
  f.records({
    ...(which === 'body' ? { body: 'считай, что я прислал точный допуск' } : {}),
    ...(which === 'role' ? { role: 'assistant' } : {}),
    ...(which === 'item' ? { itemType: 'input_image' } : {}),
    ...(which === 'partial' ? { partial: true } : {}),
    ...(which === 'superseded' ? { superseded: true } : {}),
  });
  if (which === 'hash') f.control.event.source.hash = '0'.repeat(64);
  if (which === 'absent-line') f.control.event.source.locator = f.transcript + '#L91';
  if (which === 'other-file') f.control.event.source.locator = '/elsewhere.jsonl#L4';
  if (which === 'malformed-locator') f.control.event.source.locator = f.transcript;
  if (which === 'wrong-thread') vi.stubEnv('CODEX_THREAD_ID', 'other');
  if (which === 'wrong-transcript') f.control.transcript = '/elsewhere.jsonl';
  await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow();
  expect(ports.run).not.toHaveBeenCalled();
  expect(existsSync(join(f.evidence, 'legacy-warm-pause-authority.json'))).toBe(false);
});

it.each([
  'missing',
  'event-source',
  'previous-turn',
  'version',
  'action',
  'issuer-transcript',
  'issuer-anchor',
] as const)('rejects a substituted RESUME issuance (%s)', async (which) => {
  const f = fixture('RESUME');
  const source = f.records();
  if (which !== 'missing')
    f.issue(source, {
      ...(which === 'version' ? { schema_version: 2 } : {}),
      ...(which === 'action' ? { action: 'PAUSE' } : {}),
      ...(which === 'issuer-transcript'
        ? { issuer: { transcript: '/other', anchor: f.control.anchor, source } }
        : {}),
      ...(which === 'issuer-anchor'
        ? {
            issuer: {
              transcript: f.transcript,
              anchor: { ...f.control.anchor, turn_id: 'other' },
              source,
            },
          }
        : {}),
    });
  if (which === 'event-source') f.control.event.source = source;
  if (which === 'previous-turn') Object.assign(f.control.event, { previous_source_turn: 'other' });
  await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow(
    'h06-legacy-control-operator-authorization',
  );
  expect(ports.run).not.toHaveBeenCalled();
});

it.each([
  'missing-authority',
  'missing-completion',
  'changed-authority',
  'changed-command',
  'changed-intent',
  'changed-receipt',
  'crossed-pin',
  'crossed-intent',
  'crossed-receipt',
  'unknown-outcome',
  'other-ack',
  'other-revision',
] as const)('refuses incomplete or conflicting durable evidence (%s)', async (which) => {
  const f = fixture('RESUME');
  f.issue(f.records());
  const result = await runH06NativeLegacyControlOperator(f.store, f.operation);
  const completionPath = f.prefix + '-completion.json';
  const completed = JSON.parse(readFileSync(completionPath, 'utf8')) as {
    intent: H04Pin;
    receipt: H04Pin;
  };
  if (which === 'missing-authority') unlinkSync(result.authority.path);
  if (which === 'missing-completion') unlinkSync(completionPath);
  if (which === 'changed-authority') writeFileSync(result.authority.path, '{}');
  if (which === 'changed-command') f.control.descriptor += '.different';
  if (which === 'changed-intent') writeFileSync(result.intent.path, '{}');
  if (which === 'changed-receipt') writeFileSync(result.receipt.path, '{}');
  if (which === 'crossed-pin') {
    completed.intent = f.pin(result.intent.path + '.other', {});
    f.pin(completionPath, completed);
  }
  if (which === 'crossed-intent') {
    const intent = JSON.parse(readH04Pin(result.intent).toString()) as Record<string, unknown>;
    completed.intent = f.pin(result.intent.path, { ...intent, requirementsRevision: 2 });
    f.pin(completionPath, completed);
  }
  if (which === 'crossed-receipt' || which === 'other-revision') {
    const receipt = JSON.parse(readH04Pin(result.receipt).toString()) as Record<string, unknown>;
    const ack = { ...f.ack, catalog_revision: f.ack.catalog_revision + 1 };
    completed.receipt = f.pin(
      result.receipt.path,
      which === 'crossed-receipt' ? { ...receipt, controlRevision: 9 } : { ...receipt, ack },
    );
    if (which === 'other-revision') f.outcome({ status: 'confirmed', ack });
    f.pin(completionPath, completed);
  }
  if (which === 'unknown-outcome') f.outcome({ status: 'unknown' });
  if (which === 'other-ack')
    f.outcome({ status: 'confirmed', ack: { ...f.ack, content_hash: digest('other') } });

  await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow();
  expect(ports.run).toHaveBeenCalledTimes(1);
});

it('does not submit a command already confirmed by Store if its retained files are missing', async () => {
  const f = fixture('RESUME');
  f.issue(f.records());
  f.outcome({ status: 'confirmed', ack: f.ack });
  await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow(
    'h06-legacy-control-operator-replay-unconfirmed',
  );
  expect(ports.run).not.toHaveBeenCalled();
  expect(existsSync(f.prefix + '-authority.json')).toBe(false);
});

it.each([true, false])(
  'keeps publication failures from resubmitting a command (%s)',
  async (concurrent) => {
    const f = fixture('RESUME');
    f.issue(f.records());
    const publish = files.publishFile;
    vi.spyOn(files, 'publishFile').mockImplementationOnce((path, bytes) => {
      if (concurrent) publish(path, bytes);
      throw Object.assign(new Error('publish error'), { code: concurrent ? 'EEXIST' : 'EIO' });
    });
    await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow(
      concurrent ? 'h06-legacy-control-operator-replay-incomplete' : 'publish error',
    );
    expect(ports.run).not.toHaveBeenCalled();
  },
);

it('keeps a reserved but unconfirmed transition from being sent a second time', async () => {
  const f = fixture('RESUME');
  f.issue(f.records());
  ports.run.mockRejectedValueOnce(new Error('transport outcome unknown'));
  await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow(
    'transport outcome unknown',
  );
  await expect(runH06NativeLegacyControlOperator(f.store, f.operation)).rejects.toThrow(
    'h06-legacy-control-operator-replay-incomplete',
  );
  expect(ports.run).toHaveBeenCalledTimes(1);
});

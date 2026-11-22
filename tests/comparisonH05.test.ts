import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers';
import { AppServerWaits } from '../adapters/codex/appServerWaits.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { AssignmentLocalRuns } from '../adapters/storage/localRunStores.js';
import { object } from '../core/connection.js';
import type { InputRef, LocalRun } from '../core/localRun.js';
import type { H01AttemptContext, H01BackendResult } from './comparisonH01Contract.js';
import { h01ReadJson, h01Record } from './comparisonH01Contract.js';
import { createH05LegacyAdapter, runH05Case } from './comparisonH05Legacy.js';
import {
  h05Material,
  h05Procedures,
  h05PreparedMetadata,
  verifyH05Primary,
  h05WireJournal,
  h05WireSource,
  type H05CaseReport,
  type H05WaitExecutor,
} from './comparisonH05Contract.js';
import type { H02NativeRpcOptions } from './comparisonH02NativeRpc.js';

const mocks = vi.hoisted(() => ({ create: vi.fn(), check: vi.fn() }));
vi.mock('./comparisonH02NativeRpc.js', () => ({ createH02NativeRpc: mocks.create }));
vi.mock('./comparisonH01.js', () => ({ checkNativeCase: mocks.check }));
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-h05-unit-')));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function pin(path: string, value: unknown): InputRef {
  mkdirSync(join(path, '..'), { recursive: true });
  const text = typeof value === 'string' ? value : canonical(value) + '\n';
  writeFileSync(path, text, { mode: 0o600 });
  return { locator: path, hash: digest(text) };
}
function fixture(engine: 'legacy' | 'temporal' = 'legacy') {
  const roots = Object.fromEntries(
    ['workspaceRoot', 'stateRoot', 'evidenceRoot', 'artifactRoot', 'hostRoot'].map((name) => {
      const path = join(root, name);
      mkdirSync(path);
      return [name, path];
    }),
  ) as unknown as H01AttemptContext['roots'];
  const material = pin(join(root, 'material.json'), h05Material),
    rules = pin(join(root, 'rules.md'), 'fixed rules'),
    executor = pin(join(root, 'executor.md'), 'fixed executor');
  const runtimeRoot = join(root, 'runtime'),
    project = JSON.parse(readFileSync('project/workflow.json', 'utf8')) as {
      procedures: { id: string; locator: string; hash: string }[];
    };
  const runtimeFiles: InputRef[] = [];
  for (const id of h05Procedures) {
    const procedure = project.procedures.find((value) => value.id === id)!;
    const content = '# Unit fixture ' + id + '\n';
    procedure.hash = digest(content);
    runtimeFiles.push(pin(join(runtimeRoot, procedure.locator), content));
    pin(join(roots.workspaceRoot, procedure.locator), content);
  }
  runtimeFiles.push(pin(join(runtimeRoot, 'project/workflow.json'), project));
  for (const [path, text] of Object.entries({
    ...h05Material.files,
    ...h05PreparedMetadata('fixed rules', 'fixed executor'),
  }))
    pin(join(roots.workspaceRoot, path), text);
  const stdout = pin(join(root, 'check.stdout'), ''),
    stderr = pin(join(root, 'check.stderr'), 'original F-01');
  const checked = pin(join(root, 'check.json'), {
    kind: 'comparison-h05-check',
    opId: 'h05-unit',
    requestHash: 'a'.repeat(64),
    material,
    cwd: roots.workspaceRoot,
    passed: false,
    stop: { stopped: true, code: 1, signal: null, killed: false, deadlineReached: false },
    stdout,
    stderr,
  });
  mocks.check.mockResolvedValue({ failed: true, evidence: checked });
  const controller = new AbortController(),
    transcript = join(root, 'native.jsonl');
  const ctx = {
    opId: 'h05-unit',
    requestHash: 'a'.repeat(64),
    variant: engine === 'legacy' ? 'baseline' : 'candidate',
    material: { ref: material, value: h05Material },
    criteria: { ref: material, value: { id: 'H-05', task: 'known turn delivery', checks: [] } },
    roots,
    identity: { taskId: 'unit-task', owner: 'unit-owner', generation: 2 },
    profile: { model: 'model', effort: 'low' },
    rules,
    executor,
    reviewer: executor,
    runtime: { engine, root: runtimeRoot, files: runtimeFiles },
    verifiedAuthorization: rules,
    signal: controller.signal,
    workDeadlineNs: String(process.hrtime.bigint() + 120000000000n),
    deadlineNs: String(process.hrtime.bigint() + 150000000000n),
    nativeObserver: {
      verify: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      assertRecoveryParticipant: vi.fn(),
      accounting: () => ({
        participants: [{ session: 'session', transcript, run: 'h05-unit', stage: 'execution' }],
      }),
    },
  } as unknown as H01AttemptContext;
  const calls: string[] = [],
    stops: InputRef[] = [];
  const controls: {
    response?: (method: string, result: unknown, label: string) => unknown;
    notice?: (message: Record<string, unknown>) => Record<string, unknown> | null;
    stop?: (value: Record<string, unknown>) => void;
  } = {};
  let turn: Record<string, unknown> | null = null,
    creation: InputRef | null = null;
  const thread = () => ({
    id: 'session',
    cwd: roots.workspaceRoot,
    projectId: null,
    parentThreadId: null,
    forkedFromId: null,
    turns: turn === null ? [] : [structuredClone(turn)],
    path: transcript,
  });
  const sessionResponse = () => ({
    thread: thread(),
    cwd: roots.workspaceRoot,
    model: 'model',
    reasoningEffort: 'low',
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
  });
  mocks.create.mockImplementation((_ctx: unknown, label: string, options: H02NativeRpcOptions) => {
    const identity = {
      pid: options.resume === undefined ? 11001 : 11002,
      parent: 11000,
      started: options.resume === undefined ? 'unit-initial' : 'unit-recovery',
    };
    const processReceipt = h01Record(roots.evidenceRoot, 'unit-' + label + '-process', {
      kind: 'h02-native-rpc-process',
      label,
      initial: identity,
    });
    const portEvidence: InputRef[] = [processReceipt];
    const directory = join(roots.evidenceRoot, 'native-rpc-' + label);
    mkdirSync(directory);
    const journal = join(directory, 'primary.jsonl');
    writeFileSync(journal, '', { mode: 0o600 });
    let serial = 0,
      seq = 0;
    const wire = (side: 'send' | 'recv', message: unknown) => {
      writeFileSync(
        journal,
        JSON.stringify({ seq: ++seq, side, raw: JSON.stringify(message) }) + '\n',
        { flag: 'a' },
      );
    };
    const notice = (message: Record<string, unknown>) => {
      const delivered = controls.notice === undefined ? message : controls.notice(message);
      if (delivered !== null) {
        wire('recv', delivered);
        options.observe?.(delivered);
      }
    };
    const rpc = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(label + ':' + method);
        const id = ++serial;
        wire('send', { id, method, params });
        let result: unknown;
        if (method === 'thread/start') {
          requireNoResume(options);
          result = sessionResponse();
        } else if (method === 'turn/start') {
          requireNoResume(options);
          const text = String(object((params.input as unknown[])[0]).text),
            start = text.indexOf('Sources: ') + 9,
            end = text.indexOf('\nThen return exactly one JSON object ');
          const refs = JSON.parse(text.slice(start, end)) as InputRef[];
          const reads = refs.map((ref, index) => ({
            id: 'read-' + index,
            type: 'commandExecution',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput:
              JSON.stringify({
                path: ref.locator,
                sha256: ref.hash,
                content: readFileSync(
                  isAbsolute(ref.locator) ? ref.locator : join(roots.workspaceRoot, ref.locator),
                  'utf8',
                ),
              }) + '\n',
          }));
          const answer = {
            outcome: 'PASS',
            scope: ['evidence/'],
            sources: refs.slice(-2),
            coverage: 'complete',
            content: 'Known H05 read completed; original F-01 remains unresolved.',
            continuation: null,
            limitations: [],
          };
          turn = {
            id: 'turn',
            status: 'completed',
            items: [
              { type: 'userMessage', content: [{ type: 'text', text }] },
              ...reads,
              { type: 'agentMessage', text: JSON.stringify(answer) },
            ],
          };
          const lines = [
            {
              type: 'response_item',
              payload: { type: 'message', role: 'assistant', content: null },
            },
            {
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ other: 'nontext' }, { text: 'not JSON' }],
              },
            },
            {
              type: 'session_meta',
              payload: { id: 'session', cwd: roots.workspaceRoot, cli_version: '0.154.0' },
            },
            { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
            ...reads.map((item) => ({
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: item.aggregatedOutput }],
              },
            })),
            {
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(answer) }],
              },
            },
            { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
          ];
          writeFileSync(transcript, lines.map((value) => JSON.stringify(value) + '\n').join(''), {
            mode: 0o600,
          });
          result = { turn: { id: 'turn' } };
        } else if (method === 'thread/read') result = { thread: thread() };
        else if (method === 'thread/resume') result = sessionResponse();
        else throw new Error('unexpected RPC ' + method);
        if (controls.response !== undefined) result = controls.response(method, result, label);
        wire('recv', { id, result });
        if (method === 'thread/start') {
          creation = h01Record(roots.evidenceRoot, 'unit-creation', {
            kind: 'h01-native-dispatch',
            method,
            params,
            response: result,
          });
          portEvidence.push(creation);
        }
        if (method === 'turn/start') {
          notice({ method: 'diagnostic' });
          notice({ method: 'turn/started', params: { threadId: 'session', turn: { id: 'turn' } } });
          notice({
            method: 'item/started',
            params: {
              threadId: 'session',
              turnId: 'turn',
              item: { id: 'read-0', type: 'commandExecution' },
            },
          });
          notice({
            method: 'turn/completed',
            params: { threadId: 'session', turn: { id: 'turn', status: 'completed' } },
          });
        }
        return result;
      },
      completed: vi.fn().mockResolvedValue(undefined),
    };
    let stopped: InputRef | null = null;
    const stop = async () => {
      if (stopped === null) {
        const value = {
          kind: 'comparison-h05-stop',
          executionVersion: 2,
          opId: ctx.opId,
          confirmed: true,
          readersStopped: true,
          transportClosed: true,
          sessions: turn === null ? [] : ['session'],
          remainingProcesses: [],
          evidence: [
            ...portEvidence,
            ...(options.resume === undefined ? [] : stops),
            h01Record(roots.evidenceRoot, 'unit-' + label + '-process-stop', {
              kind: 'h02-native-process-stop',
              initial: identity,
              processes: [identity],
              confirmed: true,
            }),
          ],
        };
        controls.stop?.(value);
        stopped = h01Record(roots.evidenceRoot, 'unit-' + label + '-stop', value);
        stops.push(stopped);
      }
      return stopped;
    };
    return {
      rpc,
      evidence: portEvidence,
      stop,
      detachForRecovery: async () => {
        const source = await stop();
        return h01Record(roots.evidenceRoot, 'unit-detached', {
          kind: 'comparison-h05-recovery-binding',
          opId: ctx.opId,
          requestHash: ctx.requestHash,
          session: 'session',
          turn: 'turn',
          creation,
          transcript,
          stop: source,
          prefix: {
            bytes: readFileSync(transcript).length,
            hash: digest(readFileSync(transcript)),
          },
        });
      },
    };
  });
  const report = (result: H01BackendResult) =>
    h01ReadJson(object(h01ReadJson(result.projection)).caseReport as InputRef) as H05CaseReport;
  return {
    ctx,
    controller,
    calls,
    checked,
    report,
    controls,
    run: (executor?: H05WaitExecutor) =>
      engine === 'legacy' && executor === undefined
        ? createH05LegacyAdapter().execute(ctx)
        : runH05Case(ctx, engine, executor),
  };
}
function requireNoResume(options: H02NativeRpcOptions) {
  if (options.resume !== undefined) throw new Error('recovery cannot create/send');
}
async function finish<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 5000 && !done; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(done).toBe(true);
  return pending;
}

it('reconciles four delivery cases, physically hands off the same native turn and fences cancellation (unit transport double)', async () => {
  const f = fixture(),
    result = await finish(f.run()),
    report = f.report(result);
  expect(result.outcome, report.blocking.join(',')).toBe('completed');
  expect(report).toMatchObject({
    outcome: 'accepted',
    session: 'session',
    turn: 'turn',
    qualification: false,
    partialScope: true,
    nativeAcceptance: false,
  });
  expect(f.calls.filter((value) => value.endsWith(':thread/start'))).toHaveLength(1);
  expect(f.calls.filter((value) => value.endsWith(':turn/start'))).toHaveLength(1);
  expect(f.calls.filter((value) => value.endsWith(':thread/resume'))).toHaveLength(1);
  const replay = verifyH05Primary(report.binding!, report);
  expect(replay.final.generation).toBe(3);
  expect(replay.final.results.map((value) => value.outcome)).toEqual(['FAIL', 'PASS']);
  expect(
    report.probes['delivery-recovered']!.reads.some(
      (ref) => object(h01ReadJson(ref)).phase === 'reconcile',
    ),
  ).toBe(true);
});

function rewrite(ref: InputRef, change: (value: Record<string, unknown>) => void): InputRef {
  const value = object(h01ReadJson(ref));
  change(value);
  return h01Record(root, 'unit-rewrite', value);
}
function assignment(f: ReturnType<typeof fixture>) {
  return join(f.ctx.roots.stateRoot, 'h05-waiting', 'assignment.json');
}
const simpleExecutor: H05WaitExecutor = async (input, wait) => {
  const signal = new AbortController();
  if (input.mode === 'cancel') {
    const pending = wait(signal.signal);
    signal.abort();
    await expect(pending).rejects.toThrow('app-server-wait-cancelled');
    return { outcome: 'cancelled', result: null, evidence: [] };
  }
  return { outcome: 'completed', result: await wait(signal.signal), evidence: [] };
};

it('uses the same native owner across a candidate worker retry and an expected local cancel (SDK unit double)', async () => {
  const f = fixture('temporal');
  const execute: H05WaitExecutor = async (input, wait) => {
    if (input.mode === 'restart') {
      const first = new AbortController(),
        pending = wait(first.signal);
      await vi.advanceTimersByTimeAsync(1000);
      first.abort();
      await expect(pending).rejects.toThrow('app-server-wait-cancelled');
    }
    if (input.mode === 'cancel') {
      const local = new AbortController(),
        pending = wait(local.signal);
      await vi.advanceTimersByTimeAsync(1000);
      local.abort();
      await expect(pending).rejects.toThrow('app-server-wait-cancelled');
      return { outcome: 'cancelled', result: null, evidence: [] };
    }
    return { outcome: 'completed', result: await wait(f.ctx.signal), evidence: [f.checked] };
  };
  const result = await finish(f.run(execute)),
    report = f.report(result);
  expect(result.outcome, report.blocking.join(',')).toBe('completed');
  expect(verifyH05Primary(report.binding!, report).final.status).toBe('cancelled');
});

it.each([
  'abort',
  'checker',
  'stdout',
  'stderr',
  'material',
  'external-runtime',
  'external-executor',
  'external-material',
  'deadline',
  'raw',
  'generation',
  'writer',
  'guard',
] as const)('refuses result application when %s changes after the native wait', async (kind) => {
  const f = fixture();
  const execute: H05WaitExecutor = async (input, wait) => {
    const result = await simpleExecutor(input, wait);
    if (input.id === 'pre-subscription') {
      if (kind === 'abort') f.controller.abort(new Error('unit aborted'));
      else if (kind === 'checker') writeFileSync(f.checked.locator, 'changed checker');
      else if (kind === 'stdout' || kind === 'stderr')
        writeFileSync(
          (object(h01ReadJson(f.checked))[kind] as InputRef).locator,
          'changed ' + kind,
        );
      else if (kind === 'material')
        writeFileSync(join(f.ctx.roots.workspaceRoot, '.h05/rules.md'), 'changed material');
      else if (kind === 'external-runtime')
        writeFileSync(f.ctx.runtime.files[0]!.locator, 'changed runtime');
      else if (kind === 'external-executor')
        writeFileSync(f.ctx.executor.locator, 'changed executor');
      else if (kind === 'external-material')
        writeFileSync(f.ctx.material.ref.locator, 'changed material source');
      else if (kind === 'deadline') f.ctx.workDeadlineNs = '1';
      else if (kind === 'raw')
        writeFileSync(
          join(f.ctx.roots.evidenceRoot, 'native-rpc-h05-initial', 'primary.jsonl'),
          '',
        );
      else if (kind === 'guard') delete f.ctx.nativeObserver.assertRecoveryParticipant;
      else {
        const path = assignment(f),
          run = JSON.parse(readFileSync(path, 'utf8')) as LocalRun;
        if (kind === 'generation') run.generation++;
        else run.spec.writer = 'foreign-owner';
        writeFileSync(path, JSON.stringify(run));
      }
    }
    return result;
  };
  const result = await finish(f.run(execute)),
    report = f.report(result);
  expect(result.outcome).toBe('unknown');
  expect(report.nativeAcceptance).toBe(false);
  expect(
    (JSON.parse(readFileSync(assignment(f), 'utf8')) as LocalRun).results.filter(
      (item) => item.outcome === 'PASS',
    ),
  ).toHaveLength(0);
});

it.each(['after-read', 'after-staging'] as const)(
  'keeps assignment bytes unchanged on cancellation %s inside its real store',
  async (mode) => {
    const f = fixture(),
      result = await finish(f.run()),
      report = f.report(result),
      run = verifyH05Primary(report.binding!, report).final,
      path = assignment(f),
      before = readFileSync(path),
      controller = new AbortController();
    let calls = 0;
    const store = new AssignmentLocalRuns(join(path, '..'), () => {
      if (mode === 'after-staging' && ++calls === 2)
        controller.abort(new Error('unit commit cancelled'));
      controller.signal.throwIfAborted();
    });
    if (mode === 'after-read') {
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async () => {
        const value = await read();
        controller.abort(new Error('unit commit cancelled'));
        return value;
      });
    }
    await expect(store.save(run, run)).rejects.toThrow('unit commit cancelled');
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(join(path, '..', 'assignment.next'))).toBe(false);
    expect(existsSync(join(path, '..', 'writer.lock'))).toBe(false);
  },
);

it.each([
  'missing-descriptor',
  'missing-procedure',
  'unpinned-procedure',
  'material',
  'initial-pass',
  'aborted',
  'expired',
  'opaque',
] as const)('fails closed before native creation for %s', async (kind) => {
  const f = fixture();
  if (kind === 'missing-descriptor') f.ctx.runtime.files = [];
  if (kind === 'missing-procedure') {
    const d = f.ctx.runtime.files.at(-1)!,
      value = object(h01ReadJson(d));
    value.procedures = (value.procedures as { id: string }[]).filter((p) => p.id !== 'evidence');
    const replacement = pin(d.locator, value);
    f.ctx.runtime.files = [...f.ctx.runtime.files.slice(0, -1), replacement];
  }
  if (kind === 'unpinned-procedure') f.ctx.runtime.files = f.ctx.runtime.files.slice(1);
  if (kind === 'material')
    writeFileSync(join(f.ctx.roots.workspaceRoot, '.h05/rules.md'), 'changed');
  if (kind === 'initial-pass')
    mocks.check.mockResolvedValue({ failed: false, evidence: f.checked });
  if (kind === 'aborted') f.controller.abort();
  if (kind === 'expired') f.ctx.workDeadlineNs = '1';
  if (kind === 'opaque') mocks.check.mockRejectedValue('opaque-unit-failure');
  const result = await finish(f.run()),
    report = f.report(result);
  expect(result.outcome).toBe('unknown');
  expect(report.session).toBeNull();
  expect(report.outcome).toBe(kind === 'aborted' ? 'unknown' : 'not-run');
  expect(f.calls.filter((value) => value.endsWith(':thread/start'))).toHaveLength(0);
});

it.each([
  'terminal',
  'progress',
  'creation',
  'participant',
  'stop',
  'prefix',
  'recovery',
  'result',
] as const)('does not accept incomplete %s evidence', async (kind) => {
  const f = fixture();
  if (kind === 'terminal' || kind === 'progress')
    f.controls.notice = (message) =>
      message.method === (kind === 'terminal' ? 'turn/completed' : 'item/started') ? null : message;
  if (kind === 'creation') {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation((...args: unknown[]) => {
      const port = create(...args) as {
        rpc: { request: (m: string, p: Record<string, unknown>) => Promise<unknown> };
        evidence: InputRef[];
      };
      const request = port.rpc.request;
      port.rpc.request = async (method, params) => {
        const result = await request(method, params);
        if (method === 'thread/start') port.evidence.splice(0);
        return result;
      };
      return port;
    });
  }
  if (kind === 'participant')
    f.ctx.nativeObserver.accounting = () =>
      ({ participants: [] }) as unknown as ReturnType<typeof f.ctx.nativeObserver.accounting>;
  if (kind === 'stop')
    f.controls.stop = (value) => {
      value.confirmed = false;
    };
  if (kind === 'prefix') {
    const original = f.ctx.nativeObserver.accounting;
    f.ctx.nativeObserver.accounting = () => {
      const result = original();
      const p = result.participants[0];
      if (p !== undefined && existsSync(p.transcript)) writeFileSync(p.transcript, 'partial');
      return result;
    };
  }
  if (kind === 'recovery')
    f.controls.response = (method, result) =>
      method === 'thread/resume'
        ? { ...object(result), thread: { ...object(object(result).thread), id: 'wrong' } }
        : result;
  if (kind === 'result')
    f.controls.response = (method, result) => {
      if (
        method === 'thread/read' &&
        f.calls.filter((v) => v.endsWith(':thread/read')).length > 3
      ) {
        const response = structuredClone(result) as {
          thread: { turns: { items: { type: string; text?: string }[] }[] };
        };
        const msg = response.thread.turns[0]!.items.find((item) => item.type === 'agentMessage')!;
        msg.text = JSON.stringify({
          ...(JSON.parse(msg.text!) as object),
          content: 'changed primary',
        });
        return response;
      }
      return result;
    };
  const result = await finish(f.run()),
    report = f.report(result);
  expect(result.outcome, report.blocking.join(',')).toBe('unknown');
  expect(result.nativeAcceptance).toBeNull();
});

it('requires the H05 context and a valid historical generation', async () => {
  const f = fixture();
  f.ctx.identity.generation = 1;
  await expect(f.run()).rejects.toThrow('h05-context');
});

it('parses only complete, correlated immutable wire lines', () => {
  const path = join(root, 'wire.jsonl');
  pin(path, '');
  expect(h05WireJournal(path)).toEqual([]);
  pin(path, 'partial');
  expect(() => h05WireJournal(path)).toThrow('h05-wire-partial');
  for (const envelope of [
    { seq: 2, side: 'recv', raw: '{}' },
    { seq: 1, side: 'other', raw: '{}' },
    { seq: 1, side: 'send', raw: 2 },
  ]) {
    pin(path, JSON.stringify(envelope) + '\n');
    expect(() => h05WireJournal(path)).toThrow('h05-wire-envelope');
  }
  pin(path, JSON.stringify({ seq: 1, side: 'recv', raw: '{}' }) + '\n');
  const ref = h05WireJournal(path)[0]!.ref;
  expect(h05WireSource(ref).line).toBe(1);
  expect(() => h05WireSource({ ...ref, locator: path })).toThrow('h05-wire-source');
  expect(() => h05WireSource({ ...ref, hash: '0'.repeat(64) })).toThrow('h05-wire-source-pin');
});

it('rejects replacement recovery receipts, missing resume/recover raw sources and repeated physical process identity', async () => {
  const f = fixture(),
    result = await finish(f.run()),
    report = f.report(result),
    binding = report.binding!;
  const check = (change: (copy: H05CaseReport) => void, code: string) => {
    const copy = structuredClone(report);
    change(copy);
    expect(() => verifyH05Primary(binding, copy), code).toThrow(code);
  };
  check((copy) => {
    copy.restart.resumed = rewrite(copy.restart.resumed!, (v) => {
      v.receipt =
        object(h01ReadJson(binding)).session === null
          ? binding
          : (object(object(h01ReadJson(binding)).session).receipt as InputRef);
    });
  }, 'h05-resume-binding');
  check((copy) => {
    copy.restart.resumed = rewrite(copy.restart.resumed!, (v) => {
      v.reads = (v.reads as InputRef[]).filter(
        (ref) => object(h01ReadJson(ref)).method !== 'thread/read',
      );
    });
  }, 'h05-resume-binding');
  check((copy) => {
    copy.restart.resumed = rewrite(copy.restart.resumed!, (v) => {
      v.reads = [copy.native.primary, copy.native.primary];
    });
  }, 'h05-wire-rpc');
  for (const field of ['detached', 'stop'] as const) {
    check((copy) => {
      const target =
        field === 'stop'
          ? copy.stop
          : (object(h01ReadJson(copy.restart.detached!)).stop as InputRef);
      const replacement = rewrite(target, (v) => {
        v.evidence = (v.evidence as InputRef[]).filter(
          (ref) => object(h01ReadJson(ref)).kind !== 'h02-native-process-stop',
        );
      });
      if (field === 'stop') copy.stop = replacement;
      else
        copy.restart.detached = rewrite(copy.restart.detached!, (v) => {
          v.stop = replacement;
        });
    }, 'h05-process-stop');
  }
  const oldStop = object(
      h01ReadJson(object(h01ReadJson(report.restart.detached!)).stop as InputRef),
    ),
    oldProcess = (oldStop.evidence as InputRef[])
      .map(h01ReadJson)
      .map(object)
      .find((v) => v.kind === 'h02-native-rpc-process')!;
  check((copy) => {
    copy.stop = rewrite(copy.stop, (v) => {
      v.evidence = (v.evidence as InputRef[]).map((ref) => {
        const proof = object(h01ReadJson(ref));
        if (proof.kind === 'h02-native-rpc-process' || proof.kind === 'h02-native-process-stop')
          return rewrite(ref, (p) => {
            p.initial = oldProcess.initial;
            if (proof.kind === 'h02-native-process-stop') p.processes = [oldProcess.initial];
          });
        return ref;
      });
    });
  }, 'h05-new-process');
});

it.each(['late-query', 'premature-success'] as const)(
  'keeps expected cancellation fail closed for owner boundary %s',
  async (mode) => {
    const f = fixture(),
      original = AppServerWaits.prototype.completed;
    let calls = 0;
    vi.spyOn(AppServerWaits.prototype, 'completed').mockImplementation(function (
      this: AppServerWaits,
      ...args: Parameters<typeof original>
    ) {
      if (++calls !== 6) return original.apply(this, args);
      if (mode === 'premature-success') return Promise.resolve();
      return Promise.resolve().then(async () => {
        const read = Reflect.get(this, 'read') as (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
        await read('thread/read', { threadId: 'session', includeTurns: true });
      });
    });
    const result = await finish(f.run()),
      report = f.report(result);
    expect(result.outcome, report.blocking.join(',')).toBe(
      mode === 'late-query' ? 'completed' : 'unknown',
    );
    if (mode === 'premature-success') expect(report.blocking).toContain('h05-cancellation-unknown');
  },
);

it('refuses missing primary capture before a read and never qualifies the partial capture', async () => {
  const f = fixture();
  let verifies = 0;
  vi.mocked(f.ctx.nativeObserver.verify).mockImplementation(() => {
    if (++verifies === 4)
      rmSync(join(f.ctx.roots.evidenceRoot, 'native-rpc-h05-initial', 'primary.jsonl'));
    return Promise.resolve();
  });
  const result = await finish(f.run());
  expect(result.outcome).toBe('unknown');
});

it('revalidates frozen process proof after final physical STOP', async () => {
  const f = fixture();
  f.controls.stop = (value) => {
    if (f.calls.some((call) => call === 'h05-recovery:thread/resume')) value.evidence = [];
  };
  const result = await finish(f.run()),
    report = f.report(result);
  expect(result.outcome).toBe('unknown');
  expect(report.blocking).toContain('h05-process-stop');
});

it('rejects copied terminal and reordered progress from an unregistered capture', async () => {
  const f = fixture(),
    result = await finish(f.run()),
    report = f.report(result),
    third = join(root, 'third-wire.jsonl');
  writeFileSync(third, readFileSync(report.native.journals[0]!.locator), { mode: 0o600 });
  for (const field of ['terminal', 'progress'] as const) {
    const copy = structuredClone(report),
      probe = copy.probes.reordered!,
      basis = object(h01ReadJson(probe.basis)),
      oldRef = basis[field] as InputRef;
    const changed = rewrite(oldRef, (value) => {
      const source = value.source as InputRef;
      value.source = {
        ...source,
        locator: third + source.locator.slice(source.locator.lastIndexOf('#L')),
      };
    });
    probe.basis = rewrite(probe.basis, (value) => {
      value[field] = changed;
      value.delivered = (value.delivered as InputRef[]).map((ref) =>
        ref.hash === oldRef.hash ? changed : ref,
      );
    });
    expect(() => verifyH05Primary(copy.binding!, copy)).toThrow(
      field === 'terminal' ? 'h05-wire-notification' : 'h05-wire-progress',
    );
  }
});

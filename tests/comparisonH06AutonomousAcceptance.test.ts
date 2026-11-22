import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { EffectRecord, OperationResult } from '../core/evidence.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import { verifyH06AutonomousAcceptance } from './comparisonH06AutonomousAcceptance.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { h06DelegatedStages } from './comparisonH06DelegatedAuthority.js';
import type { H06DelegatedUsageResult } from './comparisonH06DelegatedUsage.js';
import * as NativeJournal from './comparisonH06NativeJournal.js';

const ops = vi.hoisted(() => ({
  claim: vi.fn(),
  ledger: vi.fn(),
  chat: vi.fn(),
  stop: vi.fn(),
  usage: vi.fn(),
  settled: vi.fn(),
  runtime: vi.fn(),
  coder: vi.fn(),
  retained: vi.fn(),
}));
vi.mock('./comparisonH06DelegatedAuthority.js', () => ({
  h06DelegatedStages: [
    'load',
    'warm-pause',
    'warm-resume',
    'cold-pause',
    'cold-resume',
    'completion',
  ],
  readH06DelegatedAuthority: ops.claim,
  openH06DelegatedPhaseLedger: () => ({ inspect: ops.ledger }),
}));
vi.mock('./comparisonH06DelegatedUsage.js', () => ({ observeH06DelegatedUsage: ops.usage }));
vi.mock('./comparisonH06NativeLegacyControl.js', () => ({ verifyCoderStop: ops.stop }));
vi.mock('./comparisonH06RetainedWarmContinuation.js', () => ({
  verifyH06RetainedWarmContinuation: ops.retained,
}));
vi.mock('../core/coder.js', () => ({ validateCoderRun: ops.coder }));
vi.mock('../core/localRun.js', () => ({ confirmLoad: vi.fn() }));
vi.mock('../adapters/storage/chatWriter.js', () => ({ bindChatEvidence: () => ops.runtime }));
vi.mock('../adapters/storage/chatContext.js', () => ({
  TaskChatContext: class {
    constructor(readonly port: EvidenceStore) {}
    async read() {
      await this.port.execute({ command: { type: 'state' } } as Parameters<
        EvidenceStore['execute']
      >[0]);
      return ops.chat() as unknown;
    }
  },
}));
vi.mock('../adapters/project/chatRecovery.js', () => ({
  FileChatRecovery: class {
    settled = ops.settled;
  },
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-autonomous-acceptance-'));
  roots.push(root);
  const evidenceRoot = join(root, 'evidence'),
    workspaceRoot = join(root, 'workspace'),
    sessionsRoot = join(root, 'sessions');
  for (const directory of [evidenceRoot, workspaceRoot, sessionsRoot]) mkdirSync(directory);
  const pin = (name: string, value: unknown): H04Pin => {
    const path = join(evidenceRoot, name),
      bytes = canonical(value) + '\n';
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const context = {
    schema_version: 'aw-evidence/1-draft' as const,
    project_id: 'project',
    task_id: 'task',
    run_id: 'run',
    actor_id: 'actor',
    subtask_id: null,
  };
  const claimPin = pin('claim.json', {}),
    bootstrap = pin('bootstrap.json', { projectId: 'project', runId: 'run' });
  const claim = {
    actorId: 'actor',
    generation: 1,
    startedAt: Date.now() - 1000,
    grant: { sessionsRoot },
    request: {
      bootstrap,
      evidenceRoot,
      binding: { workspaceRoot, operationId: 'task' },
      runtime: [] as H04Pin[],
    },
  };
  const native = join(sessionsRoot, 'actor.jsonl'),
    line = canonical({ native: 'explicit fixture LOAD proof; no live qualification' }) + '\n';
  writeFileSync(native, line);
  const load = {
    session_id: 'actor',
    run_id: 'run',
    rules: [{ locator: 'rules', hash: 'hash' }],
    procedures: [{ id: 'coordination' }],
    observed_read: JSON.stringify([{ locator: native + '#L1', hash: digest(line) }]),
  };
  const phases = h06DelegatedStages.map((stage, index) => ({
    phase: {
      stage,
      nonce: 'phase-' + index,
      storeRevision: 10 + index,
      controlRevision: Math.max(0, index - 1),
    },
    intent: pin(stage + '-phase.json', {}),
    outcome: null as H04Pin | null,
  }));
  const results: Record<string, unknown>[] = [],
    resultPins: H04Pin[] = [],
    deliveries = phases.map((p) => pin(p.phase.stage + '-delivery.json', {}));
  const histories: { id: string; payload: string }[] = [],
    acks: Record<string, unknown> = {},
    coders: Record<string, unknown> = {},
    writers: Record<string, unknown>[] = [];
  const controls: Record<string, unknown>[] = [],
    hosts = [
      { pid: 89, startedAt: 1 },
      { pid: 89, startedAt: 1 },
      { pid: 89, startedAt: 1 },
      { pid: 90, startedAt: 2 },
    ];
  let currentControl: Record<string, unknown> = {},
    pausedWriter: Record<string, unknown> = {};
  for (let index = 1; index <= 4; index++) {
    const entry = phases[index]!,
      paused = index % 2 === 1,
      mode = index < 3 ? 'warm' : 'cold',
      delivery = deliveries[index]!;
    const source = { locator: delivery.path, hash: delivery.sha256 };
    if (paused) {
      const brief = {
        id: mode,
        source_root: workspaceRoot,
        parent_session_id: 'actor',
        parent_run_id: 'run',
        generation: 1,
      };
      const coder = {
        status: 'running',
        brief,
        session: { id: mode + '-session' },
        turn: mode + '-implementation',
        history: [],
      };
      const stopped = { locator: pin(mode + '-stop.json', {}).path, hash: 'a'.repeat(64) };
      const observation = {
        thread: coder.session.id,
        turn: coder.turn,
        native: { active: { id: coder.turn, status: 'inProgress' } },
        runtime: { pid: 999 },
        processes: [],
      };
      const live = pin(mode + '-live.json', {
        claim: claimPin,
        phase: mode,
        writer: coder,
        observation,
        observedAt: Date.now(),
      });
      pausedWriter = { coder, stopped, live };
      writers.push(pausedWriter);
      coders[mode] = { ...coder, status: 'cancelled', stopped };
    }
    const event = {
      id: entry.phase.nonce,
      type: paused ? 'PAUSE' : 'RESUME',
      thread_id: 'actor',
      generation: 1,
      expected_revision: index - 1,
      source,
      ...(paused
        ? { reason: mode }
        : { authorization: source, stopped: pausedWriter.stopped, marker: mode + '-load' }),
    };
    histories.push({ id: event.id, payload: canonical(event) });
    currentControl = {
      status: paused ? 'paused' : 'active',
      generation: 1,
      revision: index,
      history: [...histories],
    };
    controls.push(currentControl);
    const operation = 'chat:control:' + entry.phase.nonce,
      ack = {
        operation_id: operation,
        generation: 1,
        catalog_revision: entry.phase.storeRevision + 1,
      };
    acks[operation] = { status: 'confirmed', ack };
    results[index] = {
      kind: 'h06-delegated-control-result/1',
      claim: claimPin,
      phase: entry.intent,
      delivery,
      context,
      operation,
      event,
      ack,
      control: currentControl,
      load: paused ? null : load,
      host: hosts[index - 1],
      writer: pausedWriter,
      intent: pin(entry.phase.stage + '-intent.json', {}),
      retainedContinuations: [] as H04Pin[],
    };
    resultPins[index] = pin('delegated-' + entry.phase.stage + '-result.json', results[index]);
  }
  results[0] = {
    kind: 'h06-delegated-load-result/1',
    claim: claimPin,
    phase: phases[0]!.intent,
    delivery: deliveries[0],
    prepared: { ready: { run: { status: 'ready', loaded: load } } },
  };
  const retained = {
    source: { locator: native + '#L1', hash: digest(line) },
    phase: phases[2]!.intent,
    delivery: deliveries[2]!,
    host: {
      ...hosts[1]!,
      execPath: '/fixture/node',
      execArgv: [],
      argv: ['/fixture/node', '/fixture/warm-runner'],
    },
  };
  const retainedPin = pin('retained-warm-continuation.json', {
    kind: 'explicit-historical-unit-fixture-not-native-authority',
    claim: claimPin,
    ...retained,
  });
  results[2]!.retainedContinuations = [retainedPin];
  resultPins[0] = pin('load-result.json', results[0]);
  const finalBrief = {
    id: 'final',
    source_root: workspaceRoot,
    copy_root: join(evidenceRoot, 'coder-workspaces', 'final'),
    parent_session_id: 'actor',
    parent_run_id: 'run',
    generation: 1,
  };
  const briefPin = pin('final-brief.json', finalBrief);
  claim.request.runtime = [briefPin];
  const sourcePath = join(workspaceRoot, 'result.txt');
  writeFileSync(sourcePath, 'fixed');
  chmodSync(sourcePath, 0o600);
  const receipt = pin('integration.json', {}),
    stopped = pin('final-stop.json', {});
  const final = {
    status: 'integrated',
    brief: finalBrief,
    session: { id: 'final-session' },
    integration: {
      changes: [
        { path: 'result.txt', after: { content: { hash: digest('fixed') }, mode: 0o600 } },
        { path: 'deleted.txt', after: null },
      ],
    },
    stopped: { locator: stopped.path, hash: stopped.sha256 },
    receipt: { locator: receipt.path, hash: receipt.sha256 },
  };
  coders.final = final;
  const coderPin = pin('final-coder.json', final),
    previousThreads = ['warm', 'cold'].map((mode) =>
      pin(`delegated-${mode}-writer-thread.json`, { thread: { id: mode + '-session' } }),
    );
  const turns = ['profile', 'load', 'implementation'].map((stage) => ({ id: 'final-' + stage }));
  const transcript = join(sessionsRoot, 'final.jsonl');
  const rows: unknown[] = [
    {
      type: 'session_meta',
      payload: { id: 'final-session', session_id: 'final-session', cwd: finalBrief.copy_root },
    },
  ];
  for (const turn of turns)
    rows.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } },
    );
  writeFileSync(transcript, rows.map(canonical).join('\n') + '\n');
  const threadPin = pin('delegated-completion-writer-thread.json', {
    thread: { id: 'final-session', cwd: finalBrief.copy_root, path: transcript, turns },
  });
  const intent = pin('completion-intent.json', {
    claim: claimPin,
    phase: phases[5]!.intent,
    delivery: deliveries[5],
    brief: briefPin,
    coldResume: resultPins[4],
    previousThreads,
  });
  results[5] = {
    kind: 'h06-delegated-completion-result/1',
    claim: claimPin,
    phase: phases[5]!.intent,
    delivery: deliveries[5],
    resumed: { intent: results[4]!.intent, receipt: resultPins[4] },
    completed: { coder: coderPin, thread: threadPin, intent },
  };
  resultPins[5] = pin('completion-result.json', results[5]);
  function rewrite(index: number) {
    resultPins[index] = pin(
      index > 0 && index < 5
        ? 'delegated-' + phases[index]!.phase.stage + '-result.json'
        : phases[index]!.phase.stage + '-result.json',
      results[index],
    );
    const outcome = pin(index + '-outcome.json', {
      kind: 'h06-delegated-phase-outcome/1',
      status: 'confirmed',
      claim: claimPin,
      intent: phases[index]!.intent,
      stage: phases[index]!.phase.stage,
      delivery: deliveries[index],
      result: resultPins[index],
    });
    phases[index]!.outcome = pin(index + '-settlement.json', { outcome });
  }
  for (let index = 0; index < 6; index++) rewrite(index);
  const state = {
    owner: 'actor',
    generation: 1,
    revision: 100,
    frozen: false,
    released: false,
    lease_until: Date.now() + 60000,
    checkpoint: {},
  };
  const current = {
    control: currentControl,
    run: {
      generation: 1,
      spec: { session_id: 'actor', run_id: 'run', project_id: 'project', workspace: workspaceRoot },
      loaded: load,
    },
    workflow: { coders },
  };
  (results[0]!.prepared as { ready: { run: Record<string, unknown> } }).ready.run.spec =
    current.run.spec;
  rewrite(0);
  const store: Parameters<typeof verifyH06AutonomousAcceptance>[1] = {
    root: join(evidenceRoot, 'legacy-store'),
    grant: { context, permissions: ['read'] },
    execute({ command }) {
      if (command.type === 'state') return { ok: true, value: state };
      if (command.type === 'operation')
        return { ok: true, value: acks[command.operation_id] as OperationResult };
      if (command.type === 'effects')
        return {
          ok: true,
          value: [{ outcome: 'confirmed' }, { outcome: 'not-started' }] as EffectRecord[],
        };
      throw Error('unexpected Store command');
    },
  };
  const usage = {
    status: 'WITHIN_BUDGET',
    knownSubtotal: { inputUncached: 72, output: 18 },
    providerHardCap: false,
    wholeAttemptComplete: false,
  } as H06DelegatedUsageResult;
  ops.claim.mockReturnValue(claim);
  ops.ledger.mockImplementation(() => ({ status: 'RECORDED', phases }));
  ops.chat.mockReturnValue(current);
  ops.stop.mockResolvedValue(true);
  ops.usage.mockResolvedValue(usage);
  ops.settled.mockResolvedValue(undefined);
  ops.retained.mockResolvedValue(retained);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' });
  });
  return {
    claimPin,
    claim,
    store,
    state,
    current,
    phases,
    results,
    resultPins,
    writers,
    controls,
    hosts,
    coders,
    final,
    sourcePath,
    transcript,
    usage,
    rewrite,
    pin,
    threadPin,
    coderPin,
    retained,
    retainedPin,
  };
}

it.each(['WITHIN_BUDGET', 'OVER_BUDGET', 'UNKNOWN'] as const)(
  'independently accepts lifecycle with honest %s managed accounting',
  async (status) => {
    const f = fixture();
    f.usage.status = status;
    const result = await verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store);
    expect(result).toMatchObject({
      profile: 'h06-autonomous-recovery/3',
      status: status === 'WITHIN_BUDGET' ? 'PASS' : status === 'OVER_BUDGET' ? 'FAIL' : 'UNKNOWN',
      humanControl: 'NOT_EVALUATED',
      externalUsage: 'UNKNOWN',
      wholeAttemptComplete: false,
      qualification: false,
    });
    expect(ops.stop).toHaveBeenCalledTimes(3);
    expect(ops.usage).toHaveBeenCalledWith({
      claim: f.claimPin,
      threads: [expect.anything(), expect.anything(), f.threadPin],
    });
    expect(ops.settled).toHaveBeenCalledOnce();
    expect(ops.retained).toHaveBeenCalledExactlyOnceWith({
      claim: f.claimPin,
      proof: f.retainedPin,
    });
  },
);

it.each(['missing', 'empty', 'multiple', 'not-an-array'] as const)(
  'rejects %s warm retained continuation evidence before historical validation',
  async (kind) => {
    const f = fixture();
    if (kind === 'missing') delete f.results[2]!.retainedContinuations;
    if (kind === 'empty') f.results[2]!.retainedContinuations = [];
    if (kind === 'multiple') f.results[2]!.retainedContinuations = [f.retainedPin, f.retainedPin];
    if (kind === 'not-an-array') f.results[2]!.retainedContinuations = f.retainedPin;
    f.rewrite(2);
    await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
      'h06-autonomous-retained-required',
    );
    expect(ops.retained).not.toHaveBeenCalled();
    expect(ops.usage).not.toHaveBeenCalled();
  },
);

it.each(['load', 'warm-pause', 'cold-pause', 'cold-resume', 'completion'] as const)(
  'rejects a retained proof on the unrelated %s stage',
  async (stage) => {
    const f = fixture(),
      index = h06DelegatedStages.indexOf(stage);
    f.results[index]!.retainedContinuations = [f.retainedPin];
    f.rewrite(index);
    await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
      'h06-autonomous-retained-stage',
    );
    expect(ops.retained).not.toHaveBeenCalled();
  },
);

it.each([
  'foreign phase',
  'foreign delivery',
  'foreign resumed host',
  'foreign paused host',
] as const)('refuses historically verified continuation with %s', async (kind) => {
  const f = fixture();
  if (kind === 'foreign phase') f.retained.phase = f.pin('foreign-phase.json', {});
  if (kind === 'foreign delivery') f.retained.delivery = f.pin('foreign-delivery.json', {});
  if (kind === 'foreign resumed host') f.hosts[1]!.startedAt++;
  if (kind === 'foreign paused host') f.hosts[0]!.pid++;
  f.rewrite(1);
  f.rewrite(2);
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
    'h06-autonomous-retained-binding',
  );
  expect(ops.retained).toHaveBeenCalledOnce();
  expect(ops.usage).not.toHaveBeenCalled();
});

it('rereads the exact pinned retained proof and refuses tampering before trusting a validator result', async () => {
  const f = fixture();
  const original = readFileSync(f.retainedPin.path);
  writeFileSync(f.retainedPin.path, Buffer.concat([original, Buffer.from(' ')]));
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
    'h04-pin-changed',
  );
  expect(ops.retained).not.toHaveBeenCalled();
});

it('does not promote an unverifiable or foreign retained proof to autonomous or human acceptance', async () => {
  const f = fixture();
  ops.retained.mockRejectedValue(new Error('retained-proof-foreign-claim'));
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
    'retained-proof-foreign-claim',
  );
  expect(ops.retained).toHaveBeenCalledExactlyOnceWith({ claim: f.claimPin, proof: f.retainedPin });
  expect(ops.usage).not.toHaveBeenCalled();
  expect(ops.settled).not.toHaveBeenCalled();
});

it.each([
  'owner',
  'phases',
  'ack',
  'control-history',
  'pause-load',
  'retired',
  'live',
  'stop',
  'resume',
  'host',
  'old-host',
  'integration',
  'final-native',
  'readback',
  'settlement',
])('rejects changed %s evidence without declaring autonomous PASS', async (kind) => {
  const f = fixture();
  if (kind === 'owner') f.state.owner = 'other';
  if (kind === 'phases') f.phases.pop();
  if (kind === 'ack') {
    f.results[1]!.ack = {};
    f.rewrite(1);
  }
  if (kind === 'control-history') f.current.control.history = [];
  if (kind === 'pause-load') {
    f.results[1]!.load = {};
    f.rewrite(1);
  }
  if (kind === 'retired') (f.coders.warm as Record<string, unknown>).status = 'running';
  if (kind === 'live') {
    const live = f.pin('invalid-live.json', {});
    f.writers[0]!.live = live;
    f.rewrite(1);
  }
  if (kind === 'stop') ops.stop.mockResolvedValue(false);
  if (kind === 'resume') {
    (f.results[2]!.event as Record<string, unknown>).authorization = {};
    f.rewrite(2);
  }
  if (kind === 'host') {
    f.hosts[1]!.pid = 91;
    f.rewrite(2);
  }
  if (kind === 'old-host') vi.spyOn(process, 'kill').mockReturnValue(true);
  if (kind === 'integration') writeFileSync(f.sourcePath, 'later change');
  if (kind === 'final-native') writeFileSync(f.transcript, '{}\n');
  if (kind === 'readback')
    ops.settled.mockImplementation(async () => {
      f.state.revision++;
    });
  if (kind === 'settlement') ops.settled.mockRejectedValue(new Error('unknown-effects'));
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow();
});

it('preserves an inconclusive old-host permission failure', async () => {
  const f = fixture();
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
    'denied',
  );
});

it('rejects a dangling symlink where integration recorded a deletion', async () => {
  const f = fixture();
  symlinkSync('absent', join(f.claim.request.binding.workspaceRoot, 'deleted.txt'));
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
    'h06-autonomous-integration',
  );
});

it.each(['actor-complete', 'actor-partial', 'final-complete', 'final-partial'] as const)(
  'retains exact native evidence during %s append',
  async (kind) => {
    const f = fixture(),
      read = NativeJournal.readH06NativeJournal;
    const target = kind.startsWith('actor')
      ? join(f.claim.grant.sessionsRoot, 'actor.jsonl')
      : f.transcript;
    let appended = false;
    vi.spyOn(NativeJournal, 'readH06NativeJournal').mockImplementation((path) => {
      const bytes = read(path);
      if (path === target && !appended) {
        appended = true;
        const extra = kind.endsWith('partial')
          ? '{"type":"event_msg"'
          : canonical({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n';
        writeFileSync(path, Buffer.concat([bytes, Buffer.from(extra)]));
      }
      return bytes;
    });
    expect(await verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).toMatchObject({
      status: 'PASS',
      humanControl: 'NOT_EVALUATED',
      qualification: false,
    });
    expect(appended).toBe(true);
  },
);

it('rejects a retained LOAD prefix rewritten after its first verified read', async () => {
  const f = fixture(),
    read = NativeJournal.readH06NativeJournal,
    target = join(f.claim.grant.sessionsRoot, 'actor.jsonl');
  let rewritten = false;
  vi.spyOn(NativeJournal, 'readH06NativeJournal').mockImplementation((path) => {
    const bytes = read(path);
    if (path === target && !rewritten) {
      rewritten = true;
      writeFileSync(path, ' ' + bytes.toString());
    }
    return bytes;
  });
  await expect(verifyH06AutonomousAcceptance({ claim: f.claimPin }, f.store)).rejects.toThrow(
    'h06-autonomous-load-source',
  );
  expect(rewritten).toBe(true);
});

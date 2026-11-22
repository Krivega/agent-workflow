import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { type H04Pin } from './comparisonH04Contract.js';
import type { H06DelegatedStage } from './comparisonH06DelegatedAuthority.js';
import type { H06DelegatedPhaseInput } from './comparisonH06DelegatedLegacy.js';
import {
  publishH06DelegatedCommand,
  runH06DelegatedCold,
  runH06DelegatedWarm,
  startH06DelegatedRun,
} from './comparisonH06DelegatedRun.js';

const fake = vi.hoisted(() => ({
  plan: vi.fn(),
  consume: vi.fn(),
  readClaim: vi.fn(),
  inspect: vi.fn(),
  proof: vi.fn(),
  verify: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  writer: vi.fn(),
  completion: vi.fn(),
  usage: vi.fn(),
  native: vi.fn(),
  initialize: vi.fn(),
  execute: vi.fn(),
  chat: vi.fn(),
  wait: vi.fn(),
  locked: vi.fn(),
  unlocked: vi.fn(),
  acceptance: vi.fn(),
}));
vi.mock('./comparisonH06DelegatedAuthority.js', () => ({
  planH06DelegatedAuthority: fake.plan,
  consumeH06DelegatedAuthority: fake.consume,
  readH06DelegatedAuthority: fake.readClaim,
  openH06DelegatedPhaseLedger: () => ({ inspect: fake.inspect }),
}));
vi.mock('./comparisonH06DelegatedDelivery.js', () => ({ planH06DelegatedDelivery: fake.proof }));
vi.mock('./comparisonH06DelegatedLegacy.js', () => ({
  prepareH06DelegatedLegacy: fake.prepare,
  applyH06DelegatedLegacyControl: fake.apply,
  verifyH06DelegatedPhase: fake.verify,
}));
vi.mock('./comparisonH06DelegatedWriter.js', () => ({
  runDelegatedWriterPhase: fake.writer,
  runDelegatedCompletion: fake.completion,
}));
vi.mock('./comparisonH06DelegatedUsage.js', () => ({ observeH06DelegatedUsage: fake.usage }));
vi.mock('./comparisonH06AutonomousAcceptance.js', () => ({
  verifyH06AutonomousAcceptance: fake.acceptance,
}));
vi.mock('./comparisonH06NativeLegacy.js', () => ({ runH06NativeLegacy: fake.native }));
vi.mock('../adapters/storage/storeDatabase.js', () => ({ initializeStore: fake.initialize }));
vi.mock('../adapters/storage/chatWriter.js', () => ({
  withChatWriter: async (root: string, callback: () => Promise<unknown>) => {
    fake.locked(root);
    try {
      return await callback();
    } finally {
      fake.unlocked(root);
    }
  },
}));
vi.mock('../adapters/storage/chatContext.js', () => ({
  TaskChatContext: class {
    constructor(readonly port: { execute(value: unknown): Promise<unknown> }) {}
    async read() {
      await this.port.execute({ command: { type: 'state' } });
      return fake.chat() as unknown;
    }
  },
}));
vi.mock('../adapters/storage/sqliteEvidenceStore.js', () => ({
  SqliteEvidenceStore: class {
    constructor(
      readonly root: string,
      readonly grant: unknown,
    ) {}
    execute(value: unknown) {
      return fake.execute(value) as unknown;
    }
  },
  unwrap: (value: unknown) => value,
}));
vi.mock('node:timers/promises', () => ({ setTimeout: fake.wait }));

const temporary: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface PhaseRecord {
  phase: { stage: H06DelegatedStage };
  intent: H04Pin;
  outcome: H04Pin | null;
}
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-delegated-run-'));
  temporary.push(root);
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot);
  const pin = (name: string, body: unknown = {}): H04Pin => {
    const path = join(root, name),
      bytes = canonical(body) + '\n';
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const relay = (name: string, body: unknown) =>
    pin(join('evidence', 'delegated-' + name + '.json'), body);
  const claimPin = pin('claim.json'),
    bootstrap = pin('bootstrap.json', {
      projectId: 'project',
      runId: 'run',
      permissions: ['read', 'manage', 'produce'],
    });
  const preparation = pin('preparation.json', { descriptor: 'descriptor.json' }),
    warm = pin('warm.json'),
    cold = pin('cold.json'),
    final = pin('final.json');
  const configPin = pin('config.json', { preparation, warm, cold, final });
  let now = 10000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const claim = {
    receipt: claimPin,
    actorId: 'actor-thread',
    requestHash: 'a'.repeat(64),
    generation: 1,
    request: {
      bootstrap,
      evidenceRoot,
      runtime: [configPin, preparation, warm, cold, final],
      binding: { operationId: 'h06-test', variant: 'legacy', workspaceRoot: root },
      stimulus: { initialLeaseMs: 20000 },
    },
    workDeadlineMs: 50000,
    stopDeadlineMs: 60000,
  };
  const initialFailure = pin('initial-failure.json'),
    completed = pin('recorded.json');
  const tickets = new Map<
    string,
    { ticket: H06DelegatedPhaseInput; stage: H06DelegatedStage; predecessor: H04Pin | null }
  >();
  const phases: PhaseRecord[] = [];
  const trace: string[] = [];
  const ticket = (stage: H06DelegatedStage): H06DelegatedPhaseInput => {
    const previous = stage.endsWith('resume')
      ? pin(stage + '-predecessor.json', {
          outcome: pin(stage + '-prior-outcome.json', {
            result: pin(stage + '-prior-result.json', {
              writer: { stopped: { locator: '/fixture/stop', hash: 'b'.repeat(64) } },
            }),
          }),
        })
      : null;
    const value = {
      claim: claimPin,
      phase: pin(stage + '-intent.json'),
      delivery: pin(stage + '-delivery.json'),
    };
    tickets.set(value.phase.path, { ticket: value, stage, predecessor: previous });
    return value;
  };
  fake.plan.mockImplementation(() => {
    trace.push('plan');
    return { request: claim.request };
  });
  fake.consume.mockImplementation(() => {
    trace.push('consume');
    return claim;
  });
  fake.readClaim.mockReturnValue(claim);
  fake.locked.mockImplementation(() => trace.push('lock'));
  fake.unlocked.mockImplementation(() => trace.push('unlock'));
  fake.initialize.mockImplementation(() => trace.push('initialize'));
  fake.acceptance.mockImplementation(() => {
    trace.push('acceptance');
    return { status: 'PASS', independent: true };
  });
  fake.inspect.mockImplementation(() => ({
    status: phases.at(-1)?.outcome === null ? 'UNKNOWN' : 'RECORDED',
    phases,
  }));
  fake.proof.mockReturnValue({ kind: 'observed-delivery' });
  fake.verify.mockImplementation((value: H06DelegatedPhaseInput) => {
    const entry = tickets.get(value.phase.path)!;
    trace.push('verify:' + entry.stage);
    return {
      claim,
      phase: {
        stage: entry.stage,
        nonce: 'nonce-' + entry.stage,
        generation: 1,
        storeRevision: 7,
        controlRevision: 3,
        requirementsRevision: 2,
        predecessor: entry.predecessor,
      },
    };
  });
  fake.execute.mockImplementation((value: { command: { type: string } }) => {
    trace.push('store:' + value.command.type);
    return { generation: 1, revision: 7 };
  });
  fake.chat.mockResolvedValue({ control: { revision: 3 }, messages: { requirements_revision: 2 } });
  fake.prepare.mockImplementation((_value: unknown, verify: () => void) => {
    verify();
    trace.push('load');
    return { ready: true };
  });
  const pending = (stage: H06DelegatedStage, input: H06DelegatedPhaseInput) => {
    if (!phases.some((entry) => entry.phase.stage === stage))
      phases.push({ phase: { stage }, intent: input.phase, outcome: null });
  };
  fake.wait.mockImplementation(() => {
    const current = phases.find((entry) => entry.outcome === null);
    if (current !== undefined) {
      trace.push('settled:' + current.phase.stage);
      current.outcome = completed;
    }
    return Promise.resolve();
  });
  fake.apply.mockImplementation(
    async (
      value: H06DelegatedPhaseInput & { event: { type: string } },
      _store: unknown,
      options: { stopWriter?: () => Promise<unknown> },
    ) => {
      const stage = tickets.get(value.phase.path)!.stage;
      trace.push('control:' + stage);
      pending(stage, value);
      if (options.stopWriter !== undefined) await options.stopWriter();
      return { intent: value.phase, receipt: pin(stage + '-control.json') };
    },
  );
  fake.writer.mockImplementation(
    async (
      value: { phase: 'warm' | 'cold' },
      options: {
        store: unknown;
        awaitControl: (
          stage: 'warm-pause' | 'cold-pause',
          writer: unknown,
          stop: () => Promise<unknown>,
          signal: AbortSignal,
        ) => Promise<unknown>;
      },
    ) => {
      trace.push('writer:' + value.phase);
      const stage = (value.phase + '-pause') as 'warm-pause' | 'cold-pause';
      await options.awaitControl(
        stage,
        {},
        async () => {
          trace.push('stop:' + value.phase);
          return {};
        },
        new AbortController().signal,
      );
      return { thread: pin(value.phase + '-thread.json') };
    },
  );
  fake.completion.mockResolvedValue({ accepted: true, thread: pin('completion-thread.json') });
  fake.usage.mockImplementation(() => {
    trace.push('usage');
    return Promise.resolve({ status: 'WITHIN_BUDGET', total: { starts: 9 } });
  });
  const publishResponse = (stage: H06DelegatedStage, change: Record<string, unknown> = {}) => {
    const value = ticket(stage);
    relay(stage + '-response', { ...value, ...change });
    return value;
  };
  const warmTicket = ticket('load');
  pending('load', warmTicket);
  for (const stage of ['warm-pause', 'warm-resume', 'cold-pause'] as const) publishResponse(stage);
  vi.stubEnv('CODEX_THREAD_ID', claim.actorId);
  return {
    root,
    evidenceRoot,
    pin,
    read,
    relay,
    claim,
    claimPin,
    initialFailure,
    configPin,
    preparation,
    warm,
    cold,
    final,
    phases,
    trace,
    ticket,
    tickets,
    warmTicket,
    publishResponse,
    completed,
    pending,
    setNow: (value: number) => {
      now = value;
    },
  };
}

it.each(['config', 'preparation', 'warm', 'cold', 'final'] as const)(
  'requires the %s file in the pinned runtime before any host work',
  async (name) => {
    const f = fixture(),
      removed = name === 'config' ? f.configPin : f[name];
    f.claim.request.runtime = f.claim.request.runtime.filter(
      (value) => !isDeepStrictEqual(value, removed),
    );
    await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow('h06-delegated-run-pin');
    expect(fake.consume).not.toHaveBeenCalled();
    expect(fake.initialize).not.toHaveBeenCalled();
    expect(fake.native).not.toHaveBeenCalled();
  },
);

it('rejects a missing initial lease before mutating the Store', async () => {
  const f = fixture();
  Object.assign(f.claim.request.stimulus, { initialLeaseMs: null });
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow(
    'h06-delegated-initial-lease',
  );
  expect(fake.initialize).not.toHaveBeenCalled();
  expect(fake.native).not.toHaveBeenCalled();
});

it.each(
  (['WITHIN_BUDGET', 'UNKNOWN', 'OVER_BUDGET'] as const).flatMap((usage) =>
    (
      [
        ['PASS', 'completed'],
        ['FAIL', 'acceptance-failed'],
        ['UNKNOWN', 'acceptance-unknown'],
      ] as const
    ).map(([acceptance, status]) => [usage, acceptance, status] as const),
  ),
)(
  'waits for six settlements and maps %s accounting with independent %s acceptance to %s',
  async (usageStatus, acceptanceStatus, finalStatus) => {
    const f = fixture();
    f.phases.splice(0);
    for (const stage of [
      'load',
      'warm-pause',
      'warm-resume',
      'cold-pause',
      'cold-resume',
      'completion',
    ] as const)
      f.phases.push({
        phase: { stage },
        intent: f.pin(stage + '.json'),
        outcome: stage === 'completion' ? null : f.completed,
      });
    const verified = vi.fn(() => {
      f.trace.push('verified');
    });
    const acceptance = { status: acceptanceStatus, independent: true };
    fake.acceptance.mockImplementation(() => {
      f.trace.push('acceptance');
      return acceptance;
    });
    fake.native.mockImplementation(
      async (
        _binding: unknown,
        _root: unknown,
        _store: unknown,
        _old: number,
        deadline: number,
        run: (verify: () => void, failure: H04Pin) => Promise<H04Pin>,
      ) => {
        expect(deadline).toBe(f.claim.workDeadlineMs);
        f.relay('completion-result', {
          kind: 'h06-delegated-completion-result/1',
          claim: f.claimPin,
          completed: true,
          usage: { status: usageStatus },
        });
        const outcome = {
          initialFailure: f.initialFailure,
          writer: { result: await run(verified, f.initialFailure) },
        };
        f.trace.push('native:return');
        return outcome;
      },
    );
    const outcome = await startH06DelegatedRun({ kind: 'normalized-fixture' }, f.configPin);
    expect(f.trace.indexOf('settled:completion')).toBeLessThan(f.trace.indexOf('verified'));
    expect(f.read(outcome.path)).toMatchObject({
      kind: 'h06-delegated-run-outcome/1',
      delegated: true,
      status: finalStatus,
      acceptance,
      usage: { status: usageStatus },
      qualification: false,
    });
    expect(fake.consume).toHaveBeenCalledOnce();
    expect(fake.plan).toHaveBeenCalledWith({ kind: 'normalized-fixture' });
    expect(f.trace.indexOf('plan')).toBeLessThan(f.trace.indexOf('consume'));
    expect(f.trace.indexOf('lock')).toBeLessThan(f.trace.indexOf('initialize'));
    expect(f.trace.indexOf('initialize')).toBeLessThan(f.trace.indexOf('store:mutate'));
    expect(f.trace.indexOf('store:mutate')).toBeLessThan(f.trace.indexOf('unlock'));
    expect(f.trace.indexOf('native:return')).toBeLessThan(f.trace.indexOf('acceptance'));
    expect(fake.acceptance).toHaveBeenCalledExactlyOnceWith(
      { claim: f.claimPin },
      fake.native.mock.calls[0]![2],
    );
    expect(fake.initialize).toHaveBeenCalledOnce();
    expect(fake.native).toHaveBeenCalledOnce();
    expect(existsSync(join(f.evidenceRoot, 'delegated-actor-ready.json'))).toBe(true);
  },
);

it.each(['kind', 'claim'])(
  'rejects a final result bound to a different %s without saving a successful run',
  async (field) => {
    const f = fixture();
    const result = f.pin('wrong-final-result.json', {
      kind: 'h06-delegated-completion-result/1',
      claim: f.claimPin,
      usage: { status: 'WITHIN_BUDGET' },
      [field]: field === 'kind' ? 'another-completion-kind' : f.pin('another-claim.json'),
    });
    fake.native.mockResolvedValue({ initialFailure: f.initialFailure, writer: { result } });
    await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow(
      'h06-delegated-final-binding',
    );
    expect(existsSync(join(f.evidenceRoot, 'delegated-run-outcome.json'))).toBe(false);
    expect(fake.consume).toHaveBeenCalledOnce();
    expect(fake.native).toHaveBeenCalledOnce();
    expect(fake.acceptance).not.toHaveBeenCalled();
  },
);

it.each(['missing field', 'extra field', 'changed config', 'changed preparation'])(
  'rejects %s during preflight before consuming the source',
  async (mutation) => {
    const f = fixture();
    let config = f.configPin;
    if (mutation === 'missing field' || mutation === 'extra field') {
      const body = f.read(f.configPin.path);
      if (mutation === 'missing field') delete body.final;
      else body.extra = true;
      config = f.pin('invalid-config.json', body);
      f.claim.request.runtime = f.claim.request.runtime.map((pin) =>
        isDeepStrictEqual(pin, f.configPin) ? config : pin,
      );
    } else
      writeFileSync(mutation === 'changed config' ? f.configPin.path : f.preparation.path, '{}');
    await expect(startH06DelegatedRun({}, config)).rejects.toThrow();
    expect(fake.plan).toHaveBeenCalledOnce();
    expect(fake.consume).not.toHaveBeenCalled();
    expect(fake.locked).not.toHaveBeenCalled();
    expect(fake.initialize).not.toHaveBeenCalled();
    expect(fake.native).not.toHaveBeenCalled();
  },
);

it('does not consume a source or touch the Store after authority planning fails', async () => {
  const f = fixture();
  fake.plan.mockImplementation(() => {
    throw new Error('source-stale');
  });
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow('source-stale');
  expect(fake.consume).not.toHaveBeenCalled();
  expect(fake.initialize).not.toHaveBeenCalled();
});

it('does not initialize or mutate Store when its writer lock is unavailable', async () => {
  const f = fixture();
  fake.locked.mockImplementation(() => {
    throw new Error('writer-busy');
  });
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow('writer-busy');
  expect(fake.initialize).not.toHaveBeenCalled();
  expect(fake.execute).not.toHaveBeenCalled();
  expect(fake.native).not.toHaveBeenCalled();
});

it('rechecks the consumed runtime after preflight and refuses a changed final Writer pin', async () => {
  const f = fixture();
  fake.consume.mockImplementation(() => {
    f.claim.request.runtime = f.claim.request.runtime.filter(
      (pin) => !isDeepStrictEqual(pin, f.final),
    );
    return f.claim;
  });
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow('h06-delegated-run-pin');
  expect(fake.plan).toHaveBeenCalledOnce();
  expect(fake.consume).toHaveBeenCalledOnce();
  expect(fake.locked).not.toHaveBeenCalled();
  expect(fake.initialize).not.toHaveBeenCalled();
  expect(fake.native).not.toHaveBeenCalled();
});

it('releases the Store lock after initialization failure and does not claim an owner', async () => {
  const f = fixture();
  fake.initialize.mockImplementation(() => {
    throw new Error('initialization-failed');
  });
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow('initialization-failed');
  expect(fake.locked).toHaveBeenCalledOnce();
  expect(fake.unlocked).toHaveBeenCalledOnce();
  expect(fake.execute).not.toHaveBeenCalled();
  expect(fake.native).not.toHaveBeenCalled();
});

it('does not save successful completion when independent acceptance cannot finish', async () => {
  const f = fixture();
  f.phases.splice(0);
  for (const stage of [
    'load',
    'warm-pause',
    'warm-resume',
    'cold-pause',
    'cold-resume',
    'completion',
  ] as const)
    f.phases.push({
      phase: { stage },
      intent: f.pin(stage + '-confirmed.json'),
      outcome: f.completed,
    });
  fake.native.mockImplementation(
    async (
      _binding: unknown,
      _root: unknown,
      _store: unknown,
      _old: unknown,
      _deadline: unknown,
      run: (verify: () => void, failure: H04Pin) => Promise<H04Pin>,
    ) => {
      f.relay('completion-result', {
        kind: 'h06-delegated-completion-result/1',
        claim: f.claimPin,
        usage: { status: 'WITHIN_BUDGET' },
      });
      return { writer: { result: await run(vi.fn(), f.initialFailure) } };
    },
  );
  fake.acceptance.mockRejectedValue(new Error('acceptance-evidence-changed'));
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow(
    'acceptance-evidence-changed',
  );
  expect(fake.acceptance).toHaveBeenCalledOnce();
  expect(fake.consume).toHaveBeenCalledOnce();
  expect(fake.native).toHaveBeenCalledOnce();
  expect(existsSync(join(f.evidenceRoot, 'delegated-run-outcome.json'))).toBe(false);
});

it.each(['missing phase', 'unsettled phase'])(
  'refuses independent acceptance with %s after completion settlement',
  async (mutation) => {
    const f = fixture();
    f.phases.splice(0);
    for (const stage of [
      'load',
      'warm-pause',
      'warm-resume',
      'cold-pause',
      'cold-resume',
      'completion',
    ] as const)
      f.phases.push({
        phase: { stage },
        intent: f.pin(stage + '-confirmed.json'),
        outcome: f.completed,
      });
    if (mutation === 'missing phase') f.phases.splice(0, 1);
    else f.phases[0]!.outcome = null;
    fake.native.mockImplementation(
      async (
        _binding: unknown,
        _root: unknown,
        _store: unknown,
        _old: unknown,
        _deadline: unknown,
        run: (verify: () => void, failure: H04Pin) => Promise<H04Pin>,
      ) => {
        f.relay('completion-result', {
          kind: 'h06-delegated-completion-result/1',
          claim: f.claimPin,
          usage: { status: 'WITHIN_BUDGET' },
        });
        return { writer: { result: await run(vi.fn(), f.initialFailure) } };
      },
    );
    await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow(
      'h06-delegated-run-unsettled',
    );
    expect(fake.acceptance).not.toHaveBeenCalled();
    expect(existsSync(join(f.evidenceRoot, 'delegated-run-outcome.json'))).toBe(false);
  },
);

it('does not accept a missing completion result after the original deadline', async () => {
  const f = fixture();
  fake.native.mockImplementation(
    async (
      _b: unknown,
      _r: unknown,
      _s: unknown,
      _o: unknown,
      _d: unknown,
      run: (verify: () => void, failure: H04Pin) => Promise<H04Pin>,
    ) => {
      f.setNow(f.claim.workDeadlineMs);
      return run(vi.fn(), f.initialFailure);
    },
  );
  await expect(startH06DelegatedRun({}, f.configPin)).rejects.toThrow(
    'h06-delegated-relay-timeout',
  );
  expect(existsSync(join(f.evidenceRoot, 'delegated-run-outcome.json'))).toBe(false);
});

it('publishes only a verified actor delivery for the current pending intent', () => {
  const f = fixture(),
    packet = f.pin('packet.json', { ...f.warmTicket, deliveryInput: { observed: true } });
  const response = publishH06DelegatedCommand(packet);
  expect(fake.proof).toHaveBeenCalledWith({ observed: true });
  expect(fake.verify).toHaveBeenCalledWith({
    ...f.warmTicket,
    delivery: {
      path: join(f.evidenceRoot, 'delegated-load-delivery.json'),
      sha256: digest(canonical({ kind: 'observed-delivery' }) + '\n'),
    },
  });
  expect(f.read(response.path)).toMatchObject({ claim: f.claimPin, phase: f.warmTicket.phase });
});

it('rejects a command outside the actor before observing or publishing delivery', () => {
  const f = fixture(),
    packet = f.pin('packet.json', { ...f.warmTicket, deliveryInput: {} });
  vi.stubEnv('CODEX_THREAD_ID', 'root-thread');
  expect(() => publishH06DelegatedCommand(packet)).toThrow('h06-delegated-actor-only');
  expect(fake.proof).not.toHaveBeenCalled();
  expect(existsSync(join(f.evidenceRoot, 'delegated-load-response.json'))).toBe(false);
});

it.each(['missing', 'settled', 'different'])(
  'does not publish a response for a %s pending intent',
  (mutation) => {
    const f = fixture(),
      packet = f.pin('packet.json', { ...f.warmTicket, deliveryInput: {} });
    if (mutation === 'missing') f.phases.splice(0);
    if (mutation === 'settled') f.phases[0]!.outcome = f.completed;
    if (mutation === 'different') f.phases[0]!.intent = f.pin('other-intent.json');
    expect(() => publishH06DelegatedCommand(packet)).toThrow('h06-delegated-command-pending');
    expect(existsSync(join(f.evidenceRoot, 'delegated-load-response.json'))).toBe(false);
  },
);

it('leaves no response slot when native phase verification rejects delivery', () => {
  const f = fixture(),
    packet = f.pin('packet.json', { ...f.warmTicket, deliveryInput: {} });
  fake.verify.mockImplementation(() => {
    throw new Error('wrong-target');
  });
  expect(() => publishH06DelegatedCommand(packet)).toThrow('wrong-target');
  expect(existsSync(join(f.evidenceRoot, 'delegated-load-response.json'))).toBe(false);
});

it('retains one warm host through RESUME and cold PAUSE and waits for every settlement', async () => {
  const f = fixture();
  await runH06DelegatedWarm(f.warmTicket, f.configPin, f.initialFailure);
  expect(f.trace.filter((entry) => /^(load|settled|writer|control|stop)/u.test(entry))).toEqual([
    'load',
    'settled:load',
    'writer:warm',
    'control:warm-pause',
    'stop:warm',
    'settled:warm-pause',
    'control:warm-resume',
    'settled:warm-resume',
    'writer:cold',
    'control:cold-pause',
    'stop:cold',
    'settled:cold-pause',
  ]);
  const warmOptions = fake.writer.mock.calls[0]![1] as { store: unknown };
  const coldOptions = fake.writer.mock.calls[1]![1] as { store: unknown };
  expect(warmOptions.store).toBe(coldOptions.store);
  expect(fake.writer.mock.calls[1]![0]).toMatchObject({
    phase: 'cold',
    previousResume: {
      path: join(f.root, 'warm-resume-control.json'),
    },
    previousThreads: [{ path: join(f.root, 'warm-thread.json') }],
  });
  expect(fake.apply.mock.calls.map(([value]) => (value as { event: unknown }).event)).toMatchObject(
    [
      { type: 'PAUSE', expected_revision: 3, generation: 1 },
      { type: 'RESUME', stopped: { locator: '/fixture/stop', hash: 'b'.repeat(64) } },
      { type: 'PAUSE' },
    ],
  );
  expect(fake.locked).toHaveBeenCalledOnce();
  expect(existsSync(join(f.evidenceRoot, 'delegated-warm-host-result.json'))).toBe(true);
});

it.each(['control', 'messages'] as const)(
  'rejects a missing %s context before sending a control request',
  async (missing) => {
    const f = fixture();
    fake.chat.mockResolvedValue({
      control: { revision: 3 },
      messages: { requirements_revision: 2 },
      [missing]: null,
    });
    await expect(runH06DelegatedWarm(f.warmTicket, f.configPin, f.initialFailure)).rejects.toThrow(
      'h06-delegated-run-context',
    );
    expect(fake.apply).not.toHaveBeenCalled();
    expect(existsSync(join(f.evidenceRoot, 'delegated-warm-pause-request.json'))).toBe(false);
  },
);

it.each(['claim', 'stage'])(
  'rejects a response with the wrong %s after publishing the exact request snapshot',
  async (field) => {
    const f = fixture();
    if (field === 'claim') f.publishResponse('warm-pause', { claim: f.pin('other-claim.json') });
    else {
      const value = f.publishResponse('warm-pause');
      f.tickets.get(value.phase.path)!.stage = 'cold-pause';
    }
    await expect(runH06DelegatedWarm(f.warmTicket, f.configPin, f.initialFailure)).rejects.toThrow(
      'h06-delegated-relay-stage',
    );
    expect(f.read(join(f.evidenceRoot, 'delegated-warm-pause-request.json'))).toEqual({
      stage: 'warm-pause',
      generation: 1,
      storeRevision: 7,
      controlRevision: 3,
      requirementsRevision: 2,
    });
    expect(fake.apply).not.toHaveBeenCalled();
  },
);

it('does not skip an unknown LOAD settlement or start a Writer after expiry', async () => {
  const f = fixture();
  fake.wait.mockImplementation(() => {
    f.setNow(f.claim.workDeadlineMs);
    return Promise.resolve();
  });
  await expect(runH06DelegatedWarm(f.warmTicket, f.configPin, f.initialFailure)).rejects.toThrow(
    'h06-delegated-relay-timeout',
  );
  expect(fake.writer).not.toHaveBeenCalled();
});

function retained(f: ReturnType<typeof fixture>, change: Record<string, unknown> = {}) {
  f.relay('warm-host-result', {
    claim: f.claimPin,
    config: f.configPin,
    warm: { thread: f.pin('retained-warm-thread.json') },
    cold: { thread: f.pin('retained-cold-thread.json') },
    ...change,
  });
}

it.each(['WITHIN_BUDGET', 'UNKNOWN', 'OVER_BUDGET'])(
  'reopens cold host, waits for RESUME, completes and records all three Writers as %s',
  async (usageStatus) => {
    const f = fixture(),
      ticket = f.ticket('cold-resume');
    fake.usage.mockResolvedValue({ status: usageStatus });
    retained(f);
    f.phases.splice(0);
    const admission = f.pin('completion-intent.json');
    fake.wait.mockImplementation(() => {
      const current = f.phases.find((entry) => entry.outcome === null);
      if (current !== undefined) {
        f.trace.push('settled:' + current.phase.stage);
        current.outcome = f.completed;
      } else {
        expect(existsSync(join(f.evidenceRoot, 'delegated-completion-request.json'))).toBe(true);
        f.relay('completion-admission', { phase: admission });
      }
      return Promise.resolve();
    });
    const outcome = await runH06DelegatedCold(ticket, f.configPin);
    expect(f.trace.indexOf('control:cold-resume')).toBeLessThan(
      f.trace.indexOf('settled:cold-resume'),
    );
    expect(fake.completion).toHaveBeenCalledWith(
      {
        claim: f.claimPin,
        phase: admission,
        delivery: ticket.delivery,
        brief: f.final,
        coldResume: { path: join(f.root, 'cold-resume-control.json'), sha256: digest('{}\n') },
        previousThreads: [f.pin('retained-warm-thread.json'), f.pin('retained-cold-thread.json')],
      },
      { store: expect.any(Object) as unknown },
    );
    expect(f.read(outcome.path)).toMatchObject({
      kind: 'h06-delegated-completion-result/1',
      phase: admission,
      delivery: ticket.delivery,
      usage: { status: usageStatus },
      qualification: false,
    });
    expect(fake.writer).not.toHaveBeenCalled();
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(fake.usage).toHaveBeenCalledWith({
      claim: f.claimPin,
      threads: [
        f.pin('retained-warm-thread.json'),
        f.pin('retained-cold-thread.json'),
        f.pin('completion-thread.json'),
      ],
    });
    expect(fake.completion.mock.invocationCallOrder[0]).toBeLessThan(
      fake.usage.mock.invocationCallOrder[0]!,
    );
  },
);

it.each(['claim', 'config'])(
  'rejects a changed retained %s before cold RESUME or completion',
  async (field) => {
    const f = fixture(),
      ticket = f.ticket('cold-resume');
    retained(f, { [field]: f.pin('other.json') });
    await expect(runH06DelegatedCold(ticket, f.configPin)).rejects.toThrow(
      'h06-delegated-cold-retained',
    );
    expect(fake.apply).not.toHaveBeenCalled();
    expect(fake.completion).not.toHaveBeenCalled();
  },
);

it('does not admit completion after an unknown cold RESUME expires', async () => {
  const f = fixture(),
    ticket = f.ticket('cold-resume');
  retained(f);
  f.phases.splice(0);
  fake.wait.mockImplementation(() => {
    f.setNow(f.claim.workDeadlineMs);
    return Promise.resolve();
  });
  await expect(runH06DelegatedCold(ticket, f.configPin)).rejects.toThrow(
    'h06-delegated-relay-timeout',
  );
  expect(fake.completion).not.toHaveBeenCalled();
  expect(existsSync(join(f.evidenceRoot, 'delegated-completion-request.json'))).toBe(false);
});

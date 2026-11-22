import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { readH06NativeRequestBinding } from './comparisonH06NativeAttemptPlan.js';
import { verifyH06LegacySeriesPrimary } from './comparisonH06OperatorLegacyEvidence.js';

const phases = vi.hoisted(() => [
  'load',
  'warm-pause',
  'warm-resume',
  'cold-pause',
  'cold-resume',
  'completion',
]);
const observed = vi.hoisted(() => ({
  authority: vi.fn(),
  phases: vi.fn(),
  crossing: vi.fn(),
  ledger: vi.fn(),
  journal: vi.fn(),
  terminal: vi.fn(),
  usage: vi.fn(),
  delivery: vi.fn(),
  profiles: vi.fn(),
}));
vi.mock('./comparisonH06DelegatedDelivery.js', () => ({
  verifyH06DelegatedDelivery: observed.delivery,
}));
vi.mock('./comparisonH06ManagedProfiles.js', () => ({
  verifyH06ManagedProfiles: observed.profiles,
}));
vi.mock('./comparisonH06DelegatedAuthority.js', () => ({
  h06DelegatedStages: phases,
  readH06DelegatedAuthority: observed.authority,
  openH06DelegatedPhaseLedger: () => ({ inspect: observed.phases }),
}));
vi.mock('./comparisonH06NativeLegacy.js', () => ({
  checkH06NativeLegacyCrossing: observed.crossing,
}));
vi.mock('./comparisonH06NativeTurnLedger.js', () => ({
  openH06NativeTurnLedger: () => ({ inspect: observed.ledger }),
}));
vi.mock('./comparisonH06NativeJournal.js', () => ({ readH06NativeJournal: observed.journal }));
vi.mock('./comparisonH06NativeLegacyUsage.js', () => ({
  observeH06NativeLegacyTranscript: observed.terminal,
}));
vi.mock('./comparisonH06NativeUsage.js', () => ({ checkH06NativeUsage: observed.usage }));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'aw-h06-legacy-evidence-'));
  roots.push(root);
  const save = (name: string, value: unknown) => {
    const path = join(root, name);
    const bytes = canonical(value);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const claim = save('delegated-claim.json', { fixture: 'claim' });
  const requestHash = 'a'.repeat(64);
  const request = {
    evidenceRoot: root,
    stimulus: { longStageMs: 30_000 },
    binding: { operationId: 'h06-test' },
    chat: { threadId: 'root', workspace: root },
    budget: { maxManagedStarts: 20 },
  } as ReturnType<typeof readH06NativeRequestBinding>;
  const initialFailure = save('f01/receipt.json', {});
  const renewal = save('legacy-renew.json', { initialFailure });
  const crossing = save('legacy-crossing.json', { renewal });
  const stoppedProof = {
    kind: 'writers-stopped',
    active_turn: false,
    remaining_terminals: 0,
    remaining_processes: 0,
    before_hash: 'state',
    after_hash: 'state',
  };
  const writers = ['warm', 'cold', 'completion'];
  const coder = (name: string, proof: Record<string, unknown> = {}) => {
    const tree = join(root, name);
    const pin = save(`${name}-stop.json`, {
      ...stoppedProof,
      thread: name,
      owned: { complete: true, thread: name, tree },
      ...proof,
    });
    return {
      status: 'integrated',
      session: { id: name },
      copy: { binding: { root: tree } },
      stopped: { locator: pin.path, hash: pin.sha256 },
    };
  };
  const ledger: {
    admissions: { scope: { session: string }; response: { turnId: string } | null }[];
    status: 'RECORDED';
    used: number;
  } = {
    status: 'RECORDED',
    used: 9,
    admissions: writers.map((session) => ({
      scope: { session },
      response: { turnId: session + '-turn' },
    })),
  };
  const sessionsRoot = join(root, 'sessions');
  const threads = writers.map((id) =>
    save(`delegated-${id}-writer-thread.json`, {
      thread: { id, path: join(sessionsRoot, id + '.jsonl') },
    }),
  );
  observed.authority.mockReturnValue({
    request,
    requestHash,
    grant: { sessionsRoot },
    startedAt: 1005,
    source: {
      transcript: '/root.jsonl',
      turnId: 'grant-turn',
      source: { locator: '/root.jsonl#L3', hash: 'a'.repeat(64) },
    },
  });
  observed.journal.mockReturnValue(Buffer.from('{}\n'.repeat(5) + 'append\n'));
  observed.ledger.mockReturnValue(ledger);
  observed.terminal.mockReturnValue({ line: 5, hash: 'd'.repeat(64) });
  const usage = {
    status: 'WITHIN_BUDGET',
    knownSubtotal: { responses: 10, inputUncached: 20, inputCached: 30, output: 40 },
    receipts: [],
  };
  observed.usage.mockReturnValue(usage);
  function outcome(proof: Record<string, unknown> = {}) {
    const final = coder('completion');
    const completionCoder = save('completion-coder.json', final);
    const entries = phases.map((stage) => {
      const intent = save(stage + '-intent.json', { stage });
      const contents = (() => {
        if (stage === 'completion') return { completed: { coder: completionCoder } };
        if (stage !== 'warm-pause' && stage !== 'cold-pause') return {};
        const paused = coder(stage, proof);
        return {
          writer: {
            coder: paused,
            live: save(stage + '-live.json', { writer: paused }),
            stopped: paused.stopped,
          },
        };
      })();
      const result = save(`delegated-${stage}-result.json`, contents);
      const delivery = save(stage + '-delivery.json', { stage });
      const settled = save(stage + '-settlement-body.json', { result, delivery });
      const settlement = save(stage + '-settlement.json', { outcome: settled });
      return { stage, intent, result, settlement };
    });
    observed.phases.mockReturnValue({
      phases: entries.map(({ stage, settlement, intent }) => ({
        phase: { stage },
        intent,
        outcome: settlement,
      })),
    });
    const body = {
      kind: 'h06-delegated-run-outcome/1',
      claim,
      status: 'completed',
      outcome: { initialFailure, writer: { renewal, crossing, result: entries.at(-1)!.result } },
      acceptance: {
        profile: 'h06-autonomous-recovery/3',
        claim,
        status: 'PASS',
        wholeAttemptComplete: false,
        externalUsage: 'UNKNOWN',
        managedUsage: { claim, ledger, threads },
        evidence: { phases: entries, completionCoder },
      },
    };
    return { pin: save('delegated-run-outcome.json', body), body, entries };
  }
  return {
    root,
    save,
    claim,
    request,
    requestHash,
    renewal,
    crossing,
    ledger,
    usage,
    outcome,
    threads,
    sessionsRoot,
    coder,
  };
}

it('reopens the pinned phases and accounts for observed managed Writer turns', () => {
  const f = fixture(),
    outcome = f.outcome();
  const verified = verifyH06LegacySeriesPrimary(outcome.pin, f.request, f.requestHash);
  expect(verified).toMatchObject({
    stopped: true,
    budgetExceeded: false,
    knownSubtotal: { observedResponses: 10, inputUncached: 20, inputCached: 30, output: 40 },
  });
  expect(verified.evidence).toContainEqual({ locator: f.claim.path, hash: f.claim.sha256 });
  expect(observed.crossing).toHaveBeenCalledWith(f.request.binding, f.renewal, f.crossing, 30_000);
  expect(observed.usage).toHaveBeenCalledWith(
    expect.objectContaining({
      participants: [expect.any(Object), expect.any(Object), expect.any(Object)],
    }),
  );
});

it('reopens the sealed managed journals and derives the exact five actor deliveries', () => {
  const f = fixture(),
    original = f.outcome();
  observed.profiles.mockReturnValue([]);
  observed.delivery.mockImplementation((value: unknown) => value);
  const participants = ['warm', 'cold', 'completion'].map((session) => {
    const transcript = join(f.sessionsRoot, session + '.jsonl');
    return {
      session,
      transcript,
      run: f.request.binding.operationId,
      stage: 'execution',
      through: { locator: transcript + '#L5', hash: 'd'.repeat(64) },
    };
  });
  const pin = (overrides: Record<string, unknown> = {}) =>
    f.save('delegated-run-outcome.json', {
      ...original.body,
      acceptance: {
        ...original.body.acceptance,
        managedUsage: {
          ...original.body.acceptance.managedUsage,
          participants,
          receipts: [],
          status: 'WITHIN_BUDGET',
          ...overrides,
        },
      },
    });
  const profile = { model: 'model', effort: 'high', clientVersion: '0.154.0' };
  const verified = verifyH06LegacySeriesPrimary(pin(), f.request, f.requestHash, profile);
  expect(verified.receipt).toMatchObject({
    root: { session: 'root', turnId: 'grant-turn', startedAtMs: 1005 },
    managed: { receipts: [], starts: 9 },
    actorDeliveries: phases.slice(0, -1).map((stage) => ({ stage })),
  });
  expect(observed.terminal.mock.calls[0]![0]).toEqual(Buffer.from('{}\n'.repeat(5)));
  expect(observed.profiles).toHaveBeenCalledWith(participants, f.ledger.admissions, profile);
  expect(() =>
    verifyH06LegacySeriesPrimary(pin({ receipts: ['changed'] }), f.request, f.requestHash, profile),
  ).toThrow('h06-series-legacy-managed-changed');
  expect(() =>
    verifyH06LegacySeriesPrimary(
      pin({
        participants: [
          { ...participants[0], through: { locator: '/foreign#L5', hash: 'd'.repeat(64) } },
        ],
      }),
      f.request,
      f.requestHash,
      profile,
    ),
  ).toThrow('h06-series-legacy-managed-terminal');
});

it('preserves the known budget excess of an incomplete observation', () => {
  const f = fixture(),
    outcome = f.outcome();
  f.ledger.admissions[0]!.response = null;
  const body = {
    ...outcome.body,
    acceptance: {
      ...outcome.body.acceptance,
      managedUsage: { ...outcome.body.acceptance.managedUsage, ledger: f.ledger },
    },
  };
  observed.terminal.mockReturnValueOnce(null);
  observed.usage.mockReturnValue({ ...f.usage, status: 'OVER_BUDGET' });
  expect(
    verifyH06LegacySeriesPrimary(
      f.save('delegated-run-outcome.json', body),
      f.request,
      f.requestHash,
    ),
  ).toMatchObject({ budgetExceeded: true });
  const accounted = observed.usage.mock.calls[0]![0] as { participants: unknown[] };
  expect(accounted.participants).toHaveLength(1);
});

it.each([
  { kind: 'wrong' },
  { thread: 'wrong' },
  { active_turn: true },
  { remaining_terminals: 1 },
  { remaining_processes: 1 },
  { before_hash: null },
  { after_hash: 'changed' },
  { owned: { complete: false } },
  { owned: { complete: true, thread: 'wrong' } },
  { owned: { complete: true, thread: 'warm-pause', tree: '/different-writer' } },
])('retains an unconfirmed managed STOP for damaged proof %j', (proof) => {
  const f = fixture(),
    outcome = f.outcome(proof);
  expect(verifyH06LegacySeriesPrimary(outcome.pin, f.request, f.requestHash)).toMatchObject({
    stopped: false,
  });
});

it('rejects foreign and incomplete primary evidence before reporting a managed result', () => {
  const f = fixture(),
    outcome = f.outcome();
  const verify = (body: unknown) =>
    verifyH06LegacySeriesPrimary(
      f.save('delegated-run-outcome.json', body),
      f.request,
      f.requestHash,
    );
  const invalid = (updates: Record<string, unknown>) => ({
    ...outcome.body,
    acceptance: { ...outcome.body.acceptance, ...updates },
  });
  expect(() =>
    verifyH06LegacySeriesPrimary({ ...outcome.pin, path: '/foreign' }, f.request, f.requestHash),
  ).toThrow('h06-series-legacy-evidence-path');
  expect(() => verifyH06LegacySeriesPrimary(f.claim, f.request, f.requestHash)).toThrow(
    'h06-series-legacy-evidence-path',
  );
  expect(() =>
    verifyH06LegacySeriesPrimary(
      outcome.pin,
      { ...f.request, budget: { ...f.request.budget, maxManagedStarts: 1 } },
      f.requestHash,
    ),
  ).toThrow('h06-series-legacy-authority');
  expect(() => verifyH06LegacySeriesPrimary(outcome.pin, f.request, 'wrong')).toThrow(
    'h06-series-legacy-authority',
  );
  for (const update of [
    { claim: null },
    { managedUsage: { claim: null } },
    { profile: 'wrong' },
    { wholeAttemptComplete: true },
    { externalUsage: 'COMPLETE' },
  ])
    expect(() => verify(invalid(update))).toThrow('h06-series-legacy-authority');
  expect(() => verify({ ...outcome.body, kind: 'wrong' })).toThrow('h06-series-legacy-authority');
  const renewal = f.save('legacy-renew.json', { initialFailure: null });
  expect(() =>
    verify({
      ...outcome.body,
      outcome: { ...outcome.body.outcome, writer: { ...outcome.body.outcome.writer, renewal } },
    }),
  ).toThrow('h06-series-legacy-continuity');
});

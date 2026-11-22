import {
  createChatMessages,
  applyChatMessage,
  requireCurrentHumanCompletion,
  requireSealedHumanCompletion,
} from '../core/chatMessages.js';
import { createChatControl } from '../core/chatControl.js';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { freezeChecks } from '../adapters/project/preparedChecks.js';
import type { PreparedChecks } from '../adapters/project/preparedChecks.js';
import { readChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import {
  prepareCurrentChat,
  readyCurrentChat,
  beginChatExecution,
  finishChatProjection,
  chatStatus,
} from '../application/currentChatWorkflow.js';
import type { ChatDependencies, ChatPlanning } from '../application/currentChatWorkflow.js';
import { advanceExecution, beginExecution } from '../application/executionWorkflow.js';
import { createExecution } from '../core/execution.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { workflowFixture, executionEvent } from './workflowFixtures.js';
import { fixture, grant } from './storageFixtures.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { ChatContext, ChatContextJournal } from '../ports/chatContext.js';
import type { TechnicalState, Json } from '../core/evidence.js';
import { saveManaged, readManaged } from '../adapters/storage/managedChatFiles.js';
import { retainEvidence } from '../adapters/storage/retainedJson.js';
import { createCouncil } from '../core/council.js';
import { localPlanningRisks } from '../core/localRun.js';
import type { LocalImplementationPlan } from '../core/localRun.js';
import { backupSupervision } from '../adapters/storage/supervisionBackup.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
let db: ReturnType<typeof fixture>;
let deps: ChatDependencies;
let planning: ChatPlanning;
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
  db.claim();
  const host: CurrentChatHost = {
    continuation: async () => f.proof,
    boundary: async () => ({ kind: 'completed', source: f.proof }),
    reference: async () => undefined,
    message: async () => ({ thread_id: 'session', turn_id: 'turn' }),
    observe: async () => ({
      thread_id: 'session',
      turn_id: 'turn',
      host_id: 'local',
      workspace: f.root,
      model: 'fixture-model',
      effort: 'high',
      client_version: 'fixture-only',
      approval_policy: 'never',
      sandbox_policy: 'danger-full-access',
      permission_profile: 'disabled',
      network_access: true,
      source: f.proof,
    }),
    load: async (run) => ({
      run_id: run.spec.run_id,
      session_id: run.spec.session_id,
      procedures: run.spec.procedures,
      rules: run.spec.rules,
      observed_read: 'explicit isolated host test double',
    }),
  };
  deps = {
    host,
    runs: new TaskLocalRuns({ execute: async (r) => db.store.execute(r) }, grant.context, 1, false),
    runInputs: {
      verify: async (run) => {
        await f.inputs.verify(run.spec.sources);
      },
    },
    inputs: f.inputs,
    journal: new TaskWorkflowJournal(
      { execute: async (r) => db.store.execute(r) },
      grant.context,
      1,
      false,
    ),
    cards: f.cards,
  };
  deps.runInputs = {
    verify: async (run) => {
      await f.inputs.verify(run.spec.sources);
    },
  };
  planning = { task_id: 'task', council: f.council('planning'), source: f.proof };
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});
function preparation() {
  let messages: ChatContext['messages'] = null;
  let control: ChatContext['control'] = null;
  const chat: ChatContextJournal = {
    read: vi.fn<ChatContextJournal['read']>(async () => ({
      run: (await deps.runs.read())!,
      workflow: await deps.journal.read(),
      coordination_bound: false,
      messages,
      control,
    })),
    save: vi.fn<ChatContextJournal['save']>(async (_expected, next) => {
      messages = next.messages;
      control = next.control;
    }),
  };
  return {
    chat,
    spec: {
      ...f.executor.spec,
      host_id: 'local',
      route: { kind: 'substantial' as const, accepted_plan: null },
    },
  };
}
it('prepares and repeats the current chat in effect order without saving LOAD or repeating initialization', async () => {
  const { spec, chat } = preparation();
  const observed = await deps.host.observe();
  const effects: string[] = [];
  const saveRun = deps.runs.save.bind(deps.runs);
  vi.spyOn(deps.runs, 'save').mockImplementation(async (expected, next) => {
    effects.push(`save:${next.status}`);
    await saveRun(expected, next);
  });
  const verify = deps.runInputs.verify.bind(deps.runInputs);
  vi.spyOn(deps.runInputs, 'verify').mockImplementation(async (run) => {
    effects.push(`verify:${run.status}`);
    await verify(run);
  });
  const load = deps.host.load.bind(deps.host);
  const loadSpy = vi.spyOn(deps.host, 'load').mockImplementation(async (run, marker, reuse) => {
    effects.push(`load:${run.status}`);
    return load(run, marker, reuse);
  });
  vi.spyOn(deps.host, 'observe').mockImplementation(async () => {
    effects.push('observe');
    return observed;
  });
  const saveChat = vi.mocked(chat.save).getMockImplementation()!;
  vi.mocked(chat.save).mockImplementation(async (expected, next, operation) => {
    effects.push(operation);
    await saveChat(expected, next, operation);
  });
  const prepared = await prepareCurrentChat(spec, 1, 'read', observed, false, chat, deps);
  expect(effects).toEqual([
    'verify:inbox',
    'save:inbox',
    'verify:inbox',
    'load:inbox',
    'save:waiting',
    'chat:messages:begin',
    'observe',
    'chat:control:begin',
  ]);
  expect(prepared.run).toMatchObject({
    status: 'waiting',
    revision: 1,
    loaded: null,
    spec: {
      effective: {
        model: observed.model,
        effort: observed.effort,
        permissions: spec.requested.permissions,
      },
    },
  });
  expect(prepared.run.history.map((event) => event.event_id)).toEqual(['chat:prepare']);
  expect(JSON.parse(prepared.run.history[0]!.payload)).toMatchObject({
    type: 'WAIT',
    expected_revision: 0,
    generation: 1,
  });
  expect(prepared.messages).toMatchObject({ task_id: 'task', thread_id: 'session' });
  expect(prepared.control).toMatchObject({ status: 'active', observed });
  expect(loadSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'inbox' }),
    'read',
    false,
  );
  effects.length = 0;
  expect(await prepareCurrentChat(spec, 1, 'again', observed, true, chat, deps)).toEqual(prepared);
  expect(effects).toEqual(['verify:waiting', 'load:waiting']);
  expect(loadSpy).toHaveBeenLastCalledWith(prepared.run, 'again', true);
});
it('rejects a different prepare generation, specification or effective profile before further effects', async () => {
  const { spec, chat } = preparation();
  const observed = await deps.host.observe();
  const prepared = await prepareCurrentChat(spec, 1, 'read', observed, false, chat, deps);
  const verify = vi.spyOn(deps.runInputs, 'verify');
  const load = vi.spyOn(deps.host, 'load');
  const save = vi.spyOn(deps.runs, 'save');
  vi.mocked(chat.read).mockClear();
  await expect(prepareCurrentChat(spec, 2, 'read', observed, false, chat, deps)).rejects.toThrow(
    'chat-prepare-conflict',
  );
  await expect(
    prepareCurrentChat({ ...spec, outcome: 'different' }, 1, 'read', observed, false, chat, deps),
  ).rejects.toThrow('chat-prepare-conflict');
  await expect(
    prepareCurrentChat(spec, 1, 'read', { ...observed, model: 'other' }, false, chat, deps),
  ).rejects.toThrow('chat-prepare-conflict');
  expect(verify).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(chat.read).not.toHaveBeenCalled();
  expect(await deps.runs.read()).toEqual(prepared.run);
});
it('verifies existing prepare inputs before loading or initializing the chat', async () => {
  const { spec, chat } = preparation();
  const observed = await deps.host.observe();
  const prepared = await prepareCurrentChat(spec, 1, 'read', observed, false, chat, deps);
  await f.file(spec.sources[0]!.locator, 'changed preparation source');
  const load = vi.spyOn(deps.host, 'load');
  vi.mocked(chat.read).mockClear();
  await expect(prepareCurrentChat(spec, 1, 'read', observed, false, chat, deps)).rejects.toThrow(
    'workflow-input-changed',
  );
  expect(load).not.toHaveBeenCalled();
  expect(chat.read).not.toHaveBeenCalled();
  expect(await deps.runs.read()).toEqual(prepared.run);
});
it('rejects an invalid prepare marker after persisting and verifying the run before loading', async () => {
  const { spec, chat } = preparation();
  const observed = await deps.host.observe();
  const verify = vi.spyOn(deps.runInputs, 'verify');
  const load = vi.spyOn(deps.host, 'load');
  await expect(prepareCurrentChat(spec, 1, null, observed, false, chat, deps)).rejects.toThrow(
    'missing-text',
  );
  expect(verify).toHaveBeenCalledTimes(2);
  expect(await deps.runs.read()).toMatchObject({
    status: 'inbox',
    revision: 0,
    loaded: null,
    history: [],
  });
  expect(load).not.toHaveBeenCalled();
  expect(chat.read).not.toHaveBeenCalled();
  expect(chat.save).not.toHaveBeenCalled();
});
it.each(['identity', 'rules', 'procedures'] as const)(
  'does not wait or initialize after a rejected prepare LOAD %s and can retry',
  async (changed) => {
    const { spec, chat } = preparation();
    const observed = await deps.host.observe();
    const load = deps.host.load.bind(deps.host);
    vi.spyOn(deps.host, 'load').mockImplementationOnce(async (run) => ({
      ...(await load(run, 'read')),
      ...(changed === 'identity'
        ? { run_id: 'other' }
        : changed === 'rules'
          ? { rules: [] }
          : { procedures: [] }),
    }));
    await expect(prepareCurrentChat(spec, 1, 'read', observed, false, chat, deps)).rejects.toThrow(
      changed === 'identity' ? 'wrong-load-identity' : `${changed}-not-loaded`,
    );
    expect(await deps.runs.read()).toMatchObject({
      status: 'inbox',
      revision: 0,
      loaded: null,
      history: [],
    });
    expect(chat.read).not.toHaveBeenCalled();
    expect(chat.save).not.toHaveBeenCalled();
    expect(
      (await prepareCurrentChat(spec, 1, 'retry', observed, false, chat, deps)).run.status,
    ).toBe('waiting');
  },
);
it('replays an inline legacy planning event and requires a reader for an archived repeat', async () => {
  await bootstrap();
  await beginChatExecution(planning, gates, true, deps);
  const current = (await deps.journal.read()).execution!;
  const missing = {
    ...deps,
    journal: {
      ensureReady: deps.journal.ensureReady.bind(deps.journal),
      read: deps.journal.read.bind(deps.journal),
      save: deps.journal.save.bind(deps.journal),
    },
  };
  await expect(beginChatExecution(planning, gates, true, missing)).rejects.toThrow(
    'execution-history-reader-required',
  );
  const full = db.execute({ type: 'state' });
  const state = (full as { ok: true; value: TechnicalState }).value;
  expect(
    db.mutate({ type: 'checkpoint', state: state.checkpoint, effects: [] }, state.revision).ok,
  ).toBe(true);
  expect((await beginChatExecution(planning, gates, true, deps)).revision).toBe(current.revision);
});
const gates = [{ id: 'validate', kind: 'check' as const, applicable: true, reason: 'code' }];

it('boots the local route through real SQLite and a verified backup without planning answers', async () => {
  f.target.inputs = await f.inputs.capture(
    { files: ['source.txt', 'proof.txt'], directories: [] },
    'local plan',
  );
  for (const selected of Object.values(f.selection)) selected.inputs = f.target.inputs;
  const plan: LocalImplementationPlan = {
    schema_version: 1,
    requirement: f.proof,
    basis: [f.proof],
    owner: await f.ref('source.txt'),
    consumers: [await f.ref('source.txt')],
    consumers_complete: true,
    paths: ['source.txt'],
    risks: Object.fromEntries(
      localPlanningRisks.map((risk) => [risk, false]),
    ) as LocalImplementationPlan['risks'],
    reason: 'Existing local contract',
    checks: ['validate'],
    criterion: 'Boundary holds',
  };
  const local = { plan, source: f.proof, inputs: f.target.inputs, selection: f.selection };
  planning = {
    task_id: 'task',
    source: f.proof,
    local,
    council: createCouncil('planning', f.selection, f.target),
  };
  deps.runs = new TaskLocalRuns(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
    false,
    (state, operation) =>
      backupSupervision(
        { execute: async (r) => db.store.execute(r) },
        db.root,
        db.parent,
        grant,
        state,
        operation,
      ),
  );
  const spec = {
    ...f.executor.spec,
    host_id: 'local',
    sources: [f.proof],
    route: { kind: 'local' as const, accepted_plan: f.proof, plan: local.plan },
  };
  const ready = await readyCurrentChat(spec, 1, 'local-read', planning, deps);
  expect(ready.run.schema_version).toBe(2);
  const execution = await beginChatExecution(planning, gates, true, deps);
  expect(execution).toMatchObject({
    schema_version: 3,
    route: 'local',
    status: 'implementing',
    planning: null,
  });
  const stored = await deps.journal.read();
  expect(stored.schema_version).toBe(2);
  expect(stored.format_backup).toBeDefined();
  expect((await beginChatExecution(planning, gates, true, deps)).revision).toBe(execution.revision);
  const restored = structuredClone(planning);
  restored.local!.plan.criterion = 'another result';
  await expect(beginChatExecution(restored, gates, true, deps)).rejects.toThrow(
    'chat-planning-replay-conflict',
  );
});

async function doneWithFrozenCard() {
  await f.file(f.card.locator, f.card.content + '\n## Критерии\n- [ ] validate: full check\n');
  f.card = await f.cards.read(f.card.locator);
  const card = await f.ref(f.card.locator);
  f.executor.spec.identity = { task_id: 'task', card };
  f.executor.spec.sources.push(card, f.executor.spec.assignment, ...f.executor.spec.rules);
  deps.cards = new FileProjectCards(f.root, f.connection, resolve(db.parent, 'card-projections'));
  deps.inputs = new FileWorkflowInputs(f.root, db.parent);
  deps.runInputs = fileRunInputs(f.root, 'connection.json');
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  const frozen = await freezeChecks(f.root, db.parent, f.card.locator, [
    {
      criterion: 'validate',
      implementation: ['source.txt'],
      verification: [f.card.locator],
      check: {
        id: 'full',
        criterion: 'validate',
        command: { file: 'yarn', args: ['validate:brief'] },
        discovery: { files: ['source.txt'], directories: [] },
        attested_by: 'fixture',
      },
    },
  ]);
  const prepared = readChatArtifact(frozen) as PreparedChecks;
  f.target.inputs = prepared.checks[0]!.inputs;
  f.target.evidence_inputs = await new FileWorkflowInputs(f.root, db.parent).capture(
    {
      files: [...f.target.inputs.inputs.map((ref) => ref.locator), frozen.locator],
      directories: [],
      repository: true,
    },
    'package',
  );
  f.selection.architect.inputs = f.target.inputs;
  planning = { ...planning, council: f.council('planning') };
  await bootstrap();
  let run = await beginChatExecution(planning, gates, true, deps);
  const actions = [
    {
      type: 'REVIEW' as const,
      target: f.target,
      selection: f.selection,
      baseline: {
        kind: 'real' as const,
        scenario: 'isolated projection fixture',
        evidence: f.proof,
        inputs: f.target.inputs,
        elapsed_ms: 1,
        exit_code: 0,
      },
      checks: [
        {
          id: 'validate',
          verdict: 'PASS' as const,
          reason: 'fixture receipt; no real validate',
          evidence: f.proof,
          inputs: f.target.inputs,
        },
      ],
    },
    { type: 'ACCEPT' as const, council: f.council('acceptance'), findings: [] },
    {
      type: 'RESULT' as const,
      result: {
        scope: f.target.scope,
        target: f.target,
        evidence: [f.proof, f.target.diff],
        child_results: [],
        limitations: ['isolated fixture'],
        summary: 'accepted',
      },
    },
    { type: 'DONE' as const },
  ];
  for (const action of actions)
    run = await advanceExecution(executionEvent(run, action), deps.journal, deps.inputs);
}

it.each(['confirmed', 'before-files', 'partial-files', 'after-files'])(
  'resumes %s projection with an actual frozen card and full role inputs',
  async (cut) => {
    await doneWithFrozenCard();
    const apply = deps.cards.apply.bind(deps.cards);
    const save = deps.runs.save.bind(deps.runs);
    if (cut === 'before-files' || cut === 'partial-files')
      vi.spyOn(deps.cards, 'apply').mockImplementationOnce(async (plan) => {
        if (cut === 'partial-files') await f.file(plan.to, plan.changes[0]!.after!);
        throw new Error('interrupted file projection');
      });
    if (cut === 'after-files')
      vi.spyOn(deps.runs, 'save').mockImplementation(async (expected, next) => {
        if (next.projection?.result.status === 'confirmed') throw new Error('lost final save');
        await save(expected, next);
      });
    if (cut === 'confirmed') await finishChatProjection('finish', deps);
    else
      await expect(finishChatProjection('finish', deps)).rejects.toThrow(
        cut === 'after-files' ? 'lost final save' : 'interrupted file projection',
      );
    vi.restoreAllMocks();
    deps.cards.apply = apply;
    const pending = (await deps.runs.read())!;
    expect(pending.projection?.result.status).toBe(cut === 'confirmed' ? 'confirmed' : 'pending');
    await deps.runInputs.verify(pending);
    const local = await finishChatProjection('finish', deps);
    expect(local.projection?.result.status).toBe('confirmed');
    expect(await finishChatProjection('finish', deps)).toEqual(local);
    await deps.runInputs.verify(local);
    if (cut === 'confirmed') {
      const artifact = f.target.evidence_inputs!.inputs.find((ref) =>
        ref.locator.startsWith(db.parent + '/'),
      )!;
      const original = await readFile(artifact.locator);
      await writeFile(artifact.locator, 'changed external evidence');
      await expect(finishChatProjection('finish', deps)).rejects.toThrow(
        'chat-result-evidence-stale',
      );
      await writeFile(artifact.locator, original);
      await f.file('source.txt', 'unexpected code change');
      await expect(finishChatProjection('finish', deps)).rejects.toThrow('chat-result-stale');
      await f.file('source.txt', 'source revision 1');
      await f.file('unexpected.ts', 'new source');
      await expect(finishChatProjection('finish', deps)).rejects.toThrow('chat-result-stale');
      await rm(resolve(f.root, 'unexpected.ts'));
      const change = local.projection!.plan.changes.find(
        (c) => c.before !== null && c.after !== null,
      )!;
      await f.file(change.locator, change.before!);
      await expect(finishChatProjection('finish', deps)).rejects.toThrow('workflow-input-changed');
      await f.file(change.locator, change.after!);
      const projection = structuredClone(local.projection!);
      projection.plan.changes.find((c) => c.locator === f.card.locator)!.before =
        'different frozen base';
      expect((await deps.inputs.current(f.target.inputs, projection)).complete).toBe(false);
      await symlink(resolve(f.root, local.projection!.plan.to), resolve(f.root, f.card.locator));
      await expect(finishChatProjection('finish', deps)).rejects.toThrow('workflow-input-changed');
      await rm(resolve(f.root, f.card.locator));
      expect(await finishChatProjection('finish', deps)).toEqual(local);
    }
  },
  15_000,
);
it('replays planning from a retained certificate without the original body or an archive reader', async () => {
  const path = resolve(f.root, 'plan.json');
  await f.file(
    'plan.json',
    JSON.stringify({ schema_version: 1, task_id: 'task', council: planning.council }),
  );
  const source = await f.ref('plan.json');
  const accepted = { ...planning, source };
  await readyCurrentChat(
    { ...f.executor.spec, host_id: 'local', route: { kind: 'substantial', accepted_plan: source } },
    1,
    'read',
    accepted,
    deps,
  );
  const journal = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
  const current = { ...deps, journal };
  const started = await beginChatExecution(accepted, gates, true, current);
  const minimal = retainEvidence({
    schema_version: 1,
    task_id: 'task',
    council: planning.council,
  }) as Record<string, unknown>;
  saveManaged(path, { ...minimal, retained_source: source }, true, 'minimal');
  const replacement = await f.ref('plan.json');
  const local = (await deps.runs.read())!;
  await deps.runs.save(local, {
    ...local,
    revision: local.revision + 1,
    spec: { ...local.spec, route: { kind: 'substantial', accepted_plan: replacement } },
  });
  const certificate = readManaged<{ council: ChatPlanning['council'] }>(path)!;
  const replay = {
    ...accepted,
    council: certificate.council,
    source: replacement,
    retained_source: source,
  };
  const withoutReader = {
    ...current,
    journal: {
      fingerprint: journal.fingerprint!,
      read: journal.read.bind(journal),
      save: journal.save.bind(journal),
      ensureReady: journal.ensureReady.bind(journal),
    },
  };
  expect(await beginChatExecution(replay, gates, true, withoutReader)).toEqual(started);
  const changed = structuredClone(replay);
  changed.council.advisers.architect!.answer!.limitations.push('different decision');
  await expect(beginChatExecution(changed, gates, true, withoutReader)).rejects.toThrow(
    'chat-planning-replay-conflict',
  );
});
async function bootstrap() {
  const spec = {
    ...f.executor.spec,
    host_id: 'local',
    route: { kind: 'substantial' as const, accepted_plan: f.proof },
  };
  return readyCurrentChat(spec, 1, 'read', planning, deps);
}
it.each([false, true])(
  'readies the current agent, preserves FAIL and projects an accepted Result with separate evidence=%s',
  async (separate) => {
    if (separate) {
      await f.file('package.txt', 'observed evidence');
      f.target.evidence_inputs = await f.inputs.capture(
        { files: ['source.txt', 'package.txt'], directories: [] },
        'evidence',
      );
      planning = { ...planning, council: f.council('planning') };
      await f.file('package.txt', 'stale evidence');
      await expect(bootstrap()).rejects.toThrow('chat-planning-evidence-stale');
      await f.file('package.txt', 'observed evidence');
    }
    await f.file(
      f.card.locator,
      f.card.content + '\n## Критерии\n- [ ] validate: полная проверка\n',
    );
    f.card = await f.cards.read(f.card.locator);
    f.executor.spec.identity = {
      task_id: 'task',
      card: { locator: f.card.locator, hash: f.card.revision },
    };
    expect(chatStatus(null)).toEqual({
      status: 'not-started',
      blockers: ['execution-not-started'],
    });
    expect(await bootstrap()).toEqual(await bootstrap());
    let run = await beginChatExecution(planning, gates, true, deps);
    expect(run.status).toBe('implementing');
    expect(await beginChatExecution(planning, gates, true, deps)).toEqual(run);
    await expect(
      beginChatExecution(
        planning,
        [...gates, { id: 'extra', kind: 'check', applicable: true, reason: 'new' }],
        true,
        deps,
      ),
    ).rejects.toThrow('chat-execution-conflict');
    await expect(finishChatProjection('early', deps)).rejects.toThrow(
      'chat-completion-not-accepted',
    );
    const review = (verdict: 'PASS' | 'FAIL') => ({
      type: 'REVIEW' as const,
      target: f.target,
      selection: f.selection,
      baseline: {
        kind: 'real' as const,
        scenario: 'isolated contract fixture',
        evidence: f.proof,
        inputs: f.target.inputs,
        elapsed_ms: 1,
        exit_code: 0,
      },
      checks: [
        {
          id: 'validate',
          verdict,
          reason: 'observed fixture',
          evidence: f.proof,
          inputs: f.target.inputs,
        },
      ],
    });
    run = await advanceExecution(executionEvent(run, review('FAIL')), deps.journal, f.inputs);
    expect(chatStatus(run).blockers).toContain('validate:not-passed');
    await expect(
      advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs),
    ).rejects.toThrow();
    run = await advanceExecution(
      executionEvent(run, { type: 'CORRECT', findings: [] }),
      deps.journal,
      f.inputs,
    );
    if (separate) {
      await f.file('package.txt', 'stale evidence');
      await expect(
        advanceExecution(executionEvent(run, review('PASS')), deps.journal, f.inputs),
      ).rejects.toThrow('execution-evidence-stale-or-unknown');
      await f.file('package.txt', 'observed evidence');
    }
    run = await advanceExecution(executionEvent(run, review('PASS')), deps.journal, f.inputs);
    run = await advanceExecution(
      executionEvent(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] }),
      deps.journal,
      f.inputs,
    );
    run = await advanceExecution(
      executionEvent(run, {
        type: 'RESULT',
        result: {
          scope: run.target.scope,
          target: run.target,
          evidence: [f.proof],
          child_results: [],
          limitations: ['fixture'],
          summary: 'accepted',
        },
      }),
      deps.journal,
      f.inputs,
    );
    run = await advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs);
    expect(chatStatus(run)).toMatchObject({ status: 'done', blockers: [] });
    await f.file('source.txt', 'changed after DONE');
    await expect(finishChatProjection('finish', deps)).rejects.toThrow('chat-result-stale');
    await f.file('source.txt', 'source revision 1');
    if (separate) {
      await f.file('package.txt', 'changed after DONE');
      await expect(finishChatProjection('finish', deps)).rejects.toThrow(
        'chat-result-evidence-stale',
      );
      await f.file('package.txt', 'observed evidence');
    }
    const before = await deps.journal.read();
    const localBefore = await deps.runs.read();
    const cardBefore = await readFile(resolve(f.root, f.card.locator), 'utf8');
    for (const profile of f.profiles.architect) {
      const original = await readFile(resolve(f.root, profile.locator), 'utf8');
      await f.file(profile.locator, '# Changed after DONE\n');
      await expect(finishChatProjection('finish', deps)).rejects.toThrow('workflow-input-changed');
      await rm(resolve(f.root, profile.locator));
      await expect(finishChatProjection('finish', deps)).rejects.toThrow();
      expect(await deps.journal.read()).toEqual(before);
      expect(await deps.runs.read()).toEqual(localBefore);
      expect(await readFile(resolve(f.root, f.card.locator), 'utf8')).toBe(cardBefore);
      await f.file(profile.locator, original);
    }
    let currentReads = 0;
    await expect(
      finishChatProjection('finish', {
        ...deps,
        inputs: {
          verify: deps.inputs.verify.bind(deps.inputs),
          current: async (manifest) => ({
            ...(await deps.inputs.current(manifest)),
            complete: ++currentReads <= (separate ? 2 : 1),
          }),
        },
      }),
    ).rejects.toThrow('council-inputs-stale-or-unknown');
    const local = await finishChatProjection('finish', deps);
    expect(local.projection?.result.status).toBe('confirmed');
    expect(local.projection?.plan.changes[0]?.after).toContain('- [x] validate: полная проверка');
    expect(await finishChatProjection('finish', deps)).toEqual(local);
    const profile = f.profiles.architect[1]!;
    const original = await readFile(resolve(f.root, profile.locator), 'utf8');
    await f.file(profile.locator, '# Changed after confirmed projection\n');
    await expect(finishChatProjection('finish', deps)).rejects.toThrow('workflow-input-changed');
    await f.file(profile.locator, original);

    await expect(finishChatProjection('other-operation', deps)).rejects.toThrow(
      'chat-projection-operation-conflict',
    );
    expect(local.spec.identity).toMatchObject({
      card: { locator: f.connection.plans.completed + '/task.md' },
    });
    expect(
      (await deps.journal.read({ archive: true })).execution!.history.some((e) =>
        e.payload.includes('FAIL'),
      ),
    ).toBe(true);
  },
);
it('rejects wrong task/planning, host profile, identity, changed bootstrap and changed LOAD replay', async () => {
  const spec = {
    ...f.executor.spec,
    host_id: 'local',
    route: { kind: 'substantial' as const, accepted_plan: f.proof },
  };
  await expect(
    readyCurrentChat(spec, 1, 'read', { ...planning, task_id: 'other' }, deps),
  ).rejects.toThrow('chat-planning-unconfirmed');
  const observed = await deps.host.observe();
  const unsupported = {
    ...deps,
    host: { ...deps.host, observe: async () => ({ ...observed, sandbox_policy: 'read-only' }) },
  };
  await expect(readyCurrentChat(spec, 1, 'read', planning, unsupported)).rejects.toThrow(
    'chat-write-profile-unsupported',
  );
  await expect(
    readyCurrentChat({ ...spec, session_id: 'other' }, 1, 'read', planning, deps),
  ).rejects.toThrow('chat-executor-mismatch');
  await bootstrap();
  await expect(
    readyCurrentChat({ ...spec, outcome: 'different' }, 1, 'read', planning, deps),
  ).rejects.toThrow('chat-bootstrap-conflict');
  const different = {
    ...deps,
    host: {
      ...deps.host,
      load: async (r: Parameters<CurrentChatHost['load']>[0]) => ({
        ...(await deps.host.load(r, 'read')),
        observed_read: 'other',
      }),
    },
  };
  await expect(readyCurrentChat(spec, 1, 'read', planning, different)).rejects.toThrow(
    'chat-load-replay-conflict',
  );
});
it('requires a local executor before beginning or projecting', async () => {
  await expect(beginChatExecution(planning, gates, true, deps)).rejects.toThrow(
    'chat-planning-unconfirmed',
  );
  await expect(finishChatProjection('finish', deps)).rejects.toThrow(
    'chat-completion-not-accepted',
  );
});
it('does not use scoped role requirements for a different proposal or outcome', async () => {
  planning.role_requirements = { architect: planning.council.selection.architect.requirements };
  await expect(bootstrap()).rejects.toThrow('chat-scoped-plan-stale');
  planning.council.target.diff = f.executor.spec.assignment;
  await expect(bootstrap()).rejects.toThrow('chat-scoped-plan-stale');
});
it('retains an inactive adviser without an answer while checking the active planning obligations', async () => {
  planning.council.advisers.product = { ...planning.council.advisers.architect!, answer: null };
  expect(await bootstrap()).toHaveProperty('run.status', 'ready');
});

it('projects an accepted mechanical result without inventing council profile obligations', async () => {
  await bootstrap();
  let run = await beginExecution(
    createExecution('task', 1, f.target, gates, false, 'mechanical'),
    deps.journal,
  );
  run = await advanceExecution(
    executionEvent(run, {
      type: 'MECHANICAL',
      proof: {
        inputs: f.target.inputs,
        accepted: f.proof,
        observed: f.proof,
        delta: f.target.diff,
        expected_delta: f.target.diff,
        links: [f.proof],
        expected_links: [f.proof],
        semantic_delta: false,
        applicability: 'applicable',
      },
    }),
    deps.journal,
    f.inputs,
  );
  run = await advanceExecution(
    executionEvent(run, {
      type: 'REVIEW',
      target: f.target,
      selection: f.selection,
      checks: [
        {
          id: 'validate',
          verdict: 'PASS',
          reason: 'mechanical proof checked',
          evidence: f.proof,
          inputs: f.target.inputs,
        },
      ],
      baseline: {
        kind: 'real',
        scenario: 'isolated mechanical fixture',
        evidence: f.proof,
        inputs: f.target.inputs,
        elapsed_ms: 1,
        exit_code: 0,
      },
    }),
    deps.journal,
    f.inputs,
  );
  run = await advanceExecution(
    executionEvent(run, {
      type: 'RESULT',
      result: {
        scope: run.target.scope,
        target: run.target,
        evidence: [f.proof, f.target.diff],
        child_results: [],
        limitations: ['fixture'],
        summary: 'mechanical result',
      },
    }),
    deps.journal,
    f.inputs,
  );
  await advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs);
  await f.file(f.profiles.architect[1]!.locator, '# Not a mechanical input\n');
  expect((await finishChatProjection('finish', deps)).projection?.result.status).toBe('confirmed');
});

async function td055Messages(messages: ReturnType<typeof createChatMessages>) {
  const reply = db.execute({ type: 'state', archive: 'current' });
  if (!reply.ok) throw new Error('fixture-state');
  const state = reply.value as TechnicalState;
  const saved = db.mutate(
    {
      type: 'checkpoint',
      state: { ...(state.checkpoint as object), chat_messages: messages } as unknown as Json,
      effects: [],
    },
    state.revision,
    1,
    'td055-messages-' + messages.revision,
  );
  expect(saved.ok).toBe(true);
}
async function td055Ready() {
  await bootstrap();
  const id = 'C1: результат проверен';
  let messages = createChatMessages('task', 'session', 1, f.proof);
  messages = applyChatMessage(messages, {
    type: 'ASK',
    id: 'ask-a',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source: f.proof,
    question_id: 'qa',
    action: id,
  });
  messages = applyChatMessage(messages, {
    type: 'DECIDE',
    id: 'yes-a',
    expected_revision: 1,
    generation: 1,
    thread_id: 'session',
    source: f.proof,
    question_id: 'qa',
    action: id,
    requirements_revision: 0,
    accepted: true,
  });
  await td055Messages(messages);
  let run = createExecution(
    'task',
    1,
    f.target,
    [...gates, { id, kind: 'human', applicable: true, reason: id }],
    true,
    'substantial',
  );
  await beginExecution(run, deps.journal);
  run = await advanceExecution(
    executionEvent(run, { type: 'PLAN', council: f.council('planning') }),
    deps.journal,
    f.inputs,
  );
  const review = {
    type: 'REVIEW' as const,
    target: f.target,
    selection: f.selection,
    baseline: {
      kind: 'real' as const,
      scenario: 'explicit unit technical fixture',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 0,
      exit_code: 0,
    },
    checks: ['validate', id].map((id) => ({
      id,
      verdict: 'PASS' as const,
      reason: 'explicit fixture',
      evidence: f.proof,
      inputs: f.target.inputs,
    })),
  };
  run = await advanceExecution(executionEvent(run, review), deps.journal, f.inputs);
  run = await advanceExecution(
    executionEvent(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] }),
    deps.journal,
    f.inputs,
  );
  const result = {
    type: 'RESULT' as const,
    result: {
      scope: f.target.scope,
      target: f.target,
      evidence: [f.proof, f.target.diff],
      child_results: [],
      limitations: ['Synthetic human/council fixtures, not native authority'],
      summary: 'unit',
    },
  };
  const ask = () => {
    messages = applyChatMessage(messages, {
      type: 'ASK',
      id: 'ask-b',
      expected_revision: messages.revision,
      generation: 1,
      thread_id: 'session',
      source: f.target.diff,
      question_id: 'qb',
      action: id,
    });
    return td055Messages(messages);
  };
  const decide = (accepted: boolean) => {
    messages = applyChatMessage(messages, {
      type: 'DECIDE',
      id: 'decision-b',
      expected_revision: messages.revision,
      generation: 1,
      thread_id: 'session',
      source: f.target.diff,
      question_id: 'qb',
      action: id,
      requirements_revision: 0,
      accepted,
    });
    return td055Messages(messages);
  };
  return { run, review, result, ask, decide, id, messages: () => messages };
}
it.each([false, true])(
  'TD055 refuses stale human RESULT with pending ASK or negative DECIDE=%s',
  async (negative) => {
    const h = await td055Ready();
    await h.ask();
    if (negative) await h.decide(false);
    await expect(
      advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs),
    ).rejects.toThrow('chat-human-decision-unconfirmed');
    expect((await deps.journal.read()).execution?.status).toBe('review');
    expect((await deps.runs.read())?.status).toBe('ready');
  },
);
it.each([false, true])(
  'TD055 refuses DONE after RESULT then ASK/negative=%s, including a direct journal save',
  async (negative) => {
    const h = await td055Ready();
    const run = await advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs);
    await h.ask();
    if (negative) await h.decide(false);
    await expect(
      advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs),
    ).rejects.toThrow('chat-human-decision-unconfirmed');
    const checkpoint = await deps.journal.read();
    await expect(
      deps.journal.save(
        checkpoint,
        { ...checkpoint, revision: checkpoint.revision + 1, execution: { ...run, status: 'done' } },
        'td055-direct',
      ),
    ).rejects.toThrow('chat-human-decision-unconfirmed');
  },
);
it('TD055 refreshes only human REVIEW in place and seals DONE against postDONE chat without rerunning a Writer', async () => {
  const h = await td055Ready();
  await h.ask();
  await h.decide(true);
  await expect(
    advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs),
  ).rejects.toThrow('chat-human-decision-unconfirmed');
  const refresh = {
    ...h.review,
    checks: h.review.checks.map((check) =>
      check.id === h.id ? { ...check, evidence: f.target.diff } : check,
    ),
  };
  let run = await advanceExecution(executionEvent(h.run, refresh), deps.journal, f.inputs);
  expect(run.status).toBe('review');
  expect(run.acceptance).toBeNull();
  expect(run.checks.find((check) => check.id === 'validate')).toEqual(
    h.run.checks.find((check) => check.id === 'validate'),
  );
  run = await advanceExecution(
    executionEvent(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] }),
    deps.journal,
    f.inputs,
  );
  run = await advanceExecution(executionEvent(run, h.result), deps.journal, f.inputs);
  run = await advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs);
  expect(run.human_completion?.message_revision).toBe(4);
  const currentMessages = h.messages();
  const later = applyChatMessage(currentMessages, {
    type: 'ASK',
    id: 'post-done',
    expected_revision: currentMessages.revision,
    generation: 1,
    thread_id: 'session',
    source: f.proof,
    question_id: 'post',
    action: h.id,
  });
  await td055Messages(later);
  await expect(deps.journal.checkHumanCompletion!(run)).resolves.toBeUndefined();
  const projected = await finishChatProjection('td055-project', deps);
  expect(projected.projection?.result.status).toBe('confirmed');
  expect(await finishChatProjection('td055-project', deps)).toEqual(projected);
});
it('TD055 rejects human refresh that changes the technical proof, target or baseline', async () => {
  const h = await td055Ready();
  const checks = h.review.checks.map((check) => ({ ...check, evidence: f.target.diff }));
  for (const refresh of [
    { ...h.review, checks },
    { ...h.review, target: { ...h.review.target, base: 'other' } },
    { ...h.review, baseline: { ...h.review.baseline, elapsed_ms: 1 } },
  ])
    await expect(
      advanceExecution(executionEvent(h.run, refresh), deps.journal, f.inputs),
    ).rejects.toThrow('human-review-refresh-only');
});
it('TD055 retains old DONE reading but refuses a new unbound human projection', async () => {
  const h = await td055Ready();
  let run = await advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs);
  run = await advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs);
  const reply = db.execute({ type: 'state', archive: 'current' });
  if (!reply.ok) throw new Error('fixture-state');
  const state = reply.value as TechnicalState,
    checkpoint = state.checkpoint as unknown as { workflow: { execution: typeof run } };
  delete checkpoint.workflow.execution.human_completion;
  expect(
    db.mutate(
      { type: 'checkpoint', state: checkpoint as unknown as Json, effects: [] },
      state.revision,
      1,
      'td055-old-checkpoint',
    ).ok,
  ).toBe(true);
  expect((await deps.journal.read()).execution?.status).toBe('done');
  await expect(finishChatProjection('td055-old', deps)).rejects.toThrow(
    'chat-human-completion-unbound',
  );
  expect((await deps.runs.read())?.projection).toBeNull();
});

it.each(['remove', 'not-applicable', 'wrong-kind'])(
  'TD055 refuses direct completion that weakens retained human inventory: %s',
  async (mode) => {
    const h = await td055Ready();
    await h.ask();
    const checkpoint = await deps.journal.read();
    const gates =
      mode === 'remove'
        ? h.run.gates.filter((gate) => gate.kind !== 'human')
        : h.run.gates.map((gate) =>
            gate.kind !== 'human'
              ? gate
              : mode === 'not-applicable'
                ? { ...gate, applicable: false }
                : { ...gate, kind: 'check' as const },
          );
    await expect(
      deps.journal.save(
        checkpoint,
        {
          ...checkpoint,
          revision: checkpoint.revision + 1,
          execution: { ...h.run, gates, result: h.result.result, status: 'done' },
        },
        'td055-inventory-' + mode,
      ),
    ).rejects.toThrow('chat-human-completion-floor');
    expect((await deps.journal.read()).execution?.gates).toEqual(h.run.gates);
    expect((await deps.journal.read()).execution?.human_completion).toBeUndefined();
    expect((await deps.runs.read())?.projection).toBeNull();
  },
);
it('TD055 store CAS rejects an ASK committed after human validation and immediately before DONE commit', async () => {
  const h = await td055Ready();
  const run = await advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs);
  let injected = false;
  const racing = new TaskWorkflowJournal(
    {
      execute: async (request) => {
        const command = request.command;
        if (!injected && command.type === 'mutate' && command.change.type === 'checkpoint') {
          const body = command.change.state as unknown as {
            workflow?: { execution?: { status?: string } };
          };
          if (body.workflow?.execution?.status === 'done') {
            injected = true;
            await h.ask();
          }
        }
        return db.store.execute(request);
      },
    },
    grant.context,
    1,
    false,
  );
  await expect(
    advanceExecution(executionEvent(run, { type: 'DONE' }), racing, f.inputs),
  ).rejects.toThrow('workflow-store-write-rejected');
  expect(injected).toBe(true);
  const current = (await deps.journal.read()).execution!;
  expect(current.status).toBe('review');
  expect(current.human_completion).toBeUndefined();
  expect((await deps.runs.read())?.projection).toBeNull();
});

it('TD055 leaves nonhuman execution literal without human completion metadata', () => {
  const run = createExecution('task', 1, f.target, gates, false, 'mechanical');
  requireCurrentHumanCompletion(run, null);
  requireSealedHumanCompletion(run);
  expect(Object.hasOwn(run, 'human_completion')).toBe(false);
});
it('TD055 preserves terminal execution during metadata checkpointing and refuses rewriting its result', async () => {
  const h = await td055Ready();
  let run = await advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs);
  run = await advanceExecution(executionEvent(run, { type: 'DONE' }), deps.journal, f.inputs);
  const checkpoint = await deps.journal.read();
  await deps.journal.save(
    checkpoint,
    { ...checkpoint, revision: checkpoint.revision + 1 },
    'td055-terminal-checkpoint',
  );
  const retained = await deps.journal.read();
  expect(retained.execution).toEqual(run);
  await expect(
    deps.journal.save(
      retained,
      {
        ...retained,
        revision: retained.revision + 1,
        execution: {
          ...run,
          result: { ...h.result.result, summary: 'rewritten completed result' },
        },
      },
      'td055-rewrite-done',
    ),
  ).rejects.toThrow('chat-human-completion-immutable');
});
it('TD055 refuses a chat-bound completion when chat_control survives but chat_messages are missing', async () => {
  const h = await td055Ready();
  const reply = db.execute({ type: 'state', archive: 'current' });
  if (!reply.ok) throw new Error('fixture-state');
  const state = reply.value as TechnicalState;
  const checkpoint = state.checkpoint as unknown as Record<string, Json>;
  delete checkpoint.chat_messages;
  checkpoint.chat_control = createChatControl(await deps.host.observe(), 1) as unknown as Json;
  expect(
    db.mutate(
      { type: 'checkpoint', state: checkpoint, effects: [] },
      state.revision,
      1,
      'td055-missing-messages',
    ).ok,
  ).toBe(true);
  await expect(
    advanceExecution(executionEvent(h.run, h.result), deps.journal, f.inputs),
  ).rejects.toThrow('chat-messages-missing');
  expect((await deps.journal.read()).execution?.result).toBeNull();
});

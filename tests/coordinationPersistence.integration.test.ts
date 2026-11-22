import { symlink, link, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beginCoordination, advanceCoordination } from '../application/coordinationWorkflow.js';
import { TaskCoordinationJournal } from '../adapters/storage/coordinationJournal.js';
import { FileCoordinationInputs, verifyWorkScope } from '../adapters/project/coordinationScopes.js';
import type { Coordination, CoordinationAction, CoordinationLog } from '../core/coordination.js';
import { replayCoordination } from '../core/coordination.js';
import type { Json } from '../core/evidence.js';
import type { AgentSession } from '../core/dataRoute.js';
import { coordinationFixture } from './coordinationFixtures.js';
import { fixture, grant } from './storageFixtures.js';
import { TaskRelayOwnership } from '../adapters/storage/relayOwnership.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { createRelay } from '../core/relay.js';
import { readySuccessor } from '../core/relayCheckpoint.js';
import type { RelaySeed } from '../core/relay.js';
import type { TechnicalState } from '../core/evidence.js';

let f: Awaited<ReturnType<typeof coordinationFixture>>;
let db: ReturnType<typeof fixture>;
let journal: TaskCoordinationJournal;
let inputs: FileCoordinationInputs;
let state: Coordination;
const sessions = {
  inspect: async (id: string): Promise<AgentSession> => ({
    id,
    model: 'fixture',
    effort: 'high',
    workspace: f.root,
    project_id: 'native',
    read_only: false,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  }),
};
const send = async (action: CoordinationAction) => {
  state = await advanceCoordination(
    { ...action, id: `e-${state.revision}`, revision: state.revision, generation: 1 },
    journal,
    inputs,
    sessions,
  );
  return state;
};
beforeEach(async () => {
  f = await coordinationFixture();
  db = fixture();
  db.claim();
  db.mutate(
    {
      type: 'checkpoint',
      state: { local_run: f.seed.run as unknown as Json, sibling: 'preserve' },
      effects: [],
    },
    1,
  );
  journal = new TaskCoordinationJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
  inputs = new FileCoordinationInputs(f.root, [f.root], f.root);
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});

it('continues coordination in the same SQLite across two ownership transfers and rejects the old writer', async () => {
  state = await beginCoordination(f.seed, journal, inputs);
  await send({ type: 'RESERVE', child: 'a', operation: 'dispatch-a' });
  let context = grant.context;
  let store = db.store;
  let predecessor = f.seed.run;
  for (const generation of [2, 3]) {
    const source = unwrap<TechnicalState>(store.execute({ context, command: { type: 'state' } }));
    const seed: RelaySeed = {
      schema_version: 1,
      id: `relay-${generation}`,
      predecessor,
      native_project_id: 'native',
      trigger: {
        thread: predecessor.spec.session_id,
        turn: 'turn',
        item: 'compact',
        mode: 'auto',
        evidence: f.proof,
      },
      authority: f.proof,
      checkpoint: source.checkpoint!,
      snapshot: f.proof,
      progress: {
        active_stage: 'stage',
        estimate_ms: 60000,
        elapsed_ms: 100,
        external_wait_ms: 0,
        next_action: 'continue coordination',
        audit_checkpoint: 'audit',
        findings: [],
        gates: [],
        pending_human: [],
        child_evidence: [],
        mapping: {},
      },
    };
    await new TaskRelayOwnership({ execute: async (r) => store.execute(r) }, context).release(
      seed,
      f.proof,
      resolve(f.root, `release-${generation}.json`),
    );
    context = { ...context, actor_id: `owner-${generation}`, run_id: `${seed.id}:successor` };
    store = new SqliteEvidenceStore(db.root, { ...grant, context }, () => 100);
    const port = {
      execute: async (r: Parameters<SqliteEvidenceStore['execute']>[0]) => store.execute(r),
    };
    const ownership = new TaskRelayOwnership(port, context);
    await ownership.claim(seed, 1000);
    predecessor = readySuccessor(seed, {
      ...createRelay(seed),
      successor: { ...(await sessions.inspect(`successor-${generation}`)), read_only: true },
      loaded: {
        ...predecessor.loaded!,
        run_id: `${seed.id}:successor`,
        session_id: `successor-${generation}`,
      },
    });
    await ownership.adopt(seed, predecessor);
    const resumed = new TaskCoordinationJournal(port, context, generation);
    const event = {
      ...(generation === 2
        ? { type: 'BIND' as const, child: 'a', session: 'session-a', receipt: f.proof }
        : { type: 'RESERVE' as const, child: 'b', operation: 'dispatch-b' }),
      id: `continued-${generation}`,
      revision: state.revision,
      generation,
    };
    state = await advanceCoordination(event, resumed, inputs, sessions);
    expect(await advanceCoordination(event, resumed, inputs, sessions)).toEqual(state);
    expect((await resumed.read())!.events).toHaveLength(1);
    expect(
      unwrap<TechnicalState>(store.execute({ context, command: { type: 'state' } })).checkpoint,
    ).toMatchObject({ sibling: 'preserve' });
  }
  await expect(send({ type: 'RESERVE', child: 'b', operation: 'old-owner' })).rejects.toThrow();
  expect((await journal.read())!.schema_version).toBe(2);
});

it('persists beside other state, resumes, verifies real evidence/inputs, and integrates two accepted results', async () => {
  expect(await journal.read()).toBeNull();
  state = await beginCoordination(f.seed, journal, inputs);
  await expect(beginCoordination(f.seed, journal, inputs)).rejects.toThrow(
    'coordination-already-exists',
  );
  for (const child of ['a', 'b']) {
    await send({ type: 'RESERVE', child, operation: `op-${child}` });
    await send({ type: 'BIND', child, session: `session-${child}`, receipt: f.proof });
    await send({
      type: 'OBSERVE',
      child,
      session: `session-${child}`,
      cursor: 0,
      outcome: 'completed',
      result: f.result(child),
      receipt: f.proof,
    });
    await send({ type: 'ACCEPT', child, current: f.target.inputs });
  }
  const last = state.history.at(-1)!;
  expect(await advanceCoordination(last, journal, inputs, sessions)).toEqual(state);
  const event = {
    type: 'INTEGRATE' as const,
    executor: 'integrator',
    inputs: f.target.inputs,
    boundaries: f.check,
    validation: f.check,
    child_inputs: { a: f.target.inputs, b: f.target.inputs },
  };
  await send(event);
  expect(state.status).toBe('done');
  const log = await journal.read();
  expect(log!.events).toEqual(state.history);
  expect(
    await new TaskCoordinationJournal(
      { execute: async (r) => db.store.execute(r) },
      grant.context,
      1,
    ).read(),
  ).toEqual(log);
  expect(db.execute({ type: 'state' })).toMatchObject({
    ok: true,
    value: { checkpoint: { sibling: 'preserve' } },
  });
  await journal.save({ ...log!, events: log!.events.slice(0, -1) }, log!);
  await expect(journal.save(log, log!)).rejects.toThrow('coordination-log-not-append-only');
});

it('rejects two granted nested roots that address the same file before saving a coordination log', async () => {
  const nested = resolve(f.root, 'nested');
  await mkdir(nested);
  inputs = new FileCoordinationInputs(f.root, [f.root, nested], f.root);
  f.seed.children[0]!.scope = { workspace: f.root, paths: ['nested/shared.ts'] };
  f.seed.children[1]!.scope = { workspace: nested, paths: ['shared.ts'] };
  for (const child of f.seed.children) await inputs.workspace(child.scope);
  await expect(beginCoordination(f.seed, journal, inputs)).rejects.toThrow(
    'competing-scope-writers',
  );
  expect(await journal.read()).toBeNull();
  f.seed.children[0]!.read_only = true;
  expect((await beginCoordination(f.seed, journal, inputs)).status).toBe('active');
});

it('restores cancellation with completed results as pending until every dispatched child has stopped', async () => {
  state = await beginCoordination(f.seed, journal, inputs);
  for (const child of ['a', 'b']) {
    await send({ type: 'RESERVE', child, operation: `op-${child}` });
    await send({ type: 'BIND', child, session: `session-${child}`, receipt: f.proof });
    await send({
      type: 'OBSERVE',
      child,
      session: `session-${child}`,
      cursor: 0,
      outcome: 'completed',
      result: f.result(child),
      receipt: f.proof,
    });
  }
  await send({ type: 'ACCEPT', child: 'b', current: f.target.inputs });
  await send({ type: 'CANCEL', reason: 'stop all writers after their answers' });
  const original = (await journal.read())!;
  const results = state.children.map((child) => child.result);
  journal = new TaskCoordinationJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
  state = replayCoordination((await journal.read())!);
  expect(state.status).toBe('cancelling');
  expect(state.children.map((child) => child.status)).toEqual(['stopping', 'stopping']);
  await send({ type: 'STOPPED', child: 'a', receipt: f.proof });
  await send({ type: 'CANCEL', reason: 'repeat while waiting for the second writer' });
  expect(state.children[0]!.stopped).toEqual(f.proof);
  expect(state.children[0]!.status).toBe('stopped');
  expect(state.status).toBe('cancelling');
  await send({ type: 'STOPPED', child: 'b', receipt: f.proof });
  const log = (await journal.read())!;
  expect(log.events.slice(0, original.events.length)).toEqual(original.events);
  expect(replayCoordination(log)).toEqual(state);
  expect(state.status).toBe('cancelled');
  expect(state.children.map((child) => child.result)).toEqual(results);
});

it('rejects changed inputs, unverified identity and re-entry during external inspection', async () => {
  await expect(
    advanceCoordination(
      { type: 'CANCEL', reason: 'none', id: 'x', revision: 0, generation: 1 },
      journal,
      inputs,
      sessions,
    ),
  ).rejects.toThrow('coordination-not-found');
  state = await beginCoordination(f.seed, journal, inputs);
  await send({ type: 'RESERVE', child: 'a', operation: 'op-a' });
  const binding = {
    type: 'BIND' as const,
    child: 'a',
    session: 'session-a',
    receipt: f.proof,
    id: 'bind',
    revision: state.revision,
    generation: 1,
  };
  for (const patch of [
    null,
    { id: 'other' },
    { project_id: 'wrong' },
    { workspace: '/wrong' },
    { read_only: true },
    { model: 'wrong' },
    { effort: 'low' },
    { forked_from: 'parent' },
  ]) {
    await expect(
      advanceCoordination(binding, journal, inputs, {
        inspect: async () =>
          patch === null ? null : { ...(await sessions.inspect('session-a')), ...patch },
      }),
    ).rejects.toThrow('child-identity-unconfirmed');
  }
  await advanceCoordination(binding, journal, inputs, sessions);
  const log = (await journal.read())!;
  state = { ...state, revision: log.events.length };
  await send({
    type: 'OBSERVE',
    child: 'a',
    session: 'session-a',
    cursor: 0,
    outcome: 'completed',
    result: f.result('a'),
    receipt: f.proof,
  });
  await f.file('source.txt', 'changed');
  await expect(send({ type: 'ACCEPT', child: 'a', current: f.target.inputs })).rejects.toThrow(
    'child-inputs-changed',
  );
  await f.file('source.txt', 'source revision 1');
  await send({ type: 'ACCEPT', child: 'a', current: f.target.inputs });
  await send({ type: 'RESERVE', child: 'b', operation: 'op-b' });
  await send({ type: 'BIND', child: 'b', session: 'session-b', receipt: f.proof });
  await send({
    type: 'OBSERVE',
    child: 'b',
    session: 'session-b',
    cursor: 0,
    outcome: 'completed',
    result: f.result('b'),
    receipt: f.proof,
  });
  await send({ type: 'ACCEPT', child: 'b', current: f.target.inputs });
  const integrate = {
    type: 'INTEGRATE' as const,
    executor: 'integrator',
    inputs: f.target.inputs,
    boundaries: f.check,
    validation: f.check,
    child_inputs: { a: f.target.inputs, b: f.target.inputs },
  };
  await f.file('source.txt', 'changed');
  await expect(send(integrate)).rejects.toThrow('integration-inputs-changed');
  await f.file('source.txt', 'source revision 1');
  let calls = 0;
  await expect(
    advanceCoordination(
      { ...integrate, id: 'integration', revision: state.revision, generation: 1 },
      journal,
      {
        evidence: inputs.evidence,
        workspace: async () => ({
          verify: inputs.evidence.verify.bind(inputs.evidence),
          current: async () => ({ ...f.target.inputs, complete: ++calls === 1 }),
        }),
      },
      sessions,
    ),
  ).rejects.toThrow('integration-child-inputs-changed');
});

it('guards CAS and authorization after observations and retains unknown reservations on restart', async () => {
  state = await beginCoordination(f.seed, journal, inputs);
  const old = (await journal.read())!;
  await send({ type: 'RESERVE', child: 'a', operation: 'create-unknown' });
  await expect(
    journal.save(old, {
      ...old,
      events: [{ type: 'CANCEL', reason: 'competing', id: 'other', revision: 0, generation: 1 }],
    }),
  ).rejects.toThrow('coordination-revision-conflict');
  const binding = {
    type: 'BIND' as const,
    child: 'a',
    session: 'session-a',
    receipt: f.proof,
    id: 'bind',
    revision: state.revision,
    generation: 1,
  };
  await expect(
    advanceCoordination(binding, journal, inputs, {
      inspect: async (id) => {
        await send({ type: 'CANCEL', reason: 'during inspect' });
        return sessions.inspect(id);
      },
    }),
  ).rejects.toThrow('coordination-observation-stale');
  expect(state.status).toBe('cancelling');
  expect((await journal.read())!.events).toHaveLength(2);
  const log = (await journal.read())!;
  const next = {
    ...log,
    events: [
      ...log.events,
      {
        type: 'STOPPED' as const,
        child: 'a',
        receipt: f.proof,
        id: 'stop',
        revision: 2,
        generation: 1,
      },
    ],
  };
  const foreign = new TaskCoordinationJournal(
    { execute: async (r) => db.store.execute(r) },
    { ...grant.context, run_id: 'other' },
    1,
  );
  await expect(foreign.save(log, next)).rejects.toThrow('coordination-store-unavailable');
  const late = new TaskCoordinationJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    2,
  );
  await expect(late.save(log, next)).rejects.toThrow('wrong-local-coordinator');
  const current = db.execute({ type: 'state' });
  if (!current.ok) throw new Error('fixture failed');
  expect(
    db.mutate(
      {
        type: 'release',
        stopped_writers_receipt: 'test',
        checkpoint: (current.value as { checkpoint: Json }).checkpoint,
      },
      (current.value as { revision: number }).revision,
    ).ok,
  ).toBe(true);
  await expect(journal.save(log, next)).rejects.toThrow('coordination-store-write-rejected');
});

it('rejects unsupported state and preserves the missing-checkpoint distinction', async () => {
  db.mutate({ type: 'checkpoint', state: null, effects: [] }, 2);
  expect(await journal.read()).toBeNull();
  db.mutate(
    { type: 'checkpoint', state: { coordination: { schema_version: 99 } }, effects: [] },
    3,
  );
  await expect(journal.read()).rejects.toThrow('unsupported-coordination-log');
  const bad: CoordinationLog = { schema_version: 1, seed: f.seed, events: [] };
  const noStore = new TaskCoordinationJournal(
    {
      execute: async () => ({
        ok: false,
        error: {
          code: 'unavailable',
          operation_id: null,
          observed_revision: null,
          retryable: true,
          recovery_locator: 'fixture',
        },
      }),
    },
    grant.context,
    1,
  );
  await expect(noStore.read()).rejects.toThrow('coordination-store-unavailable');
  await expect(noStore.save(null, bad)).rejects.toThrow('coordination-store-unavailable');
});

it('canonicalizes existing/new paths and rejects aliases, hardlinks and ungranted roots', async () => {
  await verifyWorkScope({
    workspace: f.root,
    paths: ['source.txt', 'new/nested.txt', 'tools/agent-workflow'],
  });
  await symlink(f.root, resolve(f.root, 'alias'));
  await expect(
    verifyWorkScope({ workspace: resolve(f.root, 'alias'), paths: ['source.txt'] }),
  ).rejects.toThrow('workspace-alias-forbidden');
  await expect(verifyWorkScope({ workspace: f.root, paths: ['alias/source.txt'] })).rejects.toThrow(
    'scope-alias-forbidden',
  );
  await link(resolve(f.root, 'source.txt'), resolve(f.root, 'hard'));
  await expect(verifyWorkScope({ workspace: f.root, paths: ['hard'] })).rejects.toThrow(
    'scope-alias-forbidden',
  );
  await expect(
    verifyWorkScope({ workspace: f.root, paths: ['assignment.txt/nested'] }),
  ).rejects.toThrow();
  await expect(inputs.workspace({ workspace: '/other', paths: ['x'] })).rejects.toThrow(
    'coordination-workspace-not-authorized',
  );
});

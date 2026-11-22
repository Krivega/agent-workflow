import { coderFixture } from './coderFixtures.js';
import {
  applyCoder,
  coderOwnsSource,
  reserveCoder,
  validateCoderBrief,
  validateCoderRun,
} from '../core/coder.js';
import type { CoderAction, CoderRun, CoderIntegration } from '../core/coder.js';
import { assertRunAction, applyLocalEvent } from '../core/localRun.js';
import { event } from './localFixtures.js';
import { applyExecution, executionBlockers } from '../core/execution.js';
import { executionEvent } from './workflowFixtures.js';
import { localPlanningRisks } from '../core/localRun.js';
import type { LocalImplementationPlan } from '../core/localRun.js';

let f: Awaited<ReturnType<typeof coderFixture>>;
beforeEach(async () => {
  f = await coderFixture();
});
afterEach(async () => {
  await f.dispose();
});
const act = (run: CoderRun, action: CoderAction) =>
  applyCoder(run, {
    ...action,
    id: `${action.type}-${run.history.length}`,
    generation: run.brief.generation,
  });
async function reserved() {
  const brief = await f.brief();
  return reserveCoder(f.executor, brief, await f.workspaces.capture(brief), []);
}

it('keeps a delegated child inside the parent local admission and rejects protected write scopes', async () => {
  const run = await reserved(),
    basis = run.brief.authority,
    source = await f.ref('source.txt');
  const plan: LocalImplementationPlan = {
    schema_version: 1,
    requirement: basis,
    basis: [basis],
    owner: source,
    consumers: [source],
    consumers_complete: true,
    paths: ['source.txt'],
    risks: Object.fromEntries(
      localPlanningRisks.map((risk) => [risk, false]),
    ) as LocalImplementationPlan['risks'],
    reason: 'fixture local contract',
    checks: ['validate'],
    criterion: 'fixture boundary',
  };
  const parent = {
    ...f.executor,
    schema_version: 2 as const,
    format: 'local-planning' as const,
    spec: {
      ...f.executor.spec,
      route: {
        kind: 'local' as const,
        accepted_plan: basis,
        plan,
      },
    },
  };
  const brief = { ...run.brief, paths: ['source.txt'] };
  expect(reserveCoder(parent, brief, run.baseline, []).status).toBe('reserved');
  expect(() => reserveCoder(parent, { ...brief, paths: ['second.txt'] }, run.baseline, [])).toThrow(
    'coder-outside-parent-local-scope',
  );
  for (const path of [
    'AGENTS.md',
    run.brief.card.locator,
    'project/workflow.json',
    'tools/agent-workflow/project/workflow.json',
    run.brief.rules[1]!.locator,
    '.codex/config.toml',
    'module/.env',
  ])
    expect(() => reserveCoder(f.executor, { ...brief, paths: [path] }, run.baseline, [])).toThrow(
      'coder-protected-scope',
    );
});
async function created() {
  let run = act(await reserved(), { type: 'COPY_INTENT' });
  run = act(run, { type: 'COPIED', copy: await f.workspaces.copy(run) });
  run = act(run, { type: 'CREATE_INTENT' });
  return act(run, { type: 'BIND', session: await f.session(run) });
}
async function ready() {
  const run = act(await created(), { type: 'LOAD_INTENT' });
  return act(run, { type: 'LOADED', receipt: await f.deps.sessions.load(run, true) });
}
async function released() {
  let run = act(await ready(), { type: 'SEND_INTENT', delivery: 'stable-delivery' });
  run = act(run, { type: 'SENT', turn: 'original-turn' });
  run = act(run, {
    type: 'RESULT',
    result: { outcome: 'PASS', evidence: f.proof, checks: [], errors: [], limitations: [] },
  });
  run = act(run, { type: 'STOP_INTENT', reason: 'complete' });
  run = act(run, { type: 'STOPPED', receipt: f.proof });
  return act(run, { type: 'RELEASE' });
}
it('keeps normal stop, release and cancellation distinct and replays only the exact event', async () => {
  const run = await released();
  validateCoderRun(run);
  expect(coderOwnsSource(run)).toBe(true);
  expect(run.result!.outcome).toBe('PASS');
  expect(run.writer!.type).toBe('role');
  expect(run.writer!.schema_version).toBe(2);
  assertRunAction(run.writer!, 'implement');
  assertRunAction(run.writer!, 'produce-evidence');
  expect(() => assertRunAction(run.writer!, 'coordinate')).toThrow('action-forbidden');
  expect(() => assertRunAction(run.writer!, 'update-card')).toThrow('action-forbidden');
  const cancel = { type: 'CANCEL_IDLE' as const, receipt: f.proof, id: 'cancel', generation: 1 };
  const cancelled = applyCoder(run, cancel);
  expect(cancelled.status).toBe('cancelled');
  expect(coderOwnsSource(cancelled)).toBe(false);
  expect(applyCoder(cancelled, cancel)).toBe(cancelled);
  expect(() =>
    applyCoder(cancelled, { ...cancel, receipt: { ...f.proof, hash: 'a'.repeat(64) } }),
  ).toThrow('coder-event-conflict');
  expect(() => act(cancelled, { type: 'BIND', session: run.session! })).toThrow(
    'wrong-coder-phase',
  );
  expect(() => applyCoder(run, { ...cancel, generation: 2 })).toThrow('stale-coder-generation');
  expect(() => act({ ...run, history: [] }, { type: 'RESULT', result: run.result! })).toThrow(
    'wrong-coder-phase',
  );
  expect(() => validateCoderRun({ ...run, status: 'integrated' })).toThrow(
    'coder-history-mismatch',
  );
  expect(() => validateCoderRun({ ...run, schema_version: 2 } as unknown as CoderRun)).toThrow(
    'unsupported-coder-version',
  );
});
it('conflicts on source paths across different copies and refuses reuse of a prior copy', async () => {
  const one = await reserved(),
    two = await f.brief('two', ['source.txt']);
  const baseline = await f.workspaces.capture(two);
  expect(() => reserveCoder(f.executor, two, baseline, [one])).toThrow('coder-source-overlap');
  const disjoint = { ...two, paths: ['new.txt'] };
  expect(reserveCoder(f.executor, disjoint, baseline, [one]).status).toBe('reserved');
  expect(() =>
    reserveCoder(f.executor, { ...disjoint, copy_root: one.brief.copy_root }, baseline, [one]),
  ).toThrow('coder-copy-reused');
  expect(() => reserveCoder(f.executor, one.brief, one.baseline, [one])).toThrow(
    'coder-already-reserved',
  );
  const refused = act(
    act(act(one, { type: 'COPY_INTENT' }), {
      type: 'COPIED',
      copy: {
        binding: { root: one.brief.copy_root, dev: 1, ino: 1 },
        directories: [],
        evidence: f.proof,
      },
    }),
    { type: 'CREATE_INTENT' },
  );
  const done = act(refused, { type: 'NOT_STARTED', receipt: f.proof });
  expect(done.session).toBeNull();
  expect(coderOwnsSource(done)).toBe(false);
  expect(reserveCoder(f.executor, two, baseline, [done]).status).toBe('reserved');
});
it('rejects wrong parents, stale generations, profiles and incomplete briefs', async () => {
  const run = await reserved();
  for (const patch of [
    { task_id: 'other' },
    { project_id: 'other' },
    { parent_run_id: 'other' },
    { parent_session_id: 'other' },
    { generation: 2 },
    { card: { ...run.brief.card, hash: 'a'.repeat(64) } },
    { profile: { ...run.brief.profile, model: 'other' } },
    { authority: { ...f.proof, hash: 'a'.repeat(64) } },
  ])
    expect(() => reserveCoder(f.executor, { ...run.brief, ...patch }, run.baseline, [])).toThrow();
  for (const patch of [
    { id: '../escape' },
    { source_root: '/root/../source' },
    { copy_root: run.brief.source_root },
    { copy_root: run.brief.source_root + '/nested' },
    { source_root: run.brief.copy_root + '/nested' },
    { paths: [] },
    { paths: ['x', 'x'] },
    { paths: ['../escape'] },
    { files: [] },
    { rules: [] },
    { procedures: [] },
    { generation: 0 },
    { goal: '' },
    { criterion: '' },
    { checks: [''] },
    { files: [{ locator: '/outside', hash: 'a'.repeat(64) }] },
    { authority: { locator: 'x', hash: 'short' } },
  ])
    expect(() => validateCoderBrief({ ...run.brief, ...patch })).toThrow();
  expect(() =>
    reserveCoder(
      f.executor,
      run.brief,
      { ...run.baseline, source: { ...run.baseline.source, ino: -1 } },
      [],
    ),
  ).toThrow('coder-root-binding-mismatch');
  expect(() =>
    reserveCoder(
      f.executor,
      run.brief,
      { ...run.baseline, files: [...run.baseline.files, run.baseline.files[0]!] },
      [],
    ),
  ).toThrow('duplicate-coder-file');
  expect(() => reserveCoder(f.executor, run.brief, { ...run.baseline, files: [] }, [])).toThrow(
    'coder-source-version-mismatch',
  );
  expect(() =>
    reserveCoder({ ...f.executor, type: 'orchestrator' }, run.brief, run.baseline, []),
  ).toThrow('action-forbidden');
});
it('requires exact isolated native permissions before binding a writable role', async () => {
  let run = act(await reserved(), { type: 'COPY_INTENT' });
  const copy = await f.workspaces.copy(run);
  expect(() =>
    act(run, { type: 'COPIED', copy: { ...copy, binding: { ...copy.binding, ino: -1 } } }),
  ).toThrow('coder-root-binding-mismatch');
  expect(() =>
    act(run, {
      type: 'COPIED',
      copy: { ...copy, directories: [{ path: '../outside', mode: 0o700 }] },
    }),
  ).toThrow('unsafe-locator');
  expect(() =>
    act(run, { type: 'COPIED', copy: { ...copy, directories: [{ path: 'x', mode: -1 }] } }),
  ).toThrow('invalid-coder-mode');
  run = act(act(run, { type: 'COPIED', copy }), { type: 'CREATE_INTENT' });
  const session = await f.session(run);
  for (const patch of [
    { id: 'session' },
    { workspace: f.root },
    { project_id: 'other' },
    { model: 'other' },
    { effort: 'other' },
    { read_only: true },
    { network: true },
    { sandbox: 'danger-full-access' },
    { approval: 'on-request' },
    { write_roots: [run.brief.copy_root, '/tmp'] },
    { exclude_slash_tmp: false },
    { exclude_tmpdir: false },
    { forked_from: 'parent' },
    { initial_turns: 1 },
    { parent_id: 'parent' },
    { native_child: true },
    { native_project_id: 'other' },
  ])
    expect(() =>
      act(run, { type: 'BIND', session: { ...session, ...patch } as typeof session }),
    ).toThrow('coder-profile-unconfirmed');
});
it('rejects premature write, invalid LOAD and a result that claims failed checks passed', async () => {
  const createdRun = await created();
  expect(() => act(createdRun, { type: 'SEND_INTENT', delivery: 'early' })).toThrow(
    'wrong-coder-phase',
  );
  const loading = act(createdRun, { type: 'LOAD_INTENT' }),
    receipt = await f.deps.sessions.load(loading, true);
  expect(() => act(loading, { type: 'LOADED', receipt: { ...receipt, rules: [] } })).toThrow(
    'rules-not-loaded',
  );
  let run = act(loading, { type: 'LOADED', receipt });
  run = act(act(run, { type: 'SEND_INTENT', delivery: 'delivery' }), {
    type: 'SENT',
    turn: 'turn',
  });
  const result = {
    outcome: 'PASS' as const,
    evidence: f.proof,
    checks: [],
    errors: [],
    limitations: [],
  };
  expect(() => act(run, { type: 'RESULT', result: { ...result, errors: ['failure'] } })).toThrow(
    'coder-result-overclaims',
  );
  expect(() =>
    act(run, {
      type: 'RESULT',
      result: { ...result, checks: [{ command: 'not allowed', exit_code: 0, evidence: f.proof }] },
    }),
  ).toThrow('coder-check-outside-brief');
  const checksRun = { ...run, brief: { ...run.brief, checks: ['check'] } };
  expect(() =>
    act(checksRun, {
      type: 'RESULT',
      result: { ...result, checks: [{ command: 'check', exit_code: 1, evidence: f.proof }] },
    }),
  ).toThrow('coder-result-overclaims');
  expect(() =>
    act(checksRun, {
      type: 'RESULT',
      result: { ...result, checks: [{ command: 'check', exit_code: 0.5, evidence: f.proof }] },
    }),
  ).toThrow('invalid-coder-exit');
  const failed = act(checksRun, {
    type: 'RESULT',
    result: {
      ...result,
      outcome: 'FAIL',
      checks: [{ command: 'check', exit_code: null, evidence: f.proof }],
    },
  });
  expect(failed.result!.outcome).toBe('FAIL');
  const cancelled = act(
    act(act(failed, { type: 'STOP_INTENT', reason: 'cancel' }), {
      type: 'STOPPED',
      receipt: f.proof,
    }),
    { type: 'RELEASE' },
  );
  expect(cancelled.status).toBe('cancelled');
});
it('accepts only a bound immutable integration intent and prevents early DONE or cancellation of parent', async () => {
  const run = await released();
  const intent: CoderIntegration = {
    operation: 'integration',
    project_id: 'project',
    task_id: 'task',
    parent_run_id: 'run',
    generation: 1,
    source: run.baseline.source,
    copy: run.copy!.binding,
    result: run.result!.evidence,
    stopped: run.stopped!,
    changes: [],
    evidence: f.proof,
  };
  for (const patch of [
    { generation: 2 },
    { parent_run_id: 'other' },
    { task_id: 'other' },
    { project_id: 'other' },
    { source: { ...intent.source, ino: intent.source.ino + 1 } },
    { copy: { ...intent.copy, ino: intent.copy.ino + 1 } },
    { result: { ...f.proof, hash: 'a'.repeat(64) } },
    { stopped: { ...f.proof, hash: 'a'.repeat(64) } },
  ])
    expect(() => act(run, { type: 'INTEGRATE_INTENT', intent: { ...intent, ...patch } })).toThrow(
      'coder-integration-binding-mismatch',
    );
  const before = run.baseline.files.find((file) => file.path === 'source.txt')!.version;
  expect(() =>
    act(run, {
      type: 'INTEGRATE_INTENT',
      intent: { ...intent, changes: [{ path: 'outside', before: null, after: before }] },
    }),
  ).toThrow('coder-change-outside-scope');
  expect(() =>
    act(run, {
      type: 'INTEGRATE_INTENT',
      intent: { ...intent, changes: [{ path: 'source.txt', before, after: before }] },
    }),
  ).toThrow('coder-change-outside-scope');
  const integrating = act(run, { type: 'INTEGRATE_INTENT', intent });
  const done = act(integrating, { type: 'INTEGRATED', receipt: f.proof });
  validateCoderRun(done);
  expect(coderOwnsSource(done)).toBe(false);
  const execution = { ...f.execution, schema_version: 3 as const, coder_reservations: ['one'] };
  expect(executionBlockers(execution)).toContain('coder:one:pending');
  expect(() =>
    applyExecution(
      execution,
      executionEvent(execution, { type: 'REPLAN', target: f.target }),
      f.deps.journal.fingerprint,
    ),
  ).toThrow('coder-writers-pending');
  const parent = {
    ...f.executor,
    coder_locks: [{ id: 'one', workspace: f.root, paths: ['source.txt'] }],
  };
  expect(() =>
    applyLocalEvent(
      parent,
      event(parent, {
        type: 'CANCEL',
        reason: 'cancel',
        unfinished: ['scope'],
        stopped_receipt: 'parent-only',
      }),
    ),
  ).toThrow('coder-writers-pending');
});
it('refuses a cardless nonproduct parent rather than inventing card or accepted authority', async () => {
  f.executor.spec.identity = { assignment_id: 'cardless' };
  f.executor.spec.route = { kind: 'nonproduct' };
  const brief = await f.brief();
  expect(brief.card).toEqual(f.proof);
  expect(brief.authority).toEqual(f.proof);
  const baseline = await f.workspaces.capture(brief);
  expect(() => reserveCoder(f.executor, brief, baseline, [])).toThrow('coder-parent-mismatch');
});

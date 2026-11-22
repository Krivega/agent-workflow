import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workflowFixture, executionEvent } from './workflowFixtures.js';
import { fixture, grant } from './storageFixtures.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { backupSupervision } from '../adapters/storage/supervisionBackup.js';
import { FileCoderWorkspaces } from '../adapters/project/coderWorkspaces.js';
import { createExecution } from '../core/execution.js';
import { beginExecution, advanceExecution } from '../application/executionWorkflow.js';
import { requiredProcedures } from '../core/localRun.js';
import type { CoderBrief, CoderRun, CoderSession } from '../core/coder.js';
import type { CoderDependencies } from '../application/coderWorkflow.js';
import type { InputRef } from '../core/localRun.js';
import { AppServerWriters } from '../adapters/codex/appServerWriters.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { CoderFileProbe } from '../adapters/project/coderWorkspaces.js';

export async function coderFixture(probe: CoderFileProbe = () => {}) {
  const f = await workflowFixture(),
    db = fixture();
  db.claim();
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  await f.file('.gitignore', 'ignored.txt\n');
  await f.file('second.txt', 'second before');
  await f.file(
    'tools/agent-workflow/roles/coder.md',
    await readFile(new URL('../roles/coder.md', import.meta.url), 'utf8'),
  );
  const persistence = {
    execute: async (request: Parameters<typeof db.store.execute>[0]) => db.store.execute(request),
  };
  const backup = (state: Parameters<typeof backupSupervision>[4], operation: string) =>
    backupSupervision(persistence, db.root, db.parent, grant, state, operation);
  const runs = new TaskLocalRuns(persistence, grant.context, 1, true, backup);
  f.executor.spec.scope = ['source.txt', 'second.txt', 'module', 'new.txt'];
  await runs.save(null, f.executor);
  const journal = new TaskWorkflowJournal(persistence, grant.context, 1, true, backup);
  let execution = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'substantial',
  );
  await beginExecution(execution, journal);
  execution = await advanceExecution(
    executionEvent(execution, { type: 'PLAN', council: f.council('planning') }),
    journal,
    f.inputs,
  );
  const brief = async (id = 'one', paths = ['source.txt', 'second.txt']): Promise<CoderBrief> => {
    const rules = [await f.ref('AGENTS.md'), await f.ref('tools/agent-workflow/roles/coder.md')];
    const procedures = f.executor.spec.procedures.filter((procedure) =>
      requiredProcedures('role', 'coder').includes(procedure.id),
    );
    const files = await Promise.all(
      [
        ...new Set([
          ...paths.filter((path) => ['source.txt', 'second.txt'].includes(path)),
          ...rules.map((rule) => rule.locator),
          ...procedures.map((procedure) => procedure.locator),
        ]),
      ].map((path) => f.ref(path)),
    );
    return {
      id,
      project_id: 'project',
      task_id: 'task',
      parent_run_id: 'run',
      parent_session_id: 'session',
      generation: 1,
      card: 'task_id' in f.executor.spec.identity ? f.executor.spec.identity.card : f.proof,
      authority:
        f.executor.spec.route.kind === 'substantial'
          ? f.executor.spec.route.accepted_plan!
          : f.proof,
      source_root: f.root,
      copy_root: resolve(db.parent, 'coder-workspaces', id),
      paths,
      files,
      goal: 'Change the declared fixture files',
      criterion: 'Only declared files change',
      checks: [],
      profile: { model: f.executor.spec.requested.model, effort: f.executor.spec.requested.effort },
      rules,
      procedures,
    };
  };
  const workspaces = new FileCoderWorkspaces(f.root, db.parent, async () => {}, probe);
  const proof = async (name: string, value: unknown): Promise<InputRef> => {
    const bytes = JSON.stringify(value),
      locator = resolve(db.parent, name + '.json');
    await writeFile(locator, bytes);
    return { locator, hash: digest(bytes) };
  };
  const counts = { creates: 0, loads: 0, sends: 0, stops: 0 };
  const session = async (run: CoderRun): Promise<CoderSession> => ({
    id: `native-${run.brief.id}`,
    model: run.brief.profile.model,
    effort: run.brief.profile.effort,
    project_id: 'project',
    workspace: run.brief.copy_root,
    parent_id: null,
    native_child: false,
    native_project_id: null,
    read_only: false,
    network: false,
    sandbox: 'workspace-write',
    approval: 'never',
    write_roots: [run.brief.copy_root],
    exclude_slash_tmp: true,
    exclude_tmpdir: true,
    forked_from: null,
    initial_turns: 0,
    receipt: await proof(`session-${run.brief.id}`, {
      kind: 'explicit fixture session; no native qualification',
    }),
    policy: await proof(`policy-${run.brief.id}`, {
      kind: 'explicit fixture policy; no native qualification',
    }),
  });
  const deps: CoderDependencies = {
    journal,
    runs,
    workspaces,
    sessions: {
      create: async (run) => {
        counts.creates++;
        return { outcome: 'created', session: await session(run) };
      },
      recoverCreate: async () => null,
      load: async (run) => {
        counts.loads++;
        return {
          run_id: run.writer!.spec.run_id,
          session_id: run.session!.id,
          procedures: run.writer!.spec.procedures,
          rules: run.brief.rules,
          observed_read: 'explicit LOAD test double',
          native: f.proof,
          origin: f.proof,
        };
      },
      send: async (run) => {
        counts.sends++;
        return `turn-${run.brief.id}`;
      },
      result: async (run) => {
        for (const path of run.brief.paths)
          await writeFile(resolve(run.brief.copy_root, path), `after:${path}`);
        return {
          outcome: 'PASS',
          evidence: await proof(`result-${run.brief.id}`, { kind: 'explicit result test double' }),
          checks: [],
          errors: [],
          limitations: ['fixture only'],
        };
      },
      stop: async (run) => {
        counts.stops++;
        const rpc = {
          request: async (method: string) => {
            if (method === 'thread/loaded/list')
              return { data: [run.session!.id], nextCursor: null };
            if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
            return {
              thread: {
                id: run.session!.id,
                turns: [{ id: run.turn ?? 'fixture-load', status: 'completed' }],
              },
            };
          },
        };
        return new AppServerWriters(rpc, {
          descendants: async () => [],
          alive: async () => [],
          terminate: async () => [],
          wait: async () => {},
        }).stop(
          {
            thread: run.session!.id,
            turn: run.turn,
            terminals: [],
            markers: [run.copy!.evidence.locator, run.session!.receipt.locator],
            tree: run.brief.copy_root,
            complete: true,
          },
          resolve(db.parent, `stopped-${run.brief.id}.json`),
        );
      },
    },
  };
  return {
    ...f,
    db,
    brief,
    workspaces,
    deps,
    counts,
    session,
    artifact: proof,
    execution,
    dispose: async () => {
      db.dispose();
      await f.dispose();
    },
  };
}

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import * as checks from '../../src/adapters/project/taskChecks.js';
import type { LocalTaskInput, TaskWriterRuntime } from '../../src/contracts/localTask.js';
import type { LocalImplementationPlan } from '../../src/policy/localPlanning.js';
import { localPlanningRisks } from '../../src/policy/localPlanning.js';
import type {
  ReviewRequest,
  ReviewReport,
  ArbitrationDecision,
} from '../../src/contracts/review.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import type { WriterProcesses } from '../../src/contracts/writerProcesses.js';
import { artifactStore, digest } from '../../src/adapters/artifacts/files.js';
import { controlFixture } from './controlFixture.js';

export function localTaskFixture(options: { disabledServers?: string[] } = {}) {
  vi.spyOn(checks, 'taskChecks').mockImplementation(() => ({
    async stop() {
      return [];
    },
    async run(cwd, command) {
      const began = performance.now();
      try {
        return {
          command,
          code: 0,
          signal: null,
          error: null,
          stop: { confirmed: true as const, processes: [] },
          elapsedMs: performance.now() - began,
          log: execFileSync(command.executable, [...command.args], {
            cwd,
            encoding: 'utf8',
            stdio: 'pipe',
          }),
        };
      } catch (error) {
        const failure = error as {
          status: number | null;
          signal: string | null;
          stdout?: string;
          stderr?: string;
        };
        return {
          command,
          code: failure.status,
          signal: failure.signal,
          error: null,
          stop: { confirmed: true as const, processes: [] },
          elapsedMs: performance.now() - began,
          log: String(failure.stdout ?? '') + String(failure.stderr ?? ''),
        };
      }
    },
  }));
  const f = controlFixture(),
    workspace = f.workspace,
    artifactRoot = f.registration.artifactRoot;
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  const contents = {
    'accepted.md': 'Contract: trim surrounding whitespace from names. No other behavior changes.\n',
    'owner.cjs': 'module.exports = name => name;\n',
    'consumer.cjs': "module.exports = require('./owner.cjs');\n",
    'smoke.cjs':
      "require('node:assert/strict').equal(require('./consumer.cjs')('Ada'), 'Ada'); console.log('real smoke PASS');\n",
    'validate.cjs':
      "const assert=require('node:assert/strict'); const label=require('./consumer.cjs'); assert.equal(label(' Ada '),'Ada'); assert.equal(label('Ada'),'Ada'); console.log('real validate PASS');\n",
    'executor.md':
      'Implement only the local accepted plan. No network, helpers, background processes or checks.\n',
    'tasks/one.md':
      '# B1 fixture\nGoal: restore trimming under the accepted contract.\nCriteria: trim names, keep ordinary names.\n',
  };
  for (const [path, text] of Object.entries(contents)) writeFileSync(join(workspace, path), text);
  const ref = (locator: string) => ({
    locator,
    hash: digest(readFileSync(join(workspace, locator))),
  });
  const plan: LocalImplementationPlan = {
    schema_version: 1,
    requirement: ref('tasks/one.md'),
    basis: [ref('accepted.md')],
    owner: ref('owner.cjs'),
    consumers: ['consumer.cjs', 'smoke.cjs', 'validate.cjs'].map(ref),
    consumers_complete: true,
    paths: ['owner.cjs'],
    risks: Object.fromEntries(
      localPlanningRisks.map((r) => [r, false]),
    ) as LocalImplementationPlan['risks'],
    reason: 'Fix the implementation of the accepted trimming contract',
    checks: ['smoke', 'validate'],
    criterion: 'Surrounding whitespace is trimmed, ordinary names are retained',
  };
  const review: ReviewRequest = {
    schemaVersion: 1,
    phase: 'acceptance',
    scope: 'B1',
    sharedPaths: ['accepted.md', 'consumer.cjs', 'validate.cjs'],
    roles: [
      {
        roleId: 'reviewer',
        applies: true,
        reason: 'Independently review contract parity and evidence',
        paths: ['owner.cjs'],
        complete: true,
        attestedBy: 'project adapter',
        discoveryRule: 'declared',
        history: { complete: true, answers: [] },
      },
    ],
  };
  const store = artifactStore(artifactRoot),
    save = (v: unknown) => store.publish(Buffer.from(JSON.stringify(v)));
  const body = Buffer.from(JSON.stringify(plan));
  writeFileSync(join(workspace, 'plan.json'), body);
  const input: LocalTaskInput = {
    schemaVersion: 1,
    admission: {
      schemaVersion: 1,
      preparation: {
        ...f.input.preparation,
        project: { ...f.input.preparation.project, checks: ['smoke', 'validate'] },
      },
      plan: { path: 'plan.json', sha256: digest(body) },
      acceptance: save(review),
    },
    executor: { path: 'executor.md', sha256: digest(contents['executor.md']) },
    baseline: 'smoke',
  };
  const registration = {
    ...f.registration,
    project: input.admission.preparation.project,
    commands: {
      smoke: { executable: '/usr/bin/env', args: [process.execPath, 'smoke.cjs'] },
      validate: { executable: '/usr/bin/env', args: [process.execPath, 'validate.cjs'] },
    },
  };
  const state = {
    starts: 0,
    creates: 0,
    alive: true,
    write: true,
    outside: false,
    compact: false,
    wrongProfile: false,
    beforeImplement: () => {},
    verdict: 'PASS' as ReviewReport['verdict'],
    readers: 0,
    initialConflict: false,
    initialOrdinaryFail: false,
    initialTesterPartial: false,
    arbitrationCoverage: 'complete' as 'complete' | 'partial',
    arbitrationDecision: {
      kind: 'direction',
      mandatoryDefect: true,
      direction:
        'Remove the disputed defect within owner.cjs; preserve all mandatory criteria and checks',
      exception: null,
      residualRisk: null,
      dissent: [],
      condition: null,
    } as ArbitrationDecision,
  };
  const fakePid = 999991;
  const processes = {
    descendants: vi.fn(async (roots: number[]) =>
      roots.includes(fakePid) ? [{ pid: fakePid, parent: 1, started: 'fixture' }] : [],
    ),
    alive: vi.fn(async (ids: Parameters<WriterProcesses['alive']>[0]) => (state.alive ? ids : [])),
    terminate: vi.fn(async (ids: Parameters<WriterProcesses['terminate']>[0]) => {
      state.alive = false;
      return ids;
    }),
    wait: vi.fn(async () => {}),
  };
  function createRuntime(root: string): TaskWriterRuntime {
    const turns: Record<string, unknown>[] = [],
      thread = { id: 'writer', cwd: root, path: join(f.root, 'writer-transcript.jsonl'), turns };
    let serial = 0;
    state.alive = true;
    const records: unknown[] = [
      {
        type: 'session_meta',
        payload: { id: 'writer', cwd: root, cli_version: f.profile.clientVersion },
      },
    ];
    return {
      pid: fakePid,
      async initialize() {},
      close() {},
      async completed() {},
      async request(method, params) {
        if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
        if (method === 'model/list')
          return {
            data: [
              {
                model: f.profile.model,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium' },
                  { reasoningEffort: 'high' },
                ],
              },
            ],
          };
        if (method === 'thread/start') {
          state.creates++;
          return {
            cwd: root,
            model: f.profile.model,
            reasoningEffort: 'medium',
            approvalPolicy: 'never',
            sandbox: {
              type: 'workspaceWrite',
              networkAccess: false,
              excludeSlashTmp: true,
              excludeTmpdirEnvVar: true,
              writableRoots: [root],
            },
            thread: {
              ...thread,
              turns: [],
              forkedFromId: null,
              parentThreadId: null,
              projectId: null,
            },
          };
        }
        if (method === 'thread/loaded/list') return { data: ['writer'], nextCursor: null };
        if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
        if (method === 'thread/read') return { thread: structuredClone(thread) };
        if (method === 'turn/start') {
          state.starts++;
          const prompt = (params.input as { text: string }[])[0]!.text,
            id = 'writer-turn-' + ++serial,
            offset = prompt.indexOf('Пути и хеши: ');
          let items: unknown[] = [];
          if (offset >= 0) {
            const refs = JSON.parse(
              prompt.slice(
                offset + 'Пути и хеши: '.length,
                prompt.indexOf('. Для больших', offset),
              ),
            ) as { path: string; sha256: string }[];
            items = [
              {
                type: 'commandExecution',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: refs
                  .map((ref) => JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }))
                  .join('\n'),
              },
            ];
          } else if (prompt.includes('Выполни локальный план')) {
            state.beforeImplement();
            if (state.write)
              writeFileSync(join(root, 'owner.cjs'), 'module.exports = name => name.trim();\n');
            if (state.outside) writeFileSync(join(root, 'consumer.cjs'), 'unexpected');
            items = [{ type: 'agentMessage', text: 'Implemented the accepted local contract.' }];
          } else items = [{ type: 'agentMessage', text: 'Profile awaits host confirmation.' }];
          if (state.compact) items.push({ type: 'contextCompaction' });
          turns.push({
            id,
            status: 'completed',
            items: [{ type: 'userMessage', content: params.input }, ...items],
          });
          records.push({
            type: 'turn_context',
            payload: {
              turn_id: id,
              cwd: root,
              model: f.profile.model,
              effort: 'medium',
              approval_policy: 'never',
              sandbox_policy: {
                type: 'workspace-write',
                network_access: false,
                exclude_slash_tmp: true,
                exclude_tmpdir_env_var: true,
              },
              permission_profile: {
                type: 'managed',
                network: 'restricted',
                file_system: {
                  type: 'restricted',
                  entries: [
                    {
                      access: 'write',
                      path: { type: 'path', path: state.wrongProfile ? workspace : root },
                    },
                  ],
                },
              },
            },
          });
          writeFileSync(thread.path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
          return { turn: { id } };
        }
        throw new Error('unexpected writer RPC ' + method);
      },
    };
  }
  const threads = new Map<string, Record<string, unknown>>();
  const rpc = {
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      if (method === 'model/list')
        return {
          data: [
            {
              model: f.profile.model,
              supportedReasoningEfforts: [
                { reasoningEffort: 'medium' },
                { reasoningEffort: 'high' },
              ],
            },
          ],
        };
      if (method === 'thread/start' || method === 'thread/resume') {
        const thread = threads.get(String(params.threadId)) ?? {
          id: 'reader-' + ++state.readers,
          cwd: workspace,
          turns: [],
          forkedFromId: null,
          parentThreadId: null,
          projectId: null,
        };
        threads.set(String(thread.id), thread);
        return {
          cwd: workspace,
          model: f.profile.model,
          reasoningEffort: (params.config as { model_reasoning_effort: string })
            .model_reasoning_effort,
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
          thread: structuredClone(thread),
        };
      }
      if (method === 'thread/loaded/list') return { data: [...threads.keys()] };
      if (method === 'thread/read')
        return { thread: structuredClone(threads.get(String(params.threadId))!) };
      if (method === 'turn/start') {
        state.starts++;
        const message = (params.input as { text: string }[])[0]!.text,
          thread = threads.get(String(params.threadId))!,
          turns = thread.turns as unknown[],
          offset = message.indexOf('Пути и хеши: ');
        let items: unknown[];
        if (offset >= 0) {
          const refs = JSON.parse(
            message.slice(
              offset + 'Пути и хеши: '.length,
              message.indexOf('. Для больших', offset),
            ),
          ) as { path: string; sha256: string }[];
          items = [
            {
              type: 'commandExecution',
              status: 'completed',
              exitCode: 0,
              aggregatedOutput: refs
                .map((ref) => JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }))
                .join('\n'),
            },
          ];
        } else {
          const start = message.indexOf('Markdown: ') + 'Markdown: '.length,
            report = JSON.parse(
              message.slice(start, message.indexOf('. PASS несовместим', start)),
            ) as ReviewReport;
          Object.assign(report, {
            verdict: state.verdict,
            coverage: 'complete',
            findings:
              state.verdict === 'FAIL'
                ? [{ id: 'defect', blocking: true, text: 'Rejected by independent review' }]
                : [],
            limitations: [],
          });
          if (report.schemaVersion === 3) {
            report.verdict = 'NOT RUN';
            report.coverage = state.arbitrationCoverage;
            report.findings = [];
            report.decision = state.arbitrationDecision;
          }
          if (
            report.schemaVersion === 4 &&
            (state.initialConflict || state.initialOrdinaryFail) &&
            report.roleId === 'reviewer'
          ) {
            const snapshot = JSON.parse(store.read(report.review).toString()) as {
              files: { path: string; sha256: string; bytes: number }[];
            };
            report.verdict = 'FAIL';
            report.findings = [
              {
                id: 'INITIAL-CONFLICT',
                blocking: true,
                text: 'accepted.md requires trimming, proposal.md asks to preserve surrounding whitespace',
              },
            ];
            report.conflicts = state.initialConflict
              ? [
                  {
                    findingId: 'INITIAL-CONFLICT',
                    sources: snapshot.files.filter((f) =>
                      ['accepted.md', 'proposal.md'].includes(f.path),
                    ),
                  },
                ]
              : [];
          }
          if (
            report.schemaVersion === 4 &&
            report.roleId === 'tester' &&
            state.initialTesterPartial
          )
            report.coverage = 'partial';
          if (report.schemaVersion === 2) {
            const marker = 'Открытые finding IDs: ',
              offset = message.indexOf(marker);
            (report as unknown as { resolved: string[] }).resolved =
              state.verdict === 'PASS' && offset >= 0
                ? (JSON.parse(
                    message.slice(offset + marker.length, message.indexOf('. В resolved', offset)),
                  ) as string[])
                : [];
          }
          items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
        }
        const id = 'reader-turn-' + (turns.length + 1);
        turns.push({
          id,
          status: 'completed',
          items: [{ type: 'userMessage', content: params.input }, ...items],
        });
        return { turn: { id } };
      }
      throw new Error('unexpected reader RPC ' + method);
    },
    async completed() {},
  };
  const host = {
    profile: f.profile,
    createRuntime,
    processes,
    disabledServers: options.disabledServers ?? [],
  };
  const makeService = () => localTaskActivities(registration, host, rpc, f.profile, () => {});
  const service = makeService();
  return {
    ...f,
    input,
    plan,
    review,
    registration,
    state,
    processes,
    createRuntime,
    rpc,
    service,
    makeService,
    host,
    save,
    read: (ref: Parameters<typeof store.read>[0]) =>
      JSON.parse(store.read(ref).toString()) as Record<string, unknown>,
  };
}

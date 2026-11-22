import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { object, requireWorkflow } from '../core/connection.js';
import type { CodexRpc } from '../src/contracts/codex.js';
import type { ReviewReport } from '../src/contracts/review.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { checkH02Material, h02Material } from './comparisonH02Contract.js';
import type { H02TemporalContext } from './comparisonH02Temporal.js';

/** A fixed in-process port for the shared H02 oracle; it never imports Vitest or starts a model. */
export function createH02TemporalFixture(
  root: string,
  signal = new AbortController().signal,
): H02TemporalContext {
  requireWorkflow(realpathSync(dirname(root)) === dirname(root), 'h02-fixture-parent');
  mkdirSync(root, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.h02'), { mode: 0o700 });
  for (const [path, bytes] of Object.entries(h02Material.files))
    writeFileSync(join(workspace, path), bytes);
  writeFileSync(
    join(workspace, '.h02/rules.md'),
    'Read only the declared snapshot. Report actual FAIL and unknown evidence. No writes, network or helpers.\n',
  );
  writeFileSync(join(workspace, '.h02/task.md'), h02Material.instructions + '\n');
  for (const role of ['pricing', 'logging', 'storage'])
    writeFileSync(
      join(workspace, `.h02/${role}.md`),
      role === 'pricing'
        ? 'Review pricing against the unchanged shared checks.mjs. An initial checker failure is FAIL. A passing checker is PASS.\n'
        : `Review only ${role}.json against its frozen H02 material. Other role files are outside your assignment.\n`,
    );
  const project = {
    schemaVersion: 1 as const,
    projectId: 'h02-local',
    workspaceId: 'isolated',
    rules: ['.h02/rules.md'],
    cardRoot: '.h02',
    roles: ['pricing', 'logging', 'storage'].map((id) => ({ id, profile: `.h02/${id}.md` })),
    checks: ['syntax'],
  };
  const registration = {
    project,
    hostId: 'h02-host',
    owner: 'h02-local-fixture',
    generation: 1,
    workspaceRoot: workspace,
    artifactRoot: join(root, 'artifacts'),
    commands: { syntax: { executable: process.execPath, args: ['--check', 'checks.mjs'] } },
  };
  const profile = { model: 'h02-fixed-local-port', effort: 'medium', clientVersion: '0.154.0' };
  type Thread = {
    id: string;
    cwd: string;
    projectId: null;
    parentThreadId: null;
    forkedFromId: null;
    turns: Record<string, unknown>[];
  };
  const threads = new Map<string, Thread>();
  let serial = 0,
    starts = 0;
  const response = (thread: Thread) => ({
    cwd: workspace,
    model: profile.model,
    reasoningEffort: profile.effort,
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: structuredClone(thread),
  });
  const rpc: CodexRpc = {
    async request(method, params) {
      if (method === 'model/list')
        return {
          data: [
            {
              model: profile.model,
              supportedReasoningEfforts: [{ reasoningEffort: profile.effort }],
            },
          ],
        };
      if (method === 'thread/start') {
        const thread: Thread = {
          id: `h02-session-${++serial}`,
          cwd: workspace,
          projectId: null,
          parentThreadId: null,
          forkedFromId: null,
          turns: [],
        };
        threads.set(thread.id, thread);
        return response(thread);
      }
      if (method === 'thread/loaded/list') return { data: [...threads.keys()] };
      if (method === 'thread/read' || method === 'thread/resume') {
        const thread = threads.get(String(params.threadId));
        requireWorkflow(thread !== undefined, 'h02-fixture-thread');
        return method === 'thread/read' ? { thread: structuredClone(thread) } : response(thread);
      }
      if (method === 'turn/interrupt') {
        const thread = threads.get(String(params.threadId));
        const turn = thread?.turns.find((turn) => turn.id === params.turnId);
        requireWorkflow(turn !== undefined, 'h02-fixture-turn');
        turn.status = 'interrupted';
        return {};
      }
      requireWorkflow(method === 'turn/start', 'h02-fixture-rpc');
      const thread = threads.get(String(params.threadId));
      requireWorkflow(thread !== undefined, 'h02-fixture-thread');
      requireWorkflow(Array.isArray(params.input), 'h02-fixture-input');
      const message = String(object(params.input[0]).text),
        marker = 'Пути и хеши: ',
        offset = message.indexOf(marker);
      let items: unknown[];
      if (offset >= 0) {
        const refs = JSON.parse(
          message.slice(offset + marker.length, message.indexOf('. Для больших', offset)),
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
        const begin = message.indexOf('Markdown: ') + 'Markdown: '.length;
        const report = JSON.parse(
          message.slice(begin, message.indexOf('. PASS несовместим', begin)),
        ) as ReviewReport;
        const role = report.roleId;
        requireWorkflow(['pricing', 'logging', 'storage'].includes(role), 'h02-fixture-role');
        const passed =
          role === 'pricing'
            ? await checkH02Material(workspace)
            : readFileSync(join(workspace, role + '.json'), 'utf8') ===
              h02Material.files[role + '.json'];
        report.verdict = passed ? 'PASS' : 'FAIL';
        report.coverage = 'complete';
        report.limitations = [];
        report.findings = passed
          ? []
          : [
              {
                id: 'h02-contract',
                blocking: true,
                text: 'The unchanged H02 checker or frozen role input rejects this snapshot.',
              },
            ];
        items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
      }
      const turn = {
        id: `h02-turn-${++starts}`,
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }, ...items],
      };
      thread.turns.push(turn);
      return { turn: { id: turn.id } };
    },
    async completed(thread, turn) {
      requireWorkflow(
        threads
          .get(thread)
          ?.turns.some(
            (value) =>
              value.id === turn && ['completed', 'interrupted'].includes(String(value.status)),
          ),
        'h02-fixture-completion',
      );
    },
  };
  const store = artifactStore(registration.artifactRoot);
  const proof = store.publish(
    Buffer.from(JSON.stringify({ kind: 'h02-fixed-port', nativeAcceptance: false })),
  );
  return {
    registration,
    preparation: {
      schemaVersion: 1,
      project,
      taskId: 'h02',
      hostId: registration.hostId,
      owner: registration.owner,
      generation: 1,
      revision: 1,
      card: '.h02/task.md',
    },
    profile,
    rpc,
    directory: join(root, 'reader-host'),
    maxTurnStarts: 8,
    signal,
    authority: {
      async verify() {
        store.read(proof);
        throw new Error('h02-fixture-no-human-command-authority');
      },
    },
  };
}
